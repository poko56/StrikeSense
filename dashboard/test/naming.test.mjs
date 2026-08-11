// Deferred technique naming. The model needs follow-through it does not have at
// the moment the detector fires, and getting the wait off by even one frame
// hands it a window it was never trained on — with no error anywhere, just worse
// answers. These lock the arithmetic down.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createNamingQueue } from '../src/naming.js';

const FRAME = 8;
const q = (postPeak) => createNamingQueue(() => postPeak);

test('a model with no follow-through resolves on the spot', () => {
  // Older model files carry postPeak 0, and must not pay for this path at all.
  const n = q(0);
  const due = n.push(3, 16, 'strike-1');
  assert.deepEqual(due, { back: 16, ctx: 'strike-1' });
  assert.equal(n.size, 0);
});

test('a strike waits until the follow-through has arrived', () => {
  const n = q(64);
  assert.equal(n.push(1, 16, 'a'), null, '16 samples in, 64 needed');
  assert.equal(n.size, 1);
  for (let got = 16; got < 64; got += FRAME) {
    const due = n.advance(1, FRAME);
    if (got + FRAME < 64) assert.equal(due, null, `still short at ${got + FRAME}`);
  }
  assert.equal(n.size, 0, 'resolved once 64 samples had arrived');
});

test('the window ends exactly postPeak samples past the impact', () => {
  const n = q(64);
  n.push(1, 16, 'a');
  n.advance(1, FRAME);          // 24
  n.advance(1, FRAME);          // 32
  n.advance(1, FRAME);          // 40
  n.advance(1, FRAME);          // 48
  n.advance(1, FRAME);          // 56
  const due = n.advance(1, FRAME);   // 64
  assert.deepEqual(due, { back: 0, ctx: 'a' },
    'endBack 64 - postPeak 64 = the window ends at the newest sample');
});

test('overshoot is carried, not clamped', () => {
  // A frame can land past the target. Reporting back=0 there would classify a
  // window ending later than the model ever saw.
  const n = q(64);
  n.push(1, 16, 'a');
  const due = n.advance(1, 80);      // jumps from 16 to 96
  assert.deepEqual(due, { back: 32, ctx: 'a' });
});

test('a strike already past the follow-through resolves immediately', () => {
  const n = q(64);
  const due = n.push(1, 100, 'a');
  assert.deepEqual(due, { back: 36, ctx: 'a' });
});

test('limbs wait independently', () => {
  const n = q(64);
  n.push(1, 0, 'hand');
  n.push(3, 0, 'shin');
  assert.equal(n.size, 2);
  assert.equal(n.advance(1, 64).ctx, 'hand');
  assert.equal(n.size, 1, 'the shin is still waiting');
  assert.equal(n.advance(3, 64).ctx, 'shin');
  assert.equal(n.size, 0);
});

test('a frame for one limb does not age another limb window', () => {
  const n = q(64);
  n.push(1, 0, 'hand');
  for (let i = 0; i < 20; i++) n.advance(3, FRAME);   // other limb streaming
  assert.equal(n.size, 1, 'the hand strike must still be pending');
});

test('advance on a limb with nothing pending is a no-op', () => {
  const n = q(64);
  assert.equal(n.advance(2, FRAME), null);
  assert.equal(n.size, 0);
});

test('a second strike on the same limb replaces the first', () => {
  // Cannot happen with a 400 ms refractory and 160 ms of follow-through, but if
  // it ever did, the strike the coach just threw is the one to name.
  const n = q(64);
  n.push(1, 0, 'old');
  n.push(1, 0, 'new');
  assert.equal(n.size, 1);
  assert.equal(n.advance(1, 64).ctx, 'new');
});

test('clear drops everything half-classified', () => {
  const n = q(64);
  n.push(1, 0, 'a'); n.push(3, 0, 'b');
  n.clear();
  assert.equal(n.size, 0);
  assert.equal(n.advance(1, 64), null);
});

test('postPeak is read at resolve time, so swapping models takes effect', () => {
  let postPeak = 64;
  const n = createNamingQueue(() => postPeak);
  n.push(1, 16, 'a');
  assert.equal(n.size, 1);
  postPeak = 0;                       // coach loads an older model mid-session
  assert.deepEqual(n.advance(1, 0), { back: 16, ctx: 'a' });
});
