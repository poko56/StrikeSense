// Pure pose helpers for the phone-camera motion-capture path.
//
// The camera and the IMU intentionally remain separate sources of truth:
// IMU slot 1..4 says *which fitted sensor fired*; a nearby pose frame only
// adds the corresponding anatomical angles.  Nothing in this module infers or
// rewrites a sensor slot from the camera image.

/** MediaPipe Pose's stable 33-landmark index layout. */
export const MP_LANDMARK = Object.freeze({
  NOSE: 0,
  LEFT_EYE_INNER: 1,
  LEFT_EYE: 2,
  LEFT_EYE_OUTER: 3,
  RIGHT_EYE_INNER: 4,
  RIGHT_EYE: 5,
  RIGHT_EYE_OUTER: 6,
  LEFT_EAR: 7,
  RIGHT_EAR: 8,
  MOUTH_LEFT: 9,
  MOUTH_RIGHT: 10,
  LEFT_SHOULDER: 11,
  RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13,
  RIGHT_ELBOW: 14,
  LEFT_WRIST: 15,
  RIGHT_WRIST: 16,
  LEFT_PINKY: 17,
  RIGHT_PINKY: 18,
  LEFT_INDEX: 19,
  RIGHT_INDEX: 20,
  LEFT_THUMB: 21,
  RIGHT_THUMB: 22,
  LEFT_HIP: 23,
  RIGHT_HIP: 24,
  LEFT_KNEE: 25,
  RIGHT_KNEE: 26,
  LEFT_ANKLE: 27,
  RIGHT_ANKLE: 28,
  LEFT_HEEL: 29,
  RIGHT_HEEL: 30,
  LEFT_FOOT_INDEX: 31,
  RIGHT_FOOT_INDEX: 32,
});

// A descriptive alias is useful at call sites without creating a second,
// divergent table of landmark numbers.
export const MEDIAPIPE_POSE_LANDMARKS = MP_LANDMARK;

export const DEFAULT_VISIBILITY_THRESHOLD = 0.5;
export const DEFAULT_MAX_POSE_AGE_MS = 250;

/**
 * Sensor slot -> the anatomical chain to read from a MediaPipe pose.
 * Slots deliberately match `limbs.js`: 1=L hand, 2=R hand, 3=L shin, 4=R shin.
 */
export const SLOT_POSE_PART = Object.freeze({
  1: Object.freeze({ side: 'left',  limb: 'hand', posePart: 'leftHand',  angleKeys: Object.freeze(['shoulder', 'elbow']) }),
  2: Object.freeze({ side: 'right', limb: 'hand', posePart: 'rightHand', angleKeys: Object.freeze(['shoulder', 'elbow']) }),
  3: Object.freeze({ side: 'left',  limb: 'leg',  posePart: 'leftLeg',   angleKeys: Object.freeze(['hip', 'knee', 'ankle']) }),
  4: Object.freeze({ side: 'right', limb: 'leg',  posePart: 'rightLeg',  angleKeys: Object.freeze(['hip', 'knee', 'ankle']) }),
});

/**
 * Three landmarks defining each anatomical joint angle: [first, vertex, third].
 * Shoulder/hip use the same-side torso landmark as their proximal reference;
 * ankle uses the foot-index landmark so the result describes shin-to-foot bend.
 */
