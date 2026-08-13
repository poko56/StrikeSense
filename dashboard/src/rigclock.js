// Map the Main Node's uint32 `millis()` timestamps onto the browser's
// performance.now() clock.  WebSocket arrival time alone is not the physical
// order of an IMU batch: a coalesced message can contain frames tens of ms apart.
//
// The mapper takes the lowest observed transport delay as its offset. This is a
// practical one-way-clock estimate on a local AP, not a substitute for a
// calibrated high-speed camera sync; callers should expose it as an estimate.

const UINT32_SPAN = 0x1_0000_0000;
const HALF_UINT32 = 0x8000_0000;
const RESET_BACKWARD_MS = 1_000;
const DEFAULT_OBSERVATION_WINDOW_MS = 10_000;

export function createRigClockMapper({ observationWindowMs = DEFAULT_OBSERVATION_WINDOW_MS } = {}) {
  let lastRawMs = null;
  let epochMs = 0;
  let offsetMs = null;
  let lastMappedMs = null;
  const observations = [];
  const minimums = [];
  let observationHead = 0;
  let minimumHead = 0;
  const oneValue = [0];
  const oneResult = [];
  const windowMs = Number.isFinite(observationWindowMs) && observationWindowMs > 0
    ? observationWindowMs
    : DEFAULT_OBSERVATION_WINDOW_MS;

  function reset() {
    lastRawMs = null;
    epochMs = 0;
    offsetMs = null;
    lastMappedMs = null;
    observations.length = 0;
    minimums.length = 0;
    observationHead = 0;
    minimumHead = 0;
  }

  // Reset a rig epoch without resetting `lastMappedMs`: a Main Node reboot must
  // not make a detector that is already armed see time travel backward.
  function resetRigEpoch() {
    lastRawMs = null;
    epochMs = 0;
    offsetMs = null;
    observations.length = 0;
    minimums.length = 0;
    observationHead = 0;
    minimumHead = 0;
  }

  function unwrapRigMs(raw) {
    let outOfOrder = false;
    if (lastRawMs !== null && raw < lastRawMs) {
      const backwards = lastRawMs - raw;
      if (backwards > HALF_UINT32) {
        // Normal uint32 millis() wrap after ~49.7 days.
        epochMs += UINT32_SPAN;
      } else if (backwards > RESET_BACKWARD_MS) {
        resetRigEpoch();
      } else {
        // TCP preserves WebSocket-message order, but a firmware batch can still
        // contain a late frame. It must not move the unwrapping anchor backward.
        outOfOrder = true;
      }
    }
    if (!outOfOrder) lastRawMs = raw;
    return epochMs + raw;
  }

  function observeOffset(unwrappedRigMs, arrivalPerfMs) {
    const observedOffset = arrivalPerfMs - unwrappedRigMs;
    const observation = { atMs: arrivalPerfMs, offsetMs: observedOffset };
    observations.push(observation);
    // Monotonic deque: retain the lower envelope in O(1) amortised work even
    // while four IMUs are streaming. Equal values prefer the newer sample, so
    // expiry cannot leave an obsolete duplicate at the front.
    while (minimums.length > minimumHead &&
           minimums[minimums.length - 1].offsetMs >= observedOffset) {
      minimums.pop();
    }
    minimums.push(observation);
    const cutoff = arrivalPerfMs - windowMs;
    while (observationHead < observations.length &&
           observations[observationHead].atMs < cutoff) {
      const expired = observations[observationHead++];
      if (minimums[minimumHead] === expired) minimumHead++;
    }
    // Bound shifted-array bookkeeping without throwing away any observation in
    // the active time window.
    if (observationHead > 256) {
      observations.splice(0, observationHead);
      observationHead = 0;
    }
    if (minimumHead > 256) {
      minimums.splice(0, minimumHead);
      minimumHead = 0;
    }
    offsetMs = minimums[minimumHead]?.offsetMs ?? observedOffset;
  }

  /**
   * Map every rig timestamp in one received WS message before emitting any of
   * them. This is essential for an initial coalesced batch: its latest frame
   * reveals the lower transport offset, then its earlier frames retain their
   * true Main-Node spacing instead of all being stamped at arrival.
   */
  function mapBatch(rigRawMsValues, arrivalPerfMs, result = []) {
    result.length = 0;
    if (!Array.isArray(rigRawMsValues) || !Number.isFinite(arrivalPerfMs)) {
      for (let i = 0; i < (rigRawMsValues?.length || 0); i++) result.push(arrivalPerfMs);
      return result;
    }

    const unwrapped = new Array(rigRawMsValues.length);
    for (let i = 0; i < rigRawMsValues.length; i++) {
      const source = rigRawMsValues[i];
      if (!Number.isFinite(source)) continue;
      const value = unwrapRigMs(Math.trunc(source) >>> 0);
      unwrapped[i] = value;
      observeOffset(value, arrivalPerfMs);
    }

    // The lower envelope estimates the least queued local transport path while
    // allowing Wi-Fi conditions to evolve over a long session. Delayed packets
    // therefore cannot pull an old impact toward the present.
    for (const value of unwrapped) {
      const candidate = Number.isFinite(value) ? value + offsetMs : arrivalPerfMs;
      // A newly observed faster path can reduce the offset. Never emit a backward
      // timestamp: detector search/refractory state assumes monotonic time.
      const mapped = lastMappedMs === null ? candidate : Math.max(candidate, lastMappedMs);
      lastMappedMs = mapped;
      result.push(mapped);
    }
    return result;
  }

  /** Return one rig timestamp on the browser's monotonic timebase. */
  function map(rigRawMs, arrivalPerfMs) {
    if (!Number.isFinite(rigRawMs) || !Number.isFinite(arrivalPerfMs)) return arrivalPerfMs;
    oneValue[0] = rigRawMs;
    return mapBatch(oneValue, arrivalPerfMs, oneResult)[0];
  }

  return {
    map,
    mapBatch,
    reset,
    get offsetMs() { return offsetMs; },
  };
}
