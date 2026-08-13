// Per-strike score — one 0-100 number a coach can read off the history at a
// glance, instead of comparing two raw columns (g and °/s) in their head.
//
// What the number means: how this strike compares with strikes OF THE SAME
// TECHNIQUE in the recorded data. 50 is a typical one. That framing is what makes
// it useful — an uppercut lands around 9.5 g and a cross around 14.2 g, so a
// single "hard = high score" rule would mark every uppercut as weak and flatter
// every cross. The per-technique reference comes from the `physics` block the
// training pipeline already fits and ships inside the model file
// (ml_pipeline/train_model.py, fit_physics), so nothing here is a guessed
// threshold — it is the measured distribution of real recordings.
//
// Both halves are log-normal, hence z-scores on the log of each quantity:
//
//   power  peak |accel|  how hard it landed
//   speed  peak |gyro|   how fast the limb was turning through it
//
// score = 50 + SPREAD × mean(z_power, z_speed), clamped to 1-100. SPREAD is set
// so one standard deviation above the technique's own average reads about 72 and
// two read about 94 — a scale where the top of the range is reachable in a good
// session but not routine.

const SPREAD = 22;

// Last-resort reference, used when no model is loaded or the strike has no
// technique name: the pooled distribution across all nine techniques in
// ml_pipeline/data (geometric means 11.6 g and 846 °/s). A score against this is
// "compared with a typical strike" rather than "compared with a typical jab",
// which is weaker but still honest.
export const POOLED_NORM = {
  muG: 2.4499, sdG: 0.6659,     // log g
  muD: 6.7406, sdD: 0.5704,     // log °/s
};

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * @param {{peakG:number, peakDps:number}} strike
 * @param {{muG:number,sdG:number,muD:number,sdD:number}|null} norm
 *        the technique's own reference; POOLED_NORM is used when absent
 * @returns {{score:number, power:number, speed:number, ref:'technique'|'pooled'}}
 */
export function scoreStrike(strike, norm) {
  const n = norm || POOLED_NORM;
  const g = Math.max(strike.peakG || 0, 1e-3);
  const d = Math.max(strike.peakDps || 0, 1e-3);

  // A degenerate reference (a class with almost no samples behind it) would turn
  // a small difference into a huge z. Floor the spread rather than let one thin
  // class produce 100s and 1s.
  const sdG = Math.max(n.sdG || 0, 0.15);
  const sdD = Math.max(n.sdD || 0, 0.15);

  const zg = (Math.log(g) - n.muG) / sdG;
  const zd = (Math.log(d) - n.muD) / sdD;

  return {
    score: Math.round(clamp(50 + SPREAD * ((zg + zd) / 2), 1, 100)),
    power: Math.round(clamp(50 + SPREAD * zg, 1, 100)),
    speed: Math.round(clamp(50 + SPREAD * zd, 1, 100)),
    ref: norm ? 'technique' : 'pooled',
  };
}

/** Coarse band for colouring. Boundaries match the scorecard's own tiers. */
export function scoreTier(score) {
  if (score >= 70) return 'hi';
  if (score >= 45) return 'mid';
  return 'lo';
}
