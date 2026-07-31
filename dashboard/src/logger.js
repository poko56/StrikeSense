// AI Training Data Logger (developer mode) — capture the live WebSocket IMU
// stream, tag each sample with a fine-grained Muay Thai strike label + the
// striking limb (slot → left/right), and export a clean CSV for the pipeline.
//
// Safety guards (ผู้ใช้ขอ):
//   • ห้าม record ถ้าไม่ได้เชื่อมต่ออุปกรณ์
//   • ต้องมีโหนดของอวัยวะที่จะเก็บ (มือ/แข้ง) ออนไลน์ — และเลือกได้ว่าต้องครบซ้าย-ขวา
//   • auto-stop ถ้าอุปกรณ์หลุดระหว่างบันทึก
//
// Wiring:
//   main.js -> initLogger()               bind panel once
//   main.js -> subscribe(renderLogger)     live node-status + guard state
//   ws.js   -> logSensorData(sample,slot)  per decoded IMU sample @400 Hz
//
// Label encoding (tens-scheme, matches index.html <optgroup> + ml_pipeline):
//   10-13 หมัด · 20-25 ศอก · 30-33 เข่า · 40-44 เตะ · 50-52 ถีบ
//   coarse weapon class = floor(label/10) - 1  (0..4)
// CSV columns: ax,ay,az,gx,gy,gz,slot,label   (slot 1=L-hand 2=R-hand 3=L-shin 4=R-shin)

import { state } from './state.js';

let isRecording = false;
let recordedData = [];
let startedAt = 0;

// cached DOM refs
let btnToggle = null, btnLabel = null, btnExport = null, elHint = null;
let selLabel = null, chkBoth = null;
let elCount = null, elTime = null, elLimb = null;
const chips = {};   // slot -> chip element

const SLOT_NAMES  = ['—', 'มือซ้าย', 'มือขวา', 'แข้งซ้าย', 'แข้งขวา'];
const SLOT_SHORT  = ['—', 'L-HAND', 'R-HAND', 'L-SHIN', 'R-SHIN'];
const NODE_STALE_MS = 3000;

export function initLogger() {
  btnToggle = document.getElementById('btnRecordToggle');
  btnLabel  = document.getElementById('btnRecordLabel');
  btnExport = document.getElementById('btnExportCSV');
  elHint    = document.getElementById('loggerGuardHint');
  selLabel  = document.getElementById('strikeLabel');
  chkBoth   = document.getElementById('loggerRequireBoth');
  elCount   = document.getElementById('recordCount');
  elTime    = document.getElementById('recordTime');
  elLimb    = document.getElementById('recordLimb');
  for (let s = 1; s <= 4; s++) chips[s] = document.getElementById('nodeChip-' + s);

  if (!btnToggle || !btnExport) return;   // panel absent → no-op

  btnToggle.addEventListener('click', toggleRecording);
  btnExport.addEventListener('click', exportToCSV);
  // re-evaluate guard immediately when the strike (→ required limb) changes
  selLabel?.addEventListener('change', renderLogger);
}

// ── live-node helpers ──
function liveSlots() {
  const live = new Set();
  for (const n of state.nodes || [])
    if (n.slot >= 1 && n.slot <= 4 && (n.ageMs || 0) < NODE_STALE_MS) live.add(n.slot);
  return live;
}
// hand strikes (punch/elbow) → slots 1,2 · leg strikes (knee/kick/teep) → 3,4
function requiredSides(label) {
  const grp = Math.floor(Number(label) / 10);
  return (grp === 1 || grp === 2) ? [1, 2] : [3, 4];
}

function canRecord() {
  if (!state.connected) return { ok: false, reason: '⚠ ยังไม่เชื่อมต่ออุปกรณ์ — เชื่อมต่อก่อนบันทึก' };
  const need = requiredSides(selLabel ? selLabel.value : '41');
  const live = liveSlots();
  const have = need.filter(s => live.has(s));
  const limb = need[0] === 1 ? 'มือ' : 'แข้ง';
  if (have.length === 0)
    return { ok: false, reason: `⚠ ไม่พบโหนด${limb} — เปิดโหนดที่${limb}ก่อนบันทึก` };
  if (chkBoth?.checked && have.length < 2) {
    const missing = need.filter(s => !live.has(s)).map(s => SLOT_NAMES[s]).join(', ');
    return { ok: false, reason: `⚠ ต้องครบซ้าย-ขวา เพื่อแยกข้าง (ขาด: ${missing})` };
  }
  return { ok: true, reason: '' };
}

