// ──────────────────────────────────────────────────────────────────
// First-run setup wizard — assign each limb by SHAKING its sensor.
//
// Per the brief this opens on every load (skippable at any point). It teaches
// the basics, then walks limb-by-limb: the user shakes the node they want on
// that limb, we detect the node with the highest live peak-G (from /api/nodes,
// firmware-side per-node activity) and assign it. Any step / the whole wizard
// can be skipped.
// ──────────────────────────────────────────────────────────────────

import { state } from './state.js';

const LIMBS = [
  { slot: 1, name: 'มือซ้าย',  emoji: '🥊' },
  { slot: 2, name: 'มือขวา',   emoji: '🥊' },
  { slot: 3, name: 'แข้งซ้าย', emoji: '🦵' },
  { slot: 4, name: 'แข้งขวา',  emoji: '🦵' },
];
const SHAKE_G   = 2.2;   // peak |accel| (g) that counts as an intentional shake
const CONFIRM_N = 2;     // consecutive polls above threshold from the same mac
// `peakG` stays fresh on the rig for one second, so 500 ms still catches a
// deliberate shake while avoiding a 4.5-request/s HTTPS storm on a tiny AP.
const POLL_MS   = 500;

let api = null;
let onTour = () => {};
let onFinish = () => {};
let overlay = null;
let pollTimer = null;
let stepIdx = 0;                 // -1 welcome, 0..3 limbs, 99 done
const assignedMacs = new Set();  // macs claimed during this run
let candidateMac = null, candidateHits = 0;

export function initSetup(activeApi, opts = {}) {
  api = activeApi;
  onTour   = opts.onTour   || (() => {});
  onFinish = opts.onFinish || (() => {});
  document.getElementById('btnOpenSetup')?.addEventListener('click', () => openSetupWizard());
}

export function openSetupWizard() {
  if (overlay) return;
  stepIdx = -1;
  assignedMacs.clear();
  overlay = document.createElement('div');
  overlay.className = 'setup-overlay';
  // Tapping the dark backdrop (anywhere outside the card) closes the wizard, so it
  // can never trap the app — one of the reported "หน้าซ้อนทับกดปุ่มไม่ได้" cases was
  // the wizard sitting on top with the skip button out of reach.
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeWizard(); });
  document.body.appendChild(overlay);
  render();
}

function closeWizard() {
  stopPoll();
  overlay?.remove();
  overlay = null;
  // Reaching the end OR skipping both count as "this rig has been set up" — either
  // way the user has made a decision and shouldn't be re-prompted on every load.
  try { onFinish(); } catch (e) { console.error(e); }
}

function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } candidateMac = null; candidateHits = 0; }

// ── rendering ──
function render() {
  if (!overlay) return;
  stopPoll();
  if (stepIdx === -1)       renderWelcome();
  else if (stepIdx >= 0 && stepIdx < LIMBS.length) renderLimb();
  else                      renderDone();
}

function card(inner) {
  // Always-present ✕ so the wizard is escapable from any step, even mid-detection.
  overlay.innerHTML = `<button class="setup-close" data-act="close-x" type="button" aria-label="ปิดตัวช่วยตั้งค่า">✕</button><div class="setup-card">${inner}</div>`;
  overlay.querySelector('[data-act="close-x"]')?.addEventListener('click', closeWizard);
}

function renderWelcome() {
  card(`
    <div class="setup-kicker">ยินดีต้อนรับ · STRIKESENSE</div>
    <h2 class="setup-title">ตั้งค่าเซนเซอร์ครั้งแรก</h2>
    <p class="setup-lead">จับคู่เซนเซอร์แต่ละตัวเข้ากับอวัยวะด้วยการ <b>เขย่า</b> — ไม่ต้องเลือกเองทีละตัว</p>
    <ol class="setup-steps">
      <li>เปิด Strike Node ทุกตัวให้เชื่อมต่อ (ดูที่แท็บเซนเซอร์)</li>
      <li>ระบบจะถามทีละอวัยวะ — <b>เขย่าเซนเซอร์</b>ที่จะใส่ตรงนั้น</li>
      <li>เสร็จแล้วคาลิเบรตเพื่อความแม่นยำ</li>
    </ol>
    <div class="setup-detect">
      <div class="setup-detect-txt" id="setupOnlineTxt">กำลังค้นหาเซนเซอร์…</div>
    </div>
    <div class="setup-actions">
      <button class="setup-btn ghost" data-act="skip-all">ข้ามการตั้งค่า</button>
      <button class="setup-btn ghost" data-act="tour">ดูวิธีใช้งาน</button>
      <button class="setup-btn primary" data-act="start">เริ่มตั้งค่า ›</button>
    </div>
  `);
  bind({
    'skip-all': closeWizard,
    'tour': () => { closeWizard(); onTour(); },
    'start': () => { stepIdx = 0; render(); },
  });
  startPollForOnlineCount();
}

