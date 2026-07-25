// ──────────────────────────────────────────────────────────────────
// AI gesture model — in-browser 1D-CNN inference (no TensorFlow.js).
//
// The user trains a model with ml_pipeline/train_model.py, which emits
// `strike_web_model.json` (architecture + weights + normalisation stats).
// They upload that file here; we replay the network in plain JS on the
// live IMU stream so gesture detection runs fully offline, and the model
// file never has to be baked into firmware.
//
// Data flow:
//   ws.js       -> aiPushSample(slot, rawSample)   per decoded IMU sample (400 Hz, RAW — matches training CSV)
//   analyzer.js -> aiOnStrike(slot)                on each detected strike → classify the recent window
//   main.js     -> initAiModel() / subscribe(renderAiModel)
//
// Supported layers (matches build_model() in train_model.py):
//   conv1d · batch_normalization · max_pooling1d · global_average_pooling1d ·
//   flatten · dense · dropout(skip) · activation
// ──────────────────────────────────────────────────────────────────

import { state } from './state.js';
import { persist } from './persist.js';
import { parseModel, forward } from './ainet.js';

const LS_KEY   = 'strikesense.aiModel';   // localStorage: last uploaded model (survives reload)
const RING_CAP = 128;                      // raw samples kept per slot (≥ time_steps)
const MIN_CONF = 0.35;                      // below this we still show, but flag as uncertain

let net  = null;   // parsed model (from ainet.parseModel): { timeSteps, features, labels, mean, std, layers[], meta }

// cached DOM
let elFile, elClear, elStatus, elEnable, elBig, elConf, elProbs, elRecent;

// ───────────────────────── live buffers ─────────────────────────
function ring(slot) {
  let r = state.ai.rawBySlot.get(slot);
  if (!r) {
    r = { buf: new Float32Array(RING_CAP * (net ? net.features : 6)), idx: 0, count: 0 };
    state.ai.rawBySlot.set(slot, r);
  }
  return r;
}

/** Hot path (≤1600/s): store one RAW 6-axis sample for a slot. */
export function aiPushSample(slot, s) {
  if (!net || slot < 1 || slot > 4) return;
  const F = net.features;
  const r = ring(slot);
  const base = r.idx * F;
  r.buf[base]     = s.ax; r.buf[base + 1] = s.ay; r.buf[base + 2] = s.az;
  r.buf[base + 3] = s.gx; r.buf[base + 4] = s.gy; r.buf[base + 5] = s.gz;
  r.idx = (r.idx + 1) % RING_CAP;
  if (r.count < RING_CAP) r.count++;
}

/** Build the most-recent T×F window for a slot, standardised, or null if not enough data. */
function windowFor(slot) {
  const r = state.ai.rawBySlot.get(slot);
  const T = net.timeSteps, F = net.features;
  if (!r || r.count < T) return null;
  const win = new Float32Array(T * F);
  // oldest of the last T samples starts here in the ring
  let p = (r.idx - T + RING_CAP) % RING_CAP;
  for (let t = 0; t < T; t++) {
    const src = p * F, dst = t * F;
    for (let c = 0; c < F; c++) win[dst + c] = (r.buf[src + c] - net.mean[c]) / net.std[c];
    p = (p + 1) % RING_CAP;
  }
  return win;
}

/** Called on each detected strike. Classifies the recent window for `slot`.
 *  Returns { label, conf } or null. Also updates state.ai for the UI. */
export function aiOnStrike(slot) {
  if (!net || !state.ai.enabled) return null;
  const win = windowFor(slot);
  if (!win) return null;

  const probs = forward(net, win);
  let best = 0;
  for (let i = 1; i < probs.length; i++) if (probs[i] > probs[best]) best = i;
  const label = net.labels[best];
  const conf  = probs[best];

  const rec = { slot, label, conf, at: Date.now(), probs: Array.from(probs) };
  state.ai.last = rec;
  state.ai.history.unshift({ slot, label, conf, at: rec.at });
  if (state.ai.history.length > 12) state.ai.history.length = 12;
  return { label, conf };
}

// ───────────────────────── model load / clear ─────────────────────────
function activate(doc, { save = true } = {}) {
  net = parseModel(doc);
  state.ai.ready = true;
  state.ai.meta  = net.meta;
  state.ai.error = '';
  state.ai.rawBySlot.clear();   // feature count may have changed
  if (save) { try { persist.set(LS_KEY, doc); } catch (e) { /* quota — keep in memory */ } }
}

