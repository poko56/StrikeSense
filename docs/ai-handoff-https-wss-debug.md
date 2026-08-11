# StrikeSense — AI Handoff: HTTPS/WSS Stability Debug

Updated: 2026-08-12 (Asia/Bangkok)

This document is a handoff for the **current active problem**: the secure
mobile dashboard loads at `https://pokoman.online/`, but its connection badge
remains Offline / flaps because WSS has not successfully stayed connected.

> **Status update — 2026-08-12, later the same day.** Three separate causes of
> the permanent `ws=0` were found and fixed (see
> [Resolution: why `ws=0` was permanent](#resolution-why-ws0-was-permanent),
> which supersedes the "Recommended next debugging steps" list below — that is
> kept only for the reasoning it records). None of them was TLS or the radio.
>
> **The rig has since been rolled back to HTTP at the user's decision**, and
> that build is what the board now runs. It is the pre-HTTPS firmware carrying
> the *current* dashboard, so every UI and touch fix is present; only the camera
> is unavailable, because `getUserMedia()` requires a secure context. The
> WebSocket came up on the first try there — `ws 1`, free heap 160 KiB against
> 33–50 KiB under HTTPS. Build and instructions:
> `~/Documents/GitHub/StrikeSense-backups/firmware-http-newui-20260812/`.
>
> The HTTPS work is intact in the working tree and none of it was reverted. Read
> [What is left before HTTPS can work](#what-is-left-before-https-can-work)
> before picking it up again.

## User goal

The rig must work entirely in a mobile browser, without a native app:

- phone camera motion capture via MediaPipe Pose Landmarker;
- IMU force/strike detection from four Strike Nodes;
- left/right hands and legs, with 3-D joint angles fused with each strike;
- trusted HTTPS and WSS, so `getUserMedia()` is allowed on phones;
- no cloud runtime dependency while using the rig.

The user has asked that the connection/traffic issue be fixed. They have
authorized firmware flashing and the Main Node is connected over USB.

## Hardware/runtime facts

- Main Node: ESP32-S3, OPI PSRAM 8 MiB, USB serial
  `/dev/cu.usbmodem101`.
- Arduino core: 3.3.11. Correct FQBN used for compile/upload:

  ```sh
  esp32:esp32:esp32s3:CDCOnBoot=cdc,FlashSize=8M,PartitionScheme=default_8MB,PSRAM=opi,UploadSpeed=921600
  ```

- SoftAP address: `192.168.4.1`.
- Four IMU nodes normally send about 140–150 packets/s combined. During the
  failing HTTPS tests, ESP-NOW itself stayed healthy (`rx` climbing; zero or
  very low drops), so this is primarily a TLS/web transport issue—not a radio
  sensor failure.
- The current board was flashed successfully with the latest local source in
  this worktree. No changes have been committed.

## Certificate and DNS

- Let’s Encrypt certificate for **`pokoman.online`** was successfully issued.
- It expires **2026-11-09**.
- Certificate/key/hostname were installed on the rig SD card as:

  ```text
  /tls/server-cert.pem
  /tls/server-key.pem
  /tls/hostname.txt       # contains pokoman.online
  ```

- Do **not** commit or expose the private key. The certificate source/config
  lives outside this repository under the user’s Library/Application Support
  directory.
- Public DNS is Z.com. The DNS-01 TXT record was manually created to issue the
  certificate. Renewal is manual unless a DNS API workflow is added later.
- The browser must open **`https://pokoman.online/`**, not
  `https://192.168.4.1/`; the certificate only has a DNS SAN for
  `pokoman.online`.

## MediaPipe SD assets

Assets were installed and checksum-verified under:

```text
/mocap/mediapipe/0.10.35/
  wasm/vision_wasm_internal.js
  wasm/vision_wasm_internal.wasm
  wasm/vision_wasm_nosimd_internal.js
  wasm/vision_wasm_nosimd_internal.wasm
  models/pose_landmarker_lite.task
```

The firmware exposes only these exact assets over secure `/mocap/*` paths. It
must never expose arbitrary SD paths because the card also contains sessions
and TLS material.

## Feature implementation already present

### Browser motion capture

- `dashboard/src/motioncapture.js`: on-device MediaPipe pose capture,
  throttled video inference, camera permission UX, overlay/status.
- `dashboard/src/posemath.js`: maps sensor slots to anatomy and calculates
  visibility-gated 3-D angles.
- Fixed slots:
  - 1 = left hand
  - 2 = right hand
  - 3 = left shin/leg
  - 4 = right shin/leg
- IMU remains the **only force metric**. Pose is attached to an impact as
  form/angles/quality metadata.
- `dashboard/src/rigclock.js` maps Main Node receive timestamps to the page’s
  monotonic clock for pose/impact matching.
- Frontend tests passed before this handoff (`npm test`: 107 tests) and the
  dashboard build passed.

### Firmware HTTPS/WSS implementation

The native ESP-IDF `esp_https_server` is used because the installed
ESPAsyncWebServer/AsyncTCP stack cannot provide server-side TLS.

Relevant file:

```text
firmware/main-node/main-node.ino
```

It currently:

- serves the embedded dashboard on HTTPS :443;
- proxies existing `/api/*` calls to the legacy local HTTP server;
- exposes `/ws` through native WSS;
- sends IMU batches through `httpd_queue_work()`;
- serves five allowlisted MediaPipe files from SD;
- loads cert/key from SD at boot;
- redirects HTTP human entry pages to `https://pokoman.online/` once TLS is
  ready.

## Changes made during this debug session

These edits are in the dirty working tree and were included in the latest
firmware flash.

### 1. Removed external Google Fonts from the embedded dashboard

`dashboard/index.html` no longer requests Google Fonts. This was critical:
the old captive DNS wildcard resolved `fonts.googleapis.com` and
`fonts.gstatic.com` to the rig, but the rig presented a certificate for
`pokoman.online`. The phone therefore generated wrong-SNI TLS failures before
WSS could connect.

`npm run build` was run after the edit, regenerating:

```text
firmware/main-node/dashboard_ui.h
```

Verify before another flash:

```sh
! rg -n 'fonts\.googleapis|fonts\.gstatic' dashboard/dist/index.html firmware/main-node/dashboard_ui.h
```

### 2. Secure DNS is now exact-host, not wildcard

When HTTPS starts successfully, the AP DNS server replies only for
`pokoman.online` and answers other names with NXDOMAIN. The legacy HTTP
fallback retains wildcard captive DNS.

Purpose: stop OS connectivity probes and third-party hostnames from being
sent to the TLS listener with certificate-mismatched SNI.

Trade-off: secure mode deliberately does **not** offer an automatic captive
portal popup. The user must open `https://pokoman.online/`. If a phone uses
Private DNS / Private Relay and cannot resolve this name locally, disable that
feature for the StrikeSense Wi-Fi network while testing.

### 3. TLS session policy is intentionally small

Current configuration in `main-node.ino`:

```cpp
static constexpr size_t HTTPS_MAX_OPEN_SOCKETS = 2;
config.httpd.lru_purge_enable = false;
config.tls_handshake_timeout_ms = 4000;
```

Important correction: ESP-IDF's `max_open_sockets` means **client sessions**.
The HTTP server’s listen/control sockets are additional. Earlier reasoning
that set this to 5 was wrong and would permit five large TLS sessions.

The target is exactly:

1. one long-lived WSS connection;
2. one transient serialized HTTPS REST request.

`lru_purge_enable` must remain `false`: a server-push WSS connection does not
receive requests frequently, so LRU eviction can choose and kill WSS, causing
an Offline/Live reconnect loop.

### 4. The AP accepts one browser device

Current config sets:

```cpp
#define AP_MAX_CLIENTS 1
WiFi.softAP(AP_SSID, AP_PASSWORD, AP_CHANNEL, 0, AP_MAX_CLIENTS);
```

Live serial logs showed two distinct Wi-Fi stations during the failure. Each
TLS browser can consume roughly 50 KiB internal RAM; two phones are not a
supported secure topology on this ESP32-S3 build. Keep only one phone/tablet
connected to `StrikeSense` during secure testing.

### 5. REST request serialization and traffic reduction

`dashboard/src/api.js` now keeps a **permanent one-request lane on HTTPS**,
not just during page bootstrap. Identical outstanding GETs are single-flight
coalesced.

`dashboard/src/setup.js` now:

- reduces shake polling from 220 ms to 500 ms;
- has in-flight guards so it cannot stack async `/api/nodes` requests.

`dashboard/src/ws.js` now respects a pending reconnect backoff when the
mobile browser emits focus/online/pageshow bursts.

`dashboard/src/freshness.js` skips its whole-dashboard re-fetch on HTTPS;
that request bypassed the API lane and competed with live telemetry.

`dashboard/src/main.js` currently starts WSS only after initial hydration.
This was intended to avoid a third simultaneous TLS session during first load.
If debugging continues, verify whether this causes WSS to start too late or
never starts because bootstrap fetches get stuck.

### 6. Native HTTPS handler memory/closure hardening

- Large proxy headers and I/O scratch were moved out of the HTTPS task stack
  into a shared PSRAM scratch structure.
- Header limit reduced from 4096 to 2048 bytes, sufficient for the bounded
  local API response headers.
- One-shot dashboard, API, error, secure-status, and MediaPipe responses add
  `Connection: close` and call `httpd_sess_trigger_close()` after response
  writes to release the scarce TLS client slot.
- MediaPipe asset transfers also explicitly close after completion.

The original proxy handler had two 4 KiB header arrays plus other parser
locals and 2 KiB helper I/O buffers on a 12 KiB HTTPD task stack. That was a
credible source of the observed Guru Meditation under TLS load.

## Live evidence from the failing rig

Observed on `/dev/cu.usbmodem101` before/while patching:

- `[HTTPS] Listening on https://pokoman.online/` appeared on prior boots.
- Errors included:

  ```text
  mbedtls_ssl_handshake returned -0x7F00  # allocation failure
  mbedtls_ssl_handshake returned -0x6E00  # handshake failure
  mbedtls_ssl_handshake returned -0x7280  # peer closed / EOF
  mbedtls_ssl_handshake returned -0x7780  # client fatal alert
  ... TLS handshake timeout (0x8009)
  Guru Meditation Error: Core 1 LoadProhibited   # occurred once in old build
  ```

- Baseline internal free heap after boot was about 145–149 KiB.
- A TLS page connection dropped this by roughly 50–70 KiB.
- With two active stations/requests, heap fell to roughly 33–50 KiB and WSS
  was never established (`ws=0`).
- The dashboard did transfer successfully, for example:

  ```text
  [HTTPS] dashboard sent in 1754 ms
  ```

- On the most recent one-client test, dashboard transfer was observed, then
  heap fluctuated around 48–70 KiB while `ws=0` persisted. This is the current
  unresolved state. It means the next AI should focus on why bootstrap/API
  activity holds both TLS client slots or why `startWs()` is not reached.

## Current board state

- Latest source was compiled and flashed successfully. Flash hash verification
  succeeded.
- The AP currently accepts one Wi-Fi station.
- At the last observed moment, one station was connected, dashboard was served,
  IMU nodes were active, but WSS stayed at `ws=0`.
- At the final handoff check, `/dev/cu.usbmodem101` was no longer present in
  the host OS. If serial access is needed, reconnect/power-cycle the USB board
  and re-check the port name before attempting another flash.
- A serial `screen` monitor may otherwise own the port. Before a flash, check
  with:

  ```sh
  lsof -t /dev/cu.usbmodem101
  ```

  and only terminate the exact listed `screen` process if necessary.

## Resolution: why `ws=0` was permanent

The rig was never the thing refusing the WebSocket. The dashboard never dialled
it in time — and in the bad case, never dialled it at all.

Four facts combine:

1. `dashboard/src/main.js` had moved `startWs()` behind
   `initialHydration.finally()`. Before this debug session it ran on the first
   line of bootstrap. So REST always went first.
2. `initAiModel()` runs at panel-init time, ahead of that hydration, and fired
   `api.modelGet()` — which streams the **~140 KB trained model** off the SD
   card through the TLS proxy — plus `api.modelsList()`.
3. `dashboard/src/api.js` keeps one serialized request lane on HTTPS. So the
   real boot order was: model (140 KB) → model list → status → nodes →
   sessions → *only then* `startWs()`. Every one of those is a separate TLS
   handshake, because each one-shot response closes its session; the observed
   handshake cost was around 1.7 s.
4. No request had a deadline. `fetch()` has no default timeout, so one stalled
   read wedged the lane for as long as the browser's own socket timeout —
   `initialHydration` never settled, `startWs()` was never called, and the
   badge stayed Offline for the life of the tab.

With two TLS client sockets, `lru_purge_enable = false` and a REST poll every
1.5 s, the WebSocket handshake also had no free slot to land in even when the
lane did drain. `tls=2/2 ws=0` is the exact fingerprint.

### What changed

- `dashboard/src/main.js` — `startWs()` runs first, before any REST. The REST
  lane opens when the stream reports `onopen`, or after a 4 s grace period so a
  rig that cannot stream still serves its nodes and sessions. Bootstrap reads
  moved inside that gate; secure-mode poll intervals relaxed from 1.5 s/2 s to
  3 s/5 s, since the time-critical data arrives over WSS anyway.
- `dashboard/src/api.js` — the lane starts closed on HTTPS and is opened by
  `openRequestLane()`. Every call now carries an `AbortController` deadline
  (15 s; 60 s for the model read, 120 s for a model upload), so no single
  request can wedge the queue.
- `dashboard/src/ws.js` — `onWsOpen(fn)` lets the bootstrap wait for the
  stream.
- `dashboard/src/aimodel.js` — the 140 KB model read is now
  `startAiModelLoad()`, called after hydration instead of at panel init.
- `dashboard/index.html` — `<link rel="icon" href="data:,">`. A phone otherwise
  asks for `/favicon.ico` during page load, costing a whole TLS handshake out
  of the two-client budget exactly when WSS needs a socket.
- `firmware/main-node/main-node.ino` — `[STATS]` now prints `tls=n/2` (TLS
  client sockets in use) and `iheap=` (free **internal** DRAM, the only memory
  a TLS handshake can use). This is the instrumentation the previous handoff
  asked for, without overriding `open_fn`/`close_fn` — `esp_https_server` sets
  those itself for the TLS transport and replacing them would break it.

### Second cause, found on the rig: REST sessions never freed the pool

The dashboard-side fix above was flashed and the rig then reported, steadily:

```text
[STATS] rx=36502 drop=0 wsdrop=0 nodes=2 wifi=1 ws=0 tls=2/2 sess=off sd=OK rows=0 heap=34472 iheap=34472
```

`rx` climbing means the radio is healthy; `tls=2/2` with `ws=0` means both TLS
client sockets were held by REST and no WebSocket handshake could land — with
`lru_purge_enable = false` there was nothing to break the deadlock, so it
persisted for as long as the phone stayed on the page. `Connection: close` plus
`httpd_sess_trigger_close()` was not enough on its own.

Eviction is therefore back on, with the stream protected properly this time:

- `config.httpd.lru_purge_enable = true`;
- `httpsTouchWsSession()` calls `httpd_sess_update_lru_counter()` on the WS
  socket at handshake and on **every** pushed IMU batch.

That inverts the failure that caused eviction to be switched off in the first
place. A server-push WebSocket receives nothing, so ESP-IDF's LRU bookkeeping
ages it like an idle socket and eviction kept choosing the stream; marking it
used on every push makes it permanently the newest entry, so the victim of a
full pool is always a REST session instead.

Measured on the rig, same phone, before and after that one change:

```text
before  tls=2/2  iheap=33168…50056   ws=0   (pool full, nothing can connect)
after   tls=1/2  iheap≈94000         ws=0   (one slot permanently free)
```

The freed slot is the one the WebSocket needs, and roughly 45 KiB of internal
DRAM came back with it. `httpd_sess_update_lru_counter()` is the documented way
to keep a chosen session alive "irrespective of when it last exchanged a
packet", which is exactly a server-push stream.

### Third cause: the phone was running a dashboard cached before the flash

In the same capture, `/api/status`, `/api/nodes`, `/api/logs` and `/api/models`
requests kept arriving — but **not one `[HTTPS] … dashboard` line**. The phone
never re-downloaded the page. Commit `35a1863` served it with
`Cache-Control: public, max-age=86400`, so a copy taken before the flash is
reused for up to a day without the browser asking the rig anything, and every
dashboard-side fix above was simply not present in the JavaScript that was
running.

Two changes so this stops being invisible:

- `dashboard/build-cpp.js` emits `#define DASHBOARD_BUILD_ID` from the
  `<meta name="ss-build">` stamp, and `/api/secure-status` now reports it as
  `build`.
- `checkFreshness()` no longer gives up on HTTPS. It compares `__BUILD_ID__`
  against that field — a few dozen bytes of JSON instead of a 400 KB document
  re-fetch — and offers the existing reload bar when they differ.

Until a phone has loaded a build containing that check, the stale copy has to be
displaced once. Clearing site data or adding a query string works, but both
depend on the coach winning an argument with Safari's autocomplete, and three
attempts to do it by hand left the request log still showing no dashboard fetch
at all. So the rig now serves the same document at a second path:

```text
https://pokoman.online/new
```

A different path is a different cache key, so that URL cannot be answered from a
cache entry created for `/`. It is a one-time bootstrap, not a permanent second
address — once a build carrying the `/api/secure-status` check has been loaded,
`/` self-corrects after every later flash.

**A stale dashboard is not a quiet failure.** Everything the coach reported —
"no SD card", "the model will not upload", "the nodes are silent" — came from
the old page while the rig itself logged `sd=OK`, accepted the model POST, and
counted about 90 IMU packets a second from two live nodes. The old page opens
more parallel connections than the two-socket pool allows, so with LRU eviction
now on, its own in-flight responses are the ones being cut. Check the build
stamp in the footer before believing any symptom the dashboard reports.

### Guard added: /api/model can take the rig into crash territory

Watching the request log, one route stands out:

```text
[HTTPS] fd=52 /api/model tls=2/2 iheap=49244
[STATS] rx=8942 … ws=0 tls=2/2 … heap=22140 iheap=22140
```

Streaming the ~140 KB trained model up from SD through the legacy server drops
internal DRAM to roughly 22 KiB — close to the pressure at which a Guru
Meditation was already seen once during this debug. `httpsProxyHandler()` now
refuses any proxied request while internal heap is under 32 KiB, answering
`503` instead. `loadInitialModel()` already treats a failed read as "no model on
the rig" and falls back to the browser's own cached copy, so the failure mode is
a retry rather than a reset.

Note this is a floor, not a fix for the cost itself: the read is expensive
because the whole model crosses the loopback proxy. Serving it straight from SD
through a native handler, the way `/mocap/*` assets are served, would avoid the
double handling entirely.

Added at the same time, to make the next round of evidence decisive:

- `[HTTPS] fd=<n> <what> tls=<n>/2 iheap=<bytes>` on every dashboard, `/api/*`,
  `/mocap/*` and WS-upgrade request. Absence of these lines while the badge
  says Offline means the phone is running a **cached** dashboard and is not
  asking the rig for anything — `freshness.js` deliberately skips its check on
  HTTPS, so that state does not self-correct without a hard reload.
- a warning if `httpd_sess_trigger_close()` itself returns an error.

### How to confirm on the rig

Watch the serial log while one phone opens `https://pokoman.online/`:

- `ws=1` should appear within a few seconds of the page loading, and stay.
- `tls=` should sit at `1/2` between polls and touch `2/2` only briefly.
- `iheap=` should settle rather than trend down.

`tls=2/2` with `ws=0` means REST is still winning the race; `tls=0/2` with
`ws=0` means the phone is not reaching the listener at all (name resolution,
Private DNS, or wrong host).

## Recommended next debugging steps

These were written before the cause above was found. Items 2, 3 and 4 are done
or superseded; the rest still stand.

1. **Confirm exactly one station** is connected to `StrikeSense`. Turn off Wi-Fi
   on every other phone/tablet/laptop, then reconnect the one test phone and
   open a single fresh `https://pokoman.online/` tab.

2. **Instrument HTTPS session lifecycle** before changing architecture again.
   Add temporary `open_fn` / `close_fn` callbacks to the native HTTPD config,
   logging socket fd, free internal heap, and current session count. This will
   show which requests occupy the two slots. Do not log private headers or
   certificate data.

3. **Instrument dashboard bootstrap** with local diagnostic events around:

   - `api.modelGet()`;
   - model library list;
   - status/nodes/sessions hydration;
   - `initialHydration.finally()`;
   - `startWs()` / WSS `onopen` / `onclose`.

   The immediate question is whether WSS is never attempted or is rejected.

4. If initial REST calls prevent WSS from being reached, consider a more robust
   startup sequence:

   - serve/force-close dashboard;
   - open WSS;
   - only then allow the permanent one-at-a-time REST lane;
   - defer optional model-library reads until WSS is live.

   Do not allow a third TLS client.

5. Verify `httpd_sess_trigger_close()` actually frees the document/API session
   after the handler returns. It queues a close operation; add a log of its
   return value and of the native session open/close callbacks.

6. Consider serving a shorter TLS chain only after verifying modern phone trust
   compatibility. The installed `fullchain.pem` has four certificates and may
   increase handshake memory. Do **not** replace it casually or include a root
   incorrectly; test any reduced chain on the actual phone first.

7. Keep the current traffic protections unless testing proves otherwise:

   - no Google/external resources;
   - exact-host DNS in secure mode;
   - one AP client;
   - two HTTPS client sessions maximum;
   - permanent serialized REST;
   - LRU purge disabled.

## Useful commands

Run from repository root:

```sh
# Browser/unit tests
(cd dashboard && npm test)

# Rebuild embedded dashboard after dashboard source edits
(cd dashboard && npm run build)

# Compile firmware
arduino-cli compile \
  --fqbn 'esp32:esp32:esp32s3:CDCOnBoot=cdc,FlashSize=8M,PartitionScheme=default_8MB,PSRAM=opi,UploadSpeed=921600' \
  firmware/main-node

# Flash (user authorized this workflow)
arduino-cli upload --port /dev/cu.usbmodem101 \
  --fqbn 'esp32:esp32:esp32s3:CDCOnBoot=cdc,FlashSize=8M,PartitionScheme=default_8MB,PSRAM=opi,UploadSpeed=921600' \
  firmware/main-node

# Attach serial monitor after freeing the port
TERM=xterm screen /dev/cu.usbmodem101 115200
```

## What is left before HTTPS can work

The three fixes above were real and each one measurably improved the rig, but
they were not enough, and the request log shows why. With the current dashboard
confirmed running on the phone (build stamp checked in the footer, one tab
open), the rig logged `/api/status`, `/api/nodes`, `/api/sessions` and
`/api/logs` arriving normally — and, over 35 seconds, **not one WebSocket
upgrade, TLS handshake error, or accept failure**. The phone also reported
`invalid legacy HTTP response`, which is the loopback proxy's 502 for "the
local HTTP server did not answer".

That points at the architecture rather than any single defect. Every secure API
call costs a TLS session (~47 KiB of internal DRAM, measured) *plus* an
ESPAsyncWebServer response buffer, because `/api/*` on :443 is proxied to the
legacy server on :80. On roughly 140 KiB of usable internal heap, two TLS
sessions leave the async server too little memory to build its reply, so the
proxy times out and returns 502 — which the dashboard renders as "no SD card",
"the model will not upload", and "the nodes are silent", none of which are true
of the hardware.

**The fix is to delete the proxy**, serving the `/api/*` handlers natively from
`esp_https_server` the way `/mocap/*` assets already are. That removes the
double memory cost, the 502 class entirely, and the dependency on
ESPAsyncWebServer being reachable at all. It is a substantial refactor of the 20
API routes, and it should be done before spending any more time on TLS tuning.

Also unexplained and worth instrumenting from the browser side first: why the
WebSocket produced no trace whatsoever at the rig. Read the WS-tagged lines in
the dashboard's own diagnostic console (developer mode, SYSTEM tab) before
assuming it is a server problem — the rig cannot see a connection the phone
never opened.

## Restore points

Created 2026-08-12, before the fix above:

- tag `backup-no-camera-http-20260812` and branch `backup/no-camera-http` —
  commit `35a1863`, the last committed system before the camera and HTTPS work
  (HTTP only, no `motioncapture.js`, no `esp_https_server`);
- a checked-out worktree of it at `~/Documents/GitHub/StrikeSense-no-camera`;
- tarballs of both that commit and the full pre-fix working tree, plus two
  compiled firmware images, under `~/Documents/GitHub/StrikeSense-backups/`
  (see the README there):
  - `firmware-no-camera-20260812/` — `35a1863` exactly as committed;
  - `firmware-http-newui-20260812/` — **what the board runs now**: the same
    HTTP firmware rebuilt with the current dashboard, so the UI and touch fixes
    made after that commit are included. Its one source change is the dashboard
    `Cache-Control`, now `no-cache, no-store, must-revalidate`.

Neither the tag nor the branch was pushed to `origin`.

## Repository hygiene

- The repository was already dirty before this work. Preserve unrelated user
  changes; do not reset/revert broadly.
- Relevant changed files include `firmware/main-node/main-node.ino`,
  `firmware/main-node/dashboard_ui.h`, `dashboard/index.html`,
  `dashboard/src/api.js`, `dashboard/src/main.js`, `dashboard/src/setup.js`,
  `dashboard/src/ws.js`, `dashboard/src/freshness.js`, and
  `dashboard/test/api.test.mjs`.
- `npm test` passed with 107 tests after the frontend traffic changes.
- `arduino-cli compile` passed after the latest firmware changes.
