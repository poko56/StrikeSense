// Physics prior — the second opinion that gets fused with the network.
//
// The network is trained to be partly blind to how hard a strike was, on purpose:
// every window is per-axis standardised, and training augments each one by a
// random 0.85-1.15 gain so a Hook reads as a Hook at 6 g or at 11 g. That is the
// right call for technique shape and the wrong one for the few techniques that
// differ mainly in magnitude. Measured over ml_pipeline/data at the detected
// impacts:
//
//   Elbow-Up   7 g /  604 dps   vs   Kick-Low  18 g / 843 dps    (Cohen d 2.28)
//   Uppercut   8 g /  628 dps   vs   Hook      16 g / 954 dps    (d 1.13 on gy)
//
// Both pairs are live confusions in the model's matrix, and absolute magnitude
// separates them cleanly — so magnitude is real information the network gave up.
// This module hands it back.
//
// It is NOT the old classifyStrike() ladder. That was a hand-written staircase of
// cut-offs ("peakG > 9 → elbow") with no measurement behind any number, and it
// answered with the same confidence whether or not it had a basis. What runs here
// is one Gaussian per class fitted to the training windows, added in log space,
// at a weight chosen by measuring accuracy on held-out validation data. When the
// prior does not help, the calibration drives its weight to 0 and the network
// answers alone.
//
// What this cannot fix, and does not claim to: Elbow-Chop vs Elbow-Slash (d
// 0.53), Jab vs Cross (d 0.53), Roundhouse vs Kick-Low (d 0.46). Those differ in
// shape, not in force. No threshold on peak G will ever separate them.

/**
 * Peak |accel| (g) and peak |gyro| (dps) inside a raw, UNNORMALISED window.
 * Must match window_physics() in ml_pipeline/train_model.py exactly.
 * @param {ArrayLike<number>} raw  timeSteps × features, row-major
 * @param {number} T
 * @param {number} F
 */
export function windowPhysics(raw, T, F) {
  let acc = 0, rot = 0;
  for (let t = 0; t < T; t++) {
    const i = t * F;
    const a = Math.hypot(raw[i], raw[i + 1], raw[i + 2]);
    const w = Math.hypot(raw[i + 3], raw[i + 4], raw[i + 5]);
    if (a > acc) acc = a;
    if (w > rot) rot = w;
  }
  return [Math.log(acc + 1e-3), Math.log(rot + 1e-3)];
}

/**
 * Blend the network's posterior with the physics prior, in log space.
 *
 * @param {ArrayLike<number>} probs  network softmax, length C
 * @param {[number,number]} feat     from windowPhysics()
 * @param {{weight:number, mean:number[][], std:number[][]}|null} physics
 *        the model file's `physics` block; null (or weight 0) returns `probs`
 *        untouched, which is what older model files get.
 * @returns {Float32Array} renormalised probabilities, length C
 */
export function fusePhysics(probs, feat, physics) {
  const C = probs.length;
  if (!physics || !(physics.weight > 0) ||
      !Array.isArray(physics.mean) || physics.mean.length !== C) {
    return Float32Array.from(probs);
  }
  const w = physics.weight;
  const score = new Float64Array(C);
  let max = -Infinity;
  for (let c = 0; c < C; c++) {
    const mu = physics.mean[c], sd = physics.std[c];
    let logp = 0;
    for (let k = 0; k < 2; k++) {
      const s = sd[k] > 1e-6 ? sd[k] : 1e-6;
      const z = (feat[k] - mu[k]) / s;
      logp += -0.5 * z * z - Math.log(s);
    }
    score[c] = Math.log(Math.max(probs[c], 1e-9)) + w * logp;
    if (score[c] > max) max = score[c];
  }
  let sum = 0;
  const out = new Float32Array(C);
  for (let c = 0; c < C; c++) { out[c] = Math.exp(score[c] - max); sum += out[c]; }
  for (let c = 0; c < C; c++) out[c] /= sum;
  return out;
}
