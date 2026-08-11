// Phone-camera motion capture.  This module deliberately keeps camera pose
// separate from the IMU pipeline: pose enriches an impact with joint angles,
// but it never decides (or changes) which sensor slot fired.

import { computePoseAngles, poseSnapshotForImpact } from './posemath.js';
import { state } from './state.js';

export const MOTION_CAPTURE_DEFAULTS = Object.freeze({
  fps: 15,
  historyMs: 2_000,
  maxHistoryFrames: 60,
  maxPoseAgeMs: 250,
  visibilityThreshold: 0.5,
  facing: 'environment',
  // `auto` mirrors the selfie camera, while preserving MediaPipe's anatomical
  // left/right landmarks.  Mirroring is a preview-only coordinate transform.
  mirrorPreview: 'auto',
  wasmRoot: '/mocap/mediapipe/0.10.35/wasm',
  modelAssetPath: '/mocap/mediapipe/0.10.35/models/pose_landmarker_lite.task',
});

// Draw these ourselves instead of relying on DrawingUtils so the overlay stays
// small, predictable and independently testable.  Indices are MediaPipe Pose's
// 33-point layout (see posemath.js).
export const POSE_CONNECTIONS = Object.freeze([
  [0, 1], [1, 2], [2, 3], [3, 7], [0, 4], [4, 5], [5, 6], [6, 8], [9, 10],
  [11, 12], [11, 13], [13, 15], [15, 17], [15, 19], [15, 21], [17, 19],
  [12, 14], [14, 16], [16, 18], [16, 20], [16, 22], [18, 20],
  [11, 23], [12, 24], [23, 24],
  [23, 25], [25, 27], [27, 29], [27, 31], [29, 31],
  [24, 26], [26, 28], [28, 30], [28, 32], [30, 32],
].map(Object.freeze));

const runtime = {
  config: { ...MOTION_CAPTURE_DEFAULTS },
  initialized: false,
  running: false,
  starting: false,
  generation: 0,
  stream: null,
  pendingStream: null,
  landmarker: null,
  rafId: null,
  videoFrameId: null,
  lastInferencePerfMs: null,
  lastVideoFramePerfMs: null,
  fpsTimes: [],
  history: createPoseFrameHistory(MOTION_CAPTURE_DEFAULTS),
  elements: null,
};

/**
 * Set up the dashboard camera controls.  This is intentionally non-invasive:
 * it never asks for camera permission until the user presses `mcStart`.
 */
export function initMotionCapture(options = {}) {
  runtime.config = normaliseConfig({ ...runtime.config, ...options });
  runtime.history = createPoseFrameHistory(runtime.config);
  runtime.elements = findElements();
  bindControls();

  const support = cameraAccessStatus();
  if (!runtime.running && !runtime.starting) {
    patchMocap({
      status: support.ok ? 'idle' : 'unavailable',
      enabled: false,
      fps: 0,
      quality: 0,
      facing: runtime.config.facing,
      lastFrameAtMs: 0,
      last: null,
      lastImpact: null,
      error: support.ok ? '' : support.message,
    });
  } else {
    renderMocap();
  }
  return support;
}

/** Stop camera tracks, cancel inference and discard stale pose frames. */
export function stopMotionCapture() {
  runtime.generation++;
  runtime.running = false;
  runtime.starting = false;
  cancelFrameLoop();

  if (runtime.stream) stopStream(runtime.stream);
  runtime.stream = null;
  if (runtime.pendingStream) stopStream(runtime.pendingStream);
  runtime.pendingStream = null;

  if (runtime.landmarker && typeof runtime.landmarker.close === 'function') {
    runtime.landmarker.close();
  }
  runtime.landmarker = null;
  runtime.lastInferencePerfMs = null;
  runtime.lastVideoFramePerfMs = null;
  runtime.fpsTimes = [];
  runtime.history.clear();

  const video = runtime.elements?.video;
  if (video) {
    try { video.pause?.(); } catch { /* a detached video can reject pause */ }
    video.srcObject = null;
  }

  clearOverlay(runtime.elements?.overlay);
  patchMocap({
    status: 'idle', enabled: false, fps: 0, quality: 0,
    lastFrameAtMs: 0, last: null, lastImpact: null, error: '',
  });
}

