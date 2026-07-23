// Performance Scorecard — derives a 6-axis skill profile from live session data
// and renders it as a hand-drawn SVG radar (no chart lib → tiny PROGMEM footprint,
// on-theme with the Fight Card design).
//
// Every axis is a real, explainable metric (0-100). Strengths/weaknesses are just
// the highest/lowest axes, so a coach instantly sees what to drill.

import { state } from './state.js';
import {
  computeSpm, computeAvgG, computeAsymRatio, computeFatigue, computeCv,
} from './analyzer.js';

// ── radar geometry ──
const CX = 140, CY = 122, R = 88;
const AXES = [
  { key: 'power',       th: 'พลัง',      hint: 'แรงกระแทกเฉลี่ย (g)' },
  { key: 'speed',       th: 'ความเร็ว',   hint: 'ความเร็วเชิงมุมสูงสุด (°/s)' },
  { key: 'volume',      th: 'ปริมาณ',     hint: 'จำนวนครั้ง/นาที (SPM)' },
  { key: 'consistency', th: 'สม่ำเสมอ',   hint: 'ความคงที่ของแรง (ยิ่ง CV ต่ำยิ่งดี)' },
  { key: 'balance',     th: 'สมดุล L/R',  hint: 'สัดส่วนซ้าย-ขวา (ดีสุดที่ 50:50)' },
  { key: 'stamina',     th: 'ความอึด',    hint: 'แรงไม่ตกช่วงท้าย (fatigue ต่ำ)' },
];
// angle per axis, starting at top (-90°), clockwise
const ANG = AXES.map((_, i) => (-90 + i * (360 / AXES.length)) * Math.PI / 180);

const clamp = v => Math.max(0, Math.min(100, v));
const polar = (value, i) => {
  const r = (value / 100) * R;
  return [CX + r * Math.cos(ANG[i]), CY + r * Math.sin(ANG[i])];
};

function avgPeakDps() {
  const s = state.strikes;
  if (!s.length) return 0;
  let sum = 0;
  for (const x of s) sum += x.peakDps || 0;
  return sum / s.length;
}

// ── scoring ──
export function computeScores() {
  const n    = state.strikes.length;
  const g    = state.goals;
  const avgG = computeAvgG();
  const dps  = avgPeakDps();
  const spm  = computeSpm();
  const cv   = computeCv();
  const asym = computeAsymRatio();
  const fat  = computeFatigue().pct;

  // normalisation references (fall back to goal targets where sensible)
  const REF_POWER = g.targetPeakG || 8;    // avgG that maps to 100
  const REF_SPEED = 1500;                   // °/s that maps to 100
  const REF_SPM   = g.targetSpm   || 30;    // strikes/min that maps to 100

  const raw = {
    power:       clamp(avgG / REF_POWER * 100),
    speed:       clamp(dps  / REF_SPEED * 100),
    volume:      clamp(spm  / REF_SPM   * 100),
    consistency: clamp((1 - cv) * 100),
    balance:     clamp(100 - Math.abs(asym - 0.5) * 200),
    stamina:     clamp(100 - fat),
  };
  const axes = AXES.map(a => ({ ...a, value: Math.round(raw[a.key]) }));

  // need a few strikes before the profile means anything
  const ready   = n >= 3;
  const overall = ready ? Math.round(axes.reduce((s, a) => s + a.value, 0) / axes.length) : 0;

  const sorted     = [...axes].sort((a, b) => b.value - a.value);
  const strengths  = ready ? sorted.filter(a => a.value >= 60).slice(0, 2) : [];
  const weaknesses = ready ? sorted.filter(a => a.value < 55).slice(-2).reverse() : [];

  return { axes, overall, grade: gradeFor(overall, ready), strengths, weaknesses, ready, samples: n };
}

function gradeFor(v, ready) {
  if (!ready) return { letter: '–', th: 'รอข้อมูล', cls: 'g-wait' };
  if (v >= 85) return { letter: 'S', th: 'เยี่ยม',        cls: 'g-s' };
  if (v >= 70) return { letter: 'A', th: 'ดีมาก',         cls: 'g-a' };
  if (v >= 55) return { letter: 'B', th: 'ดี',            cls: 'g-b' };
  if (v >= 40) return { letter: 'C', th: 'พอใช้',         cls: 'g-c' };
  return             { letter: 'D', th: 'ต้องฝึกเพิ่ม',   cls: 'g-d' };
}

