// Strike detection, waveform buffer, per-round + time-on-target tracking.
import { state, scheduleRender, pushActivity, WAVEFORM_SAMPLES } from './state.js';
import { applyOffset, isCalibrating, collectSample } from './calibrate.js';
import { aiOnStrike, aiPushSample, aiDetectParams, aiStrikeNorm, aiPostPeak } from './aimodel.js';
import { createDetector } from './detector.js';
import { createNamingQueue } from './naming.js';
import { scoreStrike } from './strikescore.js';
import { attachPoseToImpact } from './motioncapture.js';

// One detector for the whole rig; it keeps its own per-slot state. Rebuilt
// whenever the active settings change, because a detector carries the arm/search
// state machine and cannot have its rules swapped mid-strike.
let detector = createDetector(null);
let detectorKey = '';

function activeDetector() {
  const cfg = aiDetectParams() || tuningToDetect(state.tuning);
  const key = JSON.stringify(cfg);
  if (key !== detectorKey) { detector = createDetector(cfg); detectorKey = key; }
  return detector;
}

/**
 * No model loaded → detect on the manual sliders, but with the v2 rules. The
 * slider stays in the units a coach thinks in (peak |accel| in g, gravity
 * included, matching the waveform's own scale); the detector wants gravity
 * removed, hence the -1.
 */
export function tuningToDetect(t) {
  return {
    version:      2,
    armG:         Math.max(0.5, (t.thresholdG ?? 6) - 1),
    releaseG:     Math.max(0.3, ((t.thresholdG ?? 6) - 1) * 0.4),
    refractoryMs: t.refractoryMs ?? 400,
    searchMs:     60,
    minPeakDps:   0,
  };
}

/** Live/replay views show the rule currently in force. */
export function activeDetectParams() { return activeDetector().cfg; }

export function magA(s) { return Math.sqrt(s.ax*s.ax + s.ay*s.ay + s.az*s.az); }
export function magG(s) { return Math.sqrt(s.gx*s.gx + s.gy*s.gy + s.gz*s.gz); }

export function classifyStrike(slot, peakG, peakDps) {
  if (slot === 1 || slot === 2) {
    if (peakG > 9)             return 'elbow';
    if (peakDps > 1500)        return 'hook';
    if (peakG > 5 && peakDps < 700) return 'cross';
    if (peakG > 7)             return 'uppercut';
    return 'jab';
  }
  if (slot === 3 || slot === 4) {
    if (peakDps > 1400)        return 'roundhouse';
    if (peakDps > 700)         return 'kick';
    return 'knee';
  }
  return 'push';
}

// Max gap between two strikes for them to belong to the same combo. A jab-cross
// is ~200-400 ms apart; 2 s comfortably chains a combination but breaks between
// separate exchanges.
export const COMBO_GAP_MS = 2000;

function bucketForce(g) {
  if (g >= 10) return '10+';
  if (g >= 5)  return '5-10';
  if (g >= 3)  return '3-5';
  return '1-3';
}

function ensureLive(slot, mac) {
  let live = state.liveBySlot.get(slot);
  if (!live) {
    live = {
      mac, peakG: 0, peakHoldMs: 0, rmsG: 0,
      lastSeenMs: 0, lastRssi: 0,
      waveform: new Float32Array(WAVEFORM_SAMPLES),
      waveIdx: 0,
    };
    state.liveBySlot.set(slot, live);
  }
  return live;
}

