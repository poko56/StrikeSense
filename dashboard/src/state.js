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
  thresholdG:    3.0,
  refractoryMs:  250,
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
  },

  // live IMU per slot
  liveBySlot: new Map(), // slot -> { mac, lastSamples, peakG, peakHoldMs, rmsG, lastSeenMs, lastRssi, waveform: Float32Array, waveIdx }

  // always-on sensor activity — proves the rig is connected + responding even
  // when NOT recording (recording only gates the session stats / radar / eval).
  liveActivity: { maxG: 0, peakHoldMs: 0, lastHitMs: 0, lastSampleMs: 0 },

  // strikes
  strikes:          [],
  strikeSeq:        0,
  lastStrikeBySlot: new Map(),

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
    ready:     false,            // a valid model is loaded
    meta:      null,             // { labels[], time_steps, features, label_mode, created }
    error:     '',               // last load error (shown in panel)
    source:    '',               // 'sd' | 'local' — where the active model came from
    saving:    false,            // uploading model to the SD card
    rawBySlot: new Map(),        // slot -> { buf:Float32Array(CAP*FEATURES), idx, count }  raw IMU ring
    last:      null,             // { slot, label, conf, at, probs:number[] }  most recent detection
    history:   [],               // recent detections [{ slot, label, conf, at }]
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

export function scheduleRender() {
  if (rafQueued) return;
  rafQueued = true;
  requestAnimationFrame(() => {
    rafQueued = false;
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
  state.goals.completedAt = 0;
}

export function pushActivity(kind, text) {
  state.ui.activity.unshift({ t: Date.now(), kind, text });
  if (state.ui.activity.length > 20) state.ui.activity.length = 20;
}
