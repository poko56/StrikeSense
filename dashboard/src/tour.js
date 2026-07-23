// Onboarding Tour — lightweight guided walkthrough (zero dependencies, tiny
// PROGMEM cost). Auto-runs on first visit, re-openable from SYSTEM tab.
// Spotlight = a positioned ring with a huge box-shadow that dims everything else.

import { persist, PERSIST_KEYS as K } from './persist.js';

const STEPS = [
  { sel: '.athlete',          title: '1 · ตั้งค่านักมวย',   body: 'ใส่ชื่อนักมวย เลือกประเภทซ้อม และโหมดเวลา (จำนวนยก) ก่อนเริ่ม' },
  { sel: '#btnRec',           title: '2 · อัดเซสชัน',        body: 'กด REC เพื่อเริ่ม/หยุดบันทึกเซสชัน — ข้อมูลถูกเก็บลง SD card ของ Main Node อัตโนมัติ' },
  { sel: '#roundDial',        title: '3 · จับเวลายก',        body: 'แตะวงกลมเพื่อเริ่มจับเวลา ระบบสลับ WORK/REST และนับยกให้อัตโนมัติ' },
  { sel: '#bodySvg',          title: '4 · จุดปะทะ',          body: 'แสดงแรงกระแทกแต่ละอวัยวะแบบเรียลไทม์ — มือ/แข้ง แยกซ้าย-ขวา' },
  { sel: '.scorecard-block',  title: '5 · ประเมินผล',        body: 'เรดาร์คะแนน 6 ด้านจากเซนเซอร์ พร้อมบอกจุดเด่นและจุดที่ต้องพัฒนา' },
  { sel: '.tabs',             title: '6 · แท็บเครื่องมือ',   body: 'เซนเซอร์ = จัดการโหนด · คลังข้อมูล = ไฟล์เซสชัน · ระบบ = ตั้งค่า + เปิดโหมดนักพัฒนา (เก็บข้อมูลเทรน AI)' },
];

let idx = 0;
let blocker = null, ring = null, card = null, onKey = null;

export function maybeAutoStartTour() {
  if (!persist.get(K.tourSeen, false)) setTimeout(startTour, 600);
}

export function startTour() {
  if (blocker) return;         // already open
  idx = 0;
  blocker = el('div', 'tour-blocker');
  ring    = el('div', 'tour-ring');
  card    = el('div', 'tour-card');
  document.body.append(blocker, ring, card);
  onKey = e => {
    if (e.key === 'Escape') endTour();
    else if (e.key === 'ArrowRight') next();
    else if (e.key === 'ArrowLeft') prev();
  };
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', reposition);
  showStep();
}

function el(tag, cls) { const n = document.createElement(tag); n.className = cls; return n; }

function currentTarget() {
  // skip steps whose element is missing in this build
  while (idx < STEPS.length && !document.querySelector(STEPS[idx].sel)) idx++;
  return idx < STEPS.length ? document.querySelector(STEPS[idx].sel) : null;
}

function showStep() {
  const t = currentTarget();
  if (!t) return endTour();
  const step = STEPS[idx];
  const last = idx === STEPS.length - 1;
  card.innerHTML = `
    <div class="tour-title">${step.title}</div>
    <div class="tour-body">${step.body}</div>
    <div class="tour-nav">
      <button class="tour-skip" type="button">ข้าม</button>
      <span class="tour-dots">${STEPS.map((_, i) => `<i class="${i === idx ? 'on' : ''}"></i>`).join('')}</span>
      <span class="tour-btns">
        ${idx > 0 ? '<button class="tour-prev" type="button">‹ ย้อน</button>' : ''}
        <button class="tour-next" type="button">${last ? 'เริ่มใช้งาน' : 'ถัดไป ›'}</button>
      </span>
    </div>`;
  card.querySelector('.tour-skip').onclick = endTour;
  card.querySelector('.tour-next').onclick = next;
  const p = card.querySelector('.tour-prev'); if (p) p.onclick = prev;

  t.scrollIntoView({ block: 'center', behavior: 'smooth' });
  setTimeout(reposition, 260);   // wait for smooth scroll to settle
}

function reposition() {
  const t = currentTarget();
  if (!t || !ring) return;
  const r = t.getBoundingClientRect();
  const pad = 6;
  Object.assign(ring.style, {
    top: (r.top - pad) + 'px', left: (r.left - pad) + 'px',
    width: (r.width + pad * 2) + 'px', height: (r.height + pad * 2) + 'px',
  });
  // place card below the target if there's room, else above
  const ch = card.offsetHeight || 150, cw = card.offsetWidth || 300;
  const below = r.bottom + 12 + ch < window.innerHeight;
  let top = below ? r.bottom + 12 : r.top - ch - 12;
  top = Math.max(12, Math.min(top, window.innerHeight - ch - 12));
  let left = Math.min(Math.max(12, r.left), window.innerWidth - cw - 12);
  Object.assign(card.style, { top: top + 'px', left: left + 'px' });
}

function next() { idx++; (idx >= STEPS.length) ? endTour() : showStep(); }
function prev() { idx = Math.max(0, idx - 1); showStep(); }

function endTour() {
  persist.set(K.tourSeen, true);
  window.removeEventListener('keydown', onKey, true);
  window.removeEventListener('resize', reposition);
  blocker?.remove(); ring?.remove(); card?.remove();
  blocker = ring = card = onKey = null;
}
