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
import { persist, PERSIST_KEYS } from './persist.js';
import { parseModel, forward } from './ainet.js';
import { api } from './api.js';
import { normalizeDetect } from './detector.js';
import { bestAllowedIndex, IDLE_LABEL, MOVE_LABEL } from './limbs.js';
import { fusePhysics, windowPhysics } from './physics.js';

const isDemo = () => new URLSearchParams(location.search).get('demo') === '1';

const LS_KEY   = 'strikesense.aiModel';   // localStorage: last uploaded model (survives reload)
// Raw samples kept per slot. Must comfortably exceed time_steps PLUS the longest
// rewind the detector can ask for (its search runs past the trigger to find the
// true peak), or windowFor() silently returns null and gesture naming stops with
// nothing in the log to say why. Sized from the loaded model, not a constant, so
// raising searchMs cannot quietly break inference.
const RING_MARGIN = 128;
let ringCap = 50 + RING_MARGIN;
// IDLE_LABEL / MOVE_LABEL come from limbs.js and match IDLE_NAME / MOVE_NAME in
// ml_pipeline/train_model.py — a model trained without one of those classes
// simply never emits it, so older model files keep working unchanged.
const MIN_CONF = 0.35;                      // below this we still show, but flag as uncertain

/** Most likely label the firing limb could physically have produced; see limbs.js. */
function bestAllowed(probs, slot) {
  return bestAllowedIndex(probs, net.labels, net.limbs, slot);
}

/**
 * Decide what one impact is called.
 *
 * Two separate things can make the answer "ไม่ระบุ", and they are not the same
 * kind of doubt:
 *
 *   Idle / Move   the model says this window was not a technique at all. The
 *                 detector can fire on a dropped glove, the sensor being
 *                 adjusted, a hard foot plant — this class is what stops those
 *                 being logged as jabs, and it stays in force always.
 *   below min_conf  the impact was real, the model just cannot say which
 *                 technique. `state.ai.alwaysName` drops this floor.
 *
 * Measured on the held-out split with the shipped model (675 real strikes,
 * 1422 still windows):
 *
 *   floor on          names 545/675 · 87.3% right → 476 strikes named correctly
 *   floor off         names 668/675 · 80.4% right → 537 strikes named correctly
 *   floor off + Idle  names 675/675 · 80.1% right → 541, but every one of the
 *   dropped too                                     1422 still windows also gets
 *                                                   handed a technique name
 *
 * So dropping the floor names MORE strikes correctly, not fewer — the accuracy
 * per name falls but coverage more than makes up for it. Dropping the Idle guard
 * as well buys four more strikes and costs the whole safety net, which is why it
 * is not offered.
 *
 * @returns {{best:number, label:string|null, conf:number, idle:boolean, unsure:boolean}}
 */
function decide(probs, slot) {
  const best = bestAllowed(probs, slot);

  // Nothing this limb can throw exists in the model — a shin impact on a
  // punches-only model. Naming it would invent a technique, so it stays unnamed
  // even when the coach asked for no abstentions.
  if (best < 0) return { best: -1, label: null, conf: 0, idle: false, unsure: true };

  const name = net.labels[best];
  const idle = name === IDLE_LABEL || name === MOVE_LABEL;
  const unsure = !state.ai.alwaysName && probs[best] < minConf();
  return {
    best,
    label: (idle || unsure) ? null : name,
    conf: probs[best],
    idle, unsure,
  };
}

let net  = null;   // parsed model (from ainet.parseModel): { timeSteps, features, labels, mean, std, layers[], meta }

// cached DOM
let elFile, elClear, elStatus, elEnable, elBig, elConf, elProbs, elRecent, elList;
let elAlways, elAlwaysHint, elCoverage;

// model library on the rig's SD card: many files, one active
let library = { active: '', models: [] };