function clearModel() {
  net = null;
  state.ai.ready = false;
  state.ai.enabled = false;
  state.ai.meta = null;
  state.ai.last = null;
  state.ai.error = '';
  state.ai.history.length = 0;
  state.ai.rawBySlot.clear();
  try { persist.set(LS_KEY, null); } catch (e) {}
}

function handleFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const doc = JSON.parse(reader.result);
      activate(doc);
      state.ai.enabled = true;   // auto-enable on successful upload
    } catch (e) {
      state.ai.ready = false;
      state.ai.meta = null;
      state.ai.error = e.message || 'อ่านไฟล์ไม่สำเร็จ';
    }
    renderAiModel();
  };
  reader.onerror = () => { state.ai.error = 'อ่านไฟล์ไม่สำเร็จ'; renderAiModel(); };
  reader.readAsText(file);
}

// ───────────────────────── UI ─────────────────────────
export function initAiModel() {
  elFile   = document.getElementById('aiModelFile');
  elClear  = document.getElementById('aiModelClear');
  elStatus = document.getElementById('aiModelStatus');
  elEnable = document.getElementById('aiEnableToggle');
  elBig    = document.getElementById('aiLastLabel');
  elConf   = document.getElementById('aiLastConf');
  elProbs  = document.getElementById('aiProbs');
  elRecent = document.getElementById('aiRecent');
  if (!elFile) return;   // panel absent → no-op

  elFile.addEventListener('change', e => {
    const f = e.target.files && e.target.files[0];
    if (f) handleFile(f);
    e.target.value = '';   // allow re-selecting the same file
  });
  elClear?.addEventListener('click', () => { clearModel(); renderAiModel(); });
  elEnable?.addEventListener('change', e => {
    state.ai.enabled = e.target.checked && state.ai.ready;
    renderAiModel();
  });

  // restore a previously uploaded model
  const saved = persist.get(LS_KEY, null);
  if (saved) { try { activate(saved, { save: false }); } catch (e) { state.ai.error = e.message; } }
  renderAiModel();
}

const SLOT_TAG = ['—', 'L-HAND', 'R-HAND', 'L-SHIN', 'R-SHIN'];

export function renderAiModel() {
  if (!elStatus) return;
  const ai = state.ai;

  if (ai.error) {
    elStatus.textContent = '⚠ ' + ai.error;
    elStatus.className = 'ai-status err';
  } else if (ai.ready) {
    const m = ai.meta;
    elStatus.textContent = `พร้อม · ${m.labels.length} ท่า · หน้าต่าง ${m.time_steps}×${m.features} · โหมด ${m.label_mode}`;
    elStatus.className = 'ai-status ok';
  } else {
    elStatus.textContent = 'ยังไม่ได้โหลดโมเดล — อัปโหลด strike_web_model.json';
    elStatus.className = 'ai-status';
  }

  if (elEnable) { elEnable.checked = ai.enabled; elEnable.disabled = !ai.ready; }
  if (elClear)  elClear.disabled = !ai.ready;

  const last = ai.last;
  if (elBig)  elBig.textContent  = last ? last.label : '—';
  if (elConf) elConf.textContent = last ? `${(last.conf * 100).toFixed(0)}% · ${SLOT_TAG[last.slot] || ''}` : '';
  if (elBig)  elBig.classList.toggle('uncertain', !!last && last.conf < MIN_CONF);

  // probability bars for the last detection
  if (elProbs) {
    if (last && ai.meta) {
      elProbs.innerHTML = ai.meta.labels.map((name, i) => {
        const p = last.probs[i] || 0;
        return `<div class="ai-prob-row"><span class="ai-prob-name">${name}</span>`
             + `<span class="ai-prob-bar"><i style="width:${(p * 100).toFixed(0)}%"></i></span>`
             + `<span class="ai-prob-pct mono">${(p * 100).toFixed(0)}</span></div>`;
      }).join('');
    } else {
      elProbs.innerHTML = '';
    }
  }

  if (elRecent) {
    elRecent.innerHTML = ai.history.map(h =>
      `<span class="ai-chip"><b>${h.label}</b> ${(h.conf * 100).toFixed(0)}%</span>`
    ).join('');
  }
}