/**
 * Attach the nearest camera pose to one sensor impact and return the compact
 * snapshot. `impactAtMs` is deliberately mapped to posemath's `tMs`: both use
 * the same performance.now() monotonic clock as VIDEO inference and the IMU
 * detector, rather than a wall-clock value that can jump or have another epoch.
 */
export function attachPoseToImpact(impact) {
  const snapshot = poseAttachmentForImpact(impact, runtime.history.frames, runtime.config);
  if (impact && typeof impact === 'object') impact.pose = snapshot;
  patchMocap({ lastImpact: snapshot });
  return snapshot;
}

/**
 * Pure form of attachPoseToImpact, exported for deterministic tests and replay
 * code. It accepts a frame list but does not retain it or mutate the impact.
 */
export function poseAttachmentForImpact(impact, frames, {
  maxPoseAgeMs = MOTION_CAPTURE_DEFAULTS.maxPoseAgeMs,
  visibilityThreshold = MOTION_CAPTURE_DEFAULTS.visibilityThreshold,
} = {}) {
  if (!impact || typeof impact !== 'object' || !Number.isFinite(impact.impactAtMs)) return null;
  // Do not pass the frame's slot, and do not use a possibly different timestamp
  // field on impact. The impact's original sensor slot remains authoritative.
  return poseSnapshotForImpact(
    { ...impact, tMs: impact.impactAtMs },
    frames,
    { maxAgeMs: maxPoseAgeMs, visibilityThreshold },
  );
}

/**
 * Browser capability guard. `getUserMedia` is only exposed to secure contexts
 * (HTTPS, plus browser-defined localhost exceptions), so fail before opening a
 * permission prompt with a useful message for the rig's HTTP fallback.
 */
export function cameraAccessStatus(environment = globalThis) {
  const win = environment?.window || environment;
  const nav = environment?.navigator || win?.navigator;
  if (!win || win.isSecureContext !== true) {
    return {
      ok: false,
      code: 'insecure-context',
      message: 'กล้องต้องเปิดผ่าน HTTPS ที่เชื่อถือได้',
    };
  }
  if (typeof nav?.mediaDevices?.getUserMedia !== 'function') {
    return {
      ok: false,
      code: 'camera-unavailable',
      message: 'เบราว์เซอร์นี้ไม่รองรับกล้อง',
    };
  }
  return { ok: true, code: 'ok', message: '' };
}

/** True when a 15 fps (or configured) VIDEO inference is due. */
export function inferenceDue(lastInferenceMs, nowMs, fps = MOTION_CAPTURE_DEFAULTS.fps) {
  const interval = 1_000 / Number(fps);
  if (!Number.isFinite(nowMs) || !Number.isFinite(interval) || interval <= 0) return false;
  return !Number.isFinite(lastInferenceMs) || nowMs - lastInferenceMs >= interval;
}

/**
 * Create the internal rolling pose history. Frames use the monotonic fusion
 * clock, are timestamp-sorted and capped by both age and count, and contain
 * only 3-D world landmarks.
 */
export function createPoseFrameHistory({
  historyMs = MOTION_CAPTURE_DEFAULTS.historyMs,
  maxHistoryFrames = MOTION_CAPTURE_DEFAULTS.maxHistoryFrames,
} = {}) {
  const frames = [];
  const maxAge = finitePositive(historyMs, MOTION_CAPTURE_DEFAULTS.historyMs);
  const maxCount = Math.max(1, Math.floor(finitePositive(maxHistoryFrames, MOTION_CAPTURE_DEFAULTS.maxHistoryFrames)));

  return {
    frames,
    push(frame) {
      if (!frame || !Number.isFinite(frame.tMs) || !Array.isArray(frame.worldLandmarks)) return false;
      frames.push(frame);
      frames.sort((a, b) => a.tMs - b.tMs);
      const newest = frames[frames.length - 1]?.tMs;
      const cutoff = newest - maxAge;
      while (frames.length && (frames[0].tMs < cutoff || frames.length > maxCount)) frames.shift();
      return true;
    },
    clear() { frames.length = 0; },
  };
}

