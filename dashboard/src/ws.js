// WebSocket binary frame decoder + reconnect logic.
import { state, scheduleRender } from './state.js';
import { ingestBatch } from './analyzer.js';
import { logSensorData } from './logger.js';

const ACCEL_LSB_PER_G  = 2048;
const GYRO_LSB_PER_DPS = 16.4;

let backoff = 500;
let lastPktAt = 0;
let pktCounter = 0;
let sampleCounter = 0;
let lastRateAt = performance.now();

let reconnectTimer = null;

export function startWs() {
  // guard: never open a second socket while one is connecting/open — mobile
  // wake-ups + timers used to stack connections and cause OFFLINE/LIVE flapping.
  if (state.ws && (state.ws.readyState === WebSocket.CONNECTING ||
                   state.ws.readyState === WebSocket.OPEN)) return;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host  = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
    ? '192.168.4.1' : location.host;
  state.wsUrl = `${proto}//${host}/ws`;

  let ws;
  try { ws = new WebSocket(state.wsUrl); }
  catch (e) { console.error('WS error', e); scheduleReconnect(); return; }

  ws.binaryType = 'arraybuffer';
  state.ws = ws;

  ws.onopen = () => {
    state.connected = true;
    backoff = 400;
    scheduleRender();
  };
  ws.onclose = () => {
    state.connected = false;
    state.ws = null;
    scheduleRender();
    scheduleReconnect();
  };
  ws.onerror = () => { /* close fires next */ };
  ws.onmessage = ev => {
    if (typeof ev.data === 'string') return;
    decodeFrame(ev.data);
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; startWs(); }, backoff);
  backoff = Math.min(backoff * 1.6, 3000);   // cap lower for snappier mobile recovery
}

// Reconnect immediately when the phone returns to the app or regains network —
// mobile browsers suspend sockets on lock/background, which showed as flapping.
function kick() {
  if (!state.ws || state.ws.readyState === WebSocket.CLOSED || state.ws.readyState === WebSocket.CLOSING) {
    backoff = 400;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    startWs();
  }
}
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') kick(); });
  window.addEventListener('online',  kick);
  window.addEventListener('focus',   kick);
  window.addEventListener('pageshow', kick);
}

function decodeFrame(buf) {
  const dv = new DataView(buf);
  if (dv.byteLength < 16) return;
  if (dv.getUint8(0) !== 0x01) return;

  const slot         = dv.getUint8(1);
  const n            = dv.getUint8(2);
  const rssi         = dv.getInt8(3);
  const seq          = dv.getUint32(4, true);
  const recvMs       = dv.getUint32(8, true);
  // const nodeUs    = dv.getUint32(12, true);

  if (dv.byteLength < 16 + n * 12) return;

  const samples = new Array(n);
  for (let i = 0; i < n; i++) {
    const off = 16 + i * 12;
    samples[i] = {
      ax: dv.getInt16(off,     true) / ACCEL_LSB_PER_G,
      ay: dv.getInt16(off + 2, true) / ACCEL_LSB_PER_G,
      az: dv.getInt16(off + 4, true) / ACCEL_LSB_PER_G,
      gx: dv.getInt16(off + 6, true) / GYRO_LSB_PER_DPS,
      gy: dv.getInt16(off + 8, true) / GYRO_LSB_PER_DPS,
      gz: dv.getInt16(off + 10, true) / GYRO_LSB_PER_DPS,
    };
    // AI training logger — no-op unless recording is armed.
    // `slot` (frame-level) tags which limb produced the sample.
    logSensorData(samples[i], slot);
  }

  pktCounter++;
  sampleCounter += n;
  lastPktAt = performance.now();

  ingestBatch({ slot, rssi, mac: null, samples, seq, recvMs: Date.now() });

  // rate counters (sliding 1 s)
  if (lastPktAt - lastRateAt >= 1000) {
    state.measuredHz   = sampleCounter;
    state.measuredKbps = ((pktCounter * (16 + n * 12)) * 8) / 1024;
    pktCounter = 0; sampleCounter = 0; lastRateAt = lastPktAt;
  }
}
