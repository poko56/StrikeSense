#!/usr/bin/env bash
# Install an already-issued public TLS certificate onto an explicit SD-card root.
# This script does not contact an ACME service, read DNS credentials, or create keys.

set -euo pipefail
umask 077

readonly RENEWAL_WARNING_SECONDS=1209600 # 14 days

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: tools/install-letsencrypt-cert.sh [--hostname <dns-name>] [--dry-run] \
  <mounted-sd-root> <fullchain.pem> <privkey.pem>

Examples:
  tools/install-letsencrypt-cert.sh --hostname rig.example.com \
    /Volumes/STRIKESENSE \
    /etc/letsencrypt/live/rig.example.com/fullchain.pem \
    /etc/letsencrypt/live/rig.example.com/privkey.pem

  tools/install-letsencrypt-cert.sh --dry-run --hostname rig.example.com \
    /Volumes/STRIKESENSE ./fullchain.pem ./privkey.pem

Validates the PEM files before writing only these paths beneath the supplied SD root:
  /tls/server-cert.pem   (copy of fullchain.pem)
  /tls/server-key.pem    (copy of unencrypted privkey.pem)
  /tls/hostname.txt      (only when --hostname is supplied)

--hostname must be the DNS name in the certificate. It is required for a
public-CA/Let's Encrypt deployment so firmware can use the same canonical name.
--dry-run performs every safety and cryptographic validation but writes nothing.
EOF
}

for command in openssl shasum awk grep mktemp cp mv chmod; do
  command -v "$command" >/dev/null 2>&1 || die "required command not found: $command"
done

hostname=''
dry_run=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --hostname)
      [[ $# -ge 2 ]] || die '--hostname requires a DNS name'
      [[ -z "$hostname" ]] || die '--hostname was supplied more than once'
      hostname="$2"
      shift 2
      ;;
    --dry-run)
      dry_run=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    --*)
      die "unknown option: $1"
      ;;
    *)
      break
      ;;
  esac
done

