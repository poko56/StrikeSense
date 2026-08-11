// The camera pose path must enhance an impact without taking ownership of it:
// an IMU slot remains its original left/right hand/leg throughout matching.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MAX_POSE_AGE_MS,
  JOINT_ANGLE_TRIPLETS,
  MP_LANDMARK,
  SLOT_POSE_PART,
  computePoseAngles,
  jointAngle3d,
  landmarkVisible,
  nearestPoseFrame,
  poseSnapshotForImpact,
  slotPosePart,
  timestampMs,
  worldLandmarksFromFrame,
} from '../src/posemath.js';

const point = (x, y, z, visibility = 1) => ({ x, y, z, visibility });

function blankPose() {
  return Array.from({ length: 33 }, () => point(0, 0, 0));
}

function putAngle(pose, [first, vertex, third], degrees, { zPlane = false } = {}) {
  // Vertex at the origin; the two unit limbs make a known interior angle.
  pose[vertex] = point(0, 0, 0);
  pose[first] = point(1, 0, 0);
  const radians = degrees * Math.PI / 180;
  pose[third] = zPlane
    ? point(Math.cos(radians), 0, Math.sin(radians))
    : point(Math.cos(radians), Math.sin(radians), 0);
  return pose;
}

function atAngle(degrees) {
  const radians = degrees * Math.PI / 180;
  return { x: Math.cos(radians), y: Math.sin(radians), z: 0 };
}

// Adjacent anatomical angles share landmarks.  Build a physically consistent
// two-joint arm rather than overwriting the elbow while constructing shoulder.
function setLeftArm(pose, shoulderDegrees, elbowDegrees) {
  pose[MP_LANDMARK.LEFT_SHOULDER] = point(0, 0, 0);
  pose[MP_LANDMARK.LEFT_HIP] = point(1, 0, 0);
  const upper = atAngle(shoulderDegrees);
  pose[MP_LANDMARK.LEFT_ELBOW] = point(upper.x, upper.y, 0);
  const lower = atAngle(shoulderDegrees + 180 + elbowDegrees);
  pose[MP_LANDMARK.LEFT_WRIST] = point(upper.x + lower.x, upper.y + lower.y, 0);
}

// Likewise, make hip -> knee -> ankle -> foot one coherent right-leg chain.
function setRightLeg(pose, hipDegrees, kneeDegrees, ankleDegrees) {
  pose[MP_LANDMARK.RIGHT_HIP] = point(0, 0, 0);
  pose[MP_LANDMARK.RIGHT_SHOULDER] = point(1, 0, 0);
  const thigh = atAngle(hipDegrees);
  pose[MP_LANDMARK.RIGHT_KNEE] = point(thigh.x, thigh.y, 0);
  const shin = atAngle(hipDegrees + 180 + kneeDegrees);
  pose[MP_LANDMARK.RIGHT_ANKLE] = point(thigh.x + shin.x, thigh.y + shin.y, 0);
  const foot = atAngle(hipDegrees + 180 + kneeDegrees + 180 + ankleDegrees);
  pose[MP_LANDMARK.RIGHT_FOOT_INDEX] = point(
    thigh.x + shin.x + foot.x,
    thigh.y + shin.y + foot.y,
    0,
  );
}

test('MediaPipe landmark indices match the 33-point Pose layout', () => {
  assert.equal(MP_LANDMARK.NOSE, 0);
  assert.equal(MP_LANDMARK.LEFT_SHOULDER, 11);
  assert.equal(MP_LANDMARK.RIGHT_WRIST, 16);
  assert.equal(MP_LANDMARK.LEFT_HIP, 23);
  assert.equal(MP_LANDMARK.RIGHT_ANKLE, 28);
  assert.equal(MP_LANDMARK.LEFT_FOOT_INDEX, 31);
  assert.equal(MP_LANDMARK.RIGHT_FOOT_INDEX, 32);
});

