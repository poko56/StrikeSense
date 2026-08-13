// Unit tests for the impact detector — `npm test` in dashboard/.
//
// These encode the failures that made the live view unusable: an ordinary
// footfall counted as a strike, and one kick counted as three or four. Each test
// names the behaviour it locks in, so a future retune that breaks one says which
// symptom is coming back.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createDetector, normalizeDetect, DEFAULT_DETECT_V2 } from '../src/detector.js';

const FRAME = 8;              // samples per radio packet (protocol.h)
const FRAME_MS = FRAME / 400 * 1000;   // 20 ms

/** Feed a G profile, one value per frame, and collect what fires. */
function run(det, profile, { slot = 3, dps = 2000, t0 = 0 } = {}) {
  const hits = [];
  profile.forEach((maxG, i) => {
    const h = det.feed(slot, {
      maxG,
      maxDps: typeof dps === 'function' ? dps(i) : dps,
      n: FRAME,
      tMs: t0 + i * FRAME_MS,
    });
    if (h) hits.push({ frame: i, ...h });
  });
  return hits;
}

const v2 = (over = {}) => createDetector({ ...DEFAULT_DETECT_V2, ...over });

// ── the "walking counts as a kick" family ───────────────────────────────────

test('rest does not fire — gravity alone is 1.0 g, not an impact', () => {
  const hits = run(v2(), Array(50).fill(1.0));
  assert.equal(hits.length, 0);
});

test('a walking-strength footfall does not fire', () => {
  // A shin IMU reads roughly 3-4 g total on an ordinary step. Under the old
  // rule (>= 3.0 g including gravity) every step was a strike.
  const walk = [1, 1, 1.2, 3.5, 4.0, 3.2, 1.5, 1, 1, 1];
  assert.equal(run(v2(), walk).length, 0);
});

test('a real strike fires exactly once', () => {
  const strike = [1, 1, 2, 5, 9, 14, 11, 6, 2, 1, 1, 1, 1];
  const hits = run(v2(), strike);
  assert.equal(hits.length, 1);
});

// ── the "one kick logged three times" family ────────────────────────────────

test('chamber, impact and foot landing count as one strike, not three', () => {
  // Shape measured in ml_pipeline/data: the leg lifts (~5 g), the shin lands
  // (~14 g), the foot returns to the floor (~7 g), all inside ~400 ms.
  const kick = [1, 1, 5, 5.5, 4, 3, 9, 14, 12, 5, 2, 1.2, 7, 6, 2, 1, 1, 1];
  const hits = run(v2(), kick);
  assert.equal(hits.length, 1, 'expected one impact for one kick');
});

test('two genuinely separate strikes both fire', () => {
  const quiet = Array(30).fill(1);       // 600 ms > refractory
  const hit   = [2, 6, 12, 8, 2, 1];
  const hits  = run(v2(), [...hit, ...quiet, ...hit, ...quiet]);
  assert.equal(hits.length, 2);
});

test('the limb must go quiet before it can fire again', () => {
  // Sustained hard motion with no let-up (a shin scraping a bag) is one event.
  const hits = run(v2(), Array(80).fill(9));
  assert.equal(hits.length, 1);
});

// ── window alignment ────────────────────────────────────────────────────────

test('reports the peak, not the first frame over the threshold', () => {
  const [hit] = run(v2(), [1, 1, 6, 8, 15, 9, 3, 1, 1, 1]);
  assert.equal(hit.peakG, 15);
});

test('reports the peak timestamp for camera-to-IMU fusion', () => {
  const [hit] = run(v2(), [1, 1, 6, 8, 15, 9, 3, 1, 1, 1], { t0: 1000 });
  assert.equal(hit.impactAtMs, 1000 + 4 * FRAME_MS,
    'the matched pose must be from the true impact peak, not detector close time');
});

test('endBack rewinds the window to the frame that held the peak', () => {
  // Peak in frame 3, then a long slow decay: the search expires four frames
  // later, so the window has to be rewound by exactly that much.
  const [hit] = run(v2(), [1, 1, 6, 15, 9, 8, 7, 6, 5, 4, 1, 1]);
  assert.equal(hit.endBack, (hit.frame - 3) * FRAME,
    'window must end at the peak frame, not wherever the search closed');
  assert.ok(hit.endBack > 0);
});

test('v2 always rewinds at least one frame — it never fires on the peak itself', () => {
  // A frame that sets a new peak restarts the search by definition, so the fire
  // always lands at least one frame later. Anything that classified at `endBack
  // = 0` would be handing the model a window that ends past the impact.
  const [hit] = run(v2(), [1, 1, 6, 7, 8, 1, 1, 1]);
  assert.equal(hit.endBack, FRAME);
});

test('a rising burst is followed to its top, not cut off at the wind-up', () => {
  // A kick is one continuous burst: the chamber arms the detector, the impact
  // lands ~250 ms later and is three times harder. Firing on the chamber would
  // report a third of the real force AND refract away the strike itself.
  const kick = [1, 1, 6, 6.5, 5.5, 5, 6, 8, 11, 16, 12, 6, 2, 1, 1, 1];
  const hits = run(v2(), kick);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].peakG, 16, 'must report the impact, not the chamber');
});

// ── rotation floor ──────────────────────────────────────────────────────────

test('minPeakDps rejects a hard jolt that barely rotates', () => {
  const jolt = [1, 1, 8, 12, 6, 1, 1, 1, 1];
  assert.equal(run(v2({ minPeakDps: 400 }), jolt, { dps: 150 }).length, 0);
  assert.equal(run(v2({ minPeakDps: 400 }), jolt, { dps: 900 }).length, 1);
});

test('a suppressed impact does not consume the refractory', () => {
  const det  = v2({ minPeakDps: 400 });
  const jolt = [1, 1, 8, 12, 6, 1, 1];
  run(det, jolt, { dps: 150, t0: 0 });                       // rejected
  const hits = run(det, jolt, { dps: 900, t0: 140 });        // 140 ms later
  assert.equal(hits.length, 1, 'a real strike right after must still register');
});

// ── per-slot isolation ──────────────────────────────────────────────────────

test('limbs do not share detector state', () => {
  const det = v2();
  const strike = [1, 2, 6, 12, 7, 2, 1];
  const a = run(det, strike, { slot: 1 });
  const b = run(det, strike, { slot: 3 });
  assert.equal(a.length, 1);
  assert.equal(b.length, 1);
});

// ── version handling ────────────────────────────────────────────────────────

test('settings without a version are treated as v1', () => {
  // Model files exported before the rewrite were cut by the first-crossing rule
  // and must keep being fed that way, or their windows shift.
  assert.equal(normalizeDetect({ thresholdG: 3, refractoryMs: 250 }).version, 1);
  assert.equal(normalizeDetect(null).version, 1);
});

test('v1 still fires on the first crossing, with no rewind', () => {
  const det = createDetector({ version: 1, thresholdG: 3, refractoryMs: 250 });
  const [hit] = run(det, [1, 1, 3.5, 9, 14, 5, 1]);
  assert.equal(hit.frame, 2, 'v1 fires on the first frame over the threshold');
  assert.equal(hit.endBack, 0);
  assert.equal(hit.peakG, 3.5);
});

test('v1 refractory is honoured', () => {
  const det = createDetector({ version: 1, thresholdG: 3, refractoryMs: 250 });
  // 250 ms = 12.5 frames; 10 frames of quiet is not enough for a second hit.
  const hits = run(det, [4, ...Array(10).fill(1), 4]);
  assert.equal(hits.length, 1);
});