[[ $# -eq 3 ]] || { usage >&2; exit 2; }

sd_root_arg="$1"
certificate_arg="$2"
key_arg="$3"

[[ "$sd_root_arg" != *$'\n'* && "$sd_root_arg" != *$'\r'* ]] || die 'SD root contains a line break'
[[ "$certificate_arg" != *$'\n'* && "$certificate_arg" != *$'\r'* ]] || die 'certificate path contains a line break'
[[ "$key_arg" != *$'\n'* && "$key_arg" != *$'\r'* ]] || die 'key path contains a line break'

[[ -d "$sd_root_arg" ]] || die "SD root must be an existing directory: $sd_root_arg"
[[ ! -L "$sd_root_arg" ]] || die "refusing a symlink as SD root: $sd_root_arg"
target_root="$(cd -P -- "$sd_root_arg" && pwd -P)"

home_dir=''
if [[ -n "${HOME:-}" && -d "$HOME" ]]; then
  home_dir="$(cd -P -- "$HOME" && pwd -P)"
fi
script_dir="$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
project_root="$(cd -P -- "$script_dir/.." && pwd -P)"
if [[ "$target_root" == '/' || ( -n "$home_dir" && "$target_root" == "$home_dir" ) || "$target_root" == "$project_root" ]]; then
  die 'refusing filesystem root, home directory, or this project as an SD-card target'
fi
case "${target_root}/" in
  "${project_root}/"*) die 'refusing any directory inside this project as an SD-card target' ;;
esac

resolve_regular_file() {
  local input="$1"
  local description="$2"
  local source_dir
  local source_base

  [[ -e "$input" ]] || die "$description file does not exist: $input"
  [[ ! -L "$input" ]] || die "refusing symlinked $description file: $input"
  [[ -f "$input" ]] || die "$description must be a regular file: $input"
  source_dir="$(cd -P -- "$(dirname -- "$input")" && pwd -P)"
  source_base="$(basename -- "$input")"
  printf '%s/%s\n' "$source_dir" "$source_base"
}

if ! certificate_source="$(resolve_regular_file "$certificate_arg" 'certificate')"; then
  exit 1
fi
if ! key_source="$(resolve_regular_file "$key_arg" 'private key')"; then
  exit 1
fi
[[ "$certificate_source" != "$key_source" ]] || die 'certificate and private-key paths must be different files'

case "$certificate_source" in
  "$target_root"/*) die 'certificate source must be outside the SD-card target' ;;
esac
case "$key_source" in
  "$target_root"/*) die 'private-key source must be outside the SD-card target' ;;
esac

valid_dns_hostname() {
  local name="$1"
  local label
  local labels

  [[ ${#name} -le 253 && "$name" == *.* && "$name" != .* && "$name" != *. ]] || return 1
  IFS='.' read -r -a labels <<< "$name"
  for label in "${labels[@]}"; do
    [[ ${#label} -ge 1 && ${#label} -le 63 ]] || return 1
    [[ "$label" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]] || return 1
  done
}

if [[ -n "$hostname" ]]; then
  valid_dns_hostname "$hostname" || die 'hostname must be a lowercase DNS name such as rig.example.com (no IP address or wildcard)'
fi

printf 'validating certificate and private key\n'
openssl x509 -in "$certificate_source" -noout >/dev/null 2>&1 || die 'certificate is not a readable PEM X.509 certificate'
if grep -Eq '^-----BEGIN ENCRYPTED PRIVATE KEY-----$|^Proc-Type: 4,ENCRYPTED$' "$key_source"; then
  die 'private key is encrypted; firmware requires an unencrypted PEM key'
fi
openssl pkey -in "$key_source" -passin pass: -noout >/dev/null 2>&1 || die 'private key is unreadable, encrypted, or not PEM; firmware requires an unencrypted PEM key'
if ! openssl x509 -in "$certificate_source" -noout -checkend 0 >/dev/null 2>&1; then
  die 'certificate is expired'
fi
if ! openssl x509 -in "$certificate_source" -noout -checkend "$RENEWAL_WARNING_SECONDS" >/dev/null 2>&1; then
  printf 'warning: certificate expires within 14 days; renew before installing it\n' >&2
fi

public_key_digest_from_certificate() {
  openssl x509 -in "$1" -pubkey -noout 2>/dev/null \
    | openssl pkey -pubin -pubout -outform DER 2>/dev/null \
    | shasum -a 256 | awk '{ print $1 }'
}

public_key_digest_from_private_key() {
  openssl pkey -in "$1" -passin pass: -pubout -outform DER 2>/dev/null \
    | shasum -a 256 | awk '{ print $1 }'
}

if ! certificate_public_key="$(public_key_digest_from_certificate "$certificate_source")"; then
  die 'could not read the certificate public key'
fi
if ! key_public_key="$(public_key_digest_from_private_key "$key_source")"; then
  die 'could not read the private-key public key'
fi
[[ "$certificate_public_key" =~ ^[0-9a-fA-F]{64}$ ]] || die 'certificate public-key fingerprint is invalid'
[[ "$key_public_key" =~ ^[0-9a-fA-F]{64}$ ]] || die 'private-key public-key fingerprint is invalid'
[[ "$certificate_public_key" == "$key_public_key" ]] || die 'certificate does not match the supplied private key'

if [[ -n "$hostname" ]]; then
  openssl x509 -in "$certificate_source" -noout -checkhost "$hostname" >/dev/null 2>&1 \
    || die "certificate does not contain DNS name: $hostname"
fi

tls_dir="${target_root}/tls"
certificate_destination="${tls_dir}/server-cert.pem"
key_destination="${tls_dir}/server-key.pem"
hostname_destination="${tls_dir}/hostname.txt"

safe_make_tls_dir() {
  case "$tls_dir" in
    "$target_root"/*) ;;
    *) die "refusing destination outside supplied SD root: $tls_dir" ;;
  esac
  [[ ! -L "$tls_dir" ]] || die "refusing symlinked TLS directory: $tls_dir"
  if [[ -e "$tls_dir" ]]; then
    [[ -d "$tls_dir" ]] || die "TLS destination exists but is not a directory: $tls_dir"
  elif (( dry_run )); then
    return
  else
    mkdir "$tls_dir"
  fi
}

safe_target_file() {
  local destination="$1"
  local description="$2"
  case "$destination" in
    "$tls_dir"/*) ;;
    *) die "refusing $description outside TLS directory: $destination" ;;
  esac
  [[ ! -L "$destination" ]] || die "refusing symlinked $description destination: $destination"
  if [[ -e "$destination" ]]; then
    [[ -f "$destination" ]] || die "$description destination exists but is not a regular file: $destination"
  fi
}

safe_make_tls_dir
safe_target_file "$certificate_destination" 'certificate'
safe_target_file "$key_destination" 'private key'
safe_target_file "$hostname_destination" 'hostname'

if [[ -z "$hostname" && -e "$hostname_destination" ]]; then
  die 'an existing /tls/hostname.txt would be left stale; rerun with its matching --hostname'
fi

if (( dry_run )); then
  printf 'dry run passed; no TLS files were written\n'
  exit 0
fi

copy_atomically() {
  local source="$1"
  local destination="$2"
  local mode="$3"
  local temporary

  temporary="$(mktemp "${tls_dir}/.$(basename -- "$destination").partial.XXXXXX")"
  if ! cp "$source" "$temporary"; then
    die "could not stage $(basename -- "$destination")"
  fi
  chmod "$mode" "$temporary"
  mv -f "$temporary" "$destination"
}

copy_atomically "$key_source" "$key_destination" 600
copy_atomically "$certificate_source" "$certificate_destination" 644
if [[ -n "$hostname" ]]; then
  hostname_temporary="$(mktemp "${tls_dir}/.hostname.txt.partial.XXXXXX")"
  printf '%s' "$hostname" > "$hostname_temporary"
  chmod 644 "$hostname_temporary"
  mv -f "$hostname_temporary" "$hostname_destination"
fi

printf 'installed TLS files under %s/tls\n' "$target_root"
printf 'power off the rig before reinserting the SD card, then use https://%s/\n' "${hostname:-192.168.4.1}"
