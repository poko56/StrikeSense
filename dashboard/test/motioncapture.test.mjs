import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MOTION_CAPTURE_DEFAULTS,
  cameraAccessStatus,
  createPoseFrameHistory,
  inferenceDue,
  makePoseFrame,
  poseAttachmentForImpact,
  poseQuality,
  projectOverlayPoint,
  selectVideoFrameTimestamp,
} from '../src/motioncapture.js';
import { JOINT_ANGLE_TRIPLETS, MP_LANDMARK } from '../src/posemath.js';

const point = (x, y, z, visibility = 1) => ({ x, y, z, visibility });
const screenPoint = (x, y, visibility = 1) => ({ x, y, visibility });

function blankPose() {
  return Array.from({ length: 33 }, () => point(0, 0, 0));
}

function putAngle(pose, [first, vertex, third], degrees) {
  pose[vertex] = point(0, 0, 0);
  pose[first] = point(1, 0, 0);
  const rad = degrees * Math.PI / 180;
  pose[third] = point(Math.cos(rad), Math.sin(rad), 0);
}

test('camera access is denied in an insecure context before a permission prompt', () => {
  const insecure = cameraAccessStatus({
    isSecureContext: false,
    location: { origin: 'http://192.168.4.1' },
    navigator: { mediaDevices: { getUserMedia() {} }, userAgent: 'Mozilla/5.0 (iPhone) Safari/605' },
  });
  assert.equal(insecure.ok, false);
  assert.equal(insecure.code, 'insecure-context');
  assert.equal(insecure.androidChrome, false);
  // iOS has no switch to offer, so it must not be sent after the desktop proxy
  // or a Chrome flag — both are remedies it cannot use.
  assert.equal(insecure.iOS, true);
  assert.match(insecure.message, /HTTPS/);
  assert.doesNotMatch(insecure.message, /chrome:\/\/flags|localhost-proxy/);
  // Whatever the device, the message names the origin that was rejected: a
  // proxy that is not running and a flag that did not take look identical
  // without it.
  assert.match(insecure.message, /http:\/\/192\.168\.4\.1/);

  // A desktop browser can reach the rig through a localhost forward, which is a
  // secure context with no flag and no certificate.
  const desktop = cameraAccessStatus({
    isSecureContext: false,
    location: { origin: 'http://192.168.4.1' },
    navigator: {
      mediaDevices: { getUserMedia() {} },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/122.0.0.0 Safari/537.36',
      maxTouchPoints: 0,
    },
  });
  assert.equal(desktop.iOS, false);
  assert.equal(desktop.androidChrome, false);
  assert.match(desktop.message, /localhost:8080/);

  // Android Chrome can make the rig's own origin a secure context, so it is
  // told how instead of being told a rule it cannot act on.
  const android = cameraAccessStatus({
    isSecureContext: false,
    location: { origin: 'http://192.168.4.1' },
    navigator: {
      mediaDevices: { getUserMedia() {} },
      userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/122.0.0.0 Mobile Safari/537.36',
    },
  });
  assert.equal(android.androidChrome, true);
  assert.match(android.message, /chrome:\/\/flags/);
  assert.match(android.message, /http:\/\/192\.168\.4\.1/);

  const unavailable = cameraAccessStatus({ isSecureContext: true, navigator: {} });
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.code, 'camera-unavailable');

  assert.deepEqual(cameraAccessStatus({
    isSecureContext: true,
    navigator: { mediaDevices: { getUserMedia() {} } },
  }), { ok: true, code: 'ok', message: '' });
});

test('VIDEO inference is capped at 15 fps without rounding drift', () => {
  const interval = 1_000 / 15;
  assert.equal(inferenceDue(null, 0, 15), true);
  assert.equal(inferenceDue(0, interval - 0.001, 15), false);
  assert.equal(inferenceDue(0, interval, 15), true);
  assert.equal(inferenceDue(100, 160, 15), false);
  assert.equal(inferenceDue(100, 167, 15), true);
  assert.equal(inferenceDue(0, 100, 0), false);
  assert.equal(MOTION_CAPTURE_DEFAULTS.fps, 15);
  assert.equal(MOTION_CAPTURE_DEFAULTS.facing, 'environment');
  assert.equal(MOTION_CAPTURE_DEFAULTS.wasmRoot, '/mocap/mediapipe/0.10.35/wasm');
  assert.equal(MOTION_CAPTURE_DEFAULTS.modelAssetPath, '/mocap/mediapipe/0.10.35/models/pose_landmarker_lite.task');
});