function toggleRecording() {
  if (!isRecording) {
    const g = canRecord();
    if (!g.ok) { flashHint(g.reason); return; }   // guard: block start
    isRecording = true;
    startedAt = performance.now();
    btnToggle.classList.add('is-recording');
    if (btnLabel) btnLabel.textContent = 'หยุดบันทึก';
    if (elCount) elCount.classList.add('hot');
  } else {
    stopRecording();
  }
}

function stopRecording() {
  isRecording = false;
  btnToggle.classList.remove('is-recording');
  if (btnLabel) btnLabel.textContent = 'เริ่มบันทึก';
  if (elCount) elCount.classList.remove('hot');
}

function flashHint(msg) {
  if (!elHint) return;
  elHint.textContent = msg;
  elHint.classList.add('show');
  clearTimeout(flashHint._t);
  flashHint._t = setTimeout(() => elHint.classList.remove('show'), 4000);
}

// ── live render (subscribed) — node chips + guard/button state ──
export function renderLogger() {
  if (!btnToggle || !state.ui.devMode) return;   // panel hidden → skip work

  // auto-stop if the link dropped mid-recording
  if (isRecording && !canRecord().ok && !state.connected) {
    stopRecording();
    flashHint('■ หยุดอัตโนมัติ — อุปกรณ์หลุดการเชื่อมต่อ');
  }

  const live = liveSlots();
  const need = new Set(requiredSides(selLabel ? selLabel.value : '41'));
  for (let s = 1; s <= 4; s++) {
    const c = chips[s];
    if (!c) continue;
    c.classList.toggle('live', live.has(s));
    c.classList.toggle('req', need.has(s));      // highlight the pair we need now
  }

  // reflect guard on the record button (only while idle — don't fight an active take)
  if (!isRecording) {
    const g = canRecord();
    btnToggle.classList.toggle('is-blocked', !g.ok);
    if (elHint) elHint.textContent = g.ok ? '' : g.reason;
    if (elHint) elHint.classList.toggle('show', !g.ok);
  }
}

// ── data capture (hot path, 400 Hz) ──
export function logSensorData(sample, slot) {
  if (!isRecording) return;
  const label = selLabel ? selLabel.value : '41';
  const s = (slot | 0);

  // Only capture the limb(s) that belong to this technique. Recording a kick
  // must not also log idle-hand samples (or slot 0) mislabelled as "kick" —
  // that pollutes the training set and hurts model accuracy.
  if (!requiredSides(label).includes(s)) return;

  recordedData.push([
    sample.ax.toFixed(4), sample.ay.toFixed(4), sample.az.toFixed(4),
    sample.gx.toFixed(3), sample.gy.toFixed(3), sample.gz.toFixed(3),
    s, label,
  ]);

  if (elCount) elCount.textContent = recordedData.length;
  if (elTime)  elTime.textContent  = ((performance.now() - startedAt) / 1000).toFixed(1) + 's';
  if (elLimb)  elLimb.textContent  = SLOT_SHORT[s] || '—';
}

function exportToCSV() {
  if (recordedData.length === 0) { flashHint('ยังไม่มีข้อมูล — กดเริ่มบันทึกแล้วออกอาวุธก่อน'); return; }

  let csv = 'ax,ay,az,gx,gy,gz,slot,label\n';
  for (const row of recordedData) csv += row.join(',') + '\n';

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const link = document.createElement('a');
  const label = selLabel ? selLabel.value : 'x';
  link.href = url;
  link.download = `strike_${label}_${Date.now()}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);

  recordedData = [];
  if (elCount) { elCount.textContent = '0'; elCount.classList.remove('hot'); }
  if (elTime)  elTime.textContent = '0.0s';
  if (elLimb)  elLimb.textContent = '—';
}
