// ──────────────────────────────────────────────────────────────────
// AI gesture model — in-browser 1D-CNN inference (no TensorFlow.js).
//
// The user trains a model with ml_pipeline/train_model.py, which emits
// `strike_web_model.json` (architecture + weights + normalisation stats).
// They upload that file here; we replay the network in plain JS on the
// live IMU stream so gesture detection runs fully offline, and the model
// file never has to be baked into firmware.
//
// Persistence: on upload the model is POSTed to the Main Node and stored on the
// SD card (/api/model). Any phone that connects afterwards auto-loads it from SD,
// so you upload once per rig, not once per device. localStorage is a local cache
// fallback. No model → detection still shows live G/values, just no gesture label.
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
import { api } from './api.js';

const isDemo = () => new URLSearchParams(location.search).get('demo') === '1';

const LS_KEY   = 'strikesense.aiModel';   // localStorage: last uploaded model (survives reload)
const RING_CAP = 128;                      // raw samples kept per slot (≥ time_steps)
const MIN_CONF = 0.35;                      // below this we still show, but flag as uncertain

let net  = null;   // parsed model (from ainet.parseModel): { timeSteps, features, labels, mean, std, layers[], meta }

// cached DOM
let elFile, elClear, elStatus, elEnable, elBig, elConf, elProbs, elRecent, elList;

// model library on the rig's SD card: many files, one active
let library = { active: '', models: [] };

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
function activate(doc) {
  net = parseModel(doc);           // throws on bad model → caller handles
  state.ai.ready = true;
  state.ai.meta  = net.meta;
  state.ai.error = '';
  state.ai.rawBySlot.clear();      // feature count may have changed
  try { persist.set(LS_KEY, doc); } catch (e) { /* quota — SD is the source of truth */ }
}

function clearModel() {
  net = null;
  state.ai.ready = false;
  state.ai.enabled = false;
  state.ai.meta = null;
  state.ai.last = null;
  state.ai.error = '';
  state.ai.source = '';
  state.ai.history.length = 0;
  state.ai.rawBySlot.clear();
  try { persist.set(LS_KEY, null); } catch (e) {}
  if (!isDemo()) api.modelDelete().catch(() => { /* device offline — local clear is enough */ });
}

// Load a freshly uploaded file: parse → enable → push to the Main Node SD card.
function handleFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    let doc;
    try {
      doc = JSON.parse(reader.result);
      activate(doc);
    } catch (e) {
      state.ai.ready = false; state.ai.meta = null;
      state.ai.error = e.message || 'อ่านไฟล์ไม่สำเร็จ';
      renderAiModel();
      return;
    }
    state.ai.enabled = true;         // auto-enable on successful upload
    state.ai.source  = 'local';

    if (!isDemo()) {                 // save into the rig's SD card library
      state.ai.saving = true;
      state.ai.error  = '';
      renderAiModel();
      api.modelUpload(JSON.stringify(doc), file.name)   // filename → library entry
        .then(() => { state.ai.source = 'sd'; return refreshLibrary(); })
        .catch(() => { state.ai.error = '⚠ บันทึกลง SD ไม่สำเร็จ — ใช้ได้เฉพาะเครื่องนี้'; })
        .finally(() => { state.ai.saving = false; renderAiModel(); });
    } else {
      renderAiModel();
    }
  };
  reader.onerror = () => { state.ai.error = 'อ่านไฟล์ไม่สำเร็จ'; renderAiModel(); };
  reader.readAsText(file);
}

// Startup: prefer the model stored on the rig's SD card so any device gets it;
// fall back to this browser's local cache when the device has none / is offline.
async function loadInitialModel() {
  if (!isDemo()) {
    try {
      const doc = await api.modelGet();
      if (doc) { activate(doc); state.ai.source = 'sd'; renderAiModel(); return; }
    } catch (e) { /* device unreachable → try local cache below */ }
  }
  const saved = persist.get(LS_KEY, null);
  if (saved) {
    try { activate(saved); state.ai.source = 'local'; }
    catch (e) { state.ai.error = e.message; }
  }
  renderAiModel();
}

// ───────────────────────── model library (SD) ─────────────────────────
function fmtSize(n) {
  return n >= 1024 ? (n / 1024).toFixed(0) + ' KB' : (n | 0) + ' B';
}

// Pull the list of models on the rig's SD card + which one is active.
async function refreshLibrary() {
  if (isDemo()) { library = { active: '', models: [] }; renderModelList(); return; }
  try {
    const r = await api.modelsList();
    library = {
      active: (r && r.active) || '',
      models: (r && Array.isArray(r.models)) ? r.models : [],
    };
  } catch (e) {
    library = { active: '', models: [] };   // device offline → empty list
  }
  renderModelList();
}