/** Copy a MediaPipe world-landmark pose into a small plain-object frame. */
export function makePoseFrame(tMs, worldLandmarks, normalizedLandmarks = null) {
  if (!Number.isFinite(tMs) || !Array.isArray(worldLandmarks)) return null;
  return {
    tMs,
    // Tasks' `worldLandmarks` can omit visibility/presence, while the matching
    // normalized image landmarks reliably carry them. Copy those confidences
    // onto the 3-D points so posemath never computes a hidden joint as visible.
    worldLandmarks: worldLandmarks.map((landmark, index) =>
      copyWorldLandmark(landmark, normalizedLandmarks?.[index])),
  };
}

/** Fraction of visible normalized landmarks, 0..1. */
export function poseQuality(landmarks, visibilityThreshold = MOTION_CAPTURE_DEFAULTS.visibilityThreshold) {
  if (!Array.isArray(landmarks) || !landmarks.length) return 0;
  const threshold = finiteNumber(visibilityThreshold, MOTION_CAPTURE_DEFAULTS.visibilityThreshold);
  let visible = 0;
  for (const landmark of landmarks) {
    if (!landmark || !Number.isFinite(landmark.x) || !Number.isFinite(landmark.y)) continue;
    const confidence = landmarkConfidence(landmark);
    if (confidence === null || confidence >= threshold) visible++;
  }
  return visible / landmarks.length;
}

/** Project a normalized screen landmark into an overlay canvas. Preview-only. */
export function projectOverlayPoint(landmark, width, height, mirrored = false) {
  if (!landmark || !Number.isFinite(landmark.x) || !Number.isFinite(landmark.y) ||
      !Number.isFinite(width) || !Number.isFinite(height)) return null;
  return {
    x: (mirrored ? 1 - landmark.x : landmark.x) * width,
    y: landmark.y * height,
  };
}

/** Draw a normalized MediaPipe skeleton over the supplied canvas. */
export function drawPoseOverlay(canvas, landmarks, {
  mirrored = false,
  visibilityThreshold = MOTION_CAPTURE_DEFAULTS.visibilityThreshold,
} = {}) {
  const ctx = canvas?.getContext?.('2d');
  if (!ctx) return false;
  const width = canvas.width || canvas.clientWidth || 0;
  const height = canvas.height || canvas.clientHeight || 0;
  if (!(width > 0) || !(height > 0)) return false;

  ctx.clearRect(0, 0, width, height);
  if (!Array.isArray(landmarks) || !landmarks.length) return true;

  const threshold = finiteNumber(visibilityThreshold, MOTION_CAPTURE_DEFAULTS.visibilityThreshold);
  const usable = (landmark) => {
    const confidence = landmarkConfidence(landmark);
    return confidence === null || confidence >= threshold;
  };
  const point = (landmark) => usable(landmark) ? projectOverlayPoint(landmark, width, height, mirrored) : null;

  ctx.save();
  ctx.strokeStyle = '#55f6b0';
  ctx.fillStyle = '#ffffff';
  ctx.lineWidth = Math.max(2, Math.round(width / 320));
  for (const [from, to] of POSE_CONNECTIONS) {
    const a = point(landmarks[from]);
    const b = point(landmarks[to]);
    if (!a || !b) continue;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  for (const landmark of landmarks) {
    const p = point(landmark);
    if (!p) continue;
    ctx.beginPath();
    ctx.arc(p.x, p.y, Math.max(2, Math.round(width / 400)), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
  return true;
}

async function startMotionCapture() {
  if (runtime.running || runtime.starting) return;
  const support = cameraAccessStatus();
  if (!support.ok) {
    patchMocap({ status: 'unavailable', enabled: false, error: support.message });
    return;
  }

  runtime.elements = findElements();
  const video = runtime.elements?.video;
  if (!video) {
    patchMocap({ status: 'error', enabled: false, error: 'ไม่พบพื้นที่แสดงกล้อง' });
    return;
  }

  const generation = ++runtime.generation;
  runtime.starting = true;
  runtime.history.clear();
  runtime.fpsTimes = [];
  runtime.lastInferencePerfMs = null;
  runtime.lastVideoFramePerfMs = null;
  runtime.pendingStream = null;
  patchMocap({
    status: 'loading', enabled: false, fps: 0, quality: 0,
    lastFrameAtMs: 0, last: null, lastImpact: null, error: '',
  });

  let pendingStream = null;
  let pendingLandmarker = null;
  try {
    // Ask for the camera while the Start-button user gesture is still fresh.
    // Some mobile browsers are stricter after an awaited module/network load.
    pendingStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: runtime.config.facing },
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30, max: 30 },
      },
    });
    if (generation !== runtime.generation) { stopStream(pendingStream); return; }
    // Keep this separately from `stream` until MediaPipe has loaded. A stop or
    // pagehide during that asynchronous load must release camera hardware now,
    // not only after the pending import/model promise resolves.
    runtime.pendingStream = pendingStream;

    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    video.srcObject = pendingStream;
    applyPreviewOrientation();
    await waitForVideo(video);
    if (generation !== runtime.generation) { stopStream(pendingStream); return; }

    // Keep the MediaPipe runtime lazy: Node tests and dashboards that never
    // start camera capture must not load its WASM/vision bundle at all.
    const vision = await import('@mediapipe/tasks-vision');
    if (generation !== runtime.generation) { stopStream(pendingStream); return; }
    const fileset = await vision.FilesetResolver.forVisionTasks(runtime.config.wasmRoot);
    if (generation !== runtime.generation) { stopStream(pendingStream); return; }
    pendingLandmarker = await vision.PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: runtime.config.modelAssetPath },
      runningMode: 'VIDEO',
      numPoses: 1,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
    if (generation !== runtime.generation) {
      pendingLandmarker.close?.();
      stopStream(pendingStream);
      return;
    }

    runtime.stream = pendingStream;
    runtime.pendingStream = null;
    runtime.landmarker = pendingLandmarker;
    runtime.running = true;
    patchMocap({ status: 'running', enabled: true, facing: runtime.config.facing, error: '' });
    scheduleFrameLoop();
  } catch (error) {
    if (generation === runtime.generation) {
      stopStream(pendingStream);
      pendingLandmarker?.close?.();
      runtime.stream = null;
      runtime.pendingStream = null;
      runtime.landmarker = null;
      patchMocap({
        status: 'error', enabled: false,
        error: humanCameraError(error),
      });
    }
  } finally {
    if (generation === runtime.generation) runtime.starting = false;
    renderMocap();
  }
}

