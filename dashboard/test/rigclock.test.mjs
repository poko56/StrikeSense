import test from 'node:test';
import assert from 'node:assert/strict';
import { createRigClockMapper } from '../src/rigclock.js';

test('rig clock keeps coalesced IMU frames spaced by their Main Node timestamps', () => {
  const clock = createRigClockMapper();
  // All three frames reached the WebSocket at once. The last frame reveals the
  // least queued path, then the earlier frames retain their source spacing.
  assert.deepEqual(clock.mapBatch([1_000, 1_020, 1_040], 2_000), [1_960, 1_980, 2_000]);
  // A later-delayed packet must use that earlier calibration rather than being
  // stamped with its own late WS arrival.
  assert.equal(clock.map(1_060, 2_090), 2_020);
  assert.equal(clock.offsetMs, 960);
});

test('rig clock improves its offset when a lower-latency frame arrives', () => {
  const clock = createRigClockMapper();
  assert.equal(clock.map(100, 180), 180);
  assert.equal(clock.map(120, 190), 190);
  assert.equal(clock.offsetMs, 70);
  assert.equal(clock.map(140, 240), 210);
});

test('a newly faster path never makes detector time run backward', () => {
  const clock = createRigClockMapper();
  assert.equal(clock.map(100, 300), 300); // initial queueing was 200 ms
  // A later frame exposes a 10 ms path. Its raw candidate would be 130 ms,
  // which must be clamped rather than violating detector/refractory ordering.
  assert.equal(clock.map(120, 130), 300);
  assert.equal(clock.offsetMs, 10);
  assert.equal(clock.map(500, 510), 510, 'the mapped timeline resumes once it catches up');
});

test('rig clock refreshes its lower envelope instead of preserving a lifetime path', () => {
  const clock = createRigClockMapper({ observationWindowMs: 50 });
  assert.equal(clock.map(100, 200), 200);
  assert.equal(clock.map(120, 230), 220);
  // Both early observations have left the 50 ms window, so current conditions
  // seed a new estimate rather than retaining an old lifetime minimum.
  assert.equal(clock.map(200, 500), 500);
  assert.equal(clock.offsetMs, 300);
});

test('rig clock supports millis wrap and a normal rig reboot', () => {
  const clock = createRigClockMapper();
  assert.equal(clock.map(0xfffffff0, 1_000), 1_000);
  // 0xfffffff0 -> 0x10 is 32 ms across the uint32 wrap.
  assert.equal(clock.map(0x10, 1_040), 1_032);

  // A small raw value after a much smaller (non-wrap) timestamp is a reboot.
  const rebooted = createRigClockMapper();
  assert.equal(rebooted.map(10_000, 12_000), 12_000);
  assert.equal(rebooted.map(20, 12_100), 12_100);
  assert.equal(rebooted.map(40, 12_140), 12_120);
});

test('rig clock treats invalid timestamps as an arrival-time fallback', () => {
  const clock = createRigClockMapper();
  assert.equal(clock.map(Number.NaN, 123), 123);
  assert.equal(clock.map(1, Number.NaN), Number.NaN);
});
