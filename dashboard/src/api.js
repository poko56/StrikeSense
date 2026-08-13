// Thin REST wrapper around Main Node API.
// All endpoints relative to current host; see rigorigin.js for the exception.

import { RIG_HTTP_BASE as BASE } from './rigorigin.js';

// The rig deliberately has a very small TLS socket budget: one phone needs a
// WSS stream and exactly one transient HTTPS request.  The ESP HTTPS server
// reserves three socket entries for itself, so a five-socket configuration has
// only two client slots.  Keep a single REST lane for the whole secure session;
// otherwise overlapping polls evict the live WSS connection and look like an
// OFFLINE/LIVE loop.  Plain-HTTP development keeps the original startup-only
// serialization so localhost testing stays responsive.
const IS_SECURE = typeof location !== 'undefined' && location.protocol === 'https:';
const KEEP_SECURE_REQUESTS_SERIAL = IS_SECURE;
let initialRequestGate = true;

// On HTTPS the whole lane starts CLOSED.  Only two TLS clients fit, and the
// live WSS stream has to claim one of them before REST claims the other: a page
// that sent its bootstrap reads first held the free slot continuously (the
// ~140 KB /api/model read alone can hold it for tens of seconds) and the WSS
// handshake was refused for as long as the tab stayed open — the dashboard sat
// on Offline with `ws=0` on the rig.  main.js opens the lane once WSS is up, or
// once its grace period expires so a rig without a stream still gets its data.
let openLane = null;
let requestTail = IS_SECURE ? new Promise(resolve => { openLane = resolve; }) : Promise.resolve();
const pendingReads = new Map();

/** Let queued REST run. Safe to call repeatedly; only the first call counts. */
export function openRequestLane() {
  const open = openLane;
  openLane = null;
  open?.();
  return requestTail;
}

// A request that never settles is worse than one that fails: it wedges the
// one-at-a-time lane until the browser's own socket timeout (minutes), and
// everything queued behind it — including the bootstrap hand-off — never runs.
// Every rig call therefore carries its own deadline.
const REQUEST_TIMEOUT_MS = 15000;
const MODEL_READ_TIMEOUT_MS = 60000;    // /api/model streams ~140 KB off SD through TLS
const MODEL_WRITE_TIMEOUT_MS = 120000;  // and an upload writes that back to the card

async function fetchText(url, opts = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ac.signal });
    // Read the body inside the same deadline. fetch() resolves at headers, so a
    // response that stops mid-transfer would otherwise stall unbounded.
    const text = await res.text();
    return { res, text };
  } finally {
    clearTimeout(timer);
  }
}

function queueRequest(run, readKey = '') {
  if (!initialRequestGate && !KEEP_SECURE_REQUESTS_SERIAL) return run();
  if (readKey && pendingReads.has(readKey)) return pendingReads.get(readKey);

  const queued = requestTail.then(run, run);
  // Keep the queue live after an unreachable rig/error response.
  requestTail = queued.catch(() => {});
  if (readKey) {
    pendingReads.set(readKey, queued);
    // Do not let a rejected read create an unhandled promise merely because we
    // are clearing the single-flight map.
    queued.then(
      () => { if (pendingReads.get(readKey) === queued) pendingReads.delete(readKey); },
      () => { if (pendingReads.get(readKey) === queued) pendingReads.delete(readKey); },
    );
  }
  return queued;
}

/** Release the startup gate; HTTPS retains its one-request lane afterwards. */
export function releaseInitialRequestGate() {
  initialRequestGate = false;
  return requestTail;
}

async function json(path, opts) {
  const url = BASE + path;
  const { timeoutMs = REQUEST_TIMEOUT_MS, ...fetchOpts } = opts || {};
  const method = String(fetchOpts.method || 'GET').toUpperCase();
  // Pollers frequently ask the same read before a weak AP has answered.  One
  // response is enough for every caller, and coalescing prevents a queue that
  // grows forever during a temporary radio stall.
  const readKey = method === 'GET' ? `${method} ${url}` : '';
  return queueRequest(async () => {
    // Keep the response body inside the startup lane. fetch() resolves at
    // headers, so releasing this before text() finishes would still overlap
    // TLS sockets on the small rig.
    const { res, text: t } = await fetchText(
      url, { headers: { 'content-type': 'application/json' }, ...fetchOpts }, timeoutMs);
    let body = null;
    try { body = t ? JSON.parse(t) : null; } catch { /* non-JSON error page */ }
    if (!res.ok) {
      // Carry the parsed payload on the error: a 409 from /api/session/start ships
      // the id of the run that is already going, and the caller adopts it.
      const err = new Error(body?.error || `${res.status} ${res.statusText}`);
      err.status = res.status;
      err.body   = body;
      throw err;
    }
    return body;
  }, readKey);
}