// Live sensor headcount on the welcome screen. With a multi-node rig the usual
// failure is starting the wizard with one sensor still switched off and only
// finding out three steps later.
function startPollForOnlineCount() {
  const txt = () => overlay?.querySelector('#setupOnlineTxt');
  let inFlight = false;
  const tick = async () => {
    if (inFlight) return;
    inFlight = true;
    let nodes;
    try { nodes = await api.nodes(); } catch (e) { return; }
    finally { inFlight = false; }
    if (!overlay || !txt()) return;
    const online = (nodes || []).filter(n => (n.ageMs ?? 9999) < 3000);
    txt().textContent = online.length
      ? `🟢 พบเซนเซอร์ออนไลน์ ${online.length} ตัว · ${online.map(n => n.mac.slice(-5)).join(' · ')}`
      : '⚠ ยังไม่พบเซนเซอร์ออนไลน์ — เปิดเครื่องแล้วรอสักครู่';
  };
  tick();
  pollTimer = setInterval(tick, 800);
}

function renderLimb() {
  const limb = LIMBS[stepIdx];
  card(`
    <div class="setup-kicker">ขั้นที่ ${stepIdx + 1}/${LIMBS.length}</div>
    <div class="setup-shake-emoji">${limb.emoji}</div>
    <h2 class="setup-title">เขย่าเซนเซอร์สำหรับ<br><span class="setup-limb">${limb.name}</span></h2>
    <p class="setup-lead">หยิบเซนเซอร์ที่จะใส่ <b>${limb.name}</b> แล้วเขย่าแรงๆ 1–2 วินาที</p>
    <div class="setup-detect">
      <div class="setup-detect-bar"><i id="setupBar"></i></div>
      <div class="setup-detect-txt" id="setupDetectTxt">กำลังรอการเขย่า…</div>
    </div>
    <div class="setup-actions">
      <button class="setup-btn ghost" data-act="skip-all">ข้ามทั้งหมด</button>
      <button class="setup-btn ghost" data-act="skip-one">ข้ามอวัยวะนี้ ›</button>
    </div>
  `);
  bind({
    'skip-all': closeWizard,
    'skip-one': () => { stepIdx++; render(); },
  });
  startPollForShake();
}

function renderDone() {
  const n = assignedMacs.size;
  card(`
    <div class="setup-kicker">เสร็จสิ้น</div>
    <div class="setup-shake-emoji">✅</div>
    <h2 class="setup-title">ตั้งค่าเรียบร้อย</h2>
    <p class="setup-lead">จับคู่แล้ว <b>${n}</b> อวัยวะ — ปรับแก้ภายหลังได้ที่แท็บเซนเซอร์</p>
    <div class="setup-actions">
      <button class="setup-btn ghost" data-act="close">เริ่มใช้งาน</button>
      <button class="setup-btn primary" data-act="cal">คาลิเบรตทั้งหมด ›</button>
    </div>
  `);
  bind({
    'close': closeWizard,
    'cal': () => { closeWizard(); document.getElementById('btnCalAll')?.click(); },
  });
}

function bind(map) {
  for (const [act, fn] of Object.entries(map)) {
    overlay.querySelector(`[data-act="${act}"]`)?.addEventListener('click', fn);
  }
}

// ── shake detection ──
function startPollForShake() {
  candidateMac = null; candidateHits = 0;
  const bar = () => overlay?.querySelector('#setupBar');
  const txt = () => overlay?.querySelector('#setupDetectTxt');
  let inFlight = false;

  pollTimer = setInterval(async () => {
    if (inFlight) return;
    inFlight = true;
    let nodes;
    try { nodes = await api.nodes(); } catch (e) { return; }
    finally { inFlight = false; }
    if (!overlay) return;

    // candidates: online nodes not already claimed this run
    const cand = (nodes || []).filter(n =>
      !assignedMacs.has(n.mac) && (n.ageMs ?? 9999) < 3000);

    let best = null;
    for (const n of cand) if (!best || (n.peakG || 0) > (best.peakG || 0)) best = n;

    const g = best ? (best.peakG || 0) : 0;
    if (bar()) bar().style.width = Math.min(100, (g / 6) * 100) + '%';

    if (best && g >= SHAKE_G) {
      if (candidateMac === best.mac) candidateHits++;
      else { candidateMac = best.mac; candidateHits = 1; }
      if (txt()) txt().textContent = `ตรวจพบการเขย่า · ${best.mac.slice(-5)} (${g.toFixed(1)}g)`;
      if (candidateHits >= CONFIRM_N) { stopPoll(); assign(best.mac); }
    } else {
      candidateMac = null; candidateHits = 0;
      const online = (nodes || []).filter(n => (n.ageMs ?? 9999) < 3000).length;
      if (txt()) txt().textContent = online
        ? 'กำลังรอการเขย่า…'
        : '⚠ ยังไม่พบโหนดออนไลน์ — เปิดเซนเซอร์ก่อน';
    }
  }, POLL_MS);
}

async function assign(mac) {
  const limb = LIMBS[stepIdx];
  const txt = overlay?.querySelector('#setupDetectTxt');
  try {
    await api.assignSlot(mac, limb.slot);
    assignedMacs.add(mac);
    if (txt) txt.textContent = `✓ จับคู่ ${mac.slice(-5)} → ${limb.name}`;
    setTimeout(() => { stepIdx++; render(); }, 700);
  } catch (e) {
    if (txt) txt.textContent = `⚠ จับคู่ไม่สำเร็จ: ${e.message}`;
    setTimeout(startPollForShake, 900);
  }
}
