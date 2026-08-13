// Dev-mode diagnostic console.
//
// Pulls the Main Node's event ring (/api/logs) and merges it with events the
// browser itself sees (WebSocket lifecycle, poll failures), so one screen shows
// both halves of the system. Serial output only helps with a laptop attached —
// which is never the case when the rig misbehaves at the gym — so this is the
// same detail, readable on the phone that is already in the room.
//
// Only runs while dev mode is on: no polling, no DOM work otherwise.

import { state } from './state.js';

const MAX_ROWS = 400;

let api = null;
let rows = [];              // [{ seq, ms, cat, msg, src }]
let lastSeq = 0;
let timer = null;
let paused = false;
let filter = '';
let elList = null, elStat = null, elFilter = null, elPause = null, elCopy = null, elClear = null;
let localSeq = 0;
let bootMs = 0;             // rig uptime at the moment of the last poll, for drift info

/** Record something the browser noticed. Safe to call before init. */
export function logLocal(cat, msg) {
  rows.push({ seq: `L${++localSeq}`, ms: null, cat, msg, src: 'app' });
  if (rows.length > MAX_ROWS) rows.splice(0, rows.length - MAX_ROWS);
}

export function initDiagLog(activeApi) {
  api = activeApi;
  elList   = document.getElementById('diagList');
  elStat   = document.getElementById('diagStat');
  elFilter = document.getElementById('diagFilter');
  elPause  = document.getElementById('diagPause');
  elCopy   = document.getElementById('diagCopy');
  elClear  = document.getElementById('diagClear');
  if (!elList) return;

  elFilter?.addEventListener('input', e => { filter = e.target.value.toLowerCase(); render(); });
  elPause?.addEventListener('click', () => {
    paused = !paused;
    elPause.textContent = paused ? '▶ ต่อ' : '⏸ หยุด';
    elPause.classList.toggle('is-on', paused);
  });
  elClear?.addEventListener('click', () => { rows = []; render(); });
  elCopy?.addEventListener('click', async () => {
    const text = visibleRows().map(fmtRow).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      elCopy.textContent = '✓ คัดลอกแล้ว';
    } catch {
      // clipboard is blocked on plain-http origins in some browsers — fall back
      // to a selectable dump so the log can still be got off the phone
      elList.textContent = text;
      elCopy.textContent = '⚠ กดค้างเพื่อเลือก';
    }
    setTimeout(() => { elCopy.textContent = '⧉ คัดลอก'; }, 2500);
  });

  // Polling is started/stopped by setDiagLogEnabled() from the dev-mode toggle.
}

/** Called when dev mode flips — avoids polling the rig when nobody is looking. */
export function setDiagLogEnabled(on) {
  if (timer) { clearInterval(timer); timer = null; }
  if (!on) return;
  // The rig's own log stays out of reach on HTTPS. Every fetch there is a whole
  // TLS session out of a pool of two, and this one ran every 1.5 s — the last
  // poller left after status and nodes moved onto the socket. It was seen
  // holding a slot and answering `502 invalid legacy HTTP response`, which is
  // this rig's way of saying it had no memory left to build a reply, while the
  // live stream had nowhere to connect. Browser-side events still record here,
  // which is what this console is needed for while debugging the connection.
  if (location.protocol === 'https:') {
    logLocal('DIAG', 'บนโหมดปลอดภัย: แสดงเฉพาะเหตุการณ์ในเบราว์เซอร์ (ไม่ดึง log จากเครื่อง)');
    return;
  }
  poll();
  timer = setInterval(poll, 1500);
}

async function poll() {
  if (paused || !api?.logs) return;
  try {
    const res = await api.logs(lastSeq);
    bootMs = res?.uptimeMs ?? bootMs;
    for (const e of res?.entries || []) {
      rows.push({ seq: e.seq, ms: e.ms, cat: e.cat, msg: e.msg, src: 'rig' });
      if (e.seq > lastSeq) lastSeq = e.seq;
    }
    if (rows.length > MAX_ROWS) rows.splice(0, rows.length - MAX_ROWS);
    render();
  } catch (err) {
    // Don't spam a row per failed poll — one entry per transition is enough.
    const last = rows[rows.length - 1];
    if (!last || last.msg !== `ดึง log ไม่ได้: ${err.message}`) {
      logLocal('APP', `ดึง log ไม่ได้: ${err.message}`);
      render();
    }
  }
}

function visibleRows() {
  if (!filter) return rows;
  return rows.filter(r =>
    (r.cat || '').toLowerCase().includes(filter) ||
    (r.msg || '').toLowerCase().includes(filter));
}

function fmtT(ms) {
  if (ms == null) return '  —  ';
  const s = ms / 1000;
  return s < 600 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m${String(Math.floor(s % 60)).padStart(2, '0')}`;
}
function fmtRow(r) { return `${fmtT(r.ms)} [${r.cat}] ${r.msg}`; }

function render() {
  if (!elList) return;
  const v = visibleRows();
  if (elStat) {
    elStat.textContent = `${v.length}/${rows.length} รายการ · rig uptime ${fmtT(bootMs)}`
      + (paused ? ' · หยุดชั่วคราว' : '');
  }
  if (!v.length) {
    elList.innerHTML = '<div class="dim small">— ยังไม่มี log —</div>';
    return;
  }
  // newest first: what just happened is what you came to read
  elList.innerHTML = v.slice(-250).reverse().map(r => `
    <div class="diag-row diag-${(r.cat || '').toLowerCase()}${r.src === 'app' ? ' diag-app' : ''}">
      <span class="diag-t">${fmtT(r.ms)}</span>
      <span class="diag-cat">${escapeHtml(r.cat || '')}</span>
      <span class="diag-msg">${escapeHtml(r.msg || '')}</span>
    </div>`).join('');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
