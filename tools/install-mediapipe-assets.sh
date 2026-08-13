#!/usr/bin/env bash
# Install the exact MediaPipe motion-capture assets onto an explicit SD-card root.
# This script intentionally does not provision, copy, or modify TLS certificates.

set -euo pipefail

readonly VERSION='0.10.35'
readonly REQUIRED_FREE_KB=40960
readonly WASM_BASE="https://unpkg.com/@mediapipe/tasks-vision@${VERSION}/wasm"
readonly MODEL_URL='https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task'

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: tools/install-mediapipe-assets.sh <mounted-sd-root>

Example:
  tools/install-mediapipe-assets.sh /Volumes/STRIKESENSE

Writes only:
  <mounted-sd-root>/mocap/mediapipe/0.10.35/
EOF
}

for command in curl shasum awk df mktemp; do
  command -v "$command" >/dev/null 2>&1 || die "required command not found: $command"
done

[[ $# -eq 1 ]] || { usage >&2; exit 2; }
[[ -d "$1" ]] || die "SD root must be an existing directory: $1"

target_root="$(cd -- "$1" && pwd -P)"
home_dir="${HOME:-}"
if [[ "$target_root" == '/' || ( -n "$home_dir" && "$target_root" == "$home_dir" ) ]]; then
  die 'refusing a filesystem root or home directory; pass the mounted SD-card root instead'
fi

free_kb="$(df -Pk "$target_root" | awk 'NR == 2 { print $4 }')"
if [[ "$free_kb" =~ ^[0-9]+$ ]] && (( free_kb < REQUIRED_FREE_KB )); then
  die "need at least ${REQUIRED_FREE_KB} KiB free on the SD card (found ${free_kb} KiB)"
fi

safe_dir() {
  local path="$1"
  case "$path" in
    "$target_root"/*) ;;
    *) die "refusing destination outside supplied SD root: $path" ;;
  esac
  [[ ! -L "$path" ]] || die "refusing symlinked directory: $path"
  if [[ -e "$path" ]]; then
    [[ -d "$path" ]] || die "destination exists but is not a directory: $path"
  else
    mkdir "$path"
  fi
}

safe_dir "${target_root}/mocap"
safe_dir "${target_root}/mocap/mediapipe"
safe_dir "${target_root}/mocap/mediapipe/${VERSION}"
safe_dir "${target_root}/mocap/mediapipe/${VERSION}/wasm"
safe_dir "${target_root}/mocap/mediapipe/${VERSION}/models"

readonly asset_root="${target_root}/mocap/mediapipe/${VERSION}"

sha256() {
  shasum -a 256 "$1" | awk '{ print $1 }'
}

install_asset() {
  local relative_path="$1"
  local url="$2"
  local expected_sha="$3"
  local destination="${asset_root}/${relative_path}"
  local destination_dir
  local temporary
  local actual_sha

  case "$destination" in
    "$asset_root"/*) ;;
    *) die "refusing destination outside asset root: $destination" ;;
  esac
  [[ ! -L "$destination" ]] || die "refusing symlinked asset: $destination"

  if [[ -f "$destination" ]]; then
    actual_sha="$(sha256 "$destination")"
    if [[ "$actual_sha" == "$expected_sha" ]]; then
      printf 'verified %s\n' "$relative_path"
      return
    fi
    printf 'replacing checksum-mismatched %s\n' "$relative_path"
  elif [[ -e "$destination" ]]; then
    die "destination exists but is not a regular file: $destination"
  fi

  destination_dir="$(dirname "$destination")"
  [[ -d "$destination_dir" && ! -L "$destination_dir" ]] || die "unsafe destination directory: $destination_dir"
  temporary="$(mktemp "${destination_dir}/.$(basename "$destination").partial.XXXXXX")"

  if ! curl --fail --location --silent --show-error --proto '=https' --tlsv1.2 \
      --retry 3 --retry-delay 1 --connect-timeout 20 \
      --output "$temporary" "$url"; then
    rm -f "$temporary"
    die "download failed: $relative_path"
  fi

  actual_sha="$(sha256 "$temporary")"
  if [[ "$actual_sha" != "$expected_sha" ]]; then
    rm -f "$temporary"
    die "checksum mismatch for $relative_path"
  fi

  mv -f "$temporary" "$destination"
  printf 'installed %s\n' "$relative_path"
}

install_asset 'wasm/vision_wasm_internal.js' \
  "${WASM_BASE}/vision_wasm_internal.js" \
  'e7fd9858e8e8f221d9b96eddc11f8e077f263e0b7bbd79d3cbe882b134274f8c'
install_asset 'wasm/vision_wasm_internal.wasm' \
  "${WASM_BASE}/vision_wasm_internal.wasm" \
  '6a5c64584c2ab61c763b6e204afbdbc7ce1caf7f5216187322bca8df94f646bc'
install_asset 'wasm/vision_wasm_nosimd_internal.js' \
  "${WASM_BASE}/vision_wasm_nosimd_internal.js" \
  '438d1fe8ff7f4d946025bc211c291543c037d8a3785ed4eee60f1f521b236296'
install_asset 'wasm/vision_wasm_nosimd_internal.wasm' \
  "${WASM_BASE}/vision_wasm_nosimd_internal.wasm" \
  '8a3092d34c79d3f57e6ba8592105e8a90f6b07c27891ffecd14cca428bfd3e31'
install_asset 'models/pose_landmarker_lite.task' \
  "$MODEL_URL" \
  '59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbf6753c459690d574a'

printf '\nMediaPipe %s is ready under %s/mocap/mediapipe/%s\n' \
  "$VERSION" "$target_root" "$VERSION"
