// Impact detector — decides WHEN a limb has struck, and which slice of motion to
// hand the classifier.
//
// Why this is its own module: the live view, the replay reducer and the Python
// training pipeline must all cut windows on identical rules. When they drift, the
// model is scored on a slice of motion it never saw in training and its answers
// degrade for no visible reason. One implementation here, mirrored sample-for-
// sample by `_impacts()` in ml_pipeline/train_model.py.
//
// ── v1 (legacy) ───────────────────────────────────────────────────────────────
// Fire on the first frame whose peak |accel| crosses `thresholdG`, then lock the
// limb out for `refractoryMs`. Kept only so models trained before v2 keep the
// alignment they were trained with.
//
// Two things made v1 fire far too often:
//
//   1. |accel| includes gravity, so a limb at rest already reads 1.0 g. A 3.0 g
//      threshold is really a 2.0 g one, and a shin-mounted IMU clears that on any
//      ordinary footfall — walking and switching stance registered as strikes.
//
//   2. First-crossing, not peak. Measured over ml_pipeline/data, the first frame
//      of a roundhouse to cross 3.0 g reads ~5 g / 260 dps while the actual impact
//      arrives ~250 ms later at ~12 g / 630 dps. v1 therefore timestamped the
//      chamber, and the 125 ms window handed to the model ended there — the model
//      was shown the wind-up and never the strike. Chambering a leg and planting a
//      foot to set up a jab produce that same signature, which is why a stance
//      change came back labelled as a kick.
//
// ── v2 ────────────────────────────────────────────────────────────────────────
// Gravity-removed magnitude, hysteresis, and a short search for the true peak:
//
//   arm      dynamic G (|accel| - 1) crosses `armG` → open a peak search
//   search   keep the largest frame seen; every new largest restarts a `searchMs`
//            timer, so a rising motion is followed to its top instead of being
//            cut off partway
//   fire     `searchMs` passes with no new peak, or the limb drops below
//            `releaseG` — whichever first; the reported window ends at the frame
//            that held the peak
//   re-arm   only after dynamic G falls back under `releaseG`, so the retraction
//            and the foot landing do not each count as another strike
//
// The restart-on-new-peak rule matters for kicks: chamber and impact are one
// continuous burst 250 ms long. A fixed search would expire on the chamber, and
// then the refractory would swallow the impact that followed — the detector
// would report the strike at a third of its real force and hand the model the
// wind-up again.
//
// Frames, not samples: the radio delivers IMU data in fixed batches (8 samples,
// protocol.h IMU_SAMPLES_PER_PACKET) and a window always ends on a batch edge,
// because that is the earliest moment the live path can act on it.

/** Bump when the cutting rule changes; models carry the version they were cut with. */
export const DETECTOR_VERSION = 2;

/** v2 defaults. Tuned against ml_pipeline/data — see docs/detector-tuning.md. */
export const DEFAULT_DETECT_V2 = {
  version:      2,
  armG:         5.0,    // dynamic g (gravity already removed) that opens a search
  releaseG:     2.0,    // must fall back under this before the limb can fire again
  refractoryMs: 400,    // hard floor between two strikes on one limb
  searchMs:     80,     // give up on a bigger peak after this long without one
  minPeakDps:   0,      // optional rotation floor; 0 disables
};

/**
 * Fill in a detector config from whatever a model file (or the tuning sliders)
 * provides. Anything without an explicit version is v1 — older model files were
 * cut with the first-crossing rule and must keep being fed that way.
 * @param {object|null} d
 */
export function normalizeDetect(d) {
  const src = d || {};
  const version = Number(src.version) || 1;
  if (version >= 2) {
    return {
      version:      2,
      armG:         num(src.armG,         DEFAULT_DETECT_V2.armG),
      releaseG:     num(src.releaseG,     DEFAULT_DETECT_V2.releaseG),
      refractoryMs: num(src.refractoryMs, DEFAULT_DETECT_V2.refractoryMs),
      searchMs:     num(src.searchMs,     DEFAULT_DETECT_V2.searchMs),
      minPeakDps:   num(src.minPeakDps,   0),
      minConf:      num(src.minConf,      0),
    };
  }
  return {
    version:      1,
    thresholdG:   num(src.thresholdG,   3.0),
    refractoryMs: num(src.refractoryMs, 250),
    minConf:      num(src.minConf,      0),
  };
}

