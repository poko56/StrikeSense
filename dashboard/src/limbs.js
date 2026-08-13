// Which limb can throw which technique.
//
// The network is handed six axes of IMU and nothing else — the slot is not a
// feature (see FEATURES in ml_pipeline/train_model.py). So nothing inside the
// model stops a shin window from coming back "Jab", or a glove from coming back
// "Roundhouse", and in practice both happen: a leg has only two or three kick
// classes to choose from, so any leg movement that is not still enough to be
// "Idle" is pushed into one of them.
//
// Muay Thai settles this without a model. Hands throw punches and elbows; legs
// throw knees, kicks and teeps. Masking the unreachable labels before the argmax
// costs nothing and removes a whole class of wrong answers.

/** Non-technique classes trained alongside the techniques; either limb may show them. */
export const IDLE_LABEL = 'Idle';
export const MOVE_LABEL = 'Move';

// Fallback for model files exported before `limbs` existed. The names come from
// FINE_NAMES / COARSE_NAMES in train_model.py, so matching on them is exact
// rather than a guess.
const LEG_NAME_RE  = /^(knee|kick|roundhouse|teep|shin)/i;
const HAND_NAME_RE = /^(jab|cross|hook|uppercut|elbow|punch)/i;

/**
 * @param {string} name      technique name as exported in the model's `labels`
 * @param {string} [declared] entry from the model's `limbs` array, when present
 * @returns {'hand'|'leg'|''} '' means any limb may produce it
 */
export function limbOfLabel(name, declared) {
  if (declared === 'hand' || declared === 'leg') return declared;
  if (declared === 'any') return '';
  if (name === IDLE_LABEL || name === MOVE_LABEL) return '';
  if (LEG_NAME_RE.test(name))  return 'leg';
  if (HAND_NAME_RE.test(name)) return 'hand';
  return '';
}

/** Slot → the limb it is strapped to. 1=L-hand 2=R-hand 3=L-shin 4=R-shin. */
export function limbOfSlot(slot) {
  if (slot === 1 || slot === 2) return 'hand';
  if (slot === 3 || slot === 4) return 'leg';
  return '';
}

/**
 * Index of the most likely label the firing limb could actually have produced.
 * @param {ArrayLike<number>} probs  softmax output
 * @param {string[]} labels
 * @param {string[]|null} declaredLimbs  model's `limbs` array, or null
 * @param {number} slot  0 to skip the gate entirely
 * @returns {number} -1 when the model has no reachable label for this limb — a
 *          shin firing on a punches-only model. Naming that would be a guess with
 *          no basis, so callers leave the strike unnamed.
 */
export function bestAllowedIndex(probs, labels, declaredLimbs, slot) {
  const want = limbOfSlot(slot);
  let best = -1;
  for (let i = 0; i < probs.length; i++) {
    const limb = limbOfLabel(labels[i], declaredLimbs ? declaredLimbs[i] : undefined);
    if (want && limb && limb !== want) continue;
    if (best < 0 || probs[i] > probs[best]) best = i;
  }
  return best;
}