// Make `name` the active model on the rig, then load it for inference.
async function selectModel(name) {
  if (isDemo() || !name || name === library.active) return;
  try {
    await api.modelActivate(name);
    const doc = await api.modelGet();
    if (doc) { activate(doc); state.ai.source = 'sd'; state.ai.enabled = true; }
    library.active = name;
    state.ai.error = '';
  } catch (e) {
    state.ai.error = 'สลับโมเดลไม่สำเร็จ';
  }
  renderAiModel();
}

// Remove `name` from the library. If it was active, adopt whatever the device
// promoted next (or clear inference if the library is now empty).
async function deleteModel(name) {
  if (isDemo() || !name) return;
  const wasActive = name === library.active;
  try { await api.modelRemove(name); } catch (e) { /* refresh below reflects truth */ }
  await refreshLibrary();
  if (wasActive) {
    if (library.active) {
      try { const doc = await api.modelGet(); if (doc) { activate(doc); state.ai.source = 'sd'; } }
      catch (e) { /* leave as-is */ }
    } else {
      net = null;
      state.ai.ready = false; state.ai.enabled = false; state.ai.meta = null; state.ai.last = null;
    }
  }
  renderAiModel();
}

function renderModelList() {
  if (!elList) return;
  const models = library.models;
  if (!models.length) {
    elList.innerHTML = '<div class="ai-models-empty">คลังว่าง — กด “เพิ่มไฟล์โมเดล” เพื่ออัปโหลด</div>';
    return;
  }
  elList.innerHTML = models.map(m => {
    const active = m.name === library.active;
    return `<div class="ai-model-row${active ? ' active' : ''}" data-name="${m.name}" role="button" tabindex="0" title="กดเพื่อเลือกใช้">`
         + `<span class="ai-model-dot"></span>`
         + `<span class="ai-model-name">${m.name}</span>`
         + `<span class="ai-model-size mono">${fmtSize(m.size || 0)}</span>`
         + (active ? `<span class="ai-model-badge">ใช้อยู่</span>` : '')
         + `<button class="ai-model-del" data-del="${m.name}" title="ลบไฟล์นี้">🗑</button>`
         + `</div>`;
  }).join('');
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
  elList   = document.getElementById('aiModelList');
  if (!elFile) return;   // panel absent → no-op

  elFile.addEventListener('change', e => {
    const f = e.target.files && e.target.files[0];
    if (f) handleFile(f);
    e.target.value = '';   // allow re-selecting the same file
  });
  elClear?.addEventListener('click', async () => { clearModel(); await refreshLibrary(); renderAiModel(); });
  elEnable?.addEventListener('change', e => {
    state.ai.enabled = e.target.checked && state.ai.ready;
    renderAiModel();
  });

  // model library: click a row to select · trash icon to delete
  elList?.addEventListener('click', e => {
    const del = e.target.closest('.ai-model-del');
    if (del) { e.stopPropagation(); deleteModel(del.dataset.del); return; }
    const row = e.target.closest('.ai-model-row');
    if (row) selectModel(row.dataset.name);
  });

  // restore from SD card (preferred) or this browser's local cache
  loadInitialModel();
  refreshLibrary();
}

const SLOT_TAG = ['—', 'L-HAND', 'R-HAND', 'L-SHIN', 'R-SHIN'];

export function renderAiModel() {
  if (!elStatus) return;
  const ai = state.ai;
  renderModelList();   // keep the library list in sync with active/upload/delete

  if (ai.saving) {
    elStatus.textContent = '⏳ กำลังบันทึกโมเดลลง SD card…';
    elStatus.className = 'ai-status';
  } else if (ai.error) {
    elStatus.textContent = '⚠ ' + ai.error;
    elStatus.className = 'ai-status err';
  } else if (ai.ready) {
    const m = ai.meta;
    const where = ai.source === 'sd' ? 'SD card' : ai.source === 'local' ? 'เครื่องนี้' : '';
    elStatus.textContent = `พร้อม · ${m.labels.length} ท่า · หน้าต่าง ${m.time_steps}×${m.features}`
                         + (where ? ` · เก็บที่ ${where}` : '');
    elStatus.className = 'ai-status ok';
  } else {
    elStatus.textContent = 'ยังไม่ได้โหลดโมเดล — ตรวจจับแรง G ได้ แต่ยังแยกท่าไม่ได้';
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
