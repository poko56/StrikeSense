// WebSocket binary frame decoder + reconnect logic.
//
// Wire format: one message carries ONE OR MORE self-describing frames back to
// back (the Main Node coalesces ~12 ms worth of IMU packets into a single
// message to cut per-message overhead). Each frame is:
//   [0]      0x01 magic
//   [1]      slot
//   [2]      sampleCount n
//   [3]      rssi (int8)
//   [4..7]   seq (u32 LE)
//   [8..11]  recvTimestampMs (u32 LE)
//   [12..15] nodeTimestampUs (u32 LE)
//   [16..]   n × { ax ay az gx gy gz } (int16 LE)

import { state, scheduleRender } from './state.js';
import { ingestBatch } from './analyzer.js';
import { logSensorData } from './logger.js';
import { logLocal } from './diaglog.js';
import { createRigClockMapper } from './rigclock.js';
import { rigWsHost } from './rigorigin.js';

const ACCEL_LSB_PER_G  = 2048;
const GYRO_LSB_PER_DPS = 16.4;

const HEADER_BYTES = 16;
const SAMPLE_BYTES = 12;
const MAX_SAMPLES  = 8;

let backoff = 400;
let lastPktAt = 0;
let pktCounter = 0;
let sampleCounter = 0;
let byteCounter = 0;
let lastRateAt = performance.now();

let reconnectTimer = null;
let tearingDown = false;
// Converts Main Node receive timestamps to this page's monotonic clock. It
// preserves timing between frames inside a coalesced WS message, which is what
// camera-to-IMU matching needs; see rigclock.js for its uncertainty caveat.
const rigClock = createRigClockMapper();

// Notified every time the stream comes up. main.js uses it to hold REST until
// the WSS connection owns one of the rig's two TLS client slots.
const openListeners = new Set();
export function onWsOpen(fn) {
  openListeners.add(fn);
  return () => openListeners.delete(fn);
}

export function startWs() {
  if (tearingDown) return;
  // guard: never open a second socket while one is connecting/open — mobile
  // wake-ups + timers used to stack connections and cause OFFLINE/LIVE flapping.
  if (state.ws && (state.ws.readyState === WebSocket.CONNECTING ||
                   state.ws.readyState === WebSocket.OPEN)) return;
  // A socket left in CLOSING (or an already-closed one still referenced) keeps the
  // rig's matching socket alive too. Cut it loose before opening the replacement.
  if (state.ws) detach(state.ws, true);
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  rigClock.reset();

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  state.wsUrl = `${proto}//${rigWsHost()}/ws`;

  let ws;
  try { ws = new WebSocket(state.wsUrl); }
  catch (e) { logLocal('WS', `สร้าง socket ไม่ได้: ${e.message}`); scheduleReconnect(); return; }

  ws.binaryType = 'arraybuffer';
  state.ws = ws;

  ws.onopen = () => {
    logLocal('WS', `เชื่อมต่อสำเร็จ ${state.wsUrl}`);
    state.connected = true;
    backoff = 400;
    lastPktAt = 0;            // don't let the stall watchdog judge a fresh socket
    scheduleRender();
    for (const fn of openListeners) {
      try { fn(); } catch (e) { logLocal('WS', `onWsOpen listener: ${e.message}`); }
    }
  };
  ws.onclose = (ev) => {
    logLocal('WS', `ปิด code=${ev?.code ?? '?'} clean=${ev?.wasClean ? 'y' : 'n'}${ws !== state.ws ? ' (ตัวที่ถูกแทนแล้ว)' : ''}`);
    if (ws !== state.ws) return;      // a socket we already replaced
    state.connected = false;
    state.ws = null;
    scheduleRender();
    scheduleReconnect();
  };
  ws.onerror = () => { /* close fires next */ };
  ws.onmessage = ev => {
    if (typeof ev.data === 'string') { handleTextFrame(ev.data); return; }
    decodeMessage(ev.data);
  };
}

// Rig state arriving as a push instead of a poll.
//
// On HTTPS every REST call costs a whole TLS session out of a pool of two, and
// the 3 s status / 5 s nodes polls held one of them permanently — the live
// stream could never claim a socket, and a rig with healthy nodes and a mounted
// SD card reported neither. The same JSON now rides the socket that is already
// open, so the secure dashboard polls for nothing.
//
// `onState` is how main.js keeps its own session-sync and node-history logic in
// one place rather than duplicating it here.
const stateListeners = new Set();
export function onRigState(fn) {
  stateListeners.add(fn);
  return () => stateListeners.delete(fn);
}

