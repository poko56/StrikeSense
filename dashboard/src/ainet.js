// ──────────────────────────────────────────────────────────────────
// Pure 1D-CNN forward pass — no DOM, no app state, no dependencies.
// Kept separate from aimodel.js so it can be unit-tested in Node against
// Keras (see ml_pipeline/verify_web_model.py). Layout & semantics mirror
// tf.keras exactly (Conv1D 'same'/'valid', BatchNorm, MaxPool1D, GAP, Dense).
// ──────────────────────────────────────────────────────────────────

export function f32(arr) { return arr instanceof Float32Array ? arr : Float32Array.from(arr); }

export function parseModel(doc) {
  if (!doc || doc.format !== 'strikesense-web/1')
    throw new Error('ไฟล์ไม่ใช่โมเดล StrikeSense (format ไม่ตรง)');
  if (!Array.isArray(doc.labels) || !doc.labels.length)
    throw new Error('โมเดลไม่มีรายชื่อคลาส (labels)');
  const mean = f32(doc.norm?.mean ?? []);
  const std  = f32(doc.norm?.std  ?? []);
  if (mean.length !== doc.features || std.length !== doc.features)
    throw new Error('ค่า normalisation (mean/std) ไม่ครบตามจำนวนแกน');

  const layers = doc.layers.map(l => {
    switch (l.type) {
      case 'conv1d':
        return {
          type: 'conv1d',
          k: l.kernel_size, filters: l.filters,
          strides: l.strides || 1, padding: l.padding || 'valid',
          act: l.activation || 'linear',
          kShape: l.kernel_shape,           // [k, Cin, F]
          W: f32(l.kernel), b: f32(l.bias),
        };
      case 'batch_normalization':
        return {
          type: 'bn', eps: l.epsilon ?? 1e-3,
          gamma: f32(l.gamma), beta: f32(l.beta),
          mean: f32(l.moving_mean), var: f32(l.moving_variance),
        };
      case 'max_pooling1d':
        return { type: 'maxpool', pool: l.pool_size, strides: l.strides || l.pool_size };
      case 'global_average_pooling1d':
        return { type: 'gap' };
      case 'flatten':
        return { type: 'flatten' };
      case 'dropout':
        return { type: 'skip' };
      case 'dense':
        return {
          type: 'dense', units: l.units, act: l.activation || 'linear',
          inDim: l.kernel_shape[0], outDim: l.kernel_shape[1],
          W: f32(l.kernel), b: f32(l.bias),
        };
      case 'activation':
        return { type: 'act', act: l.activation || 'linear' };
      default:
        throw new Error(`เลเยอร์ที่ไม่รองรับ: ${l.type}`);
    }
  });

  return {
    timeSteps: doc.time_steps, features: doc.features,
    labels: doc.labels, mean, std, layers,
    meta: {
      labels: doc.labels, time_steps: doc.time_steps, features: doc.features,
      label_mode: doc.label_mode || '—', created: doc.created || '',
    },
  };
}

// Temporal tensor: { d:Float32Array, T, C } row-major (t*C + c).
function applyAct(x, act) {
  if (act === 'relu') { for (let i = 0; i < x.length; i++) if (x[i] < 0) x[i] = 0; }
  return x;   // 'linear' → no-op; softmax handled on the final logits vector
}

function conv1d(inp, L) {
  const { T, C } = inp;
  const k = L.k, F = L.filters, s = L.strides;
  const padTotal = L.padding === 'same' ? (k - 1) : 0;
  const padL = padTotal >> 1;
  const Tout = L.padding === 'same'
    ? Math.floor((T - 1) / s) + 1
    : Math.floor((T - k) / s) + 1;
  const out = new Float32Array(Tout * F);
  const W = L.W, b = L.b;                    // W layout [k, C, F] → ((kk*C)+c)*F + f
  for (let to = 0; to < Tout; to++) {
    const start = to * s - padL;
    for (let f = 0; f < F; f++) {
      let acc = b[f];
      for (let kk = 0; kk < k; kk++) {
        const ti = start + kk;
        if (ti < 0 || ti >= T) continue;
        const inBase = ti * C;
        const wBase  = (kk * C) * F + f;
        for (let c = 0; c < C; c++) acc += inp.d[inBase + c] * W[wBase + c * F];
      }
      out[to * F + f] = acc;
    }
  }
  applyAct(out, L.act);
  return { d: out, T: Tout, C: F };
}

function batchNorm(inp, L) {
  const { T, C, d } = inp;
  for (let c = 0; c < C; c++) {
    const inv = L.gamma[c] / Math.sqrt(L.var[c] + L.eps);
    const off = L.beta[c] - L.mean[c] * inv;
    for (let t = 0; t < T; t++) { const i = t * C + c; d[i] = d[i] * inv + off; }
  }
  return inp;
}

function maxPool1d(inp, L) {
  const { T, C, d } = inp;
  const p = L.pool, s = L.strides;
  const Tout = Math.floor((T - p) / s) + 1;
  const out = new Float32Array(Tout * C);
  for (let to = 0; to < Tout; to++) {
    const start = to * s;
    for (let c = 0; c < C; c++) {
      let m = -Infinity;
      for (let pp = 0; pp < p; pp++) { const v = d[(start + pp) * C + c]; if (v > m) m = v; }
      out[to * C + c] = m;
    }
  }
  return { d: out, T: Tout, C };
}

function globalAvgPool(inp) {
  const { T, C, d } = inp;
  const out = new Float32Array(C);
  for (let t = 0; t < T; t++) for (let c = 0; c < C; c++) out[c] += d[t * C + c];
  for (let c = 0; c < C; c++) out[c] /= T;
  return out;
}

function dense(vec, L) {
  const { inDim, outDim, W, b } = L;        // W layout [in, out] → i*out + j
  const out = new Float32Array(outDim);
  for (let j = 0; j < outDim; j++) {
    let acc = b[j];
    for (let i = 0; i < inDim; i++) acc += vec[i] * W[i * outDim + j];
    out[j] = acc;
  }
  applyAct(out, L.act === 'softmax' ? 'linear' : L.act);   // softmax applied by caller
  return out;
}

function softmax(v) {
  let mx = -Infinity;
  for (const x of v) if (x > mx) mx = x;
  let sum = 0;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) { out[i] = Math.exp(v[i] - mx); sum += out[i]; }
  for (let i = 0; i < v.length; i++) out[i] /= (sum || 1);
  return out;
}

/** Run `net` (from parseModel) on an already-normalised window Float32Array(T*F). */
export function forward(net, win) {
  let x = { d: win, T: net.timeSteps, C: net.features };
  let vec = null;
  let lastAct = 'linear';
  for (const L of net.layers) {
    switch (L.type) {
      case 'conv1d':  x = conv1d(x, L); break;
      case 'bn':      x = batchNorm(x, L); break;
      case 'maxpool': x = maxPool1d(x, L); break;
      case 'gap':     vec = globalAvgPool(x); break;
      case 'flatten': vec = x.d; break;
      case 'dense':   vec = dense(vec, L); lastAct = L.act; break;
      case 'act':     lastAct = L.act; break;
      case 'skip':    break;
    }
  }
  return lastAct === 'softmax' ? softmax(vec) : vec;
}

/** Standardise a raw T×F window in place-free fashion. `raw` is Float32Array(T*F). */
export function standardise(net, raw) {
  const F = net.features, out = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = (raw[i] - net.mean[i % F]) / net.std[i % F];
  return out;
}