test('video-frame timestamp uses expected display time on the shared monotonic clock', () => {
  assert.equal(selectVideoFrameTimestamp(100, { expectedDisplayTime: 96 }, null), 96);
  assert.equal(selectVideoFrameTimestamp(100, null, null), 100, 'rAF fallback uses callback now');
  assert.equal(selectVideoFrameTimestamp(90, { expectedDisplayTime: 80 }, 96), 96,
    'metadata jitter must not make VIDEO timestamps run backward');
  assert.equal(selectVideoFrameTimestamp(Number.NaN, null, 96), 96);
});

test('rolling history discards stale frames and enforces its count cap', () => {
  const history = createPoseFrameHistory({ historyMs: 100, maxHistoryFrames: 2 });
  const pose = blankPose();
  assert.equal(history.push({ tMs: 100, worldLandmarks: pose }), true);
  assert.equal(history.push({ tMs: 150, worldLandmarks: pose }), true);
  assert.equal(history.push({ tMs: 200, worldLandmarks: pose }), true);
  assert.deepEqual(history.frames.map(f => f.tMs), [150, 200]);
  assert.equal(history.push({ tMs: 400, worldLandmarks: pose }), true);
  assert.deepEqual(history.frames.map(f => f.tMs), [400]);
  assert.equal(history.push({ tMs: 401, worldLandmarks: null }), false);
  history.clear();
  assert.equal(history.frames.length, 0);
});

test('pose frames copy image visibility onto world landmarks, so hidden joints are gated', () => {
  const world = blankPose();
  putAngle(world, JOINT_ANGLE_TRIPLETS.leftElbow, 90);
  // Tasks often provide 3-D points without confidence; the parallel normalized
  // landmarks are the confidence source that must travel with the 3-D frame.
  const normalized = world.map(l => ({ x: l.x, y: l.y, visibility: 1, presence: 1 }));
  normalized[MP_LANDMARK.LEFT_ELBOW] = { x: 0.5, y: 0.5, visibility: 0.1, presence: 0.1 };
  const frame = makePoseFrame(123, world, normalized);
  world[MP_LANDMARK.LEFT_ELBOW].x = 99;
  assert.equal(frame.tMs, 123);
  assert.deepEqual(frame.worldLandmarks[MP_LANDMARK.LEFT_ELBOW], {
    x: 0, y: 0, z: 0, visibility: 0.1, presence: 0.1,
  });
  const snapshot = poseAttachmentForImpact({ slot: 1, impactAtMs: 123 }, [frame]);
  assert.equal(snapshot.angles.elbow, null);
});

test('quality and mirrored overlay projection affect display only, never landmark data', () => {
  const landmarks = [screenPoint(0.2, 0.25), screenPoint(0.7, 0.5, 0.2), screenPoint(0.8, 0.8)];
  assert.equal(poseQuality(landmarks, 0.5), 2 / 3);
  assert.deepEqual(projectOverlayPoint(landmarks[0], 200, 100, false), { x: 40, y: 25 });
  assert.deepEqual(projectOverlayPoint(landmarks[0], 200, 100, true), { x: 160, y: 25 });
  assert.equal(landmarks[0].x, 0.2, 'mirroring must not mutate anatomical landmarks');
});

test('impactAtMs is the only clock passed to posemath and the sensor slot remains fixed', () => {
  const pose = blankPose();
  putAngle(pose, JOINT_ANGLE_TRIPLETS.leftElbow, 90);
  const frames = [{ tMs: 1_000, slot: 4, worldLandmarks: pose }];
  const impact = { slot: 1, tMs: 99_999, impactAtMs: 1_012 };
  const snapshot = poseAttachmentForImpact(impact, frames, { maxPoseAgeMs: 20 });

  assert.equal(snapshot.slot, 1);
  assert.equal(snapshot.side, 'left');
  assert.equal(snapshot.limb, 'hand');
  assert.equal(snapshot.frameAtMs, 1_000);
  assert.equal(snapshot.ageMs, 12);
  assert.equal(impact.tMs, 99_999, 'pure helper does not mutate its impact');
  assert.equal(poseAttachmentForImpact({ slot: 1, impactAtMs: 1_050 }, frames, { maxPoseAgeMs: 20 }), null);
});