function handleTextFrame(text) {
  let msg = null;
  try { msg = JSON.parse(text); } catch { return; }   // not ours — ignore
  if (!msg || msg.t !== 'state') return;
  for (const fn of stateListeners) {
    try { fn(msg); } catch (e) { logLocal('WS', `onRigState listener: ${e.message}`); }
  }
}

/** Detach handlers and close, without triggering our own reconnect logic. */
function detach(ws, closeIt) {
  try {
    ws.onopen = ws.onclose = ws.onerror = ws.onmessage = null;
    if (closeIt && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      ws.close(1000, 'replaced');
    }
  } catch { /* already gone */ }
}

// Storm brake. A reconnect loop between page and rig once ran at ~2.5 sockets a
// second for as long as the tab was open. The cause is fixed in firmware, but a
// dial-instantly-on-every-close policy will amplify any future one just as hard,
// so rapid repeats get an escalating floor instead of the snappy 400 ms.
const RECENT_WINDOW_MS = 10000;
const RECENT_LIMIT     = 6;
let recentConnects = [];

function scheduleReconnect() {
  if (reconnectTimer || tearingDown) return;

  const now = performance.now();
  recentConnects = recentConnects.filter(t => now - t < RECENT_WINDOW_MS);
  let wait = backoff;
  if (recentConnects.length >= RECENT_LIMIT) {
    wait = Math.max(wait, 5000);
    logLocal('WS', `ต่อใหม่ถี่ผิดปกติ (${recentConnects.length} ครั้ง/10 วิ) — ชะลอเป็น ${wait} ms`);
  }

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    recentConnects.push(performance.now());
    startWs();
  }, wait);
  backoff = Math.min(backoff * 1.6, 3000);   // cap lower for snappier mobile recovery
}

/** Manual "reconnect now" — wired to the RECOVERY button in the SYSTEM tab. */
export function reconnectStream(why = 'manual') {
  if (state.demoMode) return;
  tearingDown = false;
  forceReconnect(why);
}

/** Drop the current socket and immediately dial again. */
function forceReconnect(why) {
  const ws = state.ws;
  state.ws = null;
  state.connected = false;
  if (ws) detach(ws, true);
  backoff = 400;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  logLocal('WS', `ต่อใหม่: ${why}`);
  scheduleRender();
  startWs();
}