function scheduleFrameLoop() {
  if (!runtime.running) return;
  const video = runtime.elements?.video;
  if (video && typeof video.requestVideoFrameCallback === 'function') {
    runtime.videoFrameId = video.requestVideoFrameCallback((now, metadata) => {
      runtime.videoFrameId = null;
      const frameAtMs = selectVideoFrameTimestamp(now, metadata, runtime.lastVideoFramePerfMs);
      runtime.lastVideoFramePerfMs = frameAtMs;
      runVideoFrame(frameAtMs);
    });
    return;
  }
  if (typeof requestAnimationFrame === 'function') {
    runtime.rafId = requestAnimationFrame(now => {
      runtime.rafId = null;
      const frameAtMs = selectVideoFrameTimestamp(now, null, runtime.lastVideoFramePerfMs);
      runtime.lastVideoFramePerfMs = frameAtMs;
      runVideoFrame(frameAtMs);
    });
  }
}

function runVideoFrame(performanceMs) {
  if (!runtime.running || !runtime.landmarker) return;

  const video = runtime.elements?.video;
  if (video && video.readyState >= 2 &&
      inferenceDue(runtime.lastInferencePerfMs, performanceMs, runtime.config.fps)) {
    runtime.lastInferencePerfMs = performanceMs;
    try {
      const result = runtime.landmarker.detectForVideo(video, performanceMs);
      consumePoseResult(result, performanceMs, Date.now());
    } catch (error) {
      failRunningCapture(error);
      return;
    }
  }
  scheduleFrameLoop();
}

/**
 * Pick one browser-monotonic time for the displayed video frame.  VFC's
 * expectedDisplayTime is on the same performance.now() timebase as the mapped
 * rig clock; mediaTime is deliberately not used because it has a video epoch.
 */
export function selectVideoFrameTimestamp(nowMs, metadata = null, previousMs = null) {
  const expected = metadata?.expectedDisplayTime;
  const candidate = Number.isFinite(expected) ? expected : nowMs;
  if (!Number.isFinite(candidate)) return Number.isFinite(previousMs) ? previousMs : 0;
  return Number.isFinite(previousMs) ? Math.max(candidate, previousMs) : candidate;
}