// ───────────────────────── live buffers ─────────────────────────
function ring(slot) {
  let r = state.ai.rawBySlot.get(slot);
  if (!r) {
    r = { buf: new Float32Array(ringCap * (net ? net.features : 6)), idx: 0, count: 0 };
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
  r.idx = (r.idx + 1) % ringCap;
  if (r.count < ringCap) r.count++;
}

/** Build a T×F window for a slot, standardised, or null if not enough data.
 *  @param {number} endBack  end the window this many samples before the newest
 *         one. The detector searches ~60 ms past the trigger for the true peak,
 *         and the window must end at that peak — not wherever the stream has got
 *         to by the time the search closed. */
function windowFor(slot, endBack = 0) {
  const r = state.ai.rawBySlot.get(slot);
  const T = net.timeSteps, F = net.features;
  const back = Math.max(0, endBack | 0);
  if (!r || r.count < T + back || T + back > ringCap) return null;
  const raw = new Float32Array(T * F);
  // oldest of the T samples ending `back` samples ago starts here in the ring
  let p = (r.idx - back - T + ringCap * 2) % ringCap;
  for (let t = 0; t < T; t++) {
    const src = p * F, dst = t * F;
    for (let c = 0; c < F; c++) raw[dst + c] = r.buf[src + c];
    p = (p + 1) % ringCap;
  }
  return raw;
}

/** Standardise a raw window in place of a copy — what the network eats. */
function standardise(raw, T, F) {
  const win = new Float32Array(T * F);
  for (let t = 0; t < T; t++)
    for (let c = 0; c < F; c++) {
      const i = t * F + c;
      win[i] = (raw[i] - net.mean[c]) / net.std[c];
    }
  return win;
}

/**
 * Network posterior fused with the physics prior, for one RAW window.
 * The prior is what the model file carries; models without one come back with
 * the network's own probabilities untouched.
 */
function posterior(raw) {
  const T = net.timeSteps, F = net.features;
  const probs = forward(net, standardise(raw, T, F));
  return fusePhysics(probs, windowPhysics(raw, T, F), net.physics);
}

/** Called on each detected strike. Classifies the window that ends at the impact.
 *  Returns { label, conf } or null. Also updates state.ai for the UI.
 *  @param {number} slot
 *  @param {number} endBack  samples between the impact and the newest sample */
export function aiOnStrike(slot, endBack = 0) {
  if (!net || !state.ai.enabled) return null;
  const raw = windowFor(slot, endBack);
  if (!raw) return null;

  const probs = posterior(raw);
  const d = decide(probs, slot);

  if (!d.label) {
    state.ai.last = { slot, label: null, conf: d.conf, at: Date.now(),
                      probs: Array.from(probs), idle: d.idle, unsure: d.unsure };
    return null;
  }

  const label = d.label, conf = d.conf;
  const rec = { slot, label, conf, at: Date.now(), probs: Array.from(probs),
                forced: !!state.ai.alwaysName && conf < minConf() };
  state.ai.last = rec;
  state.ai.history.unshift({ slot, label, conf, at: rec.at, forced: rec.forced });
  if (state.ai.history.length > 12) state.ai.history.length = 12;
  return { label, conf };
}

/** Model loaded and switched on? Lets other views decide whether to offer AI naming. */
export function aiReady() { return !!net && state.ai.ready; }

/**
 * Detector settings the ACTIVE model was trained with, or null when the model
 * predates this field. Live and replay use these instead of the tuning sliders so
 * the impacts fed to the model are cut on the same rule the training set used.
 */
export function aiDetectParams() {
  const d = net && net.meta && net.meta.detect;
  if (!d) return null;
  // v2 files describe the peak-picking detector; anything older described the
  // first-crossing one, and must keep being fed that way or its windows shift.
  return normalizeDetect(Number(d.version) >= 2 ? {
    version:      2,
    armG:         d.arm_g,
    releaseG:     d.release_g,
    refractoryMs: d.refractory_ms,
    searchMs:     d.search_ms,
    minPeakDps:   d.min_peak_dps,
    minConf:      d.min_conf,
  } : {
    version:      1,
    thresholdG:   d.impact_g,
    refractoryMs: d.refractory_ms,
    minConf:      d.min_conf,
  });
}

/** Confidence floor calibrated at training time; 0 for models without one. */
function minConf() {
  const d = net && net.meta && net.meta.detect;
  return d ? (Number(d.min_conf) || 0) : 0;
}

/**
 * The measured [log peak accel, log peak gyro] distribution of one technique, so
 * a strike can be scored against others of its own kind rather than against a
 * single global idea of "hard". Comes from the `physics` block the training
 * pipeline fits; null when the model has none or the technique is unknown.
 * @param {string|null} label
 * @returns {{muG:number,sdG:number,muD:number,sdD:number}|null}
 */
export function aiStrikeNorm(label) {
  if (!net || !net.physics || !label) return null;
  const i = net.labels.indexOf(label);
  if (i < 0) return null;
  const m = net.physics.mean[i], s = net.physics.std[i];
  if (!m || !s) return null;
  return { muG: m[0], sdG: s[0], muD: m[1], sdD: s[1] };
}

/** Window shape the loaded model expects, or null. Replay needs it to cut windows
 *  the same length the model was trained on. */
export function aiWindowShape() {
  return net ? { timeSteps: net.timeSteps, features: net.features } : null;
}

/**
 * Classify one RAW window — same maths as the live path, but on a caller-supplied
 * buffer instead of the live ring, so recordings can be named after the fact.
 * @param {ArrayLike<number>} raw  timeSteps × features, row-major, unnormalised
 * @param {number} slot  limb the window came from; gates out techniques that limb
 *        cannot throw. 0 to classify without the gate.
 * @returns {{label:string|null, conf:number, idle:boolean}|null}
 */
export function aiClassifyRaw(raw, slot = 0) {
  if (!net) return null;
  const T = net.timeSteps, F = net.features;
  if (raw.length < T * F) return null;
  // Same rule as the live path, including the coach's abstention preference —
  // a replay must name the session the way the live view named it.
  const d = decide(posterior(raw), slot);
  return { label: d.label, conf: d.conf, idle: d.idle, unsure: d.unsure };
}

// ───────────────────────── model load / clear ─────────────────────────
function activate(doc) {
  net = parseModel(doc);           // throws on bad model → caller handles
  ringCap = net.timeSteps + RING_MARGIN;
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
  elAlways     = document.getElementById('aiAlwaysName');
  elAlwaysHint = document.getElementById('aiAlwaysNameHint');
  elCoverage   = document.getElementById('aiCoverage');
  if (!elFile) return;   // panel absent → no-op

  state.ai.alwaysName = !!persist.get(PERSIST_KEYS.aiAlwaysName, false);
  elAlways?.addEventListener('change', e => {
    state.ai.alwaysName = e.target.checked;
    persist.set(PERSIST_KEYS.aiAlwaysName, state.ai.alwaysName);
    renderAiModel();
  });

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

/**
 * The techniques this model was trained on, split by limb.
 *
 * A model can only ever answer with a class it has seen. Throw a knee at a model
 * trained on roundhouses and low kicks and it returns whichever of those the
 * motion resembles most — a nearest match, not a reading. The panel therefore
 * says out loud which names are real answers, so an approximation is never
 * mistaken for a measurement.
 */
function renderCoverage() {
  if (!elCoverage) return;
  const ai = state.ai;
  if (!ai.ready || !ai.meta) { elCoverage.innerHTML = ''; return; }

  const labels = ai.meta.labels || [];
  const hand = [], leg = [];
  labels.forEach((name, i) => {
    if (name === IDLE_LABEL || name === MOVE_LABEL) return;
    const limb = net && net.limbs ? net.limbs[i] : null;
    (limb === 'leg' ? leg : hand).push(name);
  });

  const row = (title, arr) => arr.length
    ? `<div class="ai-cov-row"><span class="ai-cov-k">${title}</span>`
      + arr.map(n => `<span class="ai-cov-chip">${n}</span>`).join('') + '</div>'
    : '';

  const knowsMove = labels.includes(MOVE_LABEL);
  elCoverage.innerHTML =
      `<div class="ai-cov-head">โมเดลนี้แยกได้ ${hand.length + leg.length} ท่า</div>`
    + row('มือ', hand) + row('ขา', leg)
    + `<div class="ai-cov-note dim small">ท่าที่ยังไม่ได้เก็บข้อมูล`
    + ` (เข่า · ถีบ · ศอกกลับ · เตะตรง) จะถูกตอบเป็นท่าที่ใกล้เคียงที่สุดในรายการนี้`
    + ` — เป็นการเทียบเคียง ไม่ใช่การอ่านค่า เก็บข้อมูลท่านั้นแล้วเทรนซ้ำถึงจะแยกได้จริง</div>`
    + (knowsMove
        ? ''
        : `<div class="ai-cov-note warn small">⚠ โมเดลนี้ไม่มีคลาส “${MOVE_LABEL}”`
          + ` — ขาที่ขยับโดยไม่ได้เตะจะไม่มีคำตอบที่ถูกต้องให้เลือก</div>`);
}

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

  renderCoverage();

  if (elAlways) { elAlways.checked = ai.alwaysName; elAlways.disabled = !ai.ready; }
  if (elAlwaysHint) {
    const floor = Math.round(minConf() * 100);
    elAlwaysHint.textContent = ai.alwaysName
      ? `ตี 100 ครั้งได้ชื่อท่า 99 ครั้ง (แม่น 80%) — ชื่อที่โมเดลมั่นใจต่ำกว่า ${floor}% ขึ้นกรอบประ`
        + ' · ยังกันการกระแทกที่ไม่ใช่ท่า (ถุงมือหล่น/ปรับเซ็นเซอร์) ไว้เหมือนเดิม'
      : (floor
          ? `ตี 100 ครั้งได้ชื่อท่า 81 ครั้ง (แม่น 87%) — ที่เหลือขึ้น "ไม่ระบุ" เพราะมั่นใจต่ำกว่า ${floor}%`
          : '');
  }

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
    // A dot marks a name the coach asked for rather than one the model stood
    // behind — so a low-confidence guess is never mistaken for a firm reading.
    elRecent.innerHTML = ai.history.map(h =>
      `<span class="ai-chip${h.forced ? ' forced' : ''}"><b>${h.label}</b> ${(h.conf * 100).toFixed(0)}%${h.forced ? ' ·' : ''}</span>`
    ).join('');
  }
}
