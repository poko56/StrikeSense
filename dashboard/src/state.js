// ──────────────────────────────────────────────────────────────────
// Central state — single source of truth for the dashboard.
// Modules read/write through this and re-render via ui.scheduleRender().
// ──────────────────────────────────────────────────────────────────

export const SLOT_NAMES = {
  0: 'Unassigned',
  1: 'Left Hand',
  2: 'Right Hand',
  3: 'Left Shin',
  4: 'Right Shin',
};
export const SLOT_SHORT = { 0: 'UA', 1: 'LH', 2: 'RH', 3: 'LS', 4: 'RS' };
export const STRIKE_TYPES = ['jab', 'cross', 'hook', 'uppercut', 'elbow', 'kick', 'roundhouse', 'knee', 'push'];

export const TUNING = {
  // Peak |accel| in g, gravity included — the same scale the live waveform draws,
  // so the slider line sits where the coach sees the spike. A limb at rest already
  // reads 1.0 g, which is why 3.0 g used to count an ordinary footfall as a
  // strike; the detector works on the gravity-removed value (see detector.js).
  thresholdG:    6.0,
  // One kick is a chamber, an impact and a foot landing inside ~400 ms. A shorter
  // lockout logged all three.
  refractoryMs:  400,
  fatigueWindow: 30_000,
  asymWindow:    60_000,
};

export const WAVEFORM_SAMPLES = 300;   // ~3 s at 100 frames per second of UI history
export const TIMELINE_MAX_PTS = 600;   // session-level points

export const state = {
  // connection
  ws:        null,
  wsUrl:     '',
  connected: false,
  demoMode:  false,
  measuredHz:   0,
  measuredKbps: 0,

  // backend snapshot
  hostStatus: null,
  nodes:      [],
  sessions:   [],

  // session
  session: {
    active:        false,
    id:            '',
    startedAtMs:   0,
    durationMs:    0,
    athlete:       'Fighter 1',
    drill:         'pad',
  },

  // round timer
  timer: {
    mode:         'idle',          // 'idle' | 'work' | 'rest' | 'done'
    preset:       '5x3',
    rounds:       5,
    workSec:      180,
    restSec:      60,
    currentRound: 0,
    phaseStartMs: 0,
    remainingMs:  0,
    autoRec:      true,
    stopwatch:    false,           // alt mode: free count up
    stopwatchStartMs: 0,
    paused:       false,           // REC stopped mid-round — clock frozen, round kept
  },

  // live IMU per slot
  liveBySlot: new Map(), // slot -> { mac, lastSamples, peakG, peakHoldMs, rmsG, lastSeenMs, lastRssi, waveform: Float32Array, waveIdx }

  // always-on sensor activity — proves the rig is connected + responding even
  // when NOT recording (recording only gates the session stats / radar / eval).
  // curG = instantaneous gravity-removed |a| (≈0 at rest, spikes on impact) so
  // the readout is steady, not a peak-hold sawtooth of the 1 g gravity vector.
  liveActivity: { curG: 0, lastHitMs: 0, lastSampleMs: 0 },

  // strikes
  strikes:          [],
  strikeSeq:        0,
  lastStrikeBySlot: new Map(),

  // live combo counter — consecutive strikes thrown inside COMBO_GAP_MS of each
  // other. Resets to 1 on the first strike after a pause; `best` is the longest
  // unbroken run this session. Gives the coach a heavy-bag-style "×N" streak.
  combo: { current: 0, best: 0, lastAtMs: 0 },

  // aggregates
  distribution:  Object.fromEntries(STRIKE_TYPES.map(t => [t, 0])),
  histogram:     { '1-3': 0, '3-5': 0, '5-10': 0, '10+': 0 },
  leftCount:     0,
  rightCount:    0,
  totalsForce:   0,
  peakG:         0,
  fatigueHistory:[],
  heatmapBySlot: { 1: 0, 2: 0, 3: 0, 4: 0 }, // cumulative count per slot
  activeMsByWindow: [],      // [{ tMs }] perf-time per packet seen → derives time-on-target

  // round-by-round history
  perRound: [],  // [{ round, strikes, peakG, avgG, asym, fatiguePct }]

  // markers (coach annotations)
  markers: [],   // [{ id, sessionMs, wallMs, label }]
  markerSeq: 0,

  // goals
  goals: {
    targetStrikes: 100,
    targetPeakG:   8,
    targetSpm:     30,
    completedAt:   0,            // wallMs when goal first met
  },

  // tuning (user editable in System tab)
  tuning: { ...TUNING },

  // calibration — dashboard-side per-slot offset
  calibration: {
    activeSlots:     new Set(),    // slots currently being calibrated (supports calibrate-all)
    collectedBySlot: new Map(),    // slot -> raw samples[] captured during calibration
    active:          0,            // legacy single-slot indicator (kept in sync; 0 = none)
    startedAt:       0,
    durationMs:      5000,
    offsets:         new Map(),    // slot -> { ax, ay, az, gx, gy, gz, samples, calibratedAt, mac, gravityAxis }
  },

  // per-node connection history (drops, reconnects, rx-rate sparkline)
  nodeHistory: new Map(),          // mac -> { firstSeen, state:'live'|'stale', drops:[{at,age}], reconnects:[{at,gap}], rxSamples:[{t,rx}], lastRxCount, lastBattery }

  // AI gesture model — user uploads a trained model (strike_web_model.json) and
  // the dashboard runs 1D-CNN inference in-browser on the live IMU stream.
  ai: {
    enabled:   false,            // run inference on strikes
    // Name every impact instead of abstaining when the model is unsure.
    //
    // ON by default. Measured on the held-out split of the current model (880
    // real strikes): abstaining below the calibrated floor names 608 of them at
    // 96.4% accuracy — 586 correct. Naming everything names 872 at 87.4% — 762
    // correct. The floor buys accuracy per name and costs 176 strikes that would
    // have been named right, which is the wrong trade for a coach reading a
    // session log. Turn it off in the AI panel to get the conservative behaviour.
    alwaysName: true,
    ready:     false,            // a valid model is loaded
    meta:      null,             // { labels[], time_steps, features, label_mode, created }
    error:     '',               // last load error (shown in panel)
    source:    '',               // 'sd' | 'local' — where the active model came from
    saving:    false,            // uploading model to the SD card
    rawBySlot: new Map(),        // slot -> { buf:Float32Array(CAP*FEATURES), idx, count }  raw IMU ring
    last:      null,             // { slot, label, conf, at, probs:number[] }  most recent detection
    history:   [],               // recent detections [{ slot, label, conf, at }]
  },

  // Phone camera pose is deliberately a light-weight companion to the IMUs:
  // the module owns MediaPipe/video/landmark history; state keeps only compact
  // UI metadata and the last fusion result. An IMU slot always decides the limb.
  mocap: {
    status:        'idle',       // idle | loading | running | unavailable | error
    enabled:       false,
    facing:        'environment',
    fps:           0,
    quality:       0,
    lastFrameAtMs: 0,
    last:          null,         // { tMs, angles } — no raw landmark arrays
    lastImpact:    null,         // compact pose snapshot attached to last IMU hit
    error:         '',
  },

  // UI / modes
  ui: {
    activeTab:    'sensors',
    strikeFilter: 'all',
    bodyHitFlash: new Map(),
    bodyHeatmap:  false,
    fullscreen:   false,
    theme:        'dark',
    devMode:      false,         // reveals AI Training Data Logger (?dev=1 / 'd' key)
    compareSet:   new Set(),     // session ids selected for compare
    activity:     [],            // last N events
  },
};