function consumePoseResult(result, performanceMs, wallMs) {
  const imageLandmarks = firstPose(result?.landmarks);
  const worldLandmarks = firstPose(result?.worldLandmarks);
  const quality = poseQuality(imageLandmarks, runtime.config.visibilityThreshold);

  syncOverlaySize();
  drawPoseOverlay(runtime.elements?.overlay, imageLandmarks, {
    // The dashboard stage flips both video and canvas together in CSS. If this
    // helper is used without that stage, retain a coordinate-flip fallback.
    mirrored: overlayNeedsCoordinateMirror(),
    visibilityThreshold: runtime.config.visibilityThreshold,
  });

  if (worldLandmarks?.length) {
    // Store the monotonic timestamp. `impact.impactAtMs` comes from the IMU
    // detector's performance.now() clock, so this is the only safe basis for
    // nearest-frame matching. `wallMs` below is only used to measure camera fps.
    const frame = makePoseFrame(performanceMs, worldLandmarks, imageLandmarks);
    if (frame) {
      runtime.history.push(frame);
      const angles = compactAngles(computePoseAngles(frame.worldLandmarks, {
        visibilityThreshold: runtime.config.visibilityThreshold,
      }));
      patchMocap({
        status: 'running', enabled: true, quality, lastFrameAtMs: performanceMs,
        last: { tMs: performanceMs, angles },
      }, false);
    }
  } else {
    // Keep history for a just-arrived IMU impact, but do not present old angles
    // as if a current frame still had a tracked body.
    patchMocap({ status: 'running', enabled: true, quality, lastFrameAtMs: performanceMs, last: null }, false);
  }

  runtime.fpsTimes.push(wallMs);
  const cutoff = wallMs - 1_000;
  while (runtime.fpsTimes.length && runtime.fpsTimes[0] < cutoff) runtime.fpsTimes.shift();
  patchMocap({ fps: runtime.fpsTimes.length }, false);
  renderMocap();
}

function failRunningCapture(error) {
  const message = humanCameraError(error);
  const stream = runtime.stream;
  runtime.running = false;
  cancelFrameLoop();
  if (stream) stopStream(stream);
  runtime.stream = null;
  runtime.landmarker?.close?.();
  runtime.landmarker = null;
  if (runtime.elements?.video) runtime.elements.video.srcObject = null;
  patchMocap({ status: 'error', enabled: false, error: message });
}

function findElements() {
  if (typeof document === 'undefined') return null;
  const byId = (id) => document.getElementById(id);
  return {
    start: byId('mcStart'),
    stop: byId('mcStop'),
    facing: byId('mcFacing'),
    status: byId('mcStatus'),
    stage: byId('mcStage'),
    video: byId('mcVideo'),
    overlay: byId('mcOverlay'),
    empty: byId('mcEmpty'),
    fps: byId('mcFps'),
    quality: byId('mcQuality'),
    lastAngles: byId('mcLastAngles'),
    sync: byId('mcSync'),
  };
}

function bindControls() {
  if (runtime.initialized || !runtime.elements) return;
  runtime.initialized = true;
  runtime.elements.start?.addEventListener('click', () => { void startMotionCapture(); });
  runtime.elements.stop?.addEventListener('click', stopMotionCapture);
  runtime.elements.facing?.addEventListener('change', async (event) => {
    const next = event.currentTarget?.value === 'environment' ? 'environment' : 'user';
    if (next === runtime.config.facing) return;
    const restart = runtime.running || runtime.starting;
    runtime.config = normaliseConfig({ ...runtime.config, facing: next });
    patchMocap({ facing: next });
    if (restart) {
      stopMotionCapture();
      await startMotionCapture();
    } else {
      applyPreviewOrientation();
    }
  });
}

function patchMocap(patch, render = true) {
  if (state?.mocap && typeof state.mocap === 'object') Object.assign(state.mocap, patch);
  if (render) renderMocap();
}