export const JOINT_ANGLE_TRIPLETS = Object.freeze({
  leftShoulder:  Object.freeze([MP_LANDMARK.LEFT_HIP,      MP_LANDMARK.LEFT_SHOULDER, MP_LANDMARK.LEFT_ELBOW]),
  rightShoulder: Object.freeze([MP_LANDMARK.RIGHT_HIP,     MP_LANDMARK.RIGHT_SHOULDER, MP_LANDMARK.RIGHT_ELBOW]),
  leftElbow:     Object.freeze([MP_LANDMARK.LEFT_SHOULDER, MP_LANDMARK.LEFT_ELBOW,    MP_LANDMARK.LEFT_WRIST]),
  rightElbow:    Object.freeze([MP_LANDMARK.RIGHT_SHOULDER, MP_LANDMARK.RIGHT_ELBOW,  MP_LANDMARK.RIGHT_WRIST]),
  leftHip:       Object.freeze([MP_LANDMARK.LEFT_SHOULDER, MP_LANDMARK.LEFT_HIP,      MP_LANDMARK.LEFT_KNEE]),
  rightHip:      Object.freeze([MP_LANDMARK.RIGHT_SHOULDER, MP_LANDMARK.RIGHT_HIP,    MP_LANDMARK.RIGHT_KNEE]),
  leftKnee:      Object.freeze([MP_LANDMARK.LEFT_HIP,      MP_LANDMARK.LEFT_KNEE,     MP_LANDMARK.LEFT_ANKLE]),
  rightKnee:     Object.freeze([MP_LANDMARK.RIGHT_HIP,     MP_LANDMARK.RIGHT_KNEE,    MP_LANDMARK.RIGHT_ANKLE]),
  leftAnkle:     Object.freeze([MP_LANDMARK.LEFT_KNEE,     MP_LANDMARK.LEFT_ANKLE,    MP_LANDMARK.LEFT_FOOT_INDEX]),
  rightAnkle:    Object.freeze([MP_LANDMARK.RIGHT_KNEE,    MP_LANDMARK.RIGHT_ANKLE,   MP_LANDMARK.RIGHT_FOOT_INDEX]),
});

/** Return the fixed camera-side mapping for a sensor slot, or null if unknown. */
export function slotPosePart(slot) {
  const n = Number(slot);
  return Number.isInteger(n) ? (SLOT_POSE_PART[n] || null) : null;
}

/**
 * True when a world landmark can safely contribute to an angle.
 *
 * Some MediaPipe builds omit visibility/presence from world landmarks.  In that
 * case finite xyz values are accepted; when either confidence is supplied it
 * must satisfy the threshold.
 */
export function landmarkVisible(landmark, visibilityThreshold = DEFAULT_VISIBILITY_THRESHOLD) {
  if (!landmark || !Number.isFinite(landmark.x) || !Number.isFinite(landmark.y) || !Number.isFinite(landmark.z)) {
    return false;
  }
  const threshold = finiteThreshold(visibilityThreshold);
  for (const key of ['visibility', 'presence']) {
    const value = landmark[key];
    if (typeof value === 'number' && Number.isFinite(value) && value < threshold) return false;
  }
  return true;
}

/**
 * Measure the 3-D interior angle a-vertex-c in degrees, or null when any point
 * is not confidently visible or either vector has no length.
 */
export function jointAngle3d(worldLandmarks, firstIndex, vertexIndex, thirdIndex,
                             visibilityThreshold = DEFAULT_VISIBILITY_THRESHOLD) {
  if (!Array.isArray(worldLandmarks)) return null;
  const first = worldLandmarks[firstIndex];
  const vertex = worldLandmarks[vertexIndex];
  const third = worldLandmarks[thirdIndex];
  if (!landmarkVisible(first, visibilityThreshold) ||
      !landmarkVisible(vertex, visibilityThreshold) ||
      !landmarkVisible(third, visibilityThreshold)) return null;

  const ax = first.x - vertex.x;
  const ay = first.y - vertex.y;
  const az = first.z - vertex.z;
  const bx = third.x - vertex.x;
  const by = third.y - vertex.y;
  const bz = third.z - vertex.z;
  const aLength = Math.hypot(ax, ay, az);
  const bLength = Math.hypot(bx, by, bz);
  if (!(aLength > 0) || !(bLength > 0)) return null;

  const cosine = (ax * bx + ay * by + az * bz) / (aLength * bLength);
  // Floating-point round-off can make a straight joint 1.0000000000000002.
  const bounded = Math.max(-1, Math.min(1, cosine));
  return Math.acos(bounded) * 180 / Math.PI;
}

