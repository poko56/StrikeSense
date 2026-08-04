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
import { classifyStrike } from './analyzer.js';

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
  const lastHit  = new Map();          // slot -> t_ms of last accepted strike
  const perSlot  = { 1: 0, 2: 0, 3: 0, 4: 0 };

  let bytes = 0, rows = 0, durationMs = 0, peakG = 0, sumG = 0;
  let carry = '';

  const dec = new TextDecoder();
  const reader = res.body.getReader();

  // Frame-level accumulation: one CSV row is one SAMPLE, but a strike is judged
  // on the peak across a frame, exactly like the live path does with a packet.
  let curKey = '', curSlot = 0, curT = 0, curMaxA = 0, curMaxW = 0;

  const flushFrame = () => {
    if (!curKey) return;
    const t = curT;
    if (t > durationMs) durationMs = t;

    // envelope
    const bi = (t / BUCKET_MS) | 0;
    let b = buckets.get(bi);
    if (!b) { b = new Float32Array(5); buckets.set(bi, b); }
    if (curMaxA > b[curSlot]) b[curSlot] = curMaxA;

    // strike detection — same rule as live
    if (curSlot >= 1 && curSlot <= 4 && curMaxA >= tuning.thresholdG) {
      const prev = lastHit.get(curSlot) ?? -1e9;
      if (t - prev >= tuning.refractoryMs) {
        lastHit.set(curSlot, t);
        strikes.push({
          id: strikes.length + 1,
          tMs: t,
          slot: curSlot,
          peakG: curMaxA,
          peakDps: curMaxW,
          type: classifyStrike(curSlot, curMaxA, curMaxW),
        });
        perSlot[curSlot]++;
        sumG += curMaxA;
        if (curMaxA > peakG) peakG = curMaxA;
      }
    }
    curKey = ''; curMaxA = 0; curMaxW = 0;
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

    const key = seq + ':' + slot;
    if (key !== curKey) { flushFrame(); curKey = key; curSlot = slot; curT = t; }
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
    durationMs, rows, bytes,
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