function renderMocap() {
  const elements = runtime.elements;
  if (!elements) return;
  const m = state?.mocap || {};
  const support = cameraAccessStatus();
  setText(elements.status, m.error || statusLabel(m.status));
  if (elements.status) {
    elements.status.dataset.state = m.status || 'idle';
    elements.status.classList.toggle('is-running', m.status === 'running');
    elements.status.classList.toggle('is-warn', m.status === 'unavailable' || m.status === 'error');
    elements.status.classList.toggle('is-error', m.status === 'error');
  }
  if (elements.stage?.classList) {
    elements.stage.classList.toggle('is-running', runtime.running);
    elements.stage.classList.toggle('is-mirrored', isPreviewMirrored());
  }
  if (elements.start) elements.start.disabled = !support.ok || runtime.running || runtime.starting;
  if (elements.stop) elements.stop.disabled = !runtime.running && !runtime.starting;
  if (elements.facing) elements.facing.value = runtime.config.facing;
  if (elements.empty) {
    elements.empty.hidden = !!runtime.running;
    const title = elements.empty.querySelector?.('b');
    const detail = elements.empty.querySelector?.('span');
    if (m.status === 'error') {
      setText(title, 'เปิดกล้องไม่ได้');
      setText(detail, m.error || 'ตรวจสอบสิทธิ์กล้องและไฟล์ MediaPipe บน SD');
    } else if (m.status === 'unavailable') {
      setText(title, 'ต้องเปิดผ่าน HTTPS');
      setText(detail, m.error || 'กล้องต้องใช้ HTTPS ที่ trusted ก่อน');
    } else {
      setText(title, 'กล้องยังไม่เริ่ม');
      setText(detail, 'ต้องเปิดหน้านี้ผ่าน HTTPS ที่ trusted ก่อน');
    }
  }
  setText(elements.fps, Number.isFinite(m.fps) ? `${m.fps.toFixed(0)} fps` : '—');
  setText(elements.quality, Number.isFinite(m.quality) ? `${Math.round(m.quality * 100)}%` : '—');
  setText(elements.lastAngles, formatAngles(m.last?.angles));
  if (!m.lastImpact) {
    setText(elements.sync, '—');
  } else if (hasUsablePoseAngles(m.lastImpact)) {
    setText(elements.sync, `Δ≈${Math.round(m.lastImpact.ageMs)} ms`);
  } else {
    setText(elements.sync, `Δ≈${Math.round(m.lastImpact.ageMs)} ms · มุมถูกบัง`);
  }
}

function applyPreviewOrientation() {
  const video = runtime.elements?.video;
  if (!video?.style) return;
  const stage = runtime.elements?.stage;
  if (stage?.classList) {
    // CSS flips video and canvas as one image plane, so skeleton points retain
    // their relative position. World landmarks are never transformed or swapped.
    stage.classList.toggle('is-mirrored', isPreviewMirrored());
    video.style.transform = '';
    return;
  }
  // Standalone fallback: flip video in CSS and flip only overlay coordinates.
  video.style.transform = isPreviewMirrored() ? 'scaleX(-1)' : '';
  video.style.transformOrigin = 'center';
}

function overlayNeedsCoordinateMirror() {
  return isPreviewMirrored() && !runtime.elements?.stage?.classList;
}

function isPreviewMirrored() {
  return typeof runtime.config.mirrorPreview === 'boolean'
    ? runtime.config.mirrorPreview
    : runtime.config.facing === 'user';
}

function syncOverlaySize() {
  const video = runtime.elements?.video;
  const canvas = runtime.elements?.overlay;
  if (!video || !canvas || !(video.videoWidth > 0) || !(video.videoHeight > 0)) return;
  if (canvas.width !== video.videoWidth) canvas.width = video.videoWidth;
  if (canvas.height !== video.videoHeight) canvas.height = video.videoHeight;
}

