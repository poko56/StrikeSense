// Unit tests for the physics prior that gets fused with the network.

import test from 'node:test';
import assert from 'node:assert/strict';
import { windowPhysics, fusePhysics } from '../src/physics.js';

const T = 4, F = 6;

/** A raw window with a constant accel magnitude and gyro magnitude. */
function flatWindow(g, dps, peakAt = -1, peakG = 0, peakDps = 0) {
  const raw = new Float32Array(T * F);
  for (let t = 0; t < T; t++) {
    const use = t === peakAt;
    raw[t * F]     = use ? peakG : g;      // ax carries the whole accel
    raw[t * F + 3] = use ? peakDps : dps;  // gx carries the whole rotation
  }
  return raw;
}

test('windowPhysics reports the PEAK, not the mean', () => {
  const [lg, ld] = windowPhysics(flatWindow(2, 100, 2, 18, 900), T, F);
  assert.ok(Math.abs(Math.exp(lg) - 18) < 0.01);
  assert.ok(Math.abs(Math.exp(ld) - 900) < 0.5);
});

test('windowPhysics combines all three axes', () => {
  const raw = new Float32Array(T * F);
  raw[0] = 3; raw[1] = 4;            // |accel| = 5
  raw[3] = 6; raw[4] = 8;            // |gyro|  = 10
  const [lg, ld] = windowPhysics(raw, T, F);
  assert.ok(Math.abs(Math.exp(lg) - 5) < 0.01);
  assert.ok(Math.abs(Math.exp(ld) - 10) < 0.01);
});

// Two classes that the network cannot tell apart but force separates cleanly —
// the Elbow-Up (7 g) vs Kick-Low (18 g) case measured in ml_pipeline/data.
const PHYSICS = {
  weight: 0.2,
  mean: [[Math.log(7), Math.log(600)], [Math.log(18), Math.log(850)]],
  std:  [[0.25, 0.35], [0.25, 0.35]],
};

test('a light strike is pulled toward the light class', () => {
  const feat = windowPhysics(flatWindow(0, 0, 0, 7, 600), T, F);
  const out = fusePhysics([0.5, 0.5], feat, PHYSICS);
  assert.ok(out[0] > out[1], 'expected the 7 g class to win');
});

test('a heavy strike is pulled toward the heavy class', () => {
  const feat = windowPhysics(flatWindow(0, 0, 0, 18, 850), T, F);
  const out = fusePhysics([0.5, 0.5], feat, PHYSICS);
  assert.ok(out[1] > out[0], 'expected the 18 g class to win');
});

test('the prior can overturn a wrong-but-weak network call', () => {
  // The network leans 60/40 the wrong way; force says otherwise, decisively.
  const feat = windowPhysics(flatWindow(0, 0, 0, 18, 850), T, F);
  const out = fusePhysics([0.6, 0.4], feat, PHYSICS);
  assert.ok(out[1] > out[0]);
});

test('the prior cannot overturn a confident network call', () => {
  // The network is the only thing that sees technique SHAPE. A prior that could
  // flip a 99% call would turn every hard jab into whichever class is heaviest.
  const feat = windowPhysics(flatWindow(0, 0, 0, 18, 850), T, F);
  const out = fusePhysics([0.99, 0.01], feat, PHYSICS);
  assert.ok(out[0] > out[1], 'a 99% network call must survive the prior');
});

test('probabilities stay normalised', () => {
  const feat = windowPhysics(flatWindow(0, 0, 0, 12, 700), T, F);
  const out = fusePhysics([0.2, 0.8], feat, PHYSICS);
  const sum = out.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-6);
});

// ── models without a prior ──────────────────────────────────────────────────

test('a model file with no physics block is passed through untouched', () => {
  const probs = [0.7, 0.3];
  const out = fusePhysics(probs, [1, 1], null);
  assert.deepEqual(Array.from(out).map(v => +v.toFixed(6)), [0.7, 0.3]);
});

test('weight 0 means the calibration found no gain — network answers alone', () => {
  const out = fusePhysics([0.7, 0.3], [99, 99], { ...PHYSICS, weight: 0 });
  assert.deepEqual(Array.from(out).map(v => +v.toFixed(6)), [0.7, 0.3]);
});

test('a physics block of the wrong length is ignored, not applied half-way', () => {
  const out = fusePhysics([0.7, 0.2, 0.1], [1, 1], PHYSICS);   // 3 classes, 2 rows
  assert.deepEqual(Array.from(out).map(v => +v.toFixed(6)), [0.7, 0.2, 0.1]);
});

test('a zero probability never becomes NaN', () => {
  const feat = windowPhysics(flatWindow(0, 0, 0, 18, 850), T, F);
  const out = fusePhysics([1, 0], feat, PHYSICS);
  assert.ok(Number.isFinite(out[0]) && Number.isFinite(out[1]));
  assert.ok(out[1] > 0);
});