export function ingestBatch({ slot, rssi, mac, samples, seq, recvMs, tMs }) {
  if (slot === 0) return;

  // Calibration mode: collect raw samples, skip detection so the user can hold still
  if (isCalibrating(slot)) {
    for (const s of samples) collectSample(slot, s);
    scheduleRender();
    return;
  }

  // Feed RAW samples (pre-calibration) to the AI inference ring — matches the
  // training CSV distribution, and works for both the WS and demo data paths.
  for (const s of samples) aiPushSample(slot, s);

  // Apply per-slot calibration offsets (no-op if not calibrated)
  for (const s of samples) applyOffset(slot, s);

  const live = ensureLive(slot, mac);
  if (mac) live.mac = mac;
  live.lastRssi   = rssi;
  live.lastSeenMs = recvMs ?? performance.now();

  let maxG   = 0;
  let maxDps = 0;
  let sumSqG = 0;
  for (const s of samples) {
    const a = magA(s);
    const g = magG(s);
    if (a > maxG)   maxG = a;
    if (g > maxDps) maxDps = g;
    sumSqG += a * a;
  }
  live.rmsG = Math.sqrt(sumSqG / samples.length);

  // Push a downsampled point per packet to waveform ring
  live.waveform[live.waveIdx] = maxG;
  live.waveIdx = (live.waveIdx + 1) % WAVEFORM_SAMPLES;

  // Keep visual feedback on the browser's current clock. WS frames also carry
  // the Main Node receive time mapped to this page's clock; that source time is
  // for detector/pose alignment only. A delayed packet must not make a body-map
  // flash or peak-hold look as if it happened in the past.
  const uiNowPerf = performance.now();
  const detectorPerf = Number.isFinite(tMs) ? tMs : uiNowPerf;
  if (maxG > live.peakG) {
    live.peakG      = maxG;
    live.peakHoldMs = uiNowPerf;
  }

  // always-on sensor activity — updated every packet regardless of recording,
  // so the user can see the rig is alive and reacting to G before pressing REC.
  // Report gravity-removed dynamic G (≈0 at rest) INSTANTANEOUSLY — no peak-hold
  // decay, so a stationary node reads a steady ~0 instead of a 1→0 sawtooth.
  const dynG = Math.max(0, maxG - 1);
  live.curG = dynG;                       // per-slot live value for the mixer
  const la = state.liveActivity;
  la.curG = dynG;                         // global live value for the topbar
  la.lastSampleMs = Date.now();

  // Track active time (only count packets while session active)
  if (state.session.active) {
    state.activeMsByWindow.push({ t: uiNowPerf, mag: live.rmsG });
    // keep last 60s of activity records
    const cutoff = uiNowPerf - 60_000;
    while (state.activeMsByWindow.length && state.activeMsByWindow[0].t < cutoff) state.activeMsByWindow.shift();
  }

  // strike detection — always fires (live feedback + gesture preview). Whether it
  // COUNTS toward the session stats/radar is gated on recording below.
  //
  // Detect on the loaded model's own settings when it has them, so the window the
  // model is handed is cut exactly as its training windows were. Falls back to the
  // manual sliders when no model is loaded.
  const recording = state.session.active || state.demoMode;

  // A strike whose window is still filling. The model is trained on windows that
  // run PAST the impact — the follow-through is what separates a Cross from a Jab
  // — so naming has to wait for those samples to arrive. See resolveNaming().
  advancePending(slot, samples.length);

  const hit = activeDetector().feed(slot, { maxG, maxDps, n: samples.length, tMs: detectorPerf });
  if (hit) {
    state.lastStrikeBySlot.set(slot, uiNowPerf);
    la.lastHitMs = Date.now();
    state.ui.bodyHitFlash.set(slot, uiNowPerf);         // body-map flash works even when idle
    // Log the strike NOW, unnamed. Count, force and the body-map flash are what a
    // coach reacts to in the moment and they must not lag behind the punch; the
    // technique name is filled in a few frames later, in place.
    const impactAtMs = hit.impactAtMs ?? hit.tMs ?? detectorPerf;
    const ev = recording
      ? recordStrike({ slot, peakG: hit.peakG, peakDps: hit.peakDps,
                       recvMs: recvMs ?? Date.now(), seq, impactAtMs })
      : null;
    // Camera setup should be checkable before pressing REC. The transient
    // attachment updates the motion panel but is intentionally not logged as a
    // strike until a session/demo is actually recording.
    if (!ev) attachPoseToImpact({ slot, impactAtMs });
    // The detector spends up to searchMs finding the true peak, so the stream has
    // already moved past it. hit.endBack rewinds to the impact; postPeak pushes
    // the window end forward into the follow-through.
    queueNaming(slot, hit.endBack, ev);
  }

  scheduleRender();
}

// ── deferred technique naming ────────────────────────────────────────────────
// The counting lives in naming.js; this is just what to do when it says go.
const naming = createNamingQueue(aiPostPeak);

function advancePending(slot, n) { classifyIfReady(slot, naming.advance(slot, n)); }
function queueNaming(slot, endBack, ev) { classifyIfReady(slot, naming.push(slot, endBack, ev)); }

function classifyIfReady(slot, due) {
  if (!due) return;                              // follow-through still arriving
  const ai = aiOnStrike(slot, due.back);
  if (!due.ctx || !ai || !ai.label) return;
  nameStrike(due.ctx, ai);
}

