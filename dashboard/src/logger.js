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
//   90 = Move — the limb that is NOT throwing (footwork, stance switch, guard)
//   coarse weapon class = floor(label/10) - 1  (0..4)
// CSV columns: ax,ay,az,gx,gy,gz,slot,label   (slot 1=L-hand 2=R-hand 3=L-shin 4=R-shin)

import { state } from './state.js';
import { techTh } from './technames.js';

// ── คลังข้อมูลเทรน ───────────────────────────────────────────────────────────
// Takes accumulate here instead of each one being downloaded and thrown away.
//
// Collecting a usable dataset means many short takes across many techniques, and
// the old flow made every take a separate download that the coach then had to
// keep track of by filename. Worse, nothing on screen said which technique still
// needed work — the answer lived in the training script's output on a laptop.
// Holding the takes lets the panel answer "ยังขาดท่าไหน" while the athlete is
// still warm, and export the whole lot as ONE file for ml_pipeline/data/.
//
// Impacts, not rows, are what the model learns from, so that is what is counted:
// roughly 50 per technique is where accuracy stopped being noise (measured — see
// the per-technique table in ml_pipeline/tune_window.py output).
const TARGET_PER_TECHNIQUE = 50;

/** label -> { rows: string[][], impacts: number } */
const bank = new Map();

/** Rough impact count for a take: peaks over the detector's arm threshold. */
function countImpacts(rows) {
  // rows are [ax,ay,az,gx,gy,gz,slot,label] as strings, interleaved across slots.
  const bySlot = new Map();
  for (const r of rows) {
    const slot = r[6];
    if (!bySlot.has(slot)) bySlot.set(slot, []);
    bySlot.get(slot).push(Math.hypot(+r[0], +r[1], +r[2]));
  }
  let n = 0;
  for (const acc of bySlot.values()) {
    let armed = true;
    for (const a of acc) {
      const dyn = a - 1;
      if (armed && dyn >= 5.0) { n++; armed = false; }
      else if (!armed && dyn < 2.0) armed = true;
    }
  }
  return n;
}

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
// Non-strike limb movement. Same number as MOVE_LABEL in ml_pipeline/train_model.py.
const MOVE_LABEL  = '90';

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
  const n = bankTake();
  if (n) flashHint(`เก็บแล้ว ${n} ครั้ง — เลือกท่าถัดไปหรือกดส่งออกเมื่อพอ`);
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
  if (s < 1 || s > 4) return;                       // slot 0 = unassigned node

  // The striking limb carries the technique label. The OTHER limb is recorded as
  // MOVE — it is not idle, it is stepping, switching stance and carrying weight
  // while the technique is thrown, and that motion is exactly what the model was
  // previously forced to call a kick because it had no other class for it. Do NOT
  // go back to dropping these rows: without them "leg moved but did not kick" has
  // no name in the training set, and the nearest kick wins by default.
  const rowLabel = requiredSides(label).includes(s) ? label : MOVE_LABEL;

  recordedData.push([
    sample.ax.toFixed(4), sample.ay.toFixed(4), sample.az.toFixed(4),
    sample.gx.toFixed(3), sample.gy.toFixed(3), sample.gz.toFixed(3),
    s, rowLabel,
  ]);

  if (elCount) elCount.textContent = recordedData.length;
  if (elTime)  elTime.textContent  = ((performance.now() - startedAt) / 1000).toFixed(1) + 's';
  if (elLimb)  elLimb.textContent  = SLOT_SHORT[s] || '—';
}

