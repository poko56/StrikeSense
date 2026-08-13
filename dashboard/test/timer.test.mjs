// Round-timer tests. The clock is driven off performance.now(), so the tests own
// a fake one — that is the only way to assert what happens when a tick arrives
// four minutes late because the phone was locked.

import test from 'node:test';
import assert from 'node:assert/strict';

// Minimal browser surface the module graph touches at import time.
globalThis.location = { search: '' };
globalThis.requestAnimationFrame = () => 0;
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

let clock = 0;
globalThis.performance = { now: () => clock };

const { state } = await import('../src/state.js');
const timer = await import('../src/timer.js');

const S = 1000;

/** Fresh 3×(60 s work / 30 s rest), stopped, clock at zero. */
function setup({ stopwatch = false, rounds = 3, workSec = 60, restSec = 30 } = {}) {
  clock = 0;
  state.strikes.length = 0;
  state.perRound.length = 0;
  Object.assign(state.timer, { rounds, workSec, restSec, stopwatch, preset: 'custom' });
  timer.resetTimer();
}

/** Advance the fake clock and tick once — how a live frame arrives. */
function tickAt(ms) { clock = ms; timer.tickTimer(); }

// ── the phone-lock case ─────────────────────────────────────────────────────

test('a tick arriving one whole phase late lands in the right phase', () => {
  setup();
  timer.startTimer();                       // work 1 starts at t=0, 60 s long
  tickAt(75 * S);                           // 15 s into rest 1
  assert.equal(state.timer.mode, 'rest');
  assert.equal(state.timer.currentRound, 1);
  assert.equal(Math.round(state.timer.remainingMs / S), 15,
    'rest must be 15 s in, not restarted at 30 s');
});

test('a tick arriving several phases late catches up, it does not restart', () => {
  setup();
  timer.startTimer();
  // 4 minutes of screen-off: work1 60 + rest1 30 + work2 60 + rest2 30 = 180 s,
  // so 240 s lands 60 s into work 3 — which is exactly when work 3 ends.
  tickAt(235 * S);
  assert.equal(state.timer.mode, 'work');
  assert.equal(state.timer.currentRound, 3);
  assert.equal(Math.round(state.timer.remainingMs / S), 5);
});

test('rounds missed while asleep are still snapshotted', () => {
  setup();
  timer.startTimer();
  tickAt(235 * S);
  assert.deepEqual(state.perRound.map(r => r.round), [1, 2],
    'work 1 and work 2 both ended while the screen was off');
});

test('the session finishes if the whole workout elapsed while asleep', () => {
  setup();
  timer.startTimer();
  tickAt(60 * 60 * S);                      // an hour later
  assert.equal(state.timer.mode, 'done');
  assert.equal(state.timer.currentRound, 3);
  assert.equal(state.timer.remainingMs, 0);
});

test('round boundaries stay on the real clock across a long gap', () => {
  setup();
  timer.startTimer();
  tickAt(200 * S);                          // 20 s into work 3 (180 s of phases)
  // Work 3 must end at t=240 s, not at 200+60.
  tickAt(239 * S);
  assert.equal(state.timer.mode, 'work');
  tickAt(241 * S);
  assert.equal(state.timer.mode, 'done', 'work 3 was due to end at 240 s');
});

// ── ordinary operation ──────────────────────────────────────────────────────

test('a normal 60 Hz run advances exactly on the boundary', () => {
  setup();
  timer.startTimer();
  for (let t = 16; t <= 59 * S; t += 16) tickAt(t);
  assert.equal(state.timer.mode, 'work');
  tickAt(60 * S);
  assert.equal(state.timer.mode, 'rest');
  assert.equal(state.timer.currentRound, 1);
});

test('ข้าม starts the next phase now, not when the old one was due', () => {
  setup();
  timer.startTimer();
  clock = 10 * S;
  timer.skipPhase();
  assert.equal(state.timer.mode, 'rest');
  tickAt(25 * S);
  assert.equal(Math.round(state.timer.remainingMs / S), 15,
    'rest began at the skip, so 15 s in at t=25 s');
});

test('pause freezes the clock and resume continues from there', () => {
  setup();
  timer.startTimer();
  tickAt(20 * S);
  timer.pauseTimer();
  clock = 300 * S;                          // five minutes of standing around
  timer.tickTimer();
  assert.equal(Math.round(state.timer.remainingMs / S), 40, 'paused clocks do not move');
  timer.resumeTimer();
  tickAt(310 * S);
  assert.equal(Math.round(state.timer.remainingMs / S), 30);
  assert.equal(state.timer.mode, 'work');
});

test('isRunning is false while paused and while idle', () => {
  setup();
  assert.equal(timer.isRunning(), false);
  timer.startTimer();
  assert.equal(timer.isRunning(), true);
  timer.pauseTimer();
  assert.equal(timer.isRunning(), false);
});

// ── stopwatch mode ──────────────────────────────────────────────────────────

test('a reset stopwatch reads 00:00, not the round length', () => {
  setup({ stopwatch: true, workSec: 180 });
  assert.equal(state.timer.remainingMs, 0,
    'the dial showed 03:00 on a stopwatch that had never been started');
});

test('the stopwatch counts up', () => {
  setup({ stopwatch: true });
  timer.startTimer();
  tickAt(42 * S);
  assert.equal(Math.round(state.timer.remainingMs / S), 42);
});

test('pressing start on a running stopwatch does not wipe the elapsed time', () => {
  setup({ stopwatch: true });
  timer.startTimer();
  tickAt(42 * S);
  timer.startTimer();                       // a second press
  timer.tickTimer();
  assert.equal(Math.round(state.timer.remainingMs / S), 42);
});

test('pressing start on a paused stopwatch resumes instead of restarting', () => {
  setup({ stopwatch: true });
  timer.startTimer();
  tickAt(42 * S);
  timer.pauseTimer();
  clock = 100 * S;
  timer.startTimer();
  tickAt(105 * S);
  assert.equal(Math.round(state.timer.remainingMs / S), 47, '42 s + the 5 s since resuming');
});

test('the stopwatch never advances rounds', () => {
  setup({ stopwatch: true });
  timer.startTimer();
  tickAt(10 * 60 * S);
  assert.equal(state.timer.mode, 'work');
  assert.equal(state.perRound.length, 0);
});

// ── REC button path ─────────────────────────────────────────────────────────

test('startOrResumeTimer leaves a running clock alone', () => {
  setup();
  timer.startTimer();
  tickAt(20 * S);
  timer.startOrResumeTimer();
  timer.tickTimer();
  assert.equal(Math.round(state.timer.remainingMs / S), 40);
  assert.equal(state.timer.currentRound, 1);
});

test('startOrResumeTimer resumes a paused clock', () => {
  setup();
  timer.startTimer();
  tickAt(20 * S);
  timer.pauseTimer();
  clock = 50 * S;
  timer.startOrResumeTimer();
  assert.equal(timer.isRunning(), true);
  tickAt(60 * S);
  assert.equal(Math.round(state.timer.remainingMs / S), 30);
});

// ── degenerate configuration ────────────────────────────────────────────────

test('a zero-length phase cannot lock the tab up', () => {
  setup({ workSec: 0, restSec: 0, rounds: 3 });
  timer.startTimer();
  tickAt(1 * S);                            // must return, not spin
  assert.ok(['work', 'rest', 'done'].includes(state.timer.mode));
});
