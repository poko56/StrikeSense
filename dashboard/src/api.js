// Thin REST wrapper around Main Node API.
// All endpoints relative to current host; on dev (localhost) we point at 192.168.4.1.

const BASE = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
  ? 'http://192.168.4.1'
  : '';

async function json(path, opts) {
  const url = BASE + path;
  const res = await fetch(url, { headers: { 'content-type': 'application/json' }, ...opts });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const t = await res.text();
  return t ? JSON.parse(t) : null;
}

export const api = {
  status:        ()         => json('/api/status'),
  nodes:         ()         => json('/api/nodes'),
  assignSlot:    (mac,slot) => json('/api/nodes/assign', { method: 'POST', body: JSON.stringify({ mac, slot: Number(slot) }) }),
  sessionStart:  (athlete)  => json('/api/session/start', { method: 'POST', body: JSON.stringify({ athlete }) }),
  sessionStop:   ()         => json('/api/session/stop',  { method: 'POST' }),
  sessions:      ()         => json('/api/sessions'),
  sessionDelete: (id)       => json('/api/sessions/' + encodeURIComponent(id), { method: 'DELETE' }),
  sessionDownloadUrl: (id)  => BASE + '/api/sessions/' + encodeURIComponent(id),
};
