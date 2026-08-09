// Session replay — open a recording from the SD card and watch it back.
//
// The recordings are big: 400 Hz × up to 4 nodes ≈ 3.8 MB per minute of CSV. So
// the file is never held in memory. It is streamed, parsed as it arrives, and
// reduced on the fly to two small things:
//
//   • strikes[]  — detected the same way the live view does it (threshold +
//                  refractory per limb), so a replay shows the same count the
//                  coach saw at the time
//   • envelope[] — peak G per limb per 100 ms bucket, which is all the timeline
//                  needs to draw
//
// A 15-minute session therefore costs ~9000 tiny buckets instead of ~57 MB.

import { SLOT_NAMES, SLOT_SHORT } from './state.js';
import { aiReady, aiWindowShape, aiClassifyRaw, aiDetectParams, aiStrikeNorm } from './aimodel.js';
import { createDetector } from './detector.js';
import { scoreStrike } from './strikescore.js';

const ACCEL_LSB_PER_G  = 2048;
const GYRO_LSB_PER_DPS = 16.4;
const BUCKET_MS        = 100;

/**
 * Stream a session CSV and reduce it.
 * @param {string} url
 * @param {{thresholdG:number, refractoryMs:number}} tuning
 * @param {(p:{bytes:number,total:number,rows:number})=>void} onProgress
 * @param {AbortSignal} signal
 */
