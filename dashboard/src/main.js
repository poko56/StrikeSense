// Entry — wires state ↔ ws ↔ ui ↔ timer ↔ polling ↔ persistence ↔ keyboard.
// Append ?demo=1 to URL to spawn synthetic data without a Main Node.

import { state, subscribe, scheduleRender, resetSessionState, pushActivity } from './state.js';
import {
  initUi, renderAll, toast, bindRefreshLibrary, refreshLibrary,
  bindSaveTuning, bindSaveModes, bindSaveGoals, openGoalsModal, openShortcutsModal,
} from './ui.js';
import { api as realApi } from './api.js';
import { startWs } from './ws.js';
import {
  applyPreset, startTimer, resetTimer, skipPhase, tickTimer, onPhaseChange,
  setStopwatch,
} from './timer.js';
import { addMarker } from './analyzer.js';
import { isDemo, startDemo, demoApi } from './demo.js';
import { persist, PERSIST_KEYS as K } from './persist.js';
import { closeModal } from './modal.js';
import { loadCalibration } from './calibrate.js';

const demo = isDemo();
const api  = demo ? demoApi : realApi;

// ───── persistence: load saved state ─────
const savedTheme   = persist.get(K.theme, 'dark');
const savedTuning  = persist.get(K.tuning, null);
const savedGoals   = persist.get(K.goals, null);
const savedAthlete = persist.get(K.athlete, '');
const savedDrill   = persist.get(K.drill, '');
const savedPreset  = persist.get(K.preset, '');
const savedModes   = persist.get(K.modes, null);
const athHistory   = persist.get(K.athleteHistory, []);

document.documentElement.dataset.theme = savedTheme;
state.ui.theme = savedTheme;
if (savedTuning) Object.assign(state.tuning, savedTuning);
if (savedGoals)  Object.assign(state.goals, savedGoals);
if (savedModes)  { state.ui.bodyHeatmap = !!savedModes.bodyHeatmap; state.timer.stopwatch = !!savedModes.stopwatch; }
loadCalibration();

// ───── bootstrap ─────
initUi();
subscribe(renderAll);

if (demo) {
  document.getElementById('modeTxt').textContent = 'DEMO';
  startDemo();
} else {
  startWs();
}

// hydrate inputs from saved
if (savedAthlete) document.getElementById('athleteName').value = savedAthlete;
if (savedDrill)   document.getElementById('drillType').value   = savedDrill;
if (savedPreset)  {
  document.getElementById('roundPreset').value = savedPreset;
  if (savedPreset === 'stopwatch') setStopwatch(true);
  else if (savedPreset !== 'custom') applyPreset(savedPreset);
}
// hydrate tuning sliders
document.getElementById('thrSlider').value  = state.tuning.thresholdG;
document.getElementById('thrVal').textContent = `${state.tuning.thresholdG.toFixed(1)} g`;
document.getElementById('refrSlider').value = state.tuning.refractoryMs;
document.getElementById('refrVal').textContent = `${state.tuning.refractoryMs} ms`;
// hydrate body mode buttons
const bmode = state.ui.bodyHeatmap ? 'heat' : 'live';
document.querySelectorAll('.seg-btn[data-bmode]').forEach(b =>
  b.classList.toggle('seg-on', b.dataset.bmode === bmode));
// athlete history datalist
const dl = document.getElementById('athleteHistory');
if (dl) dl.innerHTML = athHistory.map(n => `<option value="${n}">`).join('');

// persistence save hooks
bindSaveTuning(() => persist.set(K.tuning, { thresholdG: state.tuning.thresholdG, refractoryMs: state.tuning.refractoryMs }));
bindSaveGoals(()  => persist.set(K.goals, state.goals));
bindSaveModes(()  => persist.set(K.modes, { bodyHeatmap: state.ui.bodyHeatmap, stopwatch: state.timer.stopwatch }));

document.getElementById('athleteName').addEventListener('change', e => {
  const v = e.target.value.trim();
  persist.set(K.athlete, v);
  if (v && !athHistory.includes(v)) {
    athHistory.unshift(v);
    while (athHistory.length > 10) athHistory.pop();
    persist.set(K.athleteHistory, athHistory);
    if (dl) dl.innerHTML = athHistory.map(n => `<option value="${n}">`).join('');
  }
});
document.getElementById('drillType').addEventListener('change', e => {
  persist.set(K.drill, e.target.value);
});

// ───── REC ─────
document.getElementById('btnRec').addEventListener('click', toggleSession);
async function toggleSession() {
  if (state.session.active) await stopSession();
  else                      await startSession();
}
async function startSession() {
  const athlete = document.getElementById('athleteName').value.trim() || 'anonymous';
  try {
    const res = await api.sessionStart(athlete);
    state.session.active      = true;
    state.session.id          = res.sessionId;
    state.session.startedAtMs = Date.now();
    state.session.athlete     = athlete;
    resetSessionState();
    pushActivity('rec', `▶ Recording started · ${res.sessionId}`);
    toast(`Recording started · ${res.sessionId}`, 'ok');
    if (!res.sdLogging) toast('Warning: SD logging unavailable', 'warn');
    scheduleRender();
  } catch (e) { toast(`Start failed: ${e.message}`, 'warn'); }
}
async function stopSession() {
  try {
    await api.sessionStop();
    state.session.active = false;
    pushActivity('rec', `■ Recording stopped`);
    toast('Recording stopped', 'ok');
    refreshLibrary();
    scheduleRender();
  } catch (e) { toast(`Stop failed: ${e.message}`, 'warn'); }
}

