// Onboarding Tour — lightweight guided walkthrough (zero dependencies, tiny
// PROGMEM cost). Auto-runs on first visit, re-openable from SYSTEM tab.
//
// Two presentations from one set of steps:
//   • desktop — spotlight ring + a floating card placed beside the target
//   • phone   — spotlight ring + a bottom sheet, because a floating card on a
//               360 px screen either covers the thing it is describing or gets
//               pushed off-screen. The sheet is a fixed, thumb-reachable target
//               and the page is scrolled so the highlight sits in the strip of
//               screen the sheet does not cover.
// Swipe left/right anywhere moves between steps on touch devices.

import { persist, PERSIST_KEYS as K } from './persist.js';

const STEPS = [
  { sel: '.athlete',          tab: null,
    title: '1 · ตั้งค่านักมวย',   body: 'ใส่ชื่อนักมวย เลือกประเภทซ้อม และโหมดเวลา (จำนวนยก) ก่อนเริ่ม' },
  { sel: '#btnRec',           tab: null,
    title: '2 · อัดเซสชัน',        body: 'กดปุ่มนี้เพื่อเริ่ม/หยุดบันทึก — นาฬิกายกจะเริ่มเดินพร้อมกัน และข้อมูลถูกเก็บลง SD card อัตโนมัติ' },
  { sel: '#roundDial',        tab: null,
    title: '3 · จับเวลายก',        body: 'แตะวงกลมเพื่อเริ่มหรือเดินต่อ ระบบสลับ ชก/พัก และนับยกให้เอง' },
  { sel: '#bodySvg',          tab: null,
    title: '4 · จุดปะทะ',          body: 'แสดงแรงกระแทกแต่ละอวัยวะแบบเรียลไทม์ — มือ/แข้ง แยกซ้าย-ขวา แตะที่อวัยวะเพื่อจับคู่เซนเซอร์ได้' },
  { sel: '.scorecard-block',  tab: null,
    title: '5 · ประเมินผล',        body: 'เรดาร์คะแนน 6 ด้านจากเซนเซอร์ พร้อมบอกจุดเด่นและจุดที่ต้องพัฒนา' },
  { sel: '.tabs',             tab: null,
    title: '6 · แท็บเครื่องมือ',   body: 'เซนเซอร์ = จัดการโหนด · คลังข้อมูล = ไฟล์เซสชัน · ระบบ = ตั้งค่าและกู้คืนการเชื่อมต่อ' },
  { sel: '#nodeList',         tab: 'sensors',
    title: '7 · จัดการเซนเซอร์',   body: 'แต่ละการ์ดคือโหนด 1 ตัว เลือกอวัยวะ คาลิเบรต หรือกด "แก้อาการค้าง" ถ้าโหนดขึ้นแต่ไม่มีข้อมูลเข้า' },
  { sel: '#btnFactoryReset',  tab: 'system',
    title: '8 · เมื่อมีปัญหา',     body: 'แท็บระบบมีปุ่มกู้คืน — ต่อสตรีมใหม่ · รีสตาร์ทวิทยุ · รีบูตโหนดหลัก และรีเซ็ตเป็นค่าจากโรงงานถ้าอยากเริ่มใหม่ทั้งหมด' },
];

const MOBILE_Q = '(max-width: 760px), (pointer: coarse)';
const isMobile = () => window.matchMedia(MOBILE_Q).matches;

let idx = 0;
let blocker = null, ring = null, card = null;
let onKey = null, onScroll = null;
let touchX = 0, touchY = 0;
let scrollLockY = 0;

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
  document.body.classList.add('tour-open');
  if (isMobile()) {
    card.classList.add('tour-sheet');
    document.body.classList.add('tour-mobile');
    // Lock the page behind the sheet: on iOS a scroll that starts on the overlay
    // otherwise rubber-bands the whole document and drags the highlight away.
    scrollLockY = window.scrollY;
    blocker.addEventListener('touchmove', e => e.preventDefault(), { passive: false });
    card.addEventListener('touchstart', onTouchStart, { passive: true });
    card.addEventListener('touchend',   onTouchEnd,   { passive: true });
    blocker.addEventListener('touchstart', onTouchStart, { passive: true });
    blocker.addEventListener('touchend',   onTouchEnd,   { passive: true });
  }

  onKey = e => {
    if (e.key === 'Escape') endTour();
    else if (e.key === 'ArrowRight') next();
    else if (e.key === 'ArrowLeft') prev();
  };
  onScroll = () => reposition();
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', reposition);
  window.addEventListener('orientationchange', reposition);
  window.addEventListener('scroll', onScroll, { passive: true });
  // The URL bar collapsing on mobile changes the usable height without firing a
  // resize — visualViewport is the only reliable signal for it.
  window.visualViewport?.addEventListener('resize', reposition);
  window.visualViewport?.addEventListener('scroll', reposition);
  showStep();
}

function el(tag, cls) { const n = document.createElement(tag); n.className = cls; return n; }

