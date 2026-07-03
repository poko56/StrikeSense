// Dashboard-side sensor calibration.
// Captures static samples per slot, computes per-axis offsets, removes 1g of gravity
// from whichever accel axis is dominant (so the node can be calibrated in ANY orientation),
// then applies offsets to incoming samples in analyzer.ingestBatch() before strike detection.
//
// Supports two modes:
//   • single-slot  — startCalibration(slot, mac, dur, onProgress)
//   • all-at-once  — startCalibrationFor([{slot,mac}, …], dur, onProgress)  ← "Calibrate whole body"
//
// NOTE: This calibration affects DASHBOARD VIEW ONLY. The CSV recordings written by
// the Main Node firmware to SD card remain RAW int16 values — that's a firmware concern.
// AI team can apply the same offsets at training time if they want.

import { state, scheduleRender, pushActivity } from './state.js';
import { persist } from './persist.js';

const PERSIST_KEY = 'calibration';
const MIN_SAMPLES = 20;

/** Restore offsets map from localStorage. Called once at boot. */
export function loadCalibration() {
  const raw = persist.get(PERSIST_KEY, {});
  for (const [slot, off] of Object.entries(raw || {})) {
    state.calibration.offsets.set(Number(slot), off);
  }
}

function saveCalibration() {
  const obj = {};
  for (const [slot, off] of state.calibration.offsets) obj[slot] = off;
  persist.set(PERSIST_KEY, obj);
}

/** Apply calibration offset in-place to a sample (no-op if slot not calibrated) */
export function applyOffset(slot, sample) {
  const off = state.calibration.offsets.get(slot);
  if (!off) return sample;
  sample.ax -= off.ax;
  sample.ay -= off.ay;
  sample.az -= off.az;
  sample.gx -= off.gx;
  sample.gy -= off.gy;
  sample.gz -= off.gz;
  return sample;
}

/** Called from analyzer for each sample while `slot` is being calibrated */
export function collectSample(slot, sample) {
  let arr = state.calibration.collectedBySlot.get(slot);
  if (!arr) { arr = []; state.calibration.collectedBySlot.set(slot, arr); }
  arr.push({ ax: sample.ax, ay: sample.ay, az: sample.az, gx: sample.gx, gy: sample.gy, gz: sample.gz });
}

/** Returns true if `slot` is currently being calibrated */
export function isCalibrating(slot) {
  return state.calibration.activeSlots.has(slot);
}

/** Returns true if ANY slot is being calibrated */
export function isCalibratingAny() {
  return state.calibration.activeSlots.size > 0;
}

function resetCalState() {
  state.calibration.activeSlots     = new Set();
  state.calibration.collectedBySlot = new Map();
  state.calibration.active          = 0;
}

// Gravity-aware offset: average each axis, then strip 1g from the dominant accel axis.
// This lets calibration work in any posture (hand flat, shin vertical, …).
function computeOffset(samples, mac) {
  const sum = { ax: 0, ay: 0, az: 0, gx: 0, gy: 0, gz: 0 };
  for (const s of samples) {
    sum.ax += s.ax; sum.ay += s.ay; sum.az += s.az;
    sum.gx += s.gx; sum.gy += s.gy; sum.gz += s.gz;
  }
  const n = samples.length;
  const m = {
    ax: sum.ax / n, ay: sum.ay / n, az: sum.az / n,
    gx: sum.gx / n, gy: sum.gy / n, gz: sum.gz / n,
  };
  // dominant accel axis = where gravity is pointing
  const cand = [['ax', m.ax], ['ay', m.ay], ['az', m.az]];
  cand.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  const gAxis = cand[0][0];
  const off = { ...m };
  off[gAxis] -= Math.sign(m[gAxis] || 1) * 1.0;   // remove 1g (sign-preserving)
  off.samples      = n;
  off.calibratedAt = Date.now();
  off.mac          = mac || null;
  off.gravityAxis  = gAxis;
  return off;
}