/** Attach a technique to a strike already in the log, and fix up what depended on it. */
function nameStrike(ev, ai) {
  ev.type    = ai.label;
  ev.aiLabel = ai.label;
  ev.aiConf  = ai.conf;
  // The score compares a strike with others of its OWN technique, so it has to be
  // recomputed now that the technique is known — the value written at log time
  // used the pooled reference.
  const sc = scoreStrike({ peakG: ev.peakG, peakDps: ev.peakDps }, aiStrikeNorm(ai.label));
  ev.score = sc.score; ev.scorePower = sc.power; ev.scoreSpeed = sc.speed; ev.scoreRef = sc.ref;
  state.distribution[ai.label] = (state.distribution[ai.label] || 0) + 1;
  state.strikeSeq++;                // nudge the log's change-detection signature
  scheduleRender();
}

/** Drop anything half-classified — session reset, model swap, node dropout. */
export function resetPendingNaming() { naming.clear(); }

function recordStrike({ slot, peakG, peakDps, recvMs, seq, impactAtMs }) {
  const sessionT = state.session.active ? (recvMs - state.session.startedAtMs) : 0;
  // Technique naming comes from the trained model alone, and arrives a few frames
  // later than the strike — see resolveNaming(). classifyStrike() is a hand-tuned
  // ladder of peak-G / rotation cut-offs that answers with the same confidence
  // whether or not it has any basis, and it cannot separate techniques that
  // differ in shape rather than force. Unnamed is honest; a guess dressed up as a
  // reading is not.
  const lastT    = state.strikes.length ? state.strikes[state.strikes.length - 1].sessionMs : 0;
  const recoverMs= sessionT - lastT;

  // Scored against the pooled reference for now; nameStrike() recomputes it
  // against the technique's own distribution once the technique is known.
  const sc = scoreStrike({ peakG, peakDps }, null);

  const ev = {
    id:        ++state.strikeSeq,
    slot, type: null, peakG, peakDps,
    score:      sc.score,
    scorePower: sc.power,
    scoreSpeed: sc.speed,
    scoreRef:   sc.ref,
    aiLabel:   null,
    aiConf:    0,
    durationMs: 0,
    recoverMs,
    sessionMs:  sessionT,
    wallMs:     recvMs,
    // This is performance.now() time, not a wall-clock field for export. It lets
    // the pose ring select the actual impact frame instead of the later moment
    // when the detector's post-peak search closed.
    impactAtMs,
    seq,
    round:      state.timer.mode === 'work' ? state.timer.currentRound : 0,
  };
  ev.pose = attachPoseToImpact(ev);
  state.strikes.push(ev);
  if (state.strikes.length > 500) state.strikes.shift();

  // Unnamed strikes still count toward force/asymmetry/fatigue — only the
  // technique breakdown needs a name to bucket into, and that happens in
  // nameStrike() when the model answers.
  state.histogram[bucketForce(peakG)]++;
  if (slot === 1 || slot === 3) state.leftCount++;
  if (slot === 2 || slot === 4) state.rightCount++;
  state.heatmapBySlot[slot] = (state.heatmapBySlot[slot] || 0) + 1;

  state.totalsForce += peakG;
  if (peakG > state.peakG) state.peakG = peakG;

  state.fatigueHistory.push({ t: recvMs, g: peakG });
  const cutoff = recvMs - state.tuning.fatigueWindow * 2;
  while (state.fatigueHistory.length && state.fatigueHistory[0].t < cutoff) state.fatigueHistory.shift();

  // Live combo: consecutive strikes within COMBO_GAP_MS. First strike after a
  // pause restarts the run at 1; `best` tracks the longest run this session.
  const c = state.combo;
  c.current = (c.lastAtMs && (recvMs - c.lastAtMs) <= COMBO_GAP_MS) ? c.current + 1 : 1;
  c.lastAtMs = recvMs;
  if (c.current > c.best) c.best = c.current;

  // Goal completion check
  checkGoalCompletion();
  return ev;                 // the caller names it once the model answers
}

function checkGoalCompletion() {
  if (state.goals.completedAt) return;
  const g = state.goals;
  const meet =
    state.strikes.length >= (g.targetStrikes || Infinity) &&
    state.peakG          >= (g.targetPeakG   || Infinity);
  if (meet) {
    state.goals.completedAt = Date.now();
    pushActivity('goal', `🏆 Goal reached · ${state.strikes.length} strikes · peak ${state.peakG.toFixed(1)}g`);
  }
}