// Bus
let rafQueued = false;
const subscribers = new Set();

export function subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); }

// ── nothing may move while a finger is down ──────────────────────────────────
// Measured on an iPad with ?touchdebug=1: pointerdown ✓ touchstart ✓ pointerup ✓
// touchend ✓ click ✗, with the finger travelling 0 px over a 168 ms hold. Every
// event arrived and the finger never moved, so the browser cancelled the click
// because the ELEMENT moved out from under it — 168 ms is ten frames, and the
// renderers rebuild subtrees with innerHTML, reflowing everything below.
//
// The guard lives here, on the render bus, because there are four independent
// subscribers (renderAll, scorecard, logger, AI panel) and any one of them
// reflowing the page is enough to lose the tap. A mouse click is over in a couple
// of milliseconds and almost never collides, which is why the same page worked
// perfectly with a mouse and was dead to a finger.
let pointerHeld = false;
let holdTimer = 0;
let releaseTimer = 0;

/** True while a finger or mouse button is down or during the click dispatch window. */
export function rendersHeld() { return pointerHeld; }

function holdRenders() {
  pointerHeld = true;
  clearTimeout(holdTimer);
  clearTimeout(releaseTimer);
  // Max safety hold: clear if an interaction gets abandoned/lost
  holdTimer = setTimeout(releaseRendersNow, 1200);
}

function deferReleaseRenders() {
  // Keep renders held across the pointerup -> touchend -> click window (~150ms on iOS)
  clearTimeout(releaseTimer);
  releaseTimer = setTimeout(releaseRendersNow, 180);
}

function releaseRendersNow() {
  if (!pointerHeld) return;
  pointerHeld = false;
  clearTimeout(holdTimer);
  clearTimeout(releaseTimer);
  scheduleRender();            // catch up on everything held back
}

if (typeof window !== 'undefined') {
  // Capture phase: must run before any handler that stops propagation.
  window.addEventListener('pointerdown', holdRenders, true);
  window.addEventListener('touchstart', holdRenders, { capture: true, passive: true });
  for (const ev of ['pointerup', 'pointercancel', 'touchend', 'touchcancel']) {
    window.addEventListener(ev, deferReleaseRenders, true);
  }
  // Release shortly after click finishes executing
  window.addEventListener('click', () => {
    clearTimeout(releaseTimer);
    releaseTimer = setTimeout(releaseRendersNow, 60);
  }, true);
}

export function scheduleRender() {
  if (rafQueued) return;
  rafQueued = true;
  requestAnimationFrame(() => {
    rafQueued = false;
    if (pointerHeld) return;   // released -> releaseRenders() schedules again
    subscribers.forEach(fn => { try { fn(); } catch (e) { console.error(e); } });
  });
}

export function resetSessionState() {
  state.strikes.length     = 0;
  state.strikeSeq          = 0;
  state.totalsForce        = 0;
  state.peakG              = 0;
  state.leftCount          = 0;
  state.rightCount         = 0;
  state.fatigueHistory.length = 0;
  state.perRound.length    = 0;
  state.markers.length     = 0;
  state.markerSeq          = 0;
  state.activeMsByWindow.length = 0;
  for (const k of Object.keys(state.distribution)) state.distribution[k] = 0;
  for (const k of Object.keys(state.histogram))    state.histogram[k]    = 0;
  for (const k of Object.keys(state.heatmapBySlot)) state.heatmapBySlot[k] = 0;
  state.lastStrikeBySlot.clear();
  state.combo.current = 0; state.combo.best = 0; state.combo.lastAtMs = 0;
  state.mocap.lastImpact = null;
  state.goals.completedAt = 0;
}

export function pushActivity(kind, text) {
  state.ui.activity.unshift({ t: Date.now(), kind, text });
  if (state.ui.activity.length > 20) state.ui.activity.length = 20;
}