/**
 * Start calibration for a set of targets at once.
 *   targets    — [{ slot, mac }]
 *   onProgress — (elapsedMs, countsBySlot: Map<slot,count>) => void
 * Returns { promise, abort } — promise resolves { results: Map<slot,{samples,offset}>, failed: [{slot,reason}] }
 */
export function startCalibrationFor(targets, durationMs, onProgress) {
  abortCalibration();

  const macBySlot = new Map();
  const slots = [];
  for (const t of targets) {
    if (t.slot > 0 && !macBySlot.has(t.slot)) { slots.push(t.slot); macBySlot.set(t.slot, t.mac); }
  }

  state.calibration.activeSlots     = new Set(slots);
  state.calibration.collectedBySlot = new Map();
  state.calibration.active          = slots.length === 1 ? slots[0] : 0;
  state.calibration.startedAt       = performance.now();
  state.calibration.durationMs      = durationMs;

  let timer = null;
  let aborted = false;

  const promise = new Promise((resolve) => {
    timer = setInterval(() => {
      if (aborted) return;
      const elapsed = performance.now() - state.calibration.startedAt;
      const counts = new Map();
      for (const s of slots) counts.set(s, (state.calibration.collectedBySlot.get(s) || []).length);
      onProgress?.(elapsed, counts);
      if (elapsed >= durationMs) {
        clearInterval(timer);
        finalizeAll(slots, macBySlot, resolve);
      }
    }, 100);
  });

  function abort() {
    aborted = true;
    if (timer) clearInterval(timer);
    resetCalState();
    scheduleRender();
  }

  return { promise, abort };
}

function finalizeAll(slots, macBySlot, resolve) {
  const results = new Map();
  const failed  = [];
  for (const slot of slots) {
    const samples = state.calibration.collectedBySlot.get(slot) || [];
    if (samples.length < MIN_SAMPLES) {
      failed.push({ slot, reason: `${samples.length} samples` });
      continue;
    }
    const off = computeOffset(samples, macBySlot.get(slot));
    state.calibration.offsets.set(slot, off);
    results.set(slot, { samples: samples.length, offset: off });
    pushActivity('cal', `🎯 Calibrated slot ${slot} · n=${samples.length}`);
  }
  saveCalibration();
  resetCalState();
  scheduleRender();
  resolve({ results, failed });
}

/**
 * Single-slot calibration (used by the per-node CALIBRATE button).
 *   onProgress(elapsedMs, sampleCount)
 * Returns { promise, abort } — promise resolves { slot, samples, offset }, rejects on too-few-samples.
 */
export function startCalibration(slot, mac, durationMs, onProgress) {
  const ctrl = startCalibrationFor(
    [{ slot, mac }],
    durationMs,
    (elapsed, counts) => onProgress?.(elapsed, counts.get(slot) || 0),
  );
  const promise = ctrl.promise.then(({ results, failed }) => {
    const r = results.get(slot);
    if (r) return { slot, samples: r.samples, offset: r.offset };
    const f = failed.find(x => x.slot === slot);
    throw new Error(
      `Not enough samples (${f ? f.reason : '0'}). Make sure the node is powered + assigned + transmitting.`,
    );
  });
  return { promise, abort: ctrl.abort };
}

export function abortCalibration() {
  if (state.calibration.activeSlots.size) {
    resetCalState();
    scheduleRender();
  }
}

/** Remove calibration for a slot */
export function clearCalibration(slot) {
  state.calibration.offsets.delete(slot);
  saveCalibration();
  pushActivity('cal', `🗑 Cleared calibration for slot ${slot}`);
  scheduleRender();
}

/** Clear ALL calibrations */
export function clearAllCalibration() {
  state.calibration.offsets.clear();
  saveCalibration();
  pushActivity('cal', `🗑 Cleared all calibration`);
  scheduleRender();
}