function num(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

/** Sample rate of the IMU stream — fixed by the firmware. */
export const SAMPLE_RATE_HZ = 400;

/**
 * Build a detector. State is per limb slot, so one detector instance serves the
 * whole rig.
 * @param {object|null} cfg  raw detect settings; see normalizeDetect()
 */
export function createDetector(cfg) {
  const c = normalizeDetect(cfg);
  const searchSamples = c.version >= 2
    ? Math.max(1, Math.round(c.searchMs * SAMPLE_RATE_HZ / 1000))
    : 0;
  const bySlot = new Map();

  function slotState(slot) {
    let s = bySlot.get(slot);
    if (!s) {
      s = { armed: true, searching: false, left: 0,
            bestDyn: 0, bestAbs: 0, bestDps: 0, bestBack: 0, bestAtMs: 0,
            lastFireMs: -1e9 };
      bySlot.set(slot, s);
    }
    return s;
  }

  return {
    cfg: c,
    reset() { bySlot.clear(); },

    /**
     * Offer one radio frame for a limb.
     *
     * @param {number} slot   1..4
     * @param {{maxG:number, maxDps:number, n:number, tMs:number}} frame
     *        maxG   peak |accel| over the frame, in g, gravity INCLUDED
     *        maxDps peak |gyro| over the frame, in deg/s
     *        n      samples in the frame
     *        tMs    timestamp of the frame on the caller's clock
     * @returns {null|{peakG:number, peakDps:number, endBack:number, tMs:number, impactAtMs:number}}
     *        peakG/peakDps of the impact (peakG still gravity-included, so force
     *        stats keep their existing meaning), and `endBack` = how many samples
     *        have been pushed since the end of the frame that held the peak. The
     *        classifier window must end that far back, not at the newest sample.
     *        `impactAtMs` identifies the batch that held the peak on the caller's
     *        monotonic clock, so it can be matched to a nearby camera pose frame.
     */
    feed(slot, frame) {
      const s = slotState(slot);
      const { maxG, maxDps, n, tMs } = frame;

      if (c.version === 1) {
        if (maxG >= c.thresholdG && (tMs - s.lastFireMs) >= c.refractoryMs) {
          s.lastFireMs = tMs;
          return { peakG: maxG, peakDps: maxDps, endBack: 0, tMs, impactAtMs: tMs };
        }
        return null;
      }

      const dyn = Math.max(0, maxG - 1);

      // every pending window end recedes by one frame
      if (s.searching) s.bestBack += n;

      if (!s.searching) {
        // Re-arm on quiet. Until then the tail of the previous strike — the
        // retraction, the foot landing — cannot open a new search.
        if (!s.armed && dyn < c.releaseG) s.armed = true;
        if (s.armed && dyn >= c.armG && (tMs - s.lastFireMs) >= c.refractoryMs) {
          s.searching = true;
          s.armed     = false;
          s.left      = searchSamples - n;
          s.bestDyn = dyn; s.bestAbs = maxG; s.bestDps = maxDps; s.bestBack = 0;
          s.bestAtMs = tMs;
        }
        return null;
      }

      if (dyn > s.bestDyn) {
        // Still climbing — this is not the top yet. Restart the clock so the
        // whole burst is followed rather than the first `searchMs` of it.
        s.bestDyn = dyn; s.bestAbs = maxG; s.bestBack = 0; s.bestAtMs = tMs;
        s.left = searchSamples;
      } else {
        s.left -= n;
      }
      if (maxDps > s.bestDps) s.bestDps = maxDps;

      // The peak is settled once nothing bigger has arrived for searchMs, or the
      // limb has gone quiet.
      if (s.left > 0 && dyn >= c.releaseG) return null;

      s.searching = false;
      if (dyn < c.releaseG) s.armed = true;

      // A strike turns the limb as well as accelerating it. A footfall is a hard
      // linear jolt with little rotation, so an optional rotation floor rejects it
      // without touching the G threshold. Suppressed impacts do not consume the
      // refractory — nothing was counted.
      if (s.bestDps < c.minPeakDps) return null;

      s.lastFireMs = tMs;
      return {
        peakG: s.bestAbs, peakDps: s.bestDps, endBack: s.bestBack, tMs,
        impactAtMs: s.bestAtMs,
      };
    },
  };
}
