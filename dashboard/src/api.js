// Thin REST wrapper around Main Node API.
// All endpoints relative to current host; on dev (localhost) we point at 192.168.4.1.

const BASE = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
  ? 'http://192.168.4.1'
  : '';

async function json(path, opts) {
  const url = BASE + path;
  const res = await fetch(url, { headers: { 'content-type': 'application/json' }, ...opts });
  const t = await res.text();
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
  modelGet: async () => {
    const res = await fetch(BASE + '/api/model', { cache: 'no-store' });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  },
  modelUpload: (jsonText) => json('/api/model', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: jsonText,
  }),
  modelDelete: () => json('/api/model', { method: 'DELETE' }),
};