// Round transition snapshot — called from timer.js onPhaseChange
export function snapshotRound(roundNum) {
  if (roundNum < 1) return;
  const inRound = state.strikes.filter(s => s.round === roundNum);
  if (!inRound.length) {
    state.perRound.push({ round: roundNum, strikes: 0, peakG: 0, avgG: 0, asym: 0.5, fatiguePct: 0 });
    return;
  }
  const peakG = inRound.reduce((m, s) => Math.max(m, s.peakG), 0);
  const sum   = inRound.reduce((s, x) => s + x.peakG, 0);
  const avg   = sum / inRound.length;
  const L = inRound.filter(s => s.slot === 1 || s.slot === 3).length;
  const R = inRound.filter(s => s.slot === 2 || s.slot === 4).length;
  const asym = (L + R) > 0 ? L / (L + R) : 0.5;
  const half = Math.floor(inRound.length / 2);
  let fatiguePct = 0;
  if (half >= 3) {
    const a = inRound.slice(0, half).reduce((s,x)=>s+x.peakG,0) / half;
    const b = inRound.slice(half).reduce((s,x)=>s+x.peakG,0) / (inRound.length - half);
    if (a > 0) fatiguePct = Math.max(0, Math.min(100, Math.round(((a - b) / a) * 100)));
  }
  state.perRound.push({ round: roundNum, strikes: inRound.length, peakG, avgG: avg, asym, fatiguePct });
}

// Derived metrics
export function computeSpm() {
  if (!state.session.active) return 0;
  const mins = (Date.now() - state.session.startedAtMs) / 60000;
  return mins > 0 ? state.strikes.length / mins : 0;
}
export function computeAvgG() { return state.strikes.length ? (state.totalsForce / state.strikes.length) : 0; }
export function computeAsymRatio() {
  const t = state.leftCount + state.rightCount;
  return t > 0 ? state.leftCount / t : 0.5;
}
export function computeFatigue() {
  const arr = state.fatigueHistory;
  if (arr.length < 6) return { pct: 0, label: 'stable' };
  const half = Math.floor(arr.length / 2);
  const a = arr.slice(0, half).reduce((s,x)=>s+x.g,0) / half;
  const b = arr.slice(half).reduce((s,x)=>s+x.g,0) / (arr.length - half);
  if (a <= 0) return { pct: 0, label: 'stable' };
  const drop = Math.max(0, (a - b) / a);
  const pct = Math.min(100, Math.round(drop * 100));
  const label = pct < 15 ? 'stable' : pct < 35 ? 'fatiguing' : 'severely fatigued';
  return { pct, label };
}
export function computeCv() {
  const n = state.strikes.length;
  if (n < 3) return 0;
  const m = computeAvgG();
  if (m === 0) return 0;
  let v = 0;
  for (const s of state.strikes) v += (s.peakG - m) ** 2;
  v /= n;
  return Math.sqrt(v) / m;
}
export function computeWorkKJ() {
  let j = 0;
  for (const s of state.strikes) {
    const mass = (s.slot === 1 || s.slot === 2) ? 4 : 12;
    const v    = (s.peakG * 9.81) * (state.tuning.refractoryMs / 2000);
    j += 0.5 * mass * v * v;
  }
  return j / 1000;
}

/** % of last 30s that had movement (rms above quarter of threshold) */
export function computeTimeOnTarget() {
  if (!state.session.active) return 0;
  const arr = state.activeMsByWindow;
  if (!arr.length) return 0;
  const cutoff = performance.now() - 30_000;
  const recent = arr.filter(r => r.t >= cutoff);
  if (!recent.length) return 0;
  const active = recent.filter(r => r.mag >= state.tuning.thresholdG * 0.25).length;
  return Math.round((active / recent.length) * 100);
}

export function addMarker(label) {
  if (!state.session.active) return null;
  const sessionMs = Date.now() - state.session.startedAtMs;
  const m = {
    id: ++state.markerSeq,
    sessionMs,
    wallMs: Date.now(),
    label: label || `Marker #${state.markerSeq}`,
  };
  state.markers.push(m);
  pushActivity('marker', `📍 ${m.label} @ ${(sessionMs/1000).toFixed(1)}s`);
  return m;
}

export function deleteMarker(id) {
  state.markers = state.markers.filter(m => m.id !== id);
}