test('all four sensor slots have a fixed left/right hand/leg mapping', () => {
  assert.deepEqual(slotPosePart(1), SLOT_POSE_PART[1]);
  assert.deepEqual(slotPosePart(2), SLOT_POSE_PART[2]);
  assert.deepEqual(slotPosePart(3), SLOT_POSE_PART[3]);
  assert.deepEqual(slotPosePart(4), SLOT_POSE_PART[4]);
  assert.equal(slotPosePart(1).side, 'left');
  assert.equal(slotPosePart(2).side, 'right');
  assert.equal(slotPosePart(3).limb, 'leg');
  assert.equal(slotPosePart(4).limb, 'leg');
  assert.equal(slotPosePart(0), null);
  assert.equal(slotPosePart(5), null);
});

test('jointAngle3d measures a true 3-D elbow angle in degrees', () => {
  const pose = putAngle(blankPose(), JOINT_ANGLE_TRIPLETS.leftElbow, 60, { zPlane: true });
  const [first, vertex, third] = JOINT_ANGLE_TRIPLETS.leftElbow;
  assert.ok(Math.abs(jointAngle3d(pose, first, vertex, third) - 60) < 1e-10);
});

test('jointAngle3d handles straight joints and degenerate vectors safely', () => {
  const straight = putAngle(blankPose(), JOINT_ANGLE_TRIPLETS.rightKnee, 180);
  const [first, vertex, third] = JOINT_ANGLE_TRIPLETS.rightKnee;
  assert.ok(Math.abs(jointAngle3d(straight, first, vertex, third) - 180) < 1e-10);

  const degenerate = blankPose();
  degenerate[first] = point(0, 0, 0);
  degenerate[vertex] = point(0, 0, 0);
  degenerate[third] = point(1, 0, 0);
  assert.equal(jointAngle3d(degenerate, first, vertex, third), null);
});

test('visibility/presence threshold gates unreliable landmarks but allows Tasks world points without confidence', () => {
  const pose = putAngle(blankPose(), JOINT_ANGLE_TRIPLETS.leftKnee, 90);
  const [first, vertex, third] = JOINT_ANGLE_TRIPLETS.leftKnee;
  pose[vertex].visibility = 0.49;
  assert.equal(landmarkVisible(pose[vertex], 0.5), false);
  assert.equal(jointAngle3d(pose, first, vertex, third, 0.5), null);

  pose[vertex].visibility = 0.5;
  pose[third].presence = 0.2;
  assert.equal(jointAngle3d(pose, first, vertex, third, 0.5), null);

  delete pose[vertex].visibility;
  delete pose[third].visibility;
  delete pose[third].presence;
  assert.ok(Math.abs(jointAngle3d(pose, first, vertex, third) - 90) < 1e-10);
});

test('computePoseAngles provides bilateral arm and leg angles independently', () => {
  const pose = blankPose();
  putAngle(pose, JOINT_ANGLE_TRIPLETS.leftElbow, 90);
  putAngle(pose, JOINT_ANGLE_TRIPLETS.rightElbow, 120);
  putAngle(pose, JOINT_ANGLE_TRIPLETS.leftKnee, 75);
  putAngle(pose, JOINT_ANGLE_TRIPLETS.rightKnee, 135);
  const angles = computePoseAngles(pose);

  assert.ok(Math.abs(angles.leftElbow - 90) < 1e-10);
  assert.ok(Math.abs(angles.rightElbow - 120) < 1e-10);
  assert.ok(Math.abs(angles.leftKnee - 75) < 1e-10);
  assert.ok(Math.abs(angles.rightKnee - 135) < 1e-10);
});

test('timestamp helpers accept the dashboard timestamp field names and reject invalid values', () => {
  assert.equal(timestampMs(123), 123);
  assert.equal(timestampMs({ tMs: 1 }), 1);
  assert.equal(timestampMs({ timestamp: 2 }), 2);
  assert.equal(timestampMs({ timeMs: 3 }), 3);
  assert.equal(timestampMs({ at: 4 }), 4);
  assert.equal(timestampMs({ tMs: Number.NaN, at: 5 }), 5);
  assert.equal(timestampMs({ at: '5' }), null);
  assert.equal(timestampMs(null), null);
});

