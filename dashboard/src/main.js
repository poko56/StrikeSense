// Entry — wires state ↔ ws ↔ ui ↔ timer ↔ polling ↔ persistence ↔ keyboard.
// Append ?demo=1 to URL to spawn synthetic data without a Main Node.

import { state, subscribe, scheduleRender, resetSessionState, pushActivity } from './state.js';
import {
  initUi, renderAll, toast, bindRefreshLibrary, refreshLibrary, bindRescanNodes,
  bindSaveTuning, bindSaveModes, bindSaveGoals, openGoalsModal, openShortcutsModal,
} from './ui.js';
import { initSetup, openSetupWizard } from './setup.js';
import { api as realApi, releaseInitialRequestGate, openRequestLane } from './api.js';
import { startWs, onWsOpen, onRigState } from './ws.js';
import {
  applyPreset, resetTimer, skipPhase, tickTimer, onPhaseChange,
  setStopwatch, startOrResumeTimer, pauseTimer,
} from './timer.js';
import { addMarker } from './analyzer.js';
import { isDemo, startDemo, demoApi } from './demo.js';
import { persist, PERSIST_KEYS as K } from './persist.js';
import { closeModal } from './modal.js';
import { loadCalibration } from './calibrate.js';
import { initLogger, renderLogger } from './logger.js';
import { initAiModel, renderAiModel, startAiModelLoad } from './aimodel.js';
import { initScorecard, renderScorecard } from './score.js';
import { startTour } from './tour.js';
import { checkFreshness } from './freshness.js';
import { initTouchProbe } from './touchprobe.js';
import { initDiagLog, setDiagLogEnabled, logLocal } from './diaglog.js';
import { initMotionCapture, stopMotionCapture } from './motioncapture.js';

const demo = isDemo();
const api  = demo ? demoApi : realApi;
// Settles once the status/node/library bootstrap reads are done. The setup
// wizard waits for it rather than adding a fourth HTTPS request beside WSS —
// and it must exist from the first line, because the bootstrap itself does not
// start until the live stream has claimed its socket (see openRestLane below).
let resolveHydration;
const initialHydration = new Promise(resolve => { resolveHydration = resolve; });

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
// The old defaults (3.0 g including gravity, 250 ms) counted an ordinary footfall
// as a strike and split one kick into three. They were persisted the first time
// the sliders moved, so upgrading the dashboard alone would leave every existing
// rig on the numbers that caused the problem. Drop a stored copy of the OLD
// DEFAULTS and take the new ones; a value the coach actually chose is kept.
const LEGACY_TUNING = { thresholdG: 3.0, refractoryMs: 250 };
if (savedTuning &&
    !(savedTuning.thresholdG === LEGACY_TUNING.thresholdG &&
      savedTuning.refractoryMs === LEGACY_TUNING.refractoryMs)) {
  Object.assign(state.tuning, savedTuning);
}
if (savedGoals)  Object.assign(state.goals, savedGoals);
if (savedModes)  { state.ui.bodyHeatmap = !!savedModes.bodyHeatmap; state.timer.stopwatch = !!savedModes.stopwatch; }
loadCalibration();

// ───── bootstrap ─────
initUi(api);           // hand the UI the demo stub when running with ?demo=1
initDiagLog(api);      // dev-mode diagnostic console (rig log + browser events)
initLogger();          // AI training data logger panel
initAiModel();         // AI gesture model — upload + live inference
initScorecard();       // performance radar
initMotionCapture();   // on-device phone pose; stays off until the coach permits camera
subscribe(renderAll);
subscribe(renderScorecard);
subscribe(renderLogger);
subscribe(renderAiModel);

// ───── developer mode (reveals AI Training Data Logger) ─────
function applyDevMode(on) {
  state.ui.devMode = !!on;
  document.body.classList.toggle('is-dev', !!on);
  const cb = document.getElementById('devModeToggle');
  if (cb) cb.checked = !!on;
  persist.set(K.devMode, !!on);
  // The diagnostic console only polls the rig while dev mode is on.
  setDiagLogEnabled(!!on);
}
const urlDev = new URLSearchParams(location.search).has('dev');
applyDevMode(urlDev || persist.get(K.devMode, false));
document.getElementById('devModeToggle')?.addEventListener('change', e => {
  applyDevMode(e.target.checked);
  toast(e.target.checked ? '🛠 Developer mode ON · เปิดเครื่องมือเก็บข้อมูล' : 'Developer mode OFF', 'ok');
});

// ───── onboarding tour (re-openable from SYSTEM tab) ─────
document.getElementById('btnStartTour')?.addEventListener('click', startTour);

// ───── first-run setup wizard (shake-to-assign) ─────
// Provisioning belongs to the RIG, not the browser. The Main Node reports
// setupDone; a fresh or factory-reset device says false and every phone that
// connects gets walked through pairing. Once anyone finishes (or deliberately
// skips) we tell the rig, and it stops asking. The local flag is only a fallback
// for when the rig can't be reached.
function markSetupDone() {
  persist.set(K.setupDone, true);
  api.setupDone?.(true).catch(() => {});
}
initSetup(api, { onTour: startTour, onFinish: markSetupDone });