// Reconnect immediately when the phone returns to the app or regains network —
// mobile browsers suspend sockets on lock/background, which showed as flapping.
function kick() {
  if (!state.ws || state.ws.readyState === WebSocket.CLOSED || state.ws.readyState === WebSocket.CLOSING) {
    // Focus/online/pageshow often arrive as a burst on mobile.  Respect an
    // existing backoff instead of turning one failed TLS handshake into several
    // immediate reconnects that compete for the rig's two secure client slots.
    if (reconnectTimer) return;
    tearingDown = false;
    startWs();
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') kick(); });
  window.addEventListener('online',  kick);
  window.addEventListener('focus',   kick);
  window.addEventListener('pageshow', () => { tearingDown = false; kick(); });

  // Browsers do NOT reliably send a close frame when the page is refreshed or
  // navigated away. The rig then keeps the abandoned socket in its client list and
  // goes on queueing live IMU frames at it, and the freshly loaded page could not
  // get a working stream — the "refresh and the WebSocket is dead" bug. Closing it
  // ourselves guarantees the Main Node sees the disconnect straight away.
  // (The firmware also evicts a stale socket from the same IP on connect, so a
  // hard kill — swipe-close, crash — recovers too.)
  const teardown = () => {
    logLocal('WS', 'ปิด socket เพราะกำลังออก/รีเฟรชหน้า');
    tearingDown = true;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    const ws = state.ws;
    state.ws = null;
    if (ws) detach(ws, true);
  };
  window.addEventListener('pagehide', teardown);
  window.addEventListener('beforeunload', teardown);

  // A socket can sit in OPEN forever after the rig reboots or the phone silently
  // switches network: readyState never changes, so the UI shows a green light and
  // no data at all.
  //
  // The tell has to be precise or this turns into a reconnect loop. "A node is
  // online" is NOT enough — a sensor whose IMU has wedged still sends its 1 Hz
  // status packet, so it looks alive while producing no stream. /api/status.rx
  // counts IMU batches the rig has received, so a climbing rx means frames are
  // definitely being broadcast; if none reach us for 6 s, this socket is dead.
  const STALL_MS = 6000;
  let lastRxSeen = -1, rxGrewAt = 0;
  setInterval(() => {
    if (tearingDown || document.hidden) return;
    const rx = state.hostStatus?.rx;
    if (typeof rx === 'number') {
      if (lastRxSeen >= 0 && rx > lastRxSeen) rxGrewAt = performance.now();
      lastRxSeen = rx;
    }
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
    if (!lastPktAt || performance.now() - lastPktAt < STALL_MS) return;
    if (performance.now() - rxGrewAt > STALL_MS) return;   // rig isn't producing
    forceReconnect('rig is receiving IMU data but no frames reached this socket');
  }, 2000);
}

// One reusable set of sample objects. This path used to allocate ~1600 short-lived
// objects a second with four nodes attached — pure GC pressure on a phone. Nothing
// downstream keeps a reference past the ingestBatch() call.
const _pool = Array.from({ length: MAX_SAMPLES }, () => ({ ax: 0, ay: 0, az: 0, gx: 0, gy: 0, gz: 0 }));
const _view = [];
// A WS message holds only a handful of coalesced frames. Reuse descriptor
// arrays so the timing pre-pass does not put pressure on the phone's GC.
const _frameOffsets = [];
const _frameCounts = [];
const _frameRigTimes = [];
const _frameTimes = [];

function decodeMessage(buf) {
  const dv = new DataView(buf);
  let off = 0;
  // All frames in this message crossed the socket together, but their embedded
  // Main Node timestamps tell us when each was actually received by the rig.
  const arrivalPerfMs = performance.now();
  _frameOffsets.length = 0;
  _frameCounts.length = 0;
  _frameRigTimes.length = 0;
  while (off + HEADER_BYTES <= dv.byteLength) {
    if (dv.getUint8(off) !== 0x01) break;                 // not a frame — stop
    const n = dv.getUint8(off + 2);
    if (n < 1 || n > MAX_SAMPLES) break;
    const frameLen = HEADER_BYTES + n * SAMPLE_BYTES;
    if (off + frameLen > dv.byteLength) break;            // truncated tail
    _frameOffsets.push(off);
    _frameCounts.push(n);
    _frameRigTimes.push(dv.getUint32(off + 8, true));
    off += frameLen;
  }
  // Calibrate this whole message before feeding its frames in chronological
  // order. Otherwise the first ever coalesced message would stamp every frame
  // at its socket-arrival time rather than retaining 20/40 ms rig spacing.
  rigClock.mapBatch(_frameRigTimes, arrivalPerfMs, _frameTimes);
  for (let i = 0; i < _frameOffsets.length; i++) {
    decodeFrame(dv, _frameOffsets[i], _frameCounts[i], _frameTimes[i]);
  }

  byteCounter += dv.byteLength;
  lastPktAt = arrivalPerfMs;
  if (lastPktAt - lastRateAt >= 1000) {                   // rate counters (sliding 1 s)
    state.measuredHz   = sampleCounter;
    state.measuredKbps = (byteCounter * 8) / 1024;
    pktCounter = 0; sampleCounter = 0; byteCounter = 0; lastRateAt = lastPktAt;
  }
}

function decodeFrame(dv, off, n, frameAtMs) {
  const slot = dv.getUint8(off + 1);
  const rssi = dv.getInt8(off + 3);
  const seq  = dv.getUint32(off + 4, true);
  // The node microsecond timestamp is on a different node clock. The Main Node
  // receive timestamp is the common clock across all four slots, so use it for
  // browser-side fusion. (Keep the field in the wire format for future sync.)
  // const nodeUs = dv.getUint32(off + 12, true);

  _view.length = n;
  for (let i = 0; i < n; i++) {
    const p = off + HEADER_BYTES + i * SAMPLE_BYTES;
    const s = _pool[i];
    s.ax = dv.getInt16(p,      true) / ACCEL_LSB_PER_G;
    s.ay = dv.getInt16(p + 2,  true) / ACCEL_LSB_PER_G;
    s.az = dv.getInt16(p + 4,  true) / ACCEL_LSB_PER_G;
    s.gx = dv.getInt16(p + 6,  true) / GYRO_LSB_PER_DPS;
    s.gy = dv.getInt16(p + 8,  true) / GYRO_LSB_PER_DPS;
    s.gz = dv.getInt16(p + 10, true) / GYRO_LSB_PER_DPS;
    _view[i] = s;
    // AI training logger — no-op unless recording is armed.
    // `slot` (frame-level) tags which limb produced the sample.
    logSensorData(s, slot);
  }

  pktCounter++;
  sampleCounter += n;

  ingestBatch({
    slot, rssi, mac: null, samples: _view, seq,
    recvMs: Date.now(),
    tMs: frameAtMs,
  });
}
