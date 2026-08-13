// When is a strike's window ready to be classified?
//
// The model is trained on windows that run PAST the impact: the follow-through is
// what separates a Cross from a Jab at the wrist, and a window ending at the peak
// throws it away (measured — see the window-shape table in
// ml_pipeline/train_model.py). So the live path cannot classify the moment the
// detector fires. It has to wait for `postPeak` more samples to stream in.
//
// This module owns only the counting. It has no opinion about the model, the
// strike log, or the DOM — which is what makes the off-by-one testable.
//
// The arithmetic, in one place:
//
//   endBack   samples from the NEWEST sample back to the end of the frame that
//             held the peak. The detector reports it at fire time, and it grows
//             by one frame every time another frame arrives.
//   postPeak  samples of follow-through the training windows included.
//   back      what windowFor() needs: samples from the newest sample back to
//             where the window should END  =  endBack - postPeak.
//
// While `back` is negative the follow-through has not arrived yet and nothing can
// be classified. Older models carry postPeak 0, so they resolve immediately and
// this whole path costs them nothing.

/**
 * @param {() => number} getPostPeak  read at resolve time, so swapping the model
 *        mid-session takes effect without rebuilding the queue.
 */
export function createNamingQueue(getPostPeak) {
  const bySlot = new Map();     // slot -> { endBack, ctx }

  return {
    /** Strikes waiting on their follow-through. Tests and teardown read this. */
    get size() { return bySlot.size; },

    /**
     * A strike just fired. Returns the context immediately if it is already
     * classifiable, otherwise queues it.
     * @param {number} slot
     * @param {number} endBack  from the detector
     * @param {*} ctx  opaque payload handed back on resolve
     * @returns {{back:number, ctx:*}|null}
     */
    push(slot, endBack, ctx) {
      // One pending window per limb. A second impact inside the follow-through of
      // the first cannot happen — the detector's refractory is 400 ms and the
      // follow-through is 160 ms — but if it ever did, the newer strike is the
      // one the coach just threw, so it wins.
      bySlot.set(slot, { endBack, ctx });
      return this.ready(slot);
    },

    /**
     * Another frame arrived for this limb.
     * @returns {{back:number, ctx:*}|null} the strike to classify, if any
     */
    advance(slot, samples) {
      const p = bySlot.get(slot);
      if (!p) return null;
      p.endBack += samples;
      return this.ready(slot);
    },

    /** Resolve the pending strike for a slot if its window is complete. */
    ready(slot) {
      const p = bySlot.get(slot);
      if (!p) return null;
      const back = p.endBack - getPostPeak();
      if (back < 0) return null;
      bySlot.delete(slot);
      return { back, ctx: p.ctx };
    },

    /** Session reset, model swap, node dropout. */
    clear() { bySlot.clear(); },
  };
}