async function maybeOpenSetupWizard() {
  await initialHydration;
  // A rig with sensors already paired is not fresh — never cover a working setup
  // with the full-screen first-run wizard (a reported "หน้าซ้อนทับกดปุ่มไม่ได้"
  // case), whatever the stored flag says. Adopt it as done and move on.
  if (state.nodes.some(n => n.slot > 0)) { markSetupDone(); return; }
  let rigIsFresh = null;
  try {
    const s = state.hostStatus || await api.status();
    if (s && typeof s.setupDone === 'boolean') rigIsFresh = !s.setupDone;
  } catch { /* unreachable — fall back to the local flag below */ }
  const localSeen = persist.get(K.setupDone, false);
  if (rigIsFresh === true || (rigIsFresh === null && !localSeen)) openSetupWizard();
}
setTimeout(maybeOpenSetupWizard, 700);

// Diagnostic strip, only with ?touchdebug=1 in the URL.
initTouchProbe();

if (demo) {
  document.getElementById('modeTxt').textContent = 'DEMO';
  startDemo();
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
  _sessionCmdAtMs = Date.now();
  try {
    const res = await api.sessionStart(athlete);
    state.session.active      = true;
    state.session.id          = res.sessionId;
    state.session.startedAtMs = Date.now();
    state.session.athlete     = athlete;
    resetSessionState();
    // REC also runs the clock. Without this the round timer only ever started from
    // the dial, so pressing บันทึก armed the recording and the dial stayed at 00:00.
    startOrResumeTimer();
    pushActivity('rec', `▶ เริ่มบันทึก · ${res.sessionId}`);
    toast(`เริ่มบันทึกแล้ว · ${res.sessionId}`, 'ok');
    if (!res.sdLogging) toast('เตือน: บันทึกลง SD card ไม่ได้', 'warn');
    scheduleRender();
  } catch (e) {
    // 409 = the rig is already recording (another phone started it, or this tab
    // reloaded mid-session). Adopt that session instead of dead-ending.
    if (e.status === 409 && e.body?.sessionId) {
      state.session.active      = true;
      state.session.id          = e.body.sessionId;
      state.session.startedAtMs = Date.now() - (state.hostStatus?.session?.durationMs || 0);
      state.session.athlete     = athlete;
      startOrResumeTimer();
      toast(`เข้าร่วมการบันทึกที่กำลังทำงาน · ${e.body.sessionId}`, 'ok');
      scheduleRender();
      return;
    }
    toast(`เริ่มไม่สำเร็จ: ${e.message}`, 'warn');
  }
}
async function stopSession() {
  _sessionCmdAtMs = Date.now();
  try {
    await api.sessionStop();
  } catch (e) {
    // 409 "not active" means the rig already stopped — fall through and sync the UI
    // rather than leaving the button stuck on หยุด.
    if (e.status !== 409) { toast(`หยุดไม่สำเร็จ: ${e.message}`, 'warn'); return; }
  }
  state.session.active = false;
  pauseTimer();                 // freeze the round where it stopped, keep the count
  pushActivity('rec', `■ หยุดบันทึก`);
  toast('หยุดบันทึกแล้ว', 'ok');
  refreshLibrary();
  scheduleRender();
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
// Tapping the dial starts the clock — and now also resumes one that REC paused,
// which was otherwise only recoverable with รีเซ็ต.
document.getElementById('roundDial').addEventListener('click', startOrResumeTimer);

// ───── Marker ─────
document.getElementById('btnMarker').addEventListener('click', () => promptMarker());
function promptMarker() {
  if (!state.session.active) { toast('เริ่มบันทึกก่อน', 'warn'); return; }
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
    case 'd':
      applyDevMode(!state.ui.devMode);
      toast(state.ui.devMode ? '🛠 Developer mode ON' : 'Developer mode OFF', 'ok');
      break;
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
// A /api/status reply that was already in flight when the user hit REC describes
// the world before the press. Ignore the session part of it briefly so the button
// and the clock don't flicker back.
let _sessionCmdAtMs = 0;
const SESSION_SYNC_GRACE_MS = 2500;

async function pollStatus() {
  try {
    applyStatus(await api.status());
  } catch (e) {}
}

function applyStatus(s) {
  if (!s) return;
  state.hostStatus = s;
  if (s.session && Date.now() - _sessionCmdAtMs > SESSION_SYNC_GRACE_MS) {
    const wasActive = state.session.active;
    state.session.active = !!s.session.active;
    state.session.id     = s.session.id || state.session.id;
    if (s.session.active) state.session.startedAtMs = Date.now() - (s.session.durationMs || 0);
    if (wasActive !== state.session.active) {
      // The rig changed state without us — another phone pressed REC, or a round
      // ended. Every connected dashboard follows, clock included, so two coaches
      // watching the same rig see the same round.
      if (state.session.active) startOrResumeTimer();
      else                      pauseTimer();
    }
  }
  scheduleRender();
}

async function pollNodes() {
  try {
    applyNodes(await api.nodes());
  } catch (e) {}
}

function applyNodes(list) {
  state.nodes = Array.isArray(list) ? list : [];
  trackNodeHistory(state.nodes);
  scheduleRender();
}

// The rig pushes the same status and node telemetry down the open WebSocket, so
// the secure dashboard never has to spend a TLS session on a poll. Whichever
// transport delivers it, it lands in the same two functions.
let pushedStateAtMs = 0;
onRigState(msg => {
  pushedStateAtMs = performance.now();
  applyStatus(msg.status);
  applyNodes(msg.nodes);
});
/** True while the rig's own pushes are arriving; polling then has nothing to do. */
const stateIsPushed = () => performance.now() - pushedStateAtMs < 4000;

const STALE_MS = 8000; // 8s — Strike Node sends status every 1s; allow up to 8 missed packets before marking stale

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
bindRescanNodes(pollNodes);   // "ค้นหาใหม่" button → immediate node re-poll

// ───── polling schedule ─────
// A backgrounded phone used to keep hammering the Main Node with ~1.5 requests a
// second forever; each one costs the ESP32 a JSON build and a TCP round trip that
// competes with the live IMU stream. Nothing here needs to run while the tab is
// hidden, and the library only matters while its tab is on screen.
function paced(fn, { whenHidden = false, onlyTab = null } = {}) {
  return () => {
    if (!whenHidden && document.hidden) return;
    if (onlyTab && state.ui.activeTab !== onlyTab && state.sessions.length) return;
    fn();
  };
}

// ───── connect: the live stream goes first ─────
//
// The secure rig has exactly two TLS client sockets. The stream must claim one
// BEFORE any REST request claims the other. Running the bootstrap reads first
// (as an earlier attempt did) meant six serialized HTTPS requests — one of them
// the ~140 KB model — held the single free slot, the WSS handshake was refused
// every time, and the badge stayed Offline with `ws=0` on the rig for as long as
// the tab was open. Worse, no request had a deadline, so one stalled read could
// wedge the queue and the stream would never be dialled at all.
if (!demo) startWs();

const REST_LANE_GRACE_MS = 4000;
let restLaneOpened = false;
function openRestLane() {
  if (restLaneOpened) return;
  restLaneOpened = true;
  openRequestLane();
  // Bootstrap reads. Status and nodes are skipped when the rig has already
  // pushed them down the socket, which on a healthy secure connection it has by
  // the time this runs — that leaves the library as the only opening request.
  // The model download waits until these are done; see startAiModelLoad().
  const bootstrap = stateIsPushed()
    ? [refreshLib()]
    : [pollStatus(), pollNodes(), refreshLib()];
  void Promise.all(bootstrap).finally(() => {
    resolveHydration();
    releaseInitialRequestGate();
    startAiModelLoad();
    // The hardware HTTPS listener intentionally has only WSS + one REST client
    // slot.  checkFreshness() skips its document re-fetch on that origin; it
    // remains useful in development/legacy HTTP mode.
    void checkFreshness(typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : '', demo);
  });
}
onWsOpen(openRestLane);
// A rig whose stream cannot come up must still show its nodes and sessions, so
// the lane opens anyway once WSS has had its chance at the first socket.
setTimeout(openRestLane, demo ? 0 : REST_LANE_GRACE_MS);

// Every REST poll on HTTPS costs a full TLS handshake, because each one-shot
// response closes its session to free the slot, and the rig has two. So these
// are a fallback, not the normal path: while the socket is pushing state they
// stand down entirely, and they only take over if those pushes stop — an older
// rig build that does not send them, or a stream that has dropped.
const SECURE = location.protocol === 'https:';
const pollsIfNotPushed = fn => paced(() => { if (!stateIsPushed()) fn(); });
setInterval(pollsIfNotPushed(pollStatus), SECURE ? 3000 : 1500);
setInterval(pollsIfNotPushed(pollNodes),  SECURE ? 5000 : 2000);
setInterval(paced(refreshLib, { onlyTab: 'library' }), 10000);

// Coming back to the app: refresh at once instead of waiting out the interval.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  pollStatus(); pollNodes();
});

// ───── render loop ─────
function loop() {
  tickTimer();
  scheduleRender();
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// requestAnimationFrame stops dead when the phone locks or the coach switches apps,
// which froze the round timer mid-session. Keep ticking on an interval while hidden
// so phases still advance and the clock is right the moment they look back at it.
// (Browsers clamp background intervals to ~1 Hz — plenty for a round timer.)
setInterval(() => { if (document.hidden) tickTimer(); }, 500);

// A page put in bfcache must relinquish the camera. Without this an iPhone can
// leave its green camera indicator on after navigating away from the rig.
window.addEventListener('pagehide', stopMotionCapture);

window.__state = state;   // debug handle (also in demo, so the UI can be inspected)
