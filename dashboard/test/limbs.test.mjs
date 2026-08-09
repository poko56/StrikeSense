// Unit tests for the limb gate — the rule that stops a shin impact from being
// reported as a punch, and a glove impact from being reported as a kick.

import test from 'node:test';
import assert from 'node:assert/strict';
import { bestAllowedIndex, limbOfLabel, limbOfSlot } from '../src/limbs.js';

const LABELS = ['Jab', 'Cross', 'Hook', 'Uppercut', 'Elbow-Chop',
                'Roundhouse', 'Kick-Low', 'Knee-Straight', 'Teep', 'Move', 'Idle'];
const i = (name) => LABELS.indexOf(name);

/** probs with all the mass on `name`, the rest spread thin. */
function peaked(name, p = 0.9) {
  const rest = (1 - p) / (LABELS.length - 1);
  return LABELS.map(l => (l === name ? p : rest));
}

test('technique names map to the limb that throws them', () => {
  for (const n of ['Jab', 'Cross', 'Hook', 'Uppercut', 'Elbow-Chop', 'Elbow-Spin'])
    assert.equal(limbOfLabel(n), 'hand', n);
  for (const n of ['Roundhouse', 'Kick-Low', 'Kick-Spin', 'Knee-Straight', 'Teep-Side'])
    assert.equal(limbOfLabel(n), 'leg', n);
  for (const n of ['Idle', 'Move'])
    assert.equal(limbOfLabel(n), '', n);
});

test('an explicit limbs entry from the model file wins over the name', () => {
  assert.equal(limbOfLabel('Jab', 'leg'), 'leg');
  assert.equal(limbOfLabel('Roundhouse', 'any'), '');
});

test('slots map to limbs', () => {
  assert.equal(limbOfSlot(1), 'hand');
  assert.equal(limbOfSlot(2), 'hand');
  assert.equal(limbOfSlot(3), 'leg');
  assert.equal(limbOfSlot(4), 'leg');
  assert.equal(limbOfSlot(0), '');
});

test('a shin impact is never named a punch, even when the model insists', () => {
  // This is the reported bug: setting the leg for a jab came back as a kick or a
  // punch depending on which way the network leaned. The gate makes half of that
  // impossible without touching the model.
  const best = bestAllowedIndex(peaked('Jab', 0.95), LABELS, null, 3);
  assert.notEqual(best, i('Jab'));
  assert.equal(limbOfLabel(LABELS[best]) === 'hand', false);
});

test('a glove impact is never named a kick', () => {
  const best = bestAllowedIndex(peaked('Roundhouse', 0.95), LABELS, null, 2);
  assert.notEqual(best, i('Roundhouse'));
});

test('the gate picks the best REACHABLE label, not simply the runner-up overall', () => {
  const probs = LABELS.map(() => 0.01);
  probs[i('Jab')]        = 0.60;   // unreachable from a shin
  probs[i('Kick-Low')]   = 0.10;
  probs[i('Roundhouse')] = 0.25;
  assert.equal(bestAllowedIndex(probs, LABELS, null, 3), i('Roundhouse'));
});

test('Idle and Move stay available to both limbs', () => {
  assert.equal(bestAllowedIndex(peaked('Idle'), LABELS, null, 1), i('Idle'));
  assert.equal(bestAllowedIndex(peaked('Move'), LABELS, null, 3), i('Move'));
});

test('slot 0 disables the gate', () => {
  assert.equal(bestAllowedIndex(peaked('Jab'), LABELS, null, 0), i('Jab'));
});

test('a shin firing on a punches-only model gets no answer at all', () => {
  // -1, not "the least bad punch": there is nothing honest to report.
  const handOnly = ['Jab', 'Cross', 'Hook'];
  assert.equal(bestAllowedIndex([0.5, 0.3, 0.2], handOnly, null, 3), -1);
});

test('a model file that declares limbs is trusted for unknown names', () => {
  const labels = ['lbl77', 'Idle'];
  assert.equal(bestAllowedIndex([0.9, 0.1], labels, ['leg', 'any'], 1), 1);
  assert.equal(bestAllowedIndex([0.9, 0.1], labels, ['leg', 'any'], 3), 0);
});

// ── the "ระบุท่าเสมอ" mode ───────────────────────────────────────────────────
// Dropping the confidence floor is aimodel.js's job; the gate itself must keep
// Idle reachable either way, because that class is what stops a dropped glove
// being logged as a jab. Naming every impact must never mean naming stillness.

test('Idle stays reachable — the gate never forces a technique onto stillness', () => {
  assert.equal(bestAllowedIndex(peaked('Idle', 0.97), LABELS, null, 1), i('Idle'));
  assert.equal(bestAllowedIndex(peaked('Move', 0.97), LABELS, null, 3), i('Move'));
});

test('with Idle low, the gate returns the best technique for that limb', () => {
  const probs = LABELS.map(() => 0.01);
  probs[i('Idle')]     = 0.05;
  probs[i('Jab')]      = 0.20;
  probs[i('Uppercut')] = 0.60;
  assert.equal(bestAllowedIndex(probs, LABELS, null, 1), i('Uppercut'));
});
