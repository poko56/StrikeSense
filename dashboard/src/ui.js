// All DOM render functions + interaction wiring.
// Called via subscribe(scheduleRender). Reads state, writes DOM.

import { state, SLOT_NAMES, SLOT_SHORT, scheduleRender, pushActivity, WAVEFORM_SAMPLES } from './state.js';
import {
  computeSpm, computeAvgG, computeFatigue, computeCv, computeWorkKJ, computeTimeOnTarget,
  addMarker, deleteMarker,
} from './analyzer.js';
import { api } from './api.js';
import { openModal, closeModal } from './modal.js';
import { startCalibration, abortCalibration, clearCalibration, clearAllCalibration } from './calibrate.js';

const $ = id => document.getElementById(id);

// ───── formatters ─────
function fmtClock(ms) {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const s  = Math.floor(ms / 1000);
  const h  = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${String(h).padStart(2,'0')}:${mm}:${ss}` : `${mm}:${ss}`;
}
function fmtMs(ms) {
  if (!Number.isFinite(ms)) return '0';
  return ms < 1000 ? `${Math.round(ms)}` : `${(ms/1000).toFixed(2)}s`;
}
function fmtBytes(n) {
  if (!n) return '— B';
  if (n < 1024) return `${n} B`;
  if (n < 1024*1024) return `${(n/1024).toFixed(1)} KB`;
  return `${(n/1024/1024).toFixed(2)} MB`;
}
function fmtDate(unix) {
  if (!unix) return '—';
  const d = new Date(unix * 1000);
  return d.toLocaleString();
}
function fmtRelTime(ms) {
  const d = Date.now() - ms;
  if (d < 60_000) return `${Math.round(d/1000)}s`;
  if (d < 3600_000) return `${Math.round(d/60000)}m`;
  return `${Math.round(d/3600000)}h`;
}

// ───── TOPBAR ─────
let lastBatteryWarn = new Map();   // mac -> timestamp last warned

function renderTopbar() {
  const conn = $('conn'), txt = $('connTxt');
  if (state.demoMode) { conn.className = 'conn is-on'; txt.textContent = 'DEMO MODE'; }
  else if (state.connected) { conn.className = 'conn is-on'; txt.textContent = 'LIVE · WS'; }
  else { conn.className = 'conn is-off'; txt.textContent = 'OFFLINE · retry'; }

  const t = state.timer;
  $('curRound').textContent = (t.mode === 'idle' || t.mode === 'done')
    ? '—'
    : t.stopwatch ? '∞' : `${t.currentRound}/${t.rounds}`;
  $('curPhase').textContent = t.mode.toUpperCase();
  $('curClock').textContent = fmtClock(t.remainingMs);

  const pill = $('recPill'), pillTxt = $('recPillTxt');
  if (state.session.active) { pill.className = 'pill pill-rec'; pillTxt.textContent = 'REC · LIVE'; }
  else if (t.mode === 'rest') { pill.className = 'pill pill-rest'; pillTxt.textContent = 'REST'; }
  else { pill.className = 'pill pill-off'; pillTxt.textContent = 'STANDBY'; }

  // active state on toggle icon buttons
  $('btnHeatmap').classList.toggle('is-on', state.ui.bodyHeatmap);
  $('btnFullscreen').classList.toggle('is-on', state.ui.fullscreen);
}

// ───── DIAL + REC ─────
function renderDial() {
  const t = state.timer;
  const total = t.stopwatch
    ? Math.max(60_000, t.remainingMs)   // expand axis as stopwatch grows
    : (t.mode === 'work' ? t.workSec : t.mode === 'rest' ? t.restSec : t.workSec) * 1000;
  const frac  = t.stopwatch ? 0 : (total > 0 ? (1 - t.remainingMs / total) : 0);
  $('dialFill').setAttribute('stroke-dashoffset', `${100 - Math.min(100, Math.max(0, frac * 100))}`);
  $('roundDial').classList.toggle('is-rest', t.mode === 'rest');

  $('dialClock').textContent = fmtClock(t.remainingMs);
  $('dialPhase').textContent = (t.mode === 'idle' ? 'READY'
                              : t.mode === 'done' ? 'COMPLETE'
                              : t.stopwatch ? 'STOPWATCH' : t.mode.toUpperCase());
  $('dialRound').textContent = t.stopwatch ? '— · free —' : `Round ${t.currentRound || '—'} / ${t.rounds}`;

  const btn = $('btnRec'), lbl = $('btnRecLabel');
  if (state.session.active) { btn.classList.add('is-rec'); lbl.textContent = 'STOP'; }
  else { btn.classList.remove('is-rec'); lbl.textContent = 'RECORD'; }
}

// ───── STATS ─────
function renderStats() {
  $('stPeak').querySelector('.stat-num').textContent = state.peakG.toFixed(1);
  $('stAvg').querySelector('.stat-num').textContent  = computeAvgG().toFixed(1);
  $('stCount').textContent = state.strikes.length;
  $('stSpm').textContent   = computeSpm().toFixed(0);
  $('stToT').firstChild.textContent  = computeTimeOnTarget();
  $('stWork').firstChild.textContent = computeWorkKJ().toFixed(2);

  const dur = state.session.active
    ? Date.now() - state.session.startedAtMs
    : (state.hostStatus?.session?.durationMs ?? 0);
  $('stDuration').textContent = fmtClock(dur);
}

// ───── BODY DIAGRAM (live or heatmap) ─────
function renderBody() {
  const svg = $('bodySvg');
  svg.classList.toggle('is-heat', state.ui.bodyHeatmap);
  const now = performance.now();
  const max = Math.max(1, ...Object.values(state.heatmapBySlot));
  for (let slot = 1; slot <= 4; slot++) {
    const el = document.getElementById('zone-' + slot);
    if (!el) continue;
    const assigned = state.nodes.some(n => n.slot === slot);
    const live     = state.liveBySlot.has(slot) && (now - (state.liveBySlot.get(slot).lastSeenMs || 0)) < 2000;
    const flashAt  = state.ui.bodyHitFlash.get(slot) || 0;
    const hit      = (now - flashAt) < 250;
    el.classList.toggle('is-assigned', assigned);
    el.classList.toggle('is-live',     live);
    el.classList.toggle('is-hit',      hit);
    if (state.ui.bodyHeatmap) {
      const cnt = state.heatmapBySlot[slot] || 0;
      const lvl = Math.ceil((cnt / max) * 5);
      el.setAttribute('data-heat', String(Math.min(5, Math.max(0, lvl))));
    } else {
      el.removeAttribute('data-heat');
    }
  }
}

// ───── MIXER (VU + sparkline) ─────
function renderMixer() {
  const mix = $('mixer');
  if (!mix) return;
  const slots = [1, 2, 3, 4];
  if (mix.children.length !== slots.length) {
    mix.innerHTML = slots.map(s => `
      <div class="vu-row" data-slot="${s}">
        <span class="vu-label">${SLOT_SHORT[s]}</span>
        <div class="vu-meter"><span class="vu-fill"></span><span class="vu-peak"></span></div>
        <canvas class="vu-spark" data-slot="${s}" width="140" height="14"></canvas>
        <span class="vu-val">—</span>
      </div>
    `).join('');
  }
  const now = performance.now();
  for (const s of slots) {
    const row  = mix.querySelector(`[data-slot="${s}"]`);
    const live = state.liveBySlot.get(s);
    const lbl  = row.querySelector('.vu-label');
    const fill = row.querySelector('.vu-fill');
    const peak = row.querySelector('.vu-peak');
    const val  = row.querySelector('.vu-val');
    const cnv  = row.querySelector('canvas.vu-spark');

    if (!live || (now - live.lastSeenMs) > 3000) {
      lbl.classList.add('dim');
      fill.style.width = '0%'; peak.style.left = '0%';
      val.textContent = '—';
      clearSpark(cnv);
      continue;
    }
    lbl.classList.remove('dim');
    const age   = now - live.peakHoldMs;
    const decay = Math.max(0, 1 - age / 1200);
    const peakDisp = live.peakG * decay;
    if (decay <= 0) live.peakG = 0;
    const rmsPct  = Math.min(100, (live.rmsG / 6) * 100);
    const peakPct = Math.min(100, (peakDisp / 16) * 100);
    fill.style.width = `${rmsPct}%`;
    peak.style.left  = `${peakPct}%`;
    val.textContent  = peakDisp.toFixed(1) + 'g';
    drawSpark(cnv, live.waveform, live.waveIdx);
  }
}

function clearSpark(cnv) {
  if (!cnv.getContext) return;
  const ctx = cnv.getContext('2d');
  ctx.clearRect(0, 0, cnv.width, cnv.height);
}
function drawSpark(cnv, buf, head) {
  const ctx = cnv.getContext('2d');
  const W = cnv.width, H = cnv.height;
  ctx.clearRect(0, 0, W, H);
  const N = buf.length;
  // draw threshold line
  const thr = state.tuning.thresholdG;
  const yThr = H - Math.min(H, (thr / 16) * H);
  ctx.strokeStyle = 'rgba(255,255,255,.08)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, yThr); ctx.lineTo(W, yThr); ctx.stroke();

  ctx.strokeStyle = '#d62631';
  ctx.lineWidth = 1.1;
  ctx.beginPath();
  for (let i = 0; i < N; i++) {
    const idx = (head + i) % N;
    const v   = buf[idx] || 0;
    const x   = (i / (N - 1)) * W;
    const y   = H - Math.min(H, (v / 16) * H);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

// ───── DISTRIBUTION + HIST + ASYM + FATIGUE ─────
function renderDistribution() {
  const list = $('distList');
  const total = state.strikes.length;
  const entries = Object.entries(state.distribution).filter(([,v]) => v > 0);
  if (!entries.length) {
    list.innerHTML = '<div class="empty-card" style="padding:10px">— no strikes —</div>';
  } else {
    entries.sort((a,b) => b[1] - a[1]);
    list.innerHTML = entries.map(([type, n]) => {
      const pct = total > 0 ? (n / total * 100) : 0;
      return `
        <div class="dist-row">
          <span class="dist-name">${type.toUpperCase()}</span>
          <div class="dist-bar"><span class="dist-fill" style="width:${pct}%"></span></div>
          <span class="dist-cnt">${n} · ${pct.toFixed(0)}%</span>
        </div>`;
    }).join('');
  }

  const histMax = Math.max(1, ...Object.values(state.histogram));
  document.querySelectorAll('.hist-bar').forEach(bar => {
    const k = bar.dataset.range;
    const v = state.histogram[k] || 0;
    bar.querySelector('.hist-fill').style.height = `${(v / histMax) * 100}%`;
    bar.querySelector('.hist-cnt').textContent  = v;
  });

  const totalLR = state.leftCount + state.rightCount;
  const lPct = totalLR ? (state.leftCount / totalLR * 100) : 50;
  $('asymL').style.width = `${lPct}%`;
  $('asymR').style.width = `${100 - lPct}%`;
  $('asymLtxt').textContent = `L ${state.leftCount}`;
  $('asymRtxt').textContent = `R ${state.rightCount}`;

  const fat = computeFatigue();
  $('fatigueFill').style.width = `${fat.pct}%`;
  $('fatigueTxt').textContent  = `${fat.pct}% · ${fat.label} · CV ${(computeCv()*100).toFixed(0)}%`;
}

// ───── GOALS ─────
function renderGoals() {
  const g = state.goals;
  const sPct = Math.min(100, (state.strikes.length / Math.max(1, g.targetStrikes)) * 100);
  const pPct = Math.min(100, (state.peakG          / Math.max(1, g.targetPeakG))   * 100);
  const sFill = $('goalStrFill'); sFill.style.width = `${sPct}%`;  sFill.classList.toggle('full', sPct >= 100);
  const pFill = $('goalPeakFill'); pFill.style.width = `${pPct}%`; pFill.classList.toggle('full', pPct >= 100);
  $('goalStrTxt').textContent  = `${state.strikes.length} / ${g.targetStrikes}`;
  $('goalPeakTxt').textContent = `${state.peakG.toFixed(1)} / ${g.targetPeakG} g`;
  const st = $('goalStatus');
  if (g.completedAt) {
    st.className = 'goal-status is-done';
    st.textContent = `✓ COMPLETED at ${new Date(g.completedAt).toLocaleTimeString()}`;
  } else if (state.session.active) {
    st.className = 'goal-status';
    st.textContent = `${Math.round(Math.min(sPct, pPct))}% of goal · keep going`;
  } else {
    st.className = 'goal-status';
    st.textContent = '— set a target, hit it, repeat —';
  }
}

// ───── PER-ROUND TABLE ─────
function renderPerRound() {
  const body = $('roundTbody');
  if (!state.perRound.length) {
    body.innerHTML = '<tr class="empty"><td colspan="5">— round summary will appear here —</td></tr>';
    return;
  }
  body.innerHTML = state.perRound.map(r => `
    <tr>
      <td>R${r.round}</td>
      <td class="num">${r.strikes}</td>
      <td class="num">${r.peakG.toFixed(1)}</td>
      <td class="num">${r.avgG.toFixed(1)}</td>
      <td class="num">${r.fatiguePct}%</td>
    </tr>`).join('');
  // mark current round if active
  if (state.timer.mode === 'work') {
    const tr = document.createElement('tr');
    tr.className = 'cur';
    const inRound = state.strikes.filter(s => s.round === state.timer.currentRound);
    const peak = inRound.reduce((m,s) => Math.max(m, s.peakG), 0);
    const avg  = inRound.length ? inRound.reduce((s,x)=>s+x.peakG,0) / inRound.length : 0;
    tr.innerHTML = `<td>R${state.timer.currentRound}</td><td class="num">${inRound.length}</td><td class="num">${peak.toFixed(1)}</td><td class="num">${avg.toFixed(1)}</td><td class="num">—</td>`;
    body.appendChild(tr);
  }
}

// ───── ACTIVITY FEED ─────
function renderActivity() {
  const list = $('activityList');
  if (!state.ui.activity.length) {
    list.innerHTML = '<li class="dim">— no activity yet —</li>';
    return;
  }
  list.innerHTML = state.ui.activity.slice(0, 8).map(a => `
    <li class="ac-${a.kind}"><span class="ac-t">${fmtRelTime(a.t)}</span>${escapeHtml(a.text)}</li>
  `).join('');
}

// ───── MARKERS ─────
function renderMarkers() {
  const list = $('markerList');
  if (!state.markers.length) {
    list.innerHTML = '<li class="dim">— no markers yet · press M during session —</li>';
    return;
  }
  list.innerHTML = state.markers.slice().reverse().map(m => `
    <li data-id="${m.id}">
      <span class="mk-t">${fmtClock(m.sessionMs)}</span>
      <span class="mk-l">${escapeHtml(m.label)}</span>
      <button class="mk-del" data-mid="${m.id}" title="Delete">✕</button>
    </li>`).join('');
  list.querySelectorAll('.mk-del').forEach(b => {
    b.addEventListener('click', e => {
      deleteMarker(Number(e.target.dataset.mid));
      scheduleRender();
    });
  });
}

// ───── TIMELINE STRIP ─────
function renderTimeline() {
  const track = $('tlTrack');
  const axis  = $('tlAxis');
  if (!track || !axis) return;
  const sessionDur = state.session.active
    ? Date.now() - state.session.startedAtMs
    : (state.strikes.length ? Math.max(...state.strikes.map(s => s.sessionMs)) : 0);
  const span = Math.max(60_000, sessionDur); // at least 60s axis
  axis.innerHTML = `<span>0:00</span><span>${fmtClock(span/2)}</span><span>${fmtClock(span)}</span>`;

  const items = [];
  for (const s of state.strikes) {
    const x = (s.sessionMs / span) * 100;
    const h = Math.min(36, Math.max(4, (s.peakG / 16) * 36));
    items.push(`<span class="tl-strike s${s.slot}" style="left:${x}%;height:${h}px" data-sid="${s.id}" title="#${s.id} · ${s.peakG.toFixed(1)}g"></span>`);
  }
  for (const m of state.markers) {
    const x = (m.sessionMs / span) * 100;
    items.push(`<span class="tl-marker" style="left:${x}%" data-mid="${m.id}" title="${escapeAttr(m.label)}"></span>`);
  }
  track.innerHTML = items.join('');

  track.querySelectorAll('.tl-strike').forEach(el => {
    el.addEventListener('click', e => { openStrikeDetail(Number(e.target.dataset.sid)); e.stopPropagation(); });
  });
}

// ───── STRIKE LOG ─────
function renderStrikeLog() {
  const tbody = $('strikeTbody');
  if (!tbody) return;
  const filter = state.ui.strikeFilter;
  const rows = state.strikes
    .filter(s => filter === 'all' || String(s.slot) === filter)
    .slice(-80).reverse();
  if (!rows.length) {
    tbody.innerHTML = '<tr class="empty"><td colspan="8">— ยังไม่มีหมัด · waiting for strikes —</td></tr>';
    return;
  }
  const newestId = state.strikes.length ? state.strikes[state.strikes.length - 1].id : 0;
  tbody.innerHTML = rows.map(s => `
    <tr class="${s.id === newestId ? 'new' : ''}" data-sid="${s.id}">
      <td>${s.id}</td>
      <td>${fmtClock(s.sessionMs)}</td>
      <td>${s.round || '—'}</td>
      <td><span class="slot-tag s${s.slot}">${SLOT_SHORT[s.slot]}</span></td>
      <td class="type-cell">${s.type.toUpperCase()}</td>
      <td class="num">${s.peakG.toFixed(1)}</td>
      <td class="num">${Math.round(s.peakDps)}</td>
      <td class="num">${fmtMs(s.recoverMs)}</td>
    </tr>
  `).join('');
  tbody.querySelectorAll('tr[data-sid]').forEach(tr => {
    tr.style.cursor = 'pointer';
    tr.addEventListener('click', () => openStrikeDetail(Number(tr.dataset.sid)));
  });
}

// ───── NODES ─────
function renderNodes() {
  const list = $('nodeList');
  if (!list) return;
  if (!state.nodes.length) {
    list.innerHTML = `<div class="empty-card">— No nodes detected —<br><span class="dim">Power on a Strike Node within 2 m of the Main Node.</span></div>`;
    return;
  }
  list.innerHTML = state.nodes.map(n => {
    const isStale = (n.ageMs || 0) > 3000;
    const cls    = `node-card ${isStale ? 'stale' : 'live'}`;
    const bcls   = n.batteryPct >= 50 ? '' : n.batteryPct >= 20 ? 'low' : 'crit';
    const rssiBars = renderRssiBars(n.rssi);

    // battery low warn (throttle: once per 60s per mac)
    if (n.batteryPct > 0 && n.batteryPct < 20) {
      const last = lastBatteryWarn.get(n.mac) || 0;
      if (Date.now() - last > 60_000) {
        lastBatteryWarn.set(n.mac, Date.now());
        toast(`⚠ Battery low · ${n.mac.slice(-5)} · ${n.batteryPct}%`, 'warn');
        pushActivity('batt', `🪫 Battery low: ${n.mac.slice(-5)} ${n.batteryPct}%`);
      }
    }

    const hist = state.nodeHistory.get(n.mac);
    const drops30 = countRecent(hist?.drops, 30 * 60 * 1000); // last 30 min
    const quality = computeLinkQuality(n, hist);
    const qCls = quality >= 70 ? 'q-good' : quality >= 40 ? 'q-fair' : 'q-poor';

    const cal = state.calibration.offsets.get(n.slot);
    const isCalibrating = state.calibration.active === n.slot;

    return `
      <div class="${cls}" data-mac="${n.mac}">
        <div class="nc-head">
          <span class="nc-mac">${n.mac}</span>
          <span class="nc-quality ${qCls}" title="Link quality">${quality}%</span>
          <span class="nc-age">${isStale ? `${Math.round((n.ageMs||0)/1000)}s ago` : 'live'}</span>
        </div>
        <div class="nc-row">
          <span class="meta-k">SLOT</span>
          <select class="nc-slot-sel" data-mac="${n.mac}">
            ${Object.entries(SLOT_NAMES).map(([v,l]) =>
              `<option value="${v}"${Number(v)===n.slot?' selected':''}>${l}</option>`).join('')}
          </select>
          ${cal
            ? `<span class="cal-badge" title="Calibrated · ${new Date(cal.calibratedAt).toLocaleTimeString()}">✓ CAL</span>`
            : ''}
        </div>
        <div class="nc-row">
          <span class="meta-k">SIGNAL</span>${rssiBars}<span class="mono">${n.rssi} dBm</span>
          <span class="meta-k">BATT</span>
          <span class="batt"><span class="batt-bar"><span class="batt-fill ${bcls}" style="width:${n.batteryPct}%"></span></span><span class="mono">${n.batteryPct}%</span></span>
        </div>
        <div class="nc-row">
          <span class="meta-k">RX</span><span class="mono">${n.packetsRx}</span>
          <span class="meta-k">GAPS</span><span class="mono">${n.seqGaps}</span>
          <span class="meta-k">DROPS</span><span class="mono">${drops30}</span>
          <span class="meta-k">FW</span><span class="mono">${(n.firmware>>8)}.${(n.firmware&0xff)}</span>
        </div>
        <canvas class="nc-rxspark" data-mac="${n.mac}" width="240" height="18"></canvas>
        <div class="nc-actions">
          <button class="ico-btn" data-act="cal"     data-slot="${n.slot}" data-mac="${n.mac}" ${n.slot === 0 || isCalibrating ? 'disabled' : ''}>${isCalibrating ? 'CALIBRATING…' : (cal ? 'RE-CAL' : 'CALIBRATE')}</button>
          ${cal ? `<button class="ico-btn" data-act="cal-clear" data-slot="${n.slot}">CLEAR</button>` : ''}
          <button class="ico-btn" data-act="hist" data-mac="${n.mac}">HISTORY</button>
        </div>
      </div>`;
  }).join('');

  list.querySelectorAll('.nc-slot-sel').forEach(sel => {
    sel.addEventListener('change', async (e) => {
      const mac = e.target.dataset.mac, slot = e.target.value;
      try {
        await api.assignSlot(mac, slot);
        toast(`Slot assigned: ${SLOT_NAMES[slot]}`, 'ok');
        pushActivity('rec', `📍 ${mac.slice(-5)} → ${SLOT_NAMES[slot]}`);
      } catch (err) { toast(`Assign failed: ${err.message}`, 'warn'); }
    });
  });

  list.querySelectorAll('[data-act]').forEach(btn => {
    btn.addEventListener('click', e => {
      const act  = e.target.dataset.act;
      const mac  = e.target.dataset.mac;
      const slot = Number(e.target.dataset.slot);
      if (act === 'cal') openCalibrationModal(slot, mac);
      else if (act === 'cal-clear') {
        if (confirm(`Clear calibration for slot ${SLOT_NAMES[slot]}?`)) clearCalibration(slot);
      }
      else if (act === 'hist') openNodeHistoryModal(mac);
    });
  });

  // draw per-node rx sparklines
  list.querySelectorAll('canvas.nc-rxspark').forEach(cv => {
    const mac = cv.dataset.mac;
    drawRxSparkline(cv, state.nodeHistory.get(mac));
  });
}

function countRecent(arr, windowMs) {
  if (!arr || !arr.length) return 0;
  const cutoff = Date.now() - windowMs;
  return arr.filter(x => x.at >= cutoff).length;
}

function computeLinkQuality(n, hist) {
  // 0-100 composite. RSSI 45%, age 20%, drops 25%, battery 10%.
  const rssi = n.rssi || -90;
  const rssiScore = Math.max(0, Math.min(100, ((rssi + 90) / 60) * 100));     // -90→0, -30→100
  const ageScore  = Math.max(0, Math.min(100, 100 - ((n.ageMs || 0) / 30)));  // 0ms→100, 3000ms→0
  const drops5    = countRecent(hist?.drops, 5 * 60 * 1000);                   // last 5 min
  const dropScore = Math.max(0, 100 - drops5 * 20);                           // 5 drops = 0
  const battScore = Math.max(0, Math.min(100, (n.batteryPct || 0)));
  return Math.round(rssiScore * 0.45 + ageScore * 0.20 + dropScore * 0.25 + battScore * 0.10);
}

function drawRxSparkline(cv, hist) {
  const ctx = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  ctx.clearRect(0, 0, W, H);
  if (!hist || !hist.rxSamples.length) return;
  const arr = hist.rxSamples;
  const max = Math.max(1, ...arr.map(s => s.rx));
  ctx.strokeStyle = 'rgba(255,255,255,.06)';
  ctx.beginPath(); ctx.moveTo(0, H/2); ctx.lineTo(W, H/2); ctx.stroke();
  ctx.strokeStyle = hist.state === 'live' ? '#4ac294' : '#d62631';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  for (let i = 0; i < arr.length; i++) {
    const x = (i / Math.max(1, arr.length - 1)) * W;
    const y = H - (arr[i].rx / max) * (H - 2);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
  // drop markers
  if (hist.drops.length) {
    const oldest = arr[0]?.t || 0;
    const newest = arr[arr.length-1]?.t || Date.now();
    const span = Math.max(1, newest - oldest);
    ctx.fillStyle = '#d62631';
    for (const d of hist.drops) {
      if (d.at < oldest) continue;
      const x = ((d.at - oldest) / span) * W;
      ctx.fillRect(x - 1, 0, 2, 4);
    }
  }
}

// ───── CALIBRATION MODAL ─────
function openCalibrationModal(slot, mac) {
  if (!slot || slot === 0) { toast('Assign a slot first', 'warn'); return; }
  if (state.calibration.active) { toast('Already calibrating another slot', 'warn'); return; }

  const dur = 5000;
  const body = openModal(`
    <div class="dlg-head">
      <div class="dlg-title">CALIBRATE · ${SLOT_NAMES[slot]}</div>
      <button class="dlg-x" id="dlgCancel">✕</button>
    </div>
    <div class="cal-stage">
      <p class="cal-instr">
        Place the node on a <strong>flat, level surface</strong> with the gravity axis pointing up.
        Hold completely still for 5 seconds.
      </p>
      <div class="cal-count" id="calCount">5.0</div>
      <div class="cal-bar"><span class="cal-fill" id="calFill"></span></div>
      <div class="cal-stats mono">
        <span>Samples: <b id="calSamp">0</b></span>
        <span>Slot: <b>${SLOT_NAMES[slot]} (${mac?.slice(-5) || '—'})</b></span>
      </div>
      <div class="cal-note dim">Dashboard-side only · CSV on SD will still contain raw values.</div>
    </div>
    <div class="dlg-actions">
      <button class="dlg-btn" id="dlgAbort">ABORT</button>
    </div>
  `);

  const fill  = document.getElementById('calFill');
  const count = document.getElementById('calCount');
  const samp  = document.getElementById('calSamp');

  const controller = startCalibration(slot, mac, dur, (elapsed, n) => {
    const pct = Math.min(100, (elapsed / dur) * 100);
    fill.style.width  = pct + '%';
    count.textContent = Math.max(0, (dur - elapsed) / 1000).toFixed(1);
    samp.textContent  = n;
  });

  function abort() { controller.abort(); closeModal(); }
  document.getElementById('dlgCancel').addEventListener('click', abort);
  document.getElementById('dlgAbort').addEventListener('click', abort);

  controller.promise.then(res => {
    const o = res.offset;
    body.innerHTML = `
      <div class="dlg-head">
        <div class="dlg-title">✓ CALIBRATED · ${SLOT_NAMES[slot]}</div>
        <button class="dlg-x" onclick="document.getElementById('appDialog').close()">✕</button>
      </div>
      <table class="cmp-table">
        <thead><tr><th>Axis</th><th>Offset</th></tr></thead>
        <tbody>
          <tr><td>aX</td><td>${o.ax.toFixed(4)} g</td></tr>
          <tr><td>aY</td><td>${o.ay.toFixed(4)} g</td></tr>
          <tr><td>aZ</td><td>${o.az.toFixed(4)} g <span class="dim small">(− 1g gravity)</span></td></tr>
          <tr><td>gX</td><td>${o.gx.toFixed(2)} °/s</td></tr>
          <tr><td>gY</td><td>${o.gy.toFixed(2)} °/s</td></tr>
          <tr><td>gZ</td><td>${o.gz.toFixed(2)} °/s</td></tr>
        </tbody>
      </table>
      <div class="cal-note dim mt-4">Saved · ${res.samples} samples · applied to dashboard view immediately.</div>
      <div class="dlg-actions">
        <button class="dlg-btn primary" onclick="document.getElementById('appDialog').close()">OK</button>
      </div>`;
    toast(`Calibrated ${SLOT_NAMES[slot]} · ${res.samples} samples`, 'ok');
  }).catch(err => {
    body.innerHTML = `
      <div class="dlg-head">
        <div class="dlg-title">✕ CALIBRATION FAILED</div>
        <button class="dlg-x" onclick="document.getElementById('appDialog').close()">✕</button>
      </div>
      <div class="cal-note">${err.message}</div>
      <div class="dlg-actions">
        <button class="dlg-btn" onclick="document.getElementById('appDialog').close()">CLOSE</button>
      </div>`;
    toast(`Calibration failed: ${err.message}`, 'warn');
  });
}

// ───── NODE HISTORY MODAL ─────
function openNodeHistoryModal(mac) {
  const h = state.nodeHistory.get(mac);
  const n = state.nodes.find(x => x.mac === mac);
  if (!h) { toast('No history yet', 'warn'); return; }
  const drops = h.drops.slice().reverse();
  const recs  = h.reconnects.slice().reverse();
  const merged = [
    ...drops.map(d => ({ at: d.at, kind: 'DROP', detail: `gap age=${(d.age/1000).toFixed(1)}s` })),
    ...recs.map(r  => ({ at: r.at, kind: 'RECOVER', detail: `was off ${(r.gap/1000).toFixed(1)}s` })),
  ].sort((a, b) => b.at - a.at).slice(0, 30);

  const drops5  = countRecent(h.drops, 5 * 60 * 1000);
  const drops30 = countRecent(h.drops, 30 * 60 * 1000);
  const uptime  = ((Date.now() - h.firstSeen) / 1000 / 60).toFixed(1);

  openModal(`
    <div class="dlg-head">
      <div class="dlg-title">NODE HISTORY · ${mac}</div>
      <button class="dlg-x" onclick="document.getElementById('appDialog').close()">✕</button>
    </div>
    <div class="detail-grid">
      <div class="stat"><div class="stat-lbl">DROPS / 5m</div><div class="stat-val mono">${drops5}</div></div>
      <div class="stat"><div class="stat-lbl">DROPS / 30m</div><div class="stat-val mono">${drops30}</div></div>
      <div class="stat"><div class="stat-lbl">RECONNECTS</div><div class="stat-val mono">${h.reconnects.length}</div></div>
      <div class="stat"><div class="stat-lbl">TRACKED FOR</div><div class="stat-val mono" style="font-size:22px">${uptime}m</div></div>
    </div>
    <div class="cal-note dim mt-4">
      Common causes of frequent drops:
      <ul>
        <li>Low battery (under 20%) → node browns out under TX load</li>
        <li>Weak RSSI (worse than −75 dBm) → packets lost</li>
        <li>WiFi/ESP-NOW channel conflict with nearby APs</li>
        <li>Strike Node firmware crash → uptime resets to 0 (toast appears)</li>
      </ul>
    </div>
    <table class="cmp-table mt-4">
      <thead><tr><th>Time</th><th>Event</th><th>Detail</th></tr></thead>
      <tbody>
        ${merged.length === 0
          ? `<tr><td colspan="3" class="dim">— no events yet —</td></tr>`
          : merged.map(e => `<tr>
              <td>${new Date(e.at).toLocaleTimeString()}</td>
              <td>${e.kind}</td>
              <td>${e.detail}</td>
            </tr>`).join('')}
      </tbody>
    </table>
    <div class="dlg-actions">
      <button class="dlg-btn" onclick="document.getElementById('appDialog').close()">CLOSE</button>
    </div>
  `);
}

function renderRssiBars(rssi) {
  const lv = Math.max(0, Math.min(4, Math.round((rssi + 90) / 15)));
  return `<span class="rssi">${[1,2,3,4].map(i => `<span class="${i<=lv?'on':''}" style="height:${i*3}px"></span>`).join('')}</span>`;
}

// ───── LIBRARY ─────
let _libFilter = '';
function renderLibrary() {
  const list = $('libList');
  if (!list) return;
  const q = _libFilter.toLowerCase();
  const filtered = state.sessions.filter(s => !q || s.id.toLowerCase().includes(q));
  const total = state.sessions.length;
  const sizeBytes = state.sessions.reduce((a,s) => a + (s.bytes||0), 0);

  $('libCount').textContent = total;
  $('libSize').textContent  = fmtBytes(sizeBytes);
  if (state.hostStatus?.sd) {
    $('libCard').textContent = `${state.hostStatus.sd.usedMB ?? '—'} / ${state.hostStatus.sd.cardMB ?? '—'} MB`;
  }

  $('cmpCount').textContent = state.ui.compareSet.size;
  $('btnCompareOpen').disabled = state.ui.compareSet.size !== 2;

  if (!filtered.length) {
    list.innerHTML = '<div class="empty-card">— No recordings on SD —</div>';
    return;
  }
  list.innerHTML = filtered.sort((a,b) => (b.modTime||0) - (a.modTime||0)).map(s => {
    const isCmp = state.ui.compareSet.has(s.id);
    return `
      <div class="lib-row ${isCmp ? 'is-cmp' : ''}" data-id="${s.id}">
        <div>
          <div class="lib-id">${s.id}</div>
          <div class="lib-meta">${fmtDate(s.modTime)}</div>
        </div>
        <span class="lib-size">${fmtBytes(s.bytes)}</span>
        <span class="lib-cmp-box ${isCmp?'checked':''}" data-act="cmp" data-id="${s.id}" title="Compare">${isCmp ? '✓' : ''}</span>
        <button class="ico-btn" data-act="view" data-id="${s.id}">VIEW</button>
        <button class="ico-btn" data-act="dl"  data-id="${s.id}">↓</button>
        <button class="ico-btn danger" data-act="del" data-id="${s.id}">✕</button>
      </div>`;
  }).join('');

  list.querySelectorAll('[data-act]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const id  = e.target.dataset.id;
      const act = e.target.dataset.act;
      if (act === 'dl') {
        const a = document.createElement('a');
        a.href = api.sessionDownloadUrl(id);
        a.download = `${id}.csv`;
        document.body.appendChild(a); a.click(); a.remove();
      } else if (act === 'del') {
        if (!confirm(`Delete session ${id}? This cannot be undone.`)) return;
        try { await api.sessionDelete(id); toast('Deleted', 'ok'); refreshLibrary(); }
        catch (err) { toast(`Delete failed: ${err.message}`, 'warn'); }
      } else if (act === 'view') {
        openSessionPreview(id);
      } else if (act === 'cmp') {
        if (state.ui.compareSet.has(id)) state.ui.compareSet.delete(id);
        else if (state.ui.compareSet.size < 2) state.ui.compareSet.add(id);
        else toast('Compare slots full — clear first', 'warn');
        scheduleRender();
      }
    });
  });
}

// ───── SYSTEM ─────
function renderSystem() {
  const h = state.hostStatus;
  if (h) {
    $('sysUp').textContent    = fmtClock(h.uptimeMs);
    $('sysHeap').textContent  = `${(h.heap/1024).toFixed(0)} KB`;
    $('sysPsram').textContent = h.psram ? `${(h.psram/1024).toFixed(0)} KB` : '—';
    $('sysWs').textContent    = h.wsClients ?? 0;
    $('sysRx').textContent    = h.rx ?? 0;
    $('sysDrop').textContent  = h.dropped ?? 0;
    const used = h.sd?.usedMB ?? 0, card = h.sd?.cardMB ?? 0;
    const pct = card ? (used / card) * 100 : 0;
    const bar = $('sdBarFill');
    bar.style.width = `${pct}%`;
    bar.className = 'bar-fill' + (pct > 90 ? ' crit' : pct > 70 ? ' warn' : '');
    $('sdUsedTxt').textContent = `${used} MB used`;
    $('sdFreeTxt').textContent = `${Math.max(0, card - used)} MB free`;
  }
  $('sysHz').textContent = `${state.measuredHz ?? 0} Hz`;
  $('sysBw').textContent = `${(state.measuredKbps ?? 0).toFixed(1)} kbps`;
  $('aboutBuild').textContent = $('buildStamp').textContent;
  $('aboutUa').textContent    = navigator.userAgent;
  $('aboutUa').title          = navigator.userAgent;
}

// ───── TABS ─────
function setupTabs() {
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      state.ui.activeTab = tab;
      document.querySelectorAll('.tab').forEach(b => b.classList.toggle('tab-on', b.dataset.tab === tab));
      document.querySelectorAll('.tabpane').forEach(p => p.classList.toggle('on', p.dataset.pane === tab));
      scheduleRender();
    });
  });
}

// ───── STRIKE FILTER CHIPS ─────
function setupChips() {
  document.querySelectorAll('.chip[data-filter]').forEach(c => {
    c.addEventListener('click', () => {
      document.querySelectorAll('.chip[data-filter]').forEach(x => x.classList.remove('chip-on'));
      c.classList.add('chip-on');
      state.ui.strikeFilter = c.dataset.filter;
      scheduleRender();
    });
  });
  $('btnClearLog')?.addEventListener('click', () => {
    state.strikes.length = 0; state.strikeSeq = 0;
    for (const k of Object.keys(state.distribution)) state.distribution[k] = 0;
    for (const k of Object.keys(state.histogram))    state.histogram[k] = 0;
    state.leftCount = 0; state.rightCount = 0;
    state.totalsForce = 0; state.peakG = 0;
    state.fatigueHistory.length = 0;
    state.perRound.length = 0;
    scheduleRender();
  });
}

// ───── BODY ZONE → ASSIGN ─────
function setupBodyZones() {
  document.querySelectorAll('.zone').forEach(z => {
    z.addEventListener('click', async () => {
      const slot = Number(z.dataset.slot);
      const unassigned = state.nodes.find(n => n.slot === 0);
      if (!unassigned) {
        toast('No unassigned node available · open SENSORS to reassign', 'warn');
        document.querySelector('.tab[data-tab="sensors"]')?.click();
        return;
      }
      try {
        await api.assignSlot(unassigned.mac, slot);
        toast(`${unassigned.mac.slice(-5)} → ${SLOT_NAMES[slot]}`, 'ok');
      } catch (e) { toast('Assign failed: ' + e.message, 'warn'); }
    });
  });
}

// ───── TUNING ─────
function setupTuning() {
  const thr = $('thrSlider'), thrV = $('thrVal');
  const ref = $('refrSlider'), refV = $('refrVal');
  if (thr) thr.addEventListener('input', () => {
    state.tuning.thresholdG = parseFloat(thr.value);
    thrV.textContent = `${thr.value} g`;
    saveTuningCb?.();
  });
  if (ref) ref.addEventListener('input', () => {
    state.tuning.refractoryMs = parseInt(ref.value, 10);
    refV.textContent = `${ref.value} ms`;
    saveTuningCb?.();
  });
}

let saveTuningCb = null;
export function bindSaveTuning(fn) { saveTuningCb = fn; }

// ───── LIBRARY SEARCH ─────
function setupLibrarySearch() {
  $('libSearch')?.addEventListener('input', e => { _libFilter = e.target.value; scheduleRender(); });
  $('btnRefreshLib')?.addEventListener('click', refreshLibrary);
  $('btnCompareClear')?.addEventListener('click', () => { state.ui.compareSet.clear(); scheduleRender(); });
  $('btnCompareOpen')?.addEventListener('click', openCompareModal);
}

// ───── BODY HEATMAP TOGGLE ─────
function setupBodyToggle() {
  document.querySelectorAll('.seg-btn[data-bmode]').forEach(b => {
    b.addEventListener('click', () => {
      const mode = b.dataset.bmode;
      state.ui.bodyHeatmap = (mode === 'heat');
      document.querySelectorAll('.seg-btn[data-bmode]').forEach(x =>
        x.classList.toggle('seg-on', x.dataset.bmode === mode));
      saveModesCb?.();
      scheduleRender();
    });
  });
}
let saveModesCb = null;
export function bindSaveModes(fn) { saveModesCb = fn; }

// ───── TOAST ─────
export function toast(msg, kind = '') {
  const stack = $('toast');
  if (!stack) return;
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  stack.appendChild(el);
  setTimeout(() => el.remove(), 3600);
}

// ───── LIBRARY REFRESH HOOK ─────
let _refreshLib = () => {};
export function bindRefreshLibrary(fn) { _refreshLib = fn; }
export function refreshLibrary() { _refreshLib(); }

// ───── MODALS ─────
function openStrikeDetail(id) {
  const s = state.strikes.find(x => x.id === id);
  if (!s) return;
  const ctx = state.strikes.filter(x => x.slot === s.slot && Math.abs(x.id - id) <= 3);
  openModal(`
    <div class="dlg-head">
      <div class="dlg-title">STRIKE #${s.id} · ${s.type.toUpperCase()}</div>
      <button class="dlg-x" onclick="document.getElementById('appDialog').close()">✕</button>
    </div>
    <div class="detail-grid">
      <div class="stat"><div class="stat-lbl">PEAK</div><div class="stat-val mono">${s.peakG.toFixed(1)}<span class="stat-unit">g</span></div></div>
      <div class="stat"><div class="stat-lbl">ω</div><div class="stat-val mono">${Math.round(s.peakDps)}<span class="stat-unit">°/s</span></div></div>
      <div class="stat"><div class="stat-lbl">SLOT</div><div class="stat-val mono" style="font-size:22px">${SLOT_NAMES[s.slot]}</div></div>
      <div class="stat"><div class="stat-lbl">ROUND</div><div class="stat-val mono">R${s.round || '—'}</div></div>
      <div class="stat"><div class="stat-lbl">SESSION TIME</div><div class="stat-val mono" style="font-size:22px">${fmtClock(s.sessionMs)}</div></div>
      <div class="stat"><div class="stat-lbl">RECOVERY</div><div class="stat-val mono" style="font-size:22px">${fmtMs(s.recoverMs)}</div></div>
    </div>
    <div class="detail-ctx">
      <div style="font-weight:600;letter-spacing:.14em;color:var(--paper-3);margin-bottom:6px">NEIGHBOURS ON SAME SLOT</div>
      ${ctx.map(c => `
        <div class="ctx-row">
          <span class="mono">#${c.id}</span>
          <span>${c.type.toUpperCase()}</span>
          <span class="mono">${c.peakG.toFixed(1)}g · ${fmtClock(c.sessionMs)}</span>
        </div>`).join('')}
    </div>
  `);
}

function openSessionPreview(id) {
  const s = state.sessions.find(x => x.id === id);
  if (!s) return;
  openModal(`
    <div class="dlg-head">
      <div class="dlg-title">SESSION ${s.id}</div>
      <button class="dlg-x" onclick="document.getElementById('appDialog').close()">✕</button>
    </div>
    <div class="detail-grid">
      <div class="stat"><div class="stat-lbl">SIZE</div><div class="stat-val mono" style="font-size:22px">${fmtBytes(s.bytes)}</div></div>
      <div class="stat"><div class="stat-lbl">DATE</div><div class="stat-val mono" style="font-size:18px">${fmtDate(s.modTime)}</div></div>
    </div>
    <div class="dlg-actions">
      <button class="dlg-btn" onclick="document.getElementById('appDialog').close()">CLOSE</button>
      <a class="dlg-btn primary" href="${api.sessionDownloadUrl(id)}" download="${id}.csv">↓ DOWNLOAD CSV</a>
    </div>
  `);
}

function openCompareModal() {
  const ids = [...state.ui.compareSet];
  if (ids.length !== 2) return;
  const [aId, bId] = ids;
  const a = state.sessions.find(s => s.id === aId);
  const b = state.sessions.find(s => s.id === bId);
  if (!a || !b) return;
  openModal(`
    <div class="dlg-head">
      <div class="dlg-title">COMPARE SESSIONS</div>
      <button class="dlg-x" onclick="document.getElementById('appDialog').close()">✕</button>
    </div>
    <table class="cmp-table">
      <thead><tr><th>Metric</th><th>${a.id}</th><th>${b.id}</th><th>Δ</th></tr></thead>
      <tbody>
        ${cmpRow('Date',  fmtDate(a.modTime), fmtDate(b.modTime), '—')}
        ${cmpRow('Bytes', fmtBytes(a.bytes), fmtBytes(b.bytes), fmtBytes(Math.abs(a.bytes - b.bytes)))}
      </tbody>
    </table>
    <div class="detail-ctx">
      Compare uses SD metadata only. Download each CSV to inspect waveform details.
    </div>
    <div class="dlg-actions">
      <button class="dlg-btn" onclick="document.getElementById('appDialog').close()">CLOSE</button>
    </div>
  `);
}
function cmpRow(k, a, b, d) {
  return `<tr><td>${k}</td><td>${a}</td><td>${b}</td><td>${d}</td></tr>`;
}

export function openGoalsModal() {
  const g = state.goals;
  openModal(`
    <div class="dlg-head">
      <div class="dlg-title">TRAINING GOAL</div>
      <button class="dlg-x" onclick="document.getElementById('appDialog').close()">✕</button>
    </div>
    <div class="dlg-row"><label>STRIKES</label><input id="dlgStr"  type="number" min="1" value="${g.targetStrikes}"></div>
    <div class="dlg-row"><label>PEAK ≥ (g)</label><input id="dlgPeak" type="number" step="0.5" min="1" value="${g.targetPeakG}"></div>
    <div class="dlg-row"><label>TARGET SPM</label><input id="dlgSpm" type="number" min="1" value="${g.targetSpm}"></div>
    <div class="dlg-actions">
      <button class="dlg-btn" onclick="document.getElementById('appDialog').close()">CANCEL</button>
      <button class="dlg-btn primary" id="dlgSaveGoals">SAVE</button>
    </div>
  `);
  document.getElementById('dlgSaveGoals').addEventListener('click', () => {
    g.targetStrikes = Math.max(1, parseInt(document.getElementById('dlgStr').value, 10) || 1);
    g.targetPeakG   = Math.max(0.1, parseFloat(document.getElementById('dlgPeak').value) || 1);
    g.targetSpm     = Math.max(1, parseInt(document.getElementById('dlgSpm').value, 10) || 1);
    g.completedAt   = 0;
    saveGoalsCb?.();
    closeModal();
    scheduleRender();
  });
}
let saveGoalsCb = null;
export function bindSaveGoals(fn) { saveGoalsCb = fn; }

export function openShortcutsModal() {
  openModal(`
    <div class="dlg-head">
      <div class="dlg-title">KEYBOARD SHORTCUTS</div>
      <button class="dlg-x" onclick="document.getElementById('appDialog').close()">✕</button>
    </div>
    <div class="shortcuts">
      <div><kbd>Space</kbd> Start / Stop REC</div>
      <div><kbd>R</kbd> Reset round timer</div>
      <div><kbd>S</kbd> Skip phase</div>
      <div><kbd>M</kbd> Add coach marker</div>
      <div><kbd>F</kbd> Fullscreen presentation</div>
      <div><kbd>H</kbd> Toggle body heatmap</div>
      <div><kbd>T</kbd> Toggle theme</div>
      <div><kbd>1</kbd>–<kbd>4</kbd> Filter strike log</div>
      <div><kbd>0</kbd> Filter: all slots</div>
      <div><kbd>Esc</kbd> Close modal</div>
    </div>
    <div class="dlg-actions">
      <button class="dlg-btn primary" onclick="document.getElementById('appDialog').close()">GOT IT</button>
    </div>
  `);
}

// ───── HELPERS ─────
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function escapeAttr(s) { return escapeHtml(s).replace(/"/g, '&quot;'); }

// ───── MASTER RENDER ─────
export function renderAll() {
  renderTopbar();
  renderDial();
  renderStats();
  renderBody();
  renderMixer();
  renderDistribution();
  renderGoals();
  renderPerRound();
  renderActivity();
  renderMarkers();
  renderTimeline();
  renderStrikeLog();
  renderNodes();
  renderLibrary();
  renderSystem();
}

// ───── INIT ─────
export function initUi() {
  setupTabs();
  setupChips();
  setupBodyZones();
  setupBodyToggle();
  setupTuning();
  setupLibrarySearch();
  $('btnEditGoals')?.addEventListener('click', openGoalsModal);
  $('btnHelp')?.addEventListener('click', openShortcutsModal);
  $('buildStamp').textContent = new Date().toISOString().slice(0,10).replace(/-/g,'');
}

// Re-export modal helpers
export { addMarker, deleteMarker, openStrikeDetail, openSessionPreview };