function clearOverlay(canvas) {
  const ctx = canvas?.getContext?.('2d');
  if (ctx && canvas.width && canvas.height) ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function cancelFrameLoop() {
  const video = runtime.elements?.video;
  if (runtime.videoFrameId !== null && typeof video?.cancelVideoFrameCallback === 'function') {
    try { video.cancelVideoFrameCallback(runtime.videoFrameId); } catch { /* already dispatched */ }
  }
  runtime.videoFrameId = null;
  if (runtime.rafId !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(runtime.rafId);
  runtime.rafId = null;
}

function stopStream(stream) {
  stream?.getTracks?.().forEach(track => track.stop());
}

async function waitForVideo(video) {
  if (video.readyState >= 1) {
    await video.play();
    return;
  }
  await new Promise((resolve, reject) => {
    const done = () => { cleanup(); resolve(); };
    const failed = () => { cleanup(); reject(new Error('Camera metadata unavailable')); };
    const cleanup = () => {
      video.removeEventListener?.('loadedmetadata', done);
      video.removeEventListener?.('error', failed);
    };
    video.addEventListener?.('loadedmetadata', done, { once: true });
    video.addEventListener?.('error', failed, { once: true });
    // The event can arrive between the readyState check above and listener
    // registration on a very fast camera; do not leave start pending forever.
    if (video.readyState >= 1) done();
  });
  await video.play();
}

function firstPose(poses) {
  if (!Array.isArray(poses)) return null;
  return Array.isArray(poses[0]) ? poses[0] : poses;
}

function copyWorldLandmark(landmark, normalizedLandmark) {
  if (!landmark || typeof landmark !== 'object') return null;
  const out = { x: landmark.x, y: landmark.y, z: landmark.z };
  for (const key of ['visibility', 'presence']) {
    const value = Number.isFinite(normalizedLandmark?.[key])
      ? normalizedLandmark[key]
      : landmark[key];
    if (Number.isFinite(value)) out[key] = value;
  }
  return out;
}

function compactAngles(angles) {
  const compact = {};
  for (const [joint, degrees] of Object.entries(angles)) {
    compact[joint] = degrees === null ? null : Math.round(degrees * 10) / 10;
  }
  return compact;
}

function landmarkConfidence(landmark) {
  if (!landmark || typeof landmark !== 'object') return -Infinity;
  let confidence = null;
  for (const key of ['visibility', 'presence']) {
    if (Number.isFinite(landmark[key])) {
      confidence = confidence === null ? landmark[key] : Math.min(confidence, landmark[key]);
    }
  }
  return confidence;
}

function normaliseConfig(config) {
  return {
    ...MOTION_CAPTURE_DEFAULTS,
    ...config,
    fps: finitePositive(config.fps, MOTION_CAPTURE_DEFAULTS.fps),
    historyMs: finitePositive(config.historyMs, MOTION_CAPTURE_DEFAULTS.historyMs),
    maxHistoryFrames: Math.max(1, Math.floor(finitePositive(config.maxHistoryFrames, MOTION_CAPTURE_DEFAULTS.maxHistoryFrames))),
    maxPoseAgeMs: finitePositive(config.maxPoseAgeMs, MOTION_CAPTURE_DEFAULTS.maxPoseAgeMs),
    visibilityThreshold: finiteNumber(config.visibilityThreshold, MOTION_CAPTURE_DEFAULTS.visibilityThreshold),
    facing: config.facing === 'environment' ? 'environment' : 'user',
    mirrorPreview: typeof config.mirrorPreview === 'boolean' ? config.mirrorPreview : 'auto',
  };
}

function finitePositive(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function finiteNumber(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function setText(element, value) {
  if (element) element.textContent = value;
}

function statusLabel(status) {
  if (status === 'loading') return 'กำลังเตรียมกล้อง/MediaPipe…';
  if (status === 'running') return 'กำลังจับท่าทาง';
  if (status === 'unavailable') return 'ต้องใช้ HTTPS';
  if (status === 'error') return 'กล้องมีปัญหา';
  return 'พร้อมใช้งาน';
}

function formatAngles(angles) {
  if (!angles || typeof angles !== 'object') return '—';
  const values = Object.entries(angles)
    .filter(([, value]) => Number.isFinite(value))
    .map(([joint, value]) => `${joint} ${Math.round(value)}°`);
  return values.length ? values.join(' · ') : '—';
}

function hasUsablePoseAngles(snapshot) {
  return !!snapshot && Object.values(snapshot.angles || {}).some(Number.isFinite);
}

function humanCameraError(error) {
  const name = error?.name || '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'อนุญาตการใช้กล้องในเบราว์เซอร์ก่อน';
  if (name === 'NotFoundError') return 'ไม่พบกล้องในอุปกรณ์';
  if (name === 'NotReadableError') return 'กล้องกำลังถูกแอปอื่นใช้งาน';
  return error?.message || 'เปิด motion capture ไม่สำเร็จ';
}
