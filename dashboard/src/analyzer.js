// Strike detection, waveform buffer, per-round + time-on-target tracking.
import { state, scheduleRender, pushActivity, WAVEFORM_SAMPLES } from './state.js';
import { applyOffset, isCalibrating, collectSample } from './calibrate.js';

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

export function ingestBatch({ slot, rssi, mac, samples, seq, recvMs }) {
  if (slot === 0) return;

  // Calibration mode: collect raw samples, skip detection so the user can hold still
  if (isCalibrating(slot)) {
    for (const s of samples) collectSample(s);
    scheduleRender();
    return;
  }

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

  const nowPerf = performance.now();
  if (maxG > live.peakG) {
    live.peakG      = maxG;
    live.peakHoldMs = nowPerf;
  }

  // Track active time (only count packets while session active)
  if (state.session.active) {
    state.activeMsByWindow.push({ t: nowPerf, mag: live.rmsG });
    // keep last 60s of activity records
    const cutoff = nowPerf - 60_000;
    while (state.activeMsByWindow.length && state.activeMsByWindow[0].t < cutoff) state.activeMsByWindow.shift();
  }

  // strike detection
  const lastStrikeAt = state.lastStrikeBySlot.get(slot) || 0;
  if (maxG >= state.tuning.thresholdG && (nowPerf - lastStrikeAt) >= state.tuning.refractoryMs) {
    state.lastStrikeBySlot.set(slot, nowPerf);
    recordStrike({ slot, peakG: maxG, peakDps: maxDps, recvMs: recvMs ?? Date.now(), seq });
  }

  scheduleRender();
}

function recordStrike({ slot, peakG, peakDps, recvMs, seq }) {
  const sessionT = state.session.active ? (recvMs - state.session.startedAtMs) : 0;
  const type     = classifyStrike(slot, peakG, peakDps);
  const lastT    = state.strikes.length ? state.strikes[state.strikes.length - 1].sessionMs : 0;
  const recoverMs= sessionT - lastT;

  const ev = {
    id:        ++state.strikeSeq,
    slot, type, peakG, peakDps,
    durationMs: 0,
    recoverMs,
    sessionMs:  sessionT,
    wallMs:     recvMs,
    seq,
    round:      state.timer.mode === 'work' ? state.timer.currentRound : 0,
  };
  state.strikes.push(ev);
  if (state.strikes.length > 500) state.strikes.shift();

  state.distribution[type]      = (state.distribution[type] || 0) + 1;
  state.histogram[bucketForce(peakG)]++;
  if (slot === 1 || slot === 3) state.leftCount++;
  if (slot === 2 || slot === 4) state.rightCount++;
  state.heatmapBySlot[slot] = (state.heatmapBySlot[slot] || 0) + 1;

  state.totalsForce += peakG;
  if (peakG > state.peakG) state.peakG = peakG;

  state.fatigueHistory.push({ t: recvMs, g: peakG });
  const cutoff = recvMs - state.tuning.fatigueWindow * 2;
  while (state.fatigueHistory.length && state.fatigueHistory[0].t < cutoff) state.fatigueHistory.shift();

  state.ui.bodyHitFlash.set(slot, performance.now());

  // Goal completion check
  checkGoalCompletion();
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