// ── render ──
let elData = null, elDots = [], elBars = null;
let elGrade = null, elGradeSub = null, elOverall = null, elStr = null, elWeak = null;
let lastKey = '';

export function initScorecard() {
  const svg = document.getElementById('radarSvg');
  if (!svg) return;

  let s = '';
  // concentric grid rings
  for (const lvl of [25, 50, 75, 100]) {
    const pts = AXES.map((_, i) => polar(lvl, i).join(',')).join(' ');
    s += `<polygon class="radar-ring" points="${pts}"/>`;
  }
  // spokes + axis labels
  AXES.forEach((a, i) => {
    const [x, y]   = polar(100, i);
    const [lx, ly] = polar(120, i);
    const cos = Math.cos(ANG[i]);
    const anchor = cos > 0.3 ? 'start' : cos < -0.3 ? 'end' : 'middle';
    s += `<line class="radar-spoke" x1="${CX}" y1="${CY}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}"/>`;
    s += `<text class="radar-axis-lbl" x="${lx.toFixed(1)}" y="${(ly + 3).toFixed(1)}" text-anchor="${anchor}">${a.th}</text>`;
  });
  // data polygon + vertex dots (updated each render)
  s += `<polygon class="radar-data" id="radarData" points=""/>`;
  AXES.forEach((_, i) => { s += `<circle class="radar-dot" id="rdot-${i}" r="3.2" cx="${CX}" cy="${CY}"/>`; });
  svg.innerHTML = s;

  elData     = svg.querySelector('#radarData');
  elDots     = AXES.map((_, i) => svg.querySelector(`#rdot-${i}`));
  elBars     = document.getElementById('scoreBars');
  elGrade    = document.getElementById('scoreGrade');
  elGradeSub = document.getElementById('scoreGradeSub');
  elOverall  = document.getElementById('scoreOverall');
  elStr      = document.getElementById('scoreStrengths');
  elWeak     = document.getElementById('scoreWeak');

  // static per-axis bar skeleton (fills updated each render)
  if (elBars) {
    elBars.innerHTML = AXES.map(a => `
      <div class="sc-bar" data-axis="${a.key}" title="${a.hint}">
        <span class="sc-bar-lbl">${a.th}</span>
        <span class="sc-bar-track"><span class="sc-bar-fill" id="scb-${a.key}"></span></span>
        <span class="sc-bar-val" id="scv-${a.key}">0</span>
      </div>`).join('');
  }
}

export function renderScorecard() {
  if (!elData) return;
  const r = computeScores();

  // cheap change-detection so we don't touch the DOM 60×/s for nothing
  const key = r.overall + '|' + r.axes.map(a => a.value).join(',') + '|' + r.ready;
  if (key === lastKey) return;
  lastKey = key;

  // radar polygon + dots
  const pts = r.axes.map((a, i) => polar(a.value, i));
  elData.setAttribute('points', pts.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' '));
  pts.forEach(([x, y], i) => {
    elDots[i].setAttribute('cx', x.toFixed(1));
    elDots[i].setAttribute('cy', y.toFixed(1));
  });

  // grade + overall
  if (elGrade)    { elGrade.textContent = r.grade.letter; elGrade.className = 'score-grade ' + r.grade.cls; }
  if (elGradeSub) elGradeSub.textContent = r.grade.th;
  if (elOverall)  elOverall.textContent = r.ready ? r.overall : '—';

  // per-axis bars (colour by tier)
  for (const a of r.axes) {
    const fill = document.getElementById('scb-' + a.key);
    const val  = document.getElementById('scv-' + a.key);
    if (fill) {
      fill.style.width = a.value + '%';
      fill.className = 'sc-bar-fill ' + (a.value >= 70 ? 'tier-hi' : a.value >= 45 ? 'tier-mid' : 'tier-lo');
    }
    if (val) val.textContent = r.ready ? a.value : '—';
  }

  // strengths / weaknesses
  if (elStr)  elStr.innerHTML  = r.strengths.length
    ? r.strengths.map(a => `<span class="sc-tag sc-tag-up">▲ ${a.th}</span>`).join('')
    : '<span class="sc-tag dim">—</span>';
  if (elWeak) elWeak.innerHTML = r.weaknesses.length
    ? r.weaknesses.map(a => `<span class="sc-tag sc-tag-down">▼ ${a.th}</span>`).join('')
    : '<span class="sc-tag dim">—</span>';
}