export const api = {
  status:        ()         => json('/api/status'),
  nodes:         ()         => json('/api/nodes'),
  assignSlot:    (mac,slot) => json('/api/nodes/assign', { method: 'POST', body: JSON.stringify({ mac, slot: Number(slot) }) }),
  nodeForget:    (mac)      => json('/api/nodes/forget', { method: 'POST', body: JSON.stringify({ mac }) }),

  // ── per-node recovery ──
  // identify  : blink the node's LED so you can tell which physical sensor it is
  // linkReset : re-register the ESP-NOW peer + clear stale seq bookkeeping —
  //             for "the node is online but no data arrives"
  // restart   : reboot the node's board over the air
  nodeIdentify:  (mac) => json('/api/nodes/identify',   { method: 'POST', body: JSON.stringify({ mac }) }),
  nodeLinkReset: (mac) => json('/api/nodes/link-reset', { method: 'POST', body: JSON.stringify({ mac }) }),
  nodeRestart:   (mac) => json('/api/nodes/restart',    { method: 'POST', body: JSON.stringify({ mac }) }),

  // ── dev-mode diagnostics ──
  logs: (since = 0) => json('/api/logs?since=' + (since | 0)),

  // ── main-node recovery ──
  radioRestart:  () => json('/api/system/radio-restart', { method: 'POST' }),
  systemReboot:  () => json('/api/system/reboot',        { method: 'POST' }),
  sessionStart:  (athlete)  => json('/api/session/start', { method: 'POST', body: JSON.stringify({ athlete }) }),
  sessionStop:   ()         => json('/api/session/stop',  { method: 'POST' }),
  sessions:      ()         => json('/api/sessions'),
  // The Main Node exposes these as query-string routes; the old /api/sessions/{id}
  // paths never matched a handler, so delete 404'd and download served nothing.
  sessionDelete: (id)       => json('/api/session/delete?id=' + encodeURIComponent(id), { method: 'DELETE' }),
  sessionDownloadUrl: (id)  => BASE + '/api/session/download?id=' + encodeURIComponent(id),

  // ── provisioning ──
  setupDone:     (done = true) => json('/api/setup/done', { method: 'POST', body: JSON.stringify({ done }) }),
  factoryReset:  (opts = {}) => json('/api/factory-reset', {
    method: 'POST',
    body: JSON.stringify({
      wipeSessions: !!opts.wipeSessions,
      wipeModel:    !!opts.wipeModel,
    }),
  }),

  // ── AI model persisted on the Main Node SD card ──
  // returns the parsed model, or null if none is stored (404)
  modelGet: () => queueRequest(async () => {
    const { res, text } = await fetchText(
      BASE + '/api/model', { cache: 'no-store' }, MODEL_READ_TIMEOUT_MS);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return text ? JSON.parse(text) : null;
  }, `GET ${BASE}/api/model`),
  // ── model library: many models on SD, one active ──
  modelsList:    () => json('/api/models'),                        // { active, models:[{name,size}] }
  modelUpload:   (jsonText, name) => json('/api/models?name=' + encodeURIComponent(name || 'model.json'), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: jsonText,
    timeoutMs: MODEL_WRITE_TIMEOUT_MS,
  }),
  modelActivate: (name) => json('/api/models/activate?name=' + encodeURIComponent(name), { method: 'POST' }),
  modelRemove:   (name) => json('/api/models?name=' + encodeURIComponent(name), { method: 'DELETE' }),
  modelDelete:   () => json('/api/model', { method: 'DELETE' }),   // deactivate (clear active, keep files)
};
