// Round timer — client-side authoritative.
// Phases: idle → work → rest → work … → done.
// Stopwatch mode: just counts up, no rounds, no phases.

import { state, scheduleRender } from './state.js';
import { snapshotRound } from './analyzer.js';

const PRESETS = {
  '3x3':  { rounds: 3,  workSec: 180, restSec: 60 },
  '5x3':  { rounds: 5,  workSec: 180, restSec: 60 },
  '3x2':  { rounds: 3,  workSec: 120, restSec: 30 },
  '12x3': { rounds: 12, workSec: 180, restSec: 60 },
};

let listeners = [];
export function onPhaseChange(fn) { listeners.push(fn); }
function emit(prev, next, round) {
  for (const fn of listeners) try { fn(prev, next, round); } catch(e) { console.error(e); }
}

export function applyPreset(name) {
  const p = PRESETS[name];
  if (!p) return;
  Object.assign(state.timer, p, { preset: name });
  resetTimer();
}

export function setStopwatch(on) {
  state.timer.stopwatch = !!on;
  resetTimer();
}

export function resetTimer() {
  const prev = state.timer.mode;
  Object.assign(state.timer, {
    mode: 'idle', currentRound: 0, phaseStartMs: 0,
    remainingMs: state.timer.workSec * 1000,
    stopwatchStartMs: 0,
    paused: false,
  });
  if (prev !== 'idle') emit(prev, 'idle', 0);
  scheduleRender();
}

export function startTimer() {
  state.timer.paused = false;
  if (state.timer.stopwatch) {
    state.timer.mode = 'work';
    state.timer.remainingMs = 0;
    state.timer.stopwatchStartMs = performance.now();
    state.timer.phaseStartMs = state.timer.stopwatchStartMs;
    emit('idle', 'work', 1);
    scheduleRender();
    return;
  }
  if (state.timer.mode !== 'idle' && state.timer.mode !== 'done') return;
  const prev = state.timer.mode;
  state.timer.mode         = 'work';
  state.timer.currentRound = 1;
  state.timer.phaseStartMs = performance.now();
  state.timer.remainingMs  = state.timer.workSec * 1000;
  emit(prev, 'work', 1);
  scheduleRender();
}

export function isRunning() {
  const t = state.timer;
  return !t.paused && (t.mode === 'work' || t.mode === 'rest');
}

/** Freeze the clock where it is, keeping the round + phase. */
export function pauseTimer() {
  const t = state.timer;
  if (t.paused || (t.mode !== 'work' && t.mode !== 'rest')) return;
  t.paused = true;          // remainingMs is already current from the last tick
  scheduleRender();
}

/** Continue from where pauseTimer() left off. */
export function resumeTimer() {
  const t = state.timer;
  if (!t.paused) return;
  t.paused = false;
  if (t.stopwatch) {
    t.stopwatchStartMs = performance.now() - t.remainingMs;
    t.phaseStartMs     = t.stopwatchStartMs;
  } else {
    const total = (t.mode === 'work' ? t.workSec : t.restSec) * 1000;
    t.phaseStartMs = performance.now() - (total - t.remainingMs);
  }
  scheduleRender();
}

/**
 * What the REC button needs: make the clock run, whatever state it is in.
 * Resumes a paused timer, starts an idle/finished one, and leaves an already
 * running one alone. Pressing บันทึก used to arm the recording without ever
 * touching the timer, so the dial just sat at 00:00.
 */
export function startOrResumeTimer() {
  const t = state.timer;
  if (t.paused)   { resumeTimer(); return; }
  if (t.mode === 'work' || t.mode === 'rest') return;   // already counting
  startTimer();
}

export function skipPhase() {
  if (state.timer.stopwatch) { resetTimer(); return; }
  if (state.timer.mode === 'idle' || state.timer.mode === 'done') return;
  advancePhase();
}

function advancePhase() {
  const t = state.timer;
  const prev = t.mode;
  if (t.mode === 'work') {
    snapshotRound(t.currentRound);
    if (t.currentRound >= t.rounds) {
      t.mode = 'done'; t.remainingMs = 0;
      emit(prev, 'done', t.currentRound);
    } else {
      t.mode = 'rest'; t.remainingMs = t.restSec * 1000;
      t.phaseStartMs = performance.now();
      emit(prev, 'rest', t.currentRound);
    }
  } else if (t.mode === 'rest') {
    t.currentRound++;
    t.mode = 'work'; t.remainingMs = t.workSec * 1000;
    t.phaseStartMs = performance.now();
    emit(prev, 'work', t.currentRound);
  }
  scheduleRender();
}

export function tickTimer() {
  const t = state.timer;
  if (t.paused) return;
  if (t.stopwatch && t.mode === 'work') {
    t.remainingMs = performance.now() - t.stopwatchStartMs;
    return;
  }
  if (t.mode === 'idle' || t.mode === 'done') return;
  const elapsed = performance.now() - t.phaseStartMs;
  const total   = (t.mode === 'work' ? t.workSec : t.restSec) * 1000;
  const remain  = Math.max(0, total - elapsed);
  t.remainingMs = remain;
  if (remain <= 0) advancePhase();
}