// ───── Round preset ─────
document.getElementById('roundPreset').addEventListener('change', e => {
  const val = e.target.value;
  if (val === 'stopwatch') {
    setStopwatch(true);
    persist.set(K.preset, val);
  } else if (val === 'custom') {
    const r  = prompt('Rounds:', state.timer.rounds);
    const w  = prompt('Work seconds:', state.timer.workSec);
    const rs = prompt('Rest seconds:', state.timer.restSec);
    if (r && w && rs) {
      Object.assign(state.timer, {
        rounds: parseInt(r,10), workSec: parseInt(w,10), restSec: parseInt(rs,10),
        preset: 'custom', stopwatch: false,
      });
      resetTimer();
      persist.set(K.preset, 'custom');
    }
  } else {
    setStopwatch(false);
    applyPreset(val);
    persist.set(K.preset, val);
  }
});

document.getElementById('btnRoundReset').addEventListener('click', resetTimer);
document.getElementById('btnRoundSkip').addEventListener('click', skipPhase);
document.getElementById('autoRec').addEventListener('change', e => { state.timer.autoRec = e.target.checked; });
document.getElementById('roundDial').addEventListener('click', () => {
  if (state.timer.mode === 'idle' || state.timer.mode === 'done') startTimer();
});

// ───── Marker ─────
document.getElementById('btnMarker').addEventListener('click', () => promptMarker());
function promptMarker() {
  if (!state.session.active) { toast('Start a session first', 'warn'); return; }
  const label = prompt('Marker note (Enter to skip):', `Round ${state.timer.currentRound} · note`);
  const m = addMarker(label || undefined);
  if (m) toast(`📍 Marker @ ${(m.sessionMs/1000).toFixed(1)}s`, 'ok');
  scheduleRender();
}

// ───── Round transitions ─────
onPhaseChange((prev, next, round) => {
  if (next === 'work' && round > 0) pushActivity('rec', `🥊 Round ${round} · WORK`);
  if (next === 'rest') pushActivity('rec', `⏸ Rest after R${round}`);
  if (next === 'done') pushActivity('rec', `🏁 Workout complete`);
  if (!state.timer.autoRec) return;
  if (next === 'work' && !state.session.active && !state.timer.stopwatch) startSession();
  if (next === 'done' && state.session.active)  stopSession();
});

// ───── Theme / heatmap / fullscreen toggles ─────
document.getElementById('btnTheme').addEventListener('click', toggleTheme);
document.getElementById('btnHeatmap').addEventListener('click', toggleHeatmap);
document.getElementById('btnFullscreen').addEventListener('click', toggleFullscreen);

function toggleTheme() {
  state.ui.theme = state.ui.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = state.ui.theme;
  persist.set(K.theme, state.ui.theme);
  scheduleRender();
}
function toggleHeatmap() {
  state.ui.bodyHeatmap = !state.ui.bodyHeatmap;
  document.querySelectorAll('.seg-btn[data-bmode]').forEach(b =>
    b.classList.toggle('seg-on', b.dataset.bmode === (state.ui.bodyHeatmap ? 'heat' : 'live')));
  persist.set(K.modes, { bodyHeatmap: state.ui.bodyHeatmap, stopwatch: state.timer.stopwatch });
  scheduleRender();
}
function toggleFullscreen() {
  state.ui.fullscreen = !state.ui.fullscreen;
  document.body.classList.toggle('is-fs', state.ui.fullscreen);
  if (state.ui.fullscreen) document.documentElement.requestFullscreen?.().catch(()=>{});
  else                     document.exitFullscreen?.().catch(()=>{});
  scheduleRender();
}
document.addEventListener('fullscreenchange', () => {
  state.ui.fullscreen = !!document.fullscreenElement;
  document.body.classList.toggle('is-fs', state.ui.fullscreen);
  scheduleRender();
});