test('worldLandmarksFromFrame handles both direct and MediaPipe Tasks result shapes', () => {
  const pose = blankPose();
  assert.equal(worldLandmarksFromFrame({ worldLandmarks: pose }), pose);
  assert.equal(worldLandmarksFromFrame({ worldLandmarks: [pose] }), pose);
  assert.equal(worldLandmarksFromFrame({ landmarks: pose }), pose);
  assert.equal(worldLandmarksFromFrame({ poseWorldLandmarks: pose }), pose);
  assert.equal(worldLandmarksFromFrame({}), null);
});

test('nearestPoseFrame picks the closest timestamped frame within its age budget', () => {
  const frames = [
    { tMs: 950, name: 'too old' },
    { tMs: 1004, name: 'nearer' },
    { tMs: 1013, name: 'farther' },
    { name: 'not timestamped' },
  ];
  const hit = nearestPoseFrame(frames, 1008, 100);
  assert.equal(hit.frame.name, 'nearer');
  assert.equal(hit.tMs, 1004);
  assert.equal(hit.ageMs, 4);
});

test('nearestPoseFrame rejects stale frames and resolves exact ties toward the earlier one', () => {
  const frames = [{ tMs: 990, name: 'before' }, { tMs: 1010, name: 'after' }];
  assert.equal(nearestPoseFrame(frames, 1000, 9), null);
  assert.equal(nearestPoseFrame(frames, 1000, 10).frame.name, 'before');
  assert.equal(nearestPoseFrame(frames, 1000).ageMs, 10);
  assert.equal(DEFAULT_MAX_POSE_AGE_MS, 250);
  assert.equal(nearestPoseFrame(frames, 1000, -1), null);
});

test('a compact hand snapshot preserves the IMU slot even if the pose frame claims another slot', () => {
  const pose = blankPose();
  setLeftArm(pose, 110, 80);
  const impact = { slot: 1, tMs: 1000 };
  const frames = [{ slot: 4, tMs: 1008, worldLandmarks: pose }];

  const snapshot = poseSnapshotForImpact(impact, frames, { maxAgeMs: 20 });
  assert.deepEqual(snapshot, {
    slot: 1,
    side: 'left',
    limb: 'hand',
    posePart: 'leftHand',
    frameAtMs: 1008,
    ageMs: 8,
    angles: { shoulder: 110, elbow: 80 },
  });
  assert.equal(impact.slot, 1, 'snapshot must not mutate the impact');
  assert.equal(frames[0].slot, 4, 'snapshot must not mutate a pose frame either');
});

test('a compact leg snapshot includes only its same-side hip/knee/ankle angles', () => {
  const pose = blankPose();
  setRightLeg(pose, 100, 70, 130);
  // A left-elbow value exists, but a right-leg impact must not report it.
  putAngle(pose, JOINT_ANGLE_TRIPLETS.leftElbow, 40);

  const snapshot = poseSnapshotForImpact(
    { slot: 4, at: 2000 },
    [{ timestamp: 1995, worldLandmarks: [pose] }],
  );
  assert.deepEqual(snapshot.angles, { hip: 100, knee: 70, ankle: 130 });
  assert.equal(snapshot.slot, 4);
  assert.equal(snapshot.side, 'right');
  assert.equal(snapshot.limb, 'leg');
});

test('poseSnapshotForImpact refuses invalid slots, stale/missing frames, and uses null for hidden joints', () => {
  const pose = blankPose();
  putAngle(pose, JOINT_ANGLE_TRIPLETS.rightElbow, 90);
  pose[MP_LANDMARK.RIGHT_ELBOW].visibility = 0.1;
  assert.equal(poseSnapshotForImpact({ slot: 0, tMs: 1 }, [{ tMs: 1, worldLandmarks: pose }]), null);
  assert.equal(poseSnapshotForImpact({ slot: 2, tMs: 1 }, [{ tMs: 1000, worldLandmarks: pose }]), null);
  assert.equal(poseSnapshotForImpact({ slot: 2 }, [{ tMs: 1, worldLandmarks: pose }]), null);

  const snapshot = poseSnapshotForImpact({ slot: 2, tMs: 1 }, [{ tMs: 1, worldLandmarks: pose }]);
  assert.equal(snapshot.angles.elbow, null);
});
