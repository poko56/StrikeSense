// Dashboard-side sensor calibration.
// Captures static samples per slot, computes per-axis offsets (removing 1g on Z for gravity),
// applies offsets to incoming samples in analyzer.ingestBatch() before strike detection.
//
// NOTE: This calibration affects DASHBOARD VIEW ONLY. The CSV recordings written by
// the Main Node firmware to SD card remain RAW int16 values — that's a firmware concern.
// AI team can apply the same offsets at training time if they want.

import { state, scheduleRender, pushActivity } from './state.js';
import { persist } from './persist.js';

const PERSIST_KEY = 'calibration';

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

/** Called from analyzer when calibration is active for that slot */
export function collectSample(sample) {
  state.calibration.collected.push(sample);
}

/** Returns true if `slot` is currently being calibrated */
export function isCalibrating(slot) {
  return state.calibration.active === slot;
}

/**
 * Start calibration capture for a slot.
 *   onProgress(elapsedMs, sampleCount) — called periodically
 * Returns a controller { promise, abort() } that resolves when complete.
 */
export function startCalibration(slot, mac, durationMs, onProgress) {
  abortCalibration();  // safety: cancel any other in-progress
  state.calibration.active     = slot;
  state.calibration.collected  = [];
  state.calibration.startedAt  = performance.now();
  state.calibration.durationMs = durationMs;

  let progressTimer = null;
  let aborted = false;

  const promise = new Promise((resolve, reject) => {
    progressTimer = setInterval(() => {
      if (aborted) return;
      const elapsed = performance.now() - state.calibration.startedAt;
      onProgress?.(elapsed, state.calibration.collected.length);
      if (elapsed >= durationMs) {
        clearInterval(progressTimer);
        finalize(slot, mac, resolve, reject);
      }
    }, 100);
  });

  function abort() {
    aborted = true;
    if (progressTimer) clearInterval(progressTimer);
    state.calibration.active = 0;
    state.calibration.collected = [];
    scheduleRender();
  }

  return { promise, abort };
}

function finalize(slot, mac, resolve, reject) {
  const samples = state.calibration.collected;
  state.calibration.active    = 0;
  state.calibration.collected = [];

  if (samples.length < 20) {
    scheduleRender();
    reject(new Error(`Not enough samples (${samples.length}). Make sure the node is powered + assigned + transmitting.`));
    return;
  }

  // Average per axis
  const sum = { ax: 0, ay: 0, az: 0, gx: 0, gy: 0, gz: 0 };
  for (const s of samples) {
    sum.ax += s.ax; sum.ay += s.ay; sum.az += s.az;
    sum.gx += s.gx; sum.gy += s.gy; sum.gz += s.gz;
  }
  const n = samples.length;
  const off = {
    ax: sum.ax / n,
    ay: sum.ay / n,
    az: sum.az / n - 1.0,    // subtract 1g for gravity on Z (assume node faces up)
    gx: sum.gx / n,
    gy: sum.gy / n,
    gz: sum.gz / n,
    samples: n,
    calibratedAt: Date.now(),
    mac: mac || null,
  };
  state.calibration.offsets.set(slot, off);
  saveCalibration();
  pushActivity('cal', `🎯 Calibrated slot ${slot} · n=${n}`);
  scheduleRender();
  resolve({ slot, samples: n, offset: off });
}

export function abortCalibration() {
  if (state.calibration.active) {
    state.calibration.active    = 0;
    state.calibration.collected = [];
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
  scheduleRender();
}