// ── swipe navigation (mobile) ──
function onTouchStart(e) {
  const t = e.changedTouches[0];
  touchX = t.clientX; touchY = t.clientY;
}
function onTouchEnd(e) {
  if (e.target.closest('button')) return;      // let taps hit the buttons
  const t = e.changedTouches[0];
  const dx = t.clientX - touchX, dy = t.clientY - touchY;
  if (Math.abs(dx) < 48 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
  dx < 0 ? next() : prev();
}

function currentTarget() {
  // skip steps whose element is missing in this build
  while (idx < STEPS.length && !document.querySelector(STEPS[idx].sel)) idx++;
  return idx < STEPS.length ? document.querySelector(STEPS[idx].sel) : null;
}

function showStep() {
  if (idx >= STEPS.length) return endTour();
  // Some steps live inside a tab pane that isn't open — switch to it first,
  // otherwise the spotlight lands on a zero-size hidden element.
  const wantTab = STEPS[idx]?.tab;
  if (wantTab) document.querySelector(`.tab[data-tab="${wantTab}"]`)?.click();

  const t = currentTarget();
  if (!t) return endTour();
  const step = STEPS[idx];
  const last = idx === STEPS.length - 1;
  card.innerHTML = `
    <div class="tour-progress"><i style="width:${((idx + 1) / STEPS.length) * 100}%"></i></div>
    <div class="tour-step-of">ขั้นที่ ${idx + 1} จาก ${STEPS.length}</div>
    <div class="tour-title">${step.title}</div>
    <div class="tour-body">${step.body}</div>
    <div class="tour-nav">
      <button class="tour-skip" type="button">ข้าม</button>
      <span class="tour-dots">${STEPS.map((_, i) => `<i class="${i === idx ? 'on' : ''}"></i>`).join('')}</span>
      <span class="tour-btns">
        ${idx > 0 ? '<button class="tour-prev" type="button">‹ ย้อน</button>' : ''}
        <button class="tour-next" type="button">${last ? 'เริ่มใช้งาน' : 'ถัดไป ›'}</button>
      </span>
    </div>
    ${isMobile() ? '<div class="tour-swipe-hint">ปัดซ้าย-ขวาเพื่อเปลี่ยนขั้นตอน</div>' : ''}`;
  card.querySelector('.tour-skip').onclick = endTour;
  card.querySelector('.tour-next').onclick = next;
  const p = card.querySelector('.tour-prev'); if (p) p.onclick = prev;

  // Settle repeatedly: switching tabs reflows the page after we scroll, and a
  // smooth scroll needs a beat to land. Each pass re-checks and only moves if the
  // target still isn't sitting in the strip above the sheet.
  settle();
  setTimeout(settle, 300);
  setTimeout(settle, 650);
}

function settle() {
  const t = currentTarget();
  if (!t || !card) return;
  scrollTargetIntoFreeArea(t);
  reposition();
}

const viewportH = () => window.visualViewport?.height || window.innerHeight;

/**
 * Put the target in the part of the screen the tour card does NOT cover.
 * On a phone the sheet owns the bottom, so centring the target (the old
 * behaviour) hid it behind the sheet on every other step. Aim high instead.
 */
function scrollTargetIntoFreeArea(t) {
  if (!isMobile()) {
    t.scrollIntoView({ block: 'center', behavior: 'smooth' });
    return;
  }
  const r = t.getBoundingClientRect();
  const wantTop = viewportH() * 0.22;
  const delta = r.top - wantTop;
  if (Math.abs(delta) < 8) return;
  window.scrollBy({ top: delta, behavior: 'smooth' });
}

function reposition() {
  const t = currentTarget();
  if (!t || !ring) return;
  const pad = 6;

  if (isMobile()) {
    // The sheet is pinned by CSS (full width, safe-area aware) — nothing to
    // compute for it, which is exactly why it can't end up off-screen.
    card.style.top = card.style.left = '';

    // …but it CAN cover the highlight. The last steps target elements at the very
    // bottom of the document, which no amount of scrolling lifts above a bottom
    // sheet. Bottom is the thumb-friendly default, so only flip when the target
    // actually starts behind it — measured with the sheet in its default place.
    const vh = viewportH();
    card.classList.remove('tour-sheet-top');
    const bottomSheetTop = card.getBoundingClientRect().top;
    let r = t.getBoundingClientRect();
    const flip = r.top > bottomSheetTop - 44;   // no usable strip left above
    card.classList.toggle('tour-sheet-top', flip);

    // Read the sheet AFTER the flip — measuring beats predicting its height, which
    // varies with the length of each step's text.
    const cardRect = card.getBoundingClientRect();
    r = t.getBoundingClientRect();
    const limitTop    = flip ? cardRect.bottom + 8 : 8;
    const limitBottom = flip ? vh - 8 : cardRect.top - 8;

    // Panels like the scorecard or the node list are taller than the free strip.
    // Outlining them in full puts most of the ring off-screen, which reads as
    // "nothing is highlighted" — so clamp it to the part actually on screen.
    const top    = Math.max(limitTop, Math.min(r.top - pad, limitBottom - 36));
    const bottom = Math.min(limitBottom, Math.max(r.bottom + pad, top + 36));
    Object.assign(ring.style, {
      top: top + 'px', left: (r.left - pad) + 'px',
      width: (r.width + pad * 2) + 'px',
      height: Math.max(36, bottom - top) + 'px',
    });
    return;
  }
  const r = t.getBoundingClientRect();

  Object.assign(ring.style, {
    top: (r.top - pad) + 'px', left: (r.left - pad) + 'px',
    width: (r.width + pad * 2) + 'px', height: (r.height + pad * 2) + 'px',
  });
  // desktop: place card below the target if there's room, else above
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
  window.removeEventListener('orientationchange', reposition);
  window.removeEventListener('scroll', onScroll);
  window.visualViewport?.removeEventListener('resize', reposition);
  window.visualViewport?.removeEventListener('scroll', reposition);
  document.body.classList.remove('tour-open', 'tour-mobile');
  blocker?.remove(); ring?.remove(); card?.remove();
  blocker = ring = card = onKey = onScroll = null;
}