export async function loadSession(url, tuning, onProgress, signal) {
  const res = await fetch(url, { signal, cache: 'no-store' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const total = Number(res.headers.get('content-length')) || 0;

  const meta     = { athlete: '', id: '', sampleRate: 400 };
  const strikes  = [];
  const buckets  = new Map();          // bucketIndex -> Float32Array(5) peak per slot
  const perSlot  = { 1: 0, 2: 0, 3: 0, 4: 0 };

  let bytes = 0, rows = 0, durationMs = 0, peakG = 0, sumG = 0;
  let carry = '';

  // Keep the recent raw samples per limb so each detected impact can be shown to
  // the AI model exactly as the live path would — the heuristic classifier only
  // knows peak G and peak rotation, so it cannot tell a Hook from an Uppercut.
  const shape   = aiReady() ? aiWindowShape() : null;
  const useAi   = !!shape;
  // Detect with the model's own settings when it carries them. Scoring a model
  // trained on 3 g impacts with a 5 g detector hands it a different slice of the
  // motion than it ever saw, and it answers worse for no visible reason.
  const detector = createDetector(aiDetectParams() || { version: 1, ...tuning });
  const det      = detector.cfg;
  // timeSteps plus room for the detector's rewind to the peak — see RING_MARGIN
  // in aimodel.js. Too small and classifyAi() silently returns null.
  const RING    = shape ? shape.timeSteps + 128 : 0;
  const F       = shape ? shape.features : 6;
  const ringBySlot = new Map();     // slot -> { buf, idx, count }
  let aiNamed = 0;

  const pushRaw = (slot, ax, ay, az, gx, gy, gz) => {
    if (!useAi) return;
    let r = ringBySlot.get(slot);
    if (!r) { r = { buf: new Float32Array(RING * F), idx: 0, count: 0 }; ringBySlot.set(slot, r); }
    const b = r.idx * F;
    r.buf[b] = ax; r.buf[b + 1] = ay; r.buf[b + 2] = az;
    r.buf[b + 3] = gx; r.buf[b + 4] = gy; r.buf[b + 5] = gz;
    r.idx = (r.idx + 1) % RING;
    if (r.count < RING) r.count++;
  };

  // `endBack` mirrors the live path: the detector searches past the trigger for
  // the true peak, so the window must be rewound to end there.
  const classifyAi = (slot, endBack = 0) => {
    if (!useAi) return null;
    const r = ringBySlot.get(slot);
    const T = shape.timeSteps;
    const back = Math.max(0, endBack | 0);
    if (!r || r.count < T + back || T + back > RING) return null;
    const win = new Float32Array(T * F);
    let p = (r.idx - back - T + RING * 2) % RING;
    for (let t = 0; t < T; t++) {
      for (let c = 0; c < F; c++) win[t * F + c] = r.buf[p * F + c];
      p = (p + 1) % RING;
    }
    return aiClassifyRaw(win, slot);
  };

  const dec = new TextDecoder();
  const reader = res.body.getReader();

  // Frame-level accumulation: one CSV row is one SAMPLE, but a strike is judged
  // on the peak across a frame, exactly like the live path does with a packet.
  let curKey = '', curSlot = 0, curT = 0, curMaxA = 0, curMaxW = 0, curN = 0;

  const flushFrame = () => {
    if (!curKey) return;
    const t = curT;
    if (t > durationMs) durationMs = t;

    // envelope
    const bi = (t / BUCKET_MS) | 0;
    let b = buckets.get(bi);
    if (!b) { b = new Float32Array(5); buckets.set(bi, b); }
    if (curMaxA > b[curSlot]) b[curSlot] = curMaxA;

    // strike detection — same rule as live, same module
    if (curSlot >= 1 && curSlot <= 4) {
      const hit = detector.feed(curSlot, { maxG: curMaxA, maxDps: curMaxW, n: curN, tMs: t });
      if (hit) {
        // The trained model is the ONLY thing allowed to name a technique.
        //
        // The old fallback (classifyStrike) was a hand-written ladder of peak-G and
        // rotation cut-offs; on the same impact it would confidently answer "hook"
        // where the model says "uppercut", and it cannot distinguish techniques
        // that differ in shape rather than magnitude at all. Presenting its guesses
        // in the same column as model output made the whole list untrustworthy.
        // No model, or the model says this was not a technique → leave it unnamed
        // and say so, rather than inventing a label.
        const ai = classifyAi(curSlot, hit.endBack);
        if (ai && ai.label) aiNamed++;
        // Same scoring rule as the live view, so replaying a session shows the
        // numbers the coach saw at the time rather than a second opinion.
        const label = (ai && ai.label) || null;
        const sc = scoreStrike({ peakG: hit.peakG, peakDps: hit.peakDps }, aiStrikeNorm(label));
        strikes.push({
          id: strikes.length + 1,
          tMs: t,
          slot: curSlot,
          peakG: hit.peakG,
          peakDps: hit.peakDps,
          type: label,
          byAi: !!label,
          conf: ai ? ai.conf : 0,
          score: sc.score, scorePower: sc.power, scoreSpeed: sc.speed, scoreRef: sc.ref,
        });
        perSlot[curSlot]++;
        sumG += hit.peakG;
        if (hit.peakG > peakG) peakG = hit.peakG;
      }
    }
    curKey = ''; curMaxA = 0; curMaxW = 0; curN = 0;
  };

  const handleLine = (line) => {
    if (!line) return;
    if (line[0] === '#') {                       // header comments carry the metadata
      const m = line.match(/^#\s*(\w+)=(.*)$/);
      if (m) {
        if (m[1] === 'athlete') meta.athlete = m[2].trim();
        else if (m[1] === 'id') meta.id = m[2].trim();
        else if (m[1] === 'sample_rate_hz') meta.sampleRate = Number(m[2]) || 400;
      }
      return;
    }
    if (line[0] === 't') return;                 // the column header row

    // t_ms,slot,seq,sample_idx,ax,ay,az,gx,gy,gz
    const p = line.split(',');
    if (p.length < 10) return;
    rows++;

    const t    = +p[0];
    const slot = +p[1];
    const seq  = p[2];
    const ax = +p[4], ay = +p[5], az = +p[6];
    const gx = +p[7], gy = +p[8], gz = +p[9];

    const a = Math.sqrt(ax * ax + ay * ay + az * az) / ACCEL_LSB_PER_G;
    const w = Math.sqrt(gx * gx + gy * gy + gz * gz) / GYRO_LSB_PER_DPS;

    // Close the previous frame BEFORE this sample enters the ring. flushFrame()
    // classifies from the ring, and its window has to end on the frame edge — one
    // stray sample of the next frame shifts every window by one sample against
    // what the model was trained on.
    const key = seq + ':' + slot;
    if (key !== curKey) { flushFrame(); curKey = key; curSlot = slot; curT = t; }

    pushRaw(slot, ax, ay, az, gx, gy, gz);
    curN++;
    if (a > curMaxA) curMaxA = a;
    if (w > curMaxW) curMaxW = w;
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.length;
    carry += dec.decode(value, { stream: true });

    let nl, from = 0;
    while ((nl = carry.indexOf('\n', from)) !== -1) {
      handleLine(carry.slice(from, nl).trim());
      from = nl + 1;
    }
    carry = carry.slice(from);
    onProgress?.({ bytes, total, rows });
  }
  handleLine(carry.trim());
  flushFrame();

  // envelope as a dense, ordered array so the timeline can just walk it
  const nBuckets = Math.max(1, ((durationMs / BUCKET_MS) | 0) + 1);
  const envelope = Array.from({ length: 5 }, () => new Float32Array(nBuckets));
  for (const [bi, b] of buckets) {
    if (bi < 0 || bi >= nBuckets) continue;
    for (let s = 1; s <= 4; s++) envelope[s][bi] = b[s];
  }

  return {
    meta, strikes, envelope, nBuckets, bucketMs: BUCKET_MS,
    durationMs, rows, bytes, aiNamed, aiUsed: useAi, detect: det,
    summary: {
      strikes: strikes.length,
      peakG,
      avgG: strikes.length ? sumG / strikes.length : 0,
      perSlot,
      left:  perSlot[1] + perSlot[3],
      right: perSlot[2] + perSlot[4],
      spm: durationMs > 0 ? strikes.length / (durationMs / 60000) : 0,
    },
  };
}

/** Virtual clock that walks a loaded session. Drives the UI, owns no DOM. */
export class Playback {
  constructor(session) {
    this.s = session;
    this.tMs = 0;
    this.rate = 1;
    this.playing = false;
    this._raf = 0;
    this._last = 0;
    this.onTick = null;
  }
  play() {
    if (this.playing) return;
    if (this.tMs >= this.s.durationMs) this.tMs = 0;   // replay from the top
    this.playing = true;
    this._last = performance.now();
    const step = (now) => {
      if (!this.playing) return;
      this.tMs += (now - this._last) * this.rate;
      this._last = now;
      if (this.tMs >= this.s.durationMs) { this.tMs = this.s.durationMs; this.pause(); }
      this.onTick?.(this.tMs);
      if (this.playing) this._raf = requestAnimationFrame(step);
    };
    this._raf = requestAnimationFrame(step);
  }
  pause() {
    this.playing = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
    this.onTick?.(this.tMs);
  }
  toggle() { this.playing ? this.pause() : this.play(); }
  seek(ms) {
    this.tMs = Math.max(0, Math.min(this.s.durationMs, ms));
    this._last = performance.now();
    this.onTick?.(this.tMs);
  }
  /** Jump to the strike before/after the playhead — how a coach actually navigates. */
  step(dir) {
    const list = this.s.strikes;
    if (!list.length) return;
    if (dir > 0) {
      const n = list.find(x => x.tMs > this.tMs + 1);
      this.seek(n ? n.tMs : this.s.durationMs);
    } else {
      let prev = null;
      for (const x of list) { if (x.tMs < this.tMs - 1) prev = x; else break; }
      this.seek(prev ? prev.tMs : 0);
    }
  }
  setRate(r) {
    this.rate = r;
    this._last = performance.now();
  }
  destroy() { this.pause(); this.onTick = null; }
}

export { SLOT_NAMES, SLOT_SHORT };
