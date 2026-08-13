// Per-strike scoring. The point of the number is that it is comparable ACROSS
// techniques: an uppercut thrown well and a cross thrown well should both read
// around 50, even though the cross lands at half again the force.

import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreStrike, scoreTier, POOLED_NORM } from '../src/strikescore.js';

// Straight from the shipped model's physics block (ml_pipeline/strike_web_model_fine.json).
const JAB      = { muG: Math.log(13.7), sdG: 0.700, muD: Math.log(1150), sdD: 0.600 };
const UPPERCUT = { muG: Math.log(9.5),  sdG: 0.547, muD: Math.log(677),  sdD: 0.519 };

test('a strike at its technique average scores 50', () => {
  assert.equal(scoreStrike({ peakG: 13.7, peakDps: 1150 }, JAB).score, 50);
  assert.equal(scoreStrike({ peakG: 9.5, peakDps: 677 }, UPPERCUT).score, 50);
});

test('techniques are graded on their own scale, not one global idea of hard', () => {
  // This is the whole reason the score exists. 9.5 g is a normal uppercut and a
  // weak jab; a single force threshold would call both the same.
  const asUppercut = scoreStrike({ peakG: 9.5, peakDps: 677 }, UPPERCUT).score;
  const asJab      = scoreStrike({ peakG: 9.5, peakDps: 677 }, JAB).score;
  assert.equal(asUppercut, 50);
  assert.ok(asJab < 40, `a 9.5 g jab should read low, got ${asJab}`);
});

test('one standard deviation above reads about 72', () => {
  const s = scoreStrike({ peakG: 13.7 * Math.exp(0.700), peakDps: 1150 * Math.exp(0.600) }, JAB);
  assert.ok(Math.abs(s.score - 72) <= 1, `got ${s.score}`);
});

test('harder and faster always scores higher', () => {
  const weak   = scoreStrike({ peakG: 8,  peakDps: 700 },  JAB).score;
  const strong = scoreStrike({ peakG: 20, peakDps: 1600 }, JAB).score;
  assert.ok(strong > weak);
});

test('power and speed are reported separately', () => {
  // Hard but slow: a shove rather than a snap. The split has to show that.
  const s = scoreStrike({ peakG: 25, peakDps: 400 }, JAB);
  assert.ok(s.power > 60, `power ${s.power}`);
  assert.ok(s.speed < 40, `speed ${s.speed}`);
  assert.ok(s.score > s.speed && s.score < s.power, 'the total sits between them');
});

test('the score stays inside 1-100 however extreme the strike', () => {
  for (const st of [{ peakG: 0, peakDps: 0 }, { peakG: 1e4, peakDps: 1e6 },
                    { peakG: 0.001, peakDps: 0.001 }]) {
    const s = scoreStrike(st, JAB);
    assert.ok(s.score >= 1 && s.score <= 100, JSON.stringify(s));
    assert.ok(Number.isFinite(s.score));
  }
});

test('a missing peakDps does not produce NaN', () => {
  const s = scoreStrike({ peakG: 12 }, JAB);
  assert.ok(Number.isFinite(s.score));
});

// ── the pooled fallback ─────────────────────────────────────────────────────

test('no technique reference falls back to the pooled one and says so', () => {
  const s = scoreStrike({ peakG: 11.6, peakDps: 846 }, null);
  assert.equal(s.ref, 'pooled');
  assert.equal(s.score, 50, 'the pooled geometric mean must read as typical');
});

test('a technique reference is labelled as such', () => {
  assert.equal(scoreStrike({ peakG: 13.7, peakDps: 1150 }, JAB).ref, 'technique');
});

test('POOLED_NORM matches the pooled distribution of the shipped model', () => {
  // Guards against someone editing the constants apart from the data they came
  // from: 11.6 g and 846 °/s across the nine techniques in ml_pipeline/data.
  assert.ok(Math.abs(Math.exp(POOLED_NORM.muG) - 11.6) < 0.15);
  assert.ok(Math.abs(Math.exp(POOLED_NORM.muD) - 846) < 10);
});

// ── degenerate references ───────────────────────────────────────────────────

test('a class with almost no spread cannot manufacture 1s and 100s', () => {
  // Elbow-Up was fitted from twelve impacts and its sd is a third of the others.
  // Without a floor, a strike a hair off its mean would peg the scale.
  const thin = { muG: Math.log(6.2), sdG: 0.001, muD: Math.log(552), sdD: 0.001 };
  const s = scoreStrike({ peakG: 6.5, peakDps: 570 }, thin);
  assert.ok(s.score > 50 && s.score < 100, `got ${s.score}`);
});

test('tiers split at 45 and 70', () => {
  assert.equal(scoreTier(44), 'lo');
  assert.equal(scoreTier(45), 'mid');
  assert.equal(scoreTier(69), 'mid');
  assert.equal(scoreTier(70), 'hi');
});