/** Move the finished take into the bank, keyed by the technique it was recorded for. */
function bankTake() {
  if (!recordedData.length) return 0;
  const label = selLabel ? selLabel.value : '41';
  // The take also carries Move rows for the limb that was not throwing; they
  // belong to the Move class, not to the technique.
  const byLabel = new Map();
  for (const r of recordedData) {
    const k = r[7];
    if (!byLabel.has(k)) byLabel.set(k, []);
    byLabel.get(k).push(r);
  }
  let added = 0;
  for (const [k, rows] of byLabel) {
    let e = bank.get(k);
    if (!e) { e = { rows: [], impacts: 0 }; bank.set(k, e); }
    e.rows.push(...rows);
    const n = countImpacts(rows);
    e.impacts += n;
    if (k === label) added = n;
  }
  recordedData = [];
  if (elCount) { elCount.textContent = '0'; elCount.classList.remove('hot'); }
  if (elTime)  elTime.textContent = '0.0s';
  if (elLimb)  elLimb.textContent = '—';
  renderBank();
  return added;
}

/** Everything collected so far, as one file the training script reads directly. */
function exportToCSV() {
  bankTake();                       // never leave the last take behind
  const total = [...bank.values()].reduce((n, e) => n + e.rows.length, 0);
  if (!total) { flashHint('ยังไม่มีข้อมูล — กดเริ่มบันทึกแล้วออกอาวุธก่อน'); return; }

  const parts = ['ax,ay,az,gx,gy,gz,slot,label\n'];
  for (const e of bank.values()) for (const row of e.rows) parts.push(row.join(',') + '\n');

  const blob = new Blob(parts, { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  // One file per collection run. train_model.py globs ./data/*.csv, so dropping
  // this in beside the existing takes is the whole install step.
  link.download = `strike_all_${Date.now()}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
  flashHint('บันทึกไฟล์แล้ว — วางไว้ใน ml_pipeline/data/ แล้วเทรนใหม่');
}

/** What has been collected, and what is still short of a usable amount. */
function renderBank() {
  const host = document.getElementById('trainBank');
  if (!host) return;
  const entries = [...bank.entries()].sort((a, b) => b[1].impacts - a[1].impacts);
  if (!entries.length) {
    host.innerHTML = '<div class="dim small">ยังไม่ได้เก็บอะไร — เลือกท่า กดเริ่มบันทึก ออกอาวุธ แล้วกดหยุด</div>';
    return;
  }
  const nameOf = (k) => k === MOVE_LABEL ? 'ขยับตัว (ไม่ได้ออกอาวุธ)'
                                         : techTh(FINE_TH[k] || ('label ' + k));
  host.innerHTML = entries.map(([k, e]) => {
    const pct = Math.min(100, e.impacts / TARGET_PER_TECHNIQUE * 100);
    const done = e.impacts >= TARGET_PER_TECHNIQUE;
    return `<div class="train-row${done ? ' done' : ''}">
        <span class="train-name">${nameOf(k)}</span>
        <span class="train-bar"><i style="width:${pct.toFixed(0)}%"></i></span>
        <span class="train-n mono">${e.impacts}${done ? '' : '/' + TARGET_PER_TECHNIQUE}</span>
      </div>`;
  }).join('')
  + `<div class="dim small" style="margin-top:8px">รวม ${
      entries.reduce((n, [, e]) => n + e.impacts, 0)} ครั้ง · ${
      ([...bank.values()].reduce((n, e) => n + e.rows.length, 0) / 1000).toFixed(0)}k แถว</div>`;
}

// label id → the English name train_model.py uses, so technames.js can translate.
const FINE_TH = {
  '10': 'Jab', '11': 'Cross', '12': 'Hook', '13': 'Uppercut',
  '20': 'Elbow-Chop', '21': 'Elbow-Slash', '22': 'Elbow-Up',
  '23': 'Elbow-Thrust', '24': 'Elbow-Spear', '25': 'Elbow-Spin',
  '30': 'Knee-Straight', '31': 'Knee-Diagonal', '32': 'Knee-Curve', '33': 'Knee-Fly',
  '40': 'Kick-Straight', '41': 'Roundhouse', '42': 'Kick-Low',
  '43': 'Kick-Spin', '44': 'Kick-Heel',
  '50': 'Teep', '51': 'Teep-Side', '52': 'Teep-Back',
};