// ───── Keyboard shortcuts ─────
window.addEventListener('keydown', (e) => {
  // ignore when typing in input/textarea/select
  const tag = (e.target?.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
  if (e.key === 'Escape') { closeModal(); return; }
  // ignore modifier combos
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  switch (e.key.toLowerCase()) {
    case ' ': e.preventDefault(); toggleSession(); break;
    case 'r': resetTimer(); break;
    case 's': skipPhase();  break;
    case 'm': promptMarker(); break;
    case 'f': toggleFullscreen(); break;
    case 'h': toggleHeatmap(); break;
    case 't': toggleTheme(); break;
    case '?': case '/': openShortcutsModal(); break;
    case '0': case '1': case '2': case '3': case '4': {
      const filter = e.key === '0' ? 'all' : e.key;
      state.ui.strikeFilter = filter;
      document.querySelectorAll('.chip[data-filter]').forEach(c =>
        c.classList.toggle('chip-on', c.dataset.filter === filter));
      scheduleRender();
      break;
    }
  }
});

// ───── polling ─────
async function pollStatus() {
  try {
    const s = await api.status();
    state.hostStatus = s;
    if (s?.session) {
      const wasActive = state.session.active;
      state.session.active = !!s.session.active;
      state.session.id     = s.session.id || state.session.id;
      if (s.session.active) state.session.startedAtMs = Date.now() - (s.session.durationMs || 0);
      if (wasActive !== state.session.active) scheduleRender();
    }
    scheduleRender();
  } catch (e) {}
}
async function pollNodes() {
  try {
    const list = await api.nodes();
    state.nodes = Array.isArray(list) ? list : [];
    trackNodeHistory(state.nodes);
    scheduleRender();
  } catch (e) {}
}

const STALE_MS = 2500;

function trackNodeHistory(nodes) {
  const now = Date.now();
  const seenMacs = new Set();

  for (const n of nodes) {
    seenMacs.add(n.mac);
    let h = state.nodeHistory.get(n.mac);
    if (!h) {
      h = {
        firstSeen: now,
        state:    (n.ageMs || 0) > STALE_MS ? 'stale' : 'live',
        drops:    [],
        reconnects: [],
        rxSamples: [],
        lastRxCount: n.packetsRx || 0,
        lastBattery: n.batteryPct || 0,
        lastUptimeMs: n.nodeUptimeMs || 0,
      };
      state.nodeHistory.set(n.mac, h);
      if (h.state === 'live') {
        pushActivity('node', `🟢 New node connected · ${n.mac.slice(-5)}`);
        toast(`Node online · ${n.mac.slice(-5)}`, 'ok');
      }
    }

    const isStale = (n.ageMs || 0) > STALE_MS;

    // detect drop
    if (h.state === 'live' && isStale) {
      h.state = 'stale';
      h.drops.push({ at: now, age: n.ageMs || 0 });
      if (h.drops.length > 30) h.drops.shift();
      pushActivity('drop', `🔴 Lost: ${n.mac.slice(-5)} · age ${(n.ageMs/1000).toFixed(1)}s · batt ${n.batteryPct}% · rssi ${n.rssi}dBm`);
      toast(`Lost ${n.mac.slice(-5)} · ${(n.ageMs/1000).toFixed(1)}s gap`, 'warn');
    }
    // detect recovery
    if (h.state === 'stale' && !isStale) {
      const lastDrop = h.drops[h.drops.length - 1];
      const gap = lastDrop ? (now - lastDrop.at) : 0;
      h.state = 'live';
      h.reconnects.push({ at: now, gap });
      if (h.reconnects.length > 30) h.reconnects.shift();
      pushActivity('node', `🟢 Recovered: ${n.mac.slice(-5)} · was off ${(gap/1000).toFixed(1)}s`);
      toast(`Recovered ${n.mac.slice(-5)}`, 'ok');
    }
    // detect uptime reset → node rebooted
    if (n.nodeUptimeMs && n.nodeUptimeMs < (h.lastUptimeMs - 1000)) {
      pushActivity('drop', `↻ Node rebooted: ${n.mac.slice(-5)}`);
      toast(`Reboot detected: ${n.mac.slice(-5)}`, 'warn');
    }
    h.lastUptimeMs = n.nodeUptimeMs || h.lastUptimeMs;

    // RX rate sampling (delta packets between polls)
    const delta = Math.max(0, (n.packetsRx || 0) - h.lastRxCount);
    h.lastRxCount = n.packetsRx || 0;
    h.rxSamples.push({ t: now, rx: delta });
    if (h.rxSamples.length > 30) h.rxSamples.shift();
    h.lastBattery = n.batteryPct || h.lastBattery;
  }

  // mark long-absent nodes
  for (const [mac, h] of state.nodeHistory) {
    if (!seenMacs.has(mac) && h.state === 'live') {
      h.state = 'stale';
      h.drops.push({ at: now, age: 9999 });
      pushActivity('drop', `🔴 Vanished from /api/nodes: ${mac.slice(-5)}`);
    }
  }
}
async function refreshLib() {
  try {
    const list = await api.sessions();
    state.sessions = Array.isArray(list) ? list : [];
    scheduleRender();
  } catch (e) {}
}
bindRefreshLibrary(refreshLib);

pollStatus(); pollNodes(); refreshLib();
setInterval(pollStatus, 1500);
setInterval(pollNodes,  2000);
setInterval(refreshLib, 8000);

// ───── render loop ─────
function loop() {
  tickTimer();
  scheduleRender();
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

if (!demo) window.__state = state;