/** Compute all bilateral arm and leg joint angles from one world-landmark pose. */
export function computePoseAngles(worldLandmarks, { visibilityThreshold = DEFAULT_VISIBILITY_THRESHOLD } = {}) {
  const out = {};
  for (const [name, [first, vertex, third]] of Object.entries(JOINT_ANGLE_TRIPLETS)) {
    out[name] = jointAngle3d(worldLandmarks, first, vertex, third, visibilityThreshold);
  }
  return out;
}

/**
 * Pull a single-pose world-landmark array out of the frame shapes used by the
 * dashboard and MediaPipe Tasks.  A Tasks result has `worldLandmarks[0]`; the
 * dashboard normally stores that first pose directly as `worldLandmarks`.
 */
export function worldLandmarksFromFrame(frame) {
  if (!frame || typeof frame !== 'object') return null;
  for (const candidate of [frame.worldLandmarks, frame.landmarks, frame.poseWorldLandmarks]) {
    if (!Array.isArray(candidate)) continue;
    if (Array.isArray(candidate[0])) return candidate[0];
    return candidate;
  }
  return null;
}

/** Return a timestamp in milliseconds from supported frame/impact field names. */
export function timestampMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (!value || typeof value !== 'object') return null;
  for (const key of ['tMs', 'timestamp', 'timeMs', 'at']) {
    const candidate = value[key];
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;
  }
  return null;
}

/**
 * Find the closest timestamped camera frame to an impact on the same clock.
 * A tie is resolved toward the earlier frame, making selection deterministic.
 * The result is null when the closest frame lies outside maxAgeMs.
 */
export function nearestPoseFrame(frames, impactAtMs, maxAgeMs = DEFAULT_MAX_POSE_AGE_MS) {
  const impactTime = timestampMs(impactAtMs);
  const maximumAge = finiteAge(maxAgeMs);
  if (!Array.isArray(frames) || impactTime === null || maximumAge === null) return null;

  let closest = null;
  for (const frame of frames) {
    const tMs = timestampMs(frame);
    if (tMs === null) continue;
    const ageMs = Math.abs(tMs - impactTime);
    if (ageMs > maximumAge) continue;
    if (!closest || ageMs < closest.ageMs || (ageMs === closest.ageMs && tMs < closest.tMs)) {
      closest = { frame, tMs, ageMs };
    }
  }
  return closest;
}

/**
 * Produce the small, JSON-safe pose attachment for one IMU impact.
 *
 * `impact.slot` is copied verbatim (after numeric validation) and determines
 * which side/limb angles are selected.  A pose frame's own `slot` field is
 * deliberately ignored: one phone pose represents the whole fighter.
 */
export function poseSnapshotForImpact(impact, frames, {
  maxAgeMs = DEFAULT_MAX_POSE_AGE_MS,
  visibilityThreshold = DEFAULT_VISIBILITY_THRESHOLD,
} = {}) {
  if (!impact || typeof impact !== 'object') return null;
  const slot = Number(impact.slot);
  const part = slotPosePart(slot);
  const impactAtMs = timestampMs(impact);
  if (!part || impactAtMs === null) return null;

  const nearest = nearestPoseFrame(frames, impactAtMs, maxAgeMs);
  if (!nearest) return null;
  const worldLandmarks = worldLandmarksFromFrame(nearest.frame);
  if (!worldLandmarks) return null;

  const allAngles = computePoseAngles(worldLandmarks, { visibilityThreshold });
  const prefix = part.side;
  const angles = {};
  for (const joint of part.angleKeys) {
    angles[joint] = compactDegrees(allAngles[prefix + capitalise(joint)]);
  }

  return {
    slot,
    side: part.side,
    limb: part.limb,
    posePart: part.posePart,
    frameAtMs: nearest.tMs,
    ageMs: nearest.ageMs,
    angles,
  };
}

function finiteThreshold(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : DEFAULT_VISIBILITY_THRESHOLD;
}

function finiteAge(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function capitalise(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function compactDegrees(value) {
  return value === null ? null : Math.round(value * 10) / 10;
}
