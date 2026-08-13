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
    // In stopwatch mode this field holds ELAPSED time, not time left, so a reset
    // has to show 00:00. Seeding it with workSec put "03:00" on the dial of a
    // stopwatch that had not been started.
    remainingMs: state.timer.stopwatch ? 0 : state.timer.workSec * 1000,
    stopwatchStartMs: 0,
    paused: false,
  });
  if (prev !== 'idle') emit(prev, 'idle', 0);
  scheduleRender();
}

export function startTimer() {
  if (state.timer.stopwatch) {
    // Already counting — pressing start again must not silently throw the
    // elapsed time away mid-session.
    if (state.timer.mode === 'work' && !state.timer.paused) return;
    if (state.timer.paused) { resumeTimer(); return; }
    const prev = state.timer.mode;
    state.timer.mode = 'work';
    state.timer.remainingMs = 0;
    state.timer.stopwatchStartMs = performance.now();
    state.timer.phaseStartMs = state.timer.stopwatchStartMs;
    emit(prev, 'work', 1);
    scheduleRender();
    return;
  }
  state.timer.paused = false;
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

/**
 * Move to the next phase.
 *
 * @param {number} startedAtMs  the instant the NEW phase began — which is not
 *   always "now". When a phase runs out on its own it began the moment the
 *   previous one was due to end; passing `now` instead silently donates the
 *   overshoot to every phase, and the round clock drifts away from the session
 *   clock. When the coach hits ข้าม, `now` is exactly right, and that is the
 *   default.
 */
function advancePhase(startedAtMs = performance.now()) {
  const t = state.timer;
  const prev = t.mode;
  if (t.mode === 'work') {
    snapshotRound(t.currentRound);
    if (t.currentRound >= t.rounds) {
      t.mode = 'done'; t.remainingMs = 0;
      emit(prev, 'done', t.currentRound);
    } else {
      t.mode = 'rest'; t.remainingMs = t.restSec * 1000;
      t.phaseStartMs = startedAtMs;
      emit(prev, 'rest', t.currentRound);
    }
  } else if (t.mode === 'rest') {
    t.currentRound++;
    t.mode = 'work'; t.remainingMs = t.workSec * 1000;
    t.phaseStartMs = startedAtMs;
    emit(prev, 'work', t.currentRound);
  }
  scheduleRender();
}

// A tick that arrives very late has to walk forward one phase at a time. The cap
// only exists so a misconfigured 0-second phase cannot spin forever.
const MAX_CATCHUP_PHASES = 200;

export function tickTimer() {
  const t = state.timer;
  if (t.paused) return;
  if (t.stopwatch && t.mode === 'work') {
    t.remainingMs = performance.now() - t.stopwatchStartMs;
    return;
  }
  if (t.mode === 'idle' || t.mode === 'done') return;

  // Catch up; do not restart. requestAnimationFrame stops dead when the phone
  // locks, and the 500 ms fallback interval is throttled by the browser and
  // suspended outright on iOS — so a tick can arrive minutes late, covering
  // several whole phases. Replaying them from the moment each was due keeps the
  // round boundaries, and the per-round snapshots hung off them, on the real
  // clock. Restarting the next phase at wake-up instead pushed every remaining
  // round later by however long the screen had been off.
  const now = performance.now();
  for (let guard = 0; guard < MAX_CATCHUP_PHASES; guard++) {
    const total  = (t.mode === 'work' ? t.workSec : t.restSec) * 1000;
    const remain = total - (now - t.phaseStartMs);
    if (remain > 0) { t.remainingMs = remain; return; }
    advancePhase(t.phaseStartMs + total);
    if (t.mode === 'done' || t.mode === 'idle') return;
  }
  // Phases of zero length — nothing sensible to catch up to. Anchor to now so
  // the loop cannot run again on the next tick.
  t.phaseStartMs = now;
  t.remainingMs  = (t.mode === 'work' ? t.workSec : t.restSec) * 1000;
}
