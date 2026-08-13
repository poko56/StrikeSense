// Why a tap does nothing.
//
// Three plausible causes have already been fixed on reasoning alone and the
// symptom survived all three. A tap either produces a `click` or it does not,
// and the browser says exactly where the chain breaks — so stop guessing and
// read it off the device that actually has the problem.
//
// Open the dashboard with ?touchdebug=1 and tap anything. The strip at the top
// shows, for the last tap: which events arrived, what element they landed on,
// how far the finger travelled, and how long it was held. Read it out and the
// cause is no longer in doubt:
//
//   touchstart ✓ … click ✗  + travel large   → the browser called it a drag
//   touchstart ✓ … click ✗  + target changed → the element was replaced mid-tap
//   touchstart ✓ … pointerup ✗               → something swallowed the release
//   touchstart ✗                             → the touch never reached the page
//
// It costs nothing when the flag is absent: nothing is created and no listener
// is attached.

const SEQ = ['pointerdown', 'touchstart', 'pointerup', 'touchend', 'click'];

export function initTouchProbe() {
  if (!new URLSearchParams(location.search).has('touchdebug')) return;

  const bar = document.createElement('div');
  bar.id = 'touchProbe';
  bar.style.cssText = [
    'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:99999',
    'background:#0b0b0f', 'color:#e8e6e1', 'border-bottom:2px solid #d62631',
    'font:600 11px/1.45 ui-monospace,Menlo,monospace', 'padding:6px 10px',
    'white-space:pre-wrap', 'pointer-events:none',   // must never block a tap itself
  ].join(';');
  bar.textContent = 'แตะปุ่มใดก็ได้ — จะแสดงว่า event ไหนมาถึงบ้าง';
  document.body.appendChild(bar);

  let seen = {}, start = null, startEl = '', maxMove = 0, t0 = 0;

  const name = (el) => {
    if (!el || !el.tagName) return '—';
    const id = el.id ? '#' + el.id : '';
    const cls = el.className && typeof el.className === 'string'
      ? '.' + el.className.trim().split(/\s+/)[0] : '';
    return el.tagName.toLowerCase() + id + cls;
  };

  const paint = (note = '') => {
    const line = SEQ.map(e => `${e} ${seen[e] ? '✓' : '✗'}`).join('  ');
    bar.textContent =
      `${line}\nแตะที่ ${startEl}` +
      (seen.click ? ` → click ที่ ${seen.clickEl}` : '') +
      `\nขยับ ${maxMove.toFixed(0)}px · ค้าง ${t0 ? Math.round(performance.now() - t0) : 0}ms${note}`;
  };

  addEventListener('pointerdown', e => {
    seen = {}; maxMove = 0; t0 = performance.now();
    start = { x: e.clientX, y: e.clientY };
    startEl = name(e.target);
    seen.pointerdown = true;
    paint();
  }, true);

  addEventListener('pointermove', e => {
    if (!start) return;
    maxMove = Math.max(maxMove, Math.hypot(e.clientX - start.x, e.clientY - start.y));
  }, true);

  for (const ev of ['touchstart', 'pointerup', 'touchend']) {
    addEventListener(ev, () => { seen[ev] = true; paint(); }, true);
  }

  addEventListener('click', e => {
    seen.click = true; seen.clickEl = name(e.target);
    // Did the element under the finger survive to the end of the tap?
    paint(seen.clickEl !== startEl ? '  ⚠ element เปลี่ยนระหว่างแตะ' : '');
  }, true);

  // A tap that produced no click at all is the case worth shouting about.
  addEventListener('touchend', () => {
    setTimeout(() => { if (!seen.click) paint('  ⚠ ไม่มี click เกิดขึ้น'); }, 120);
  }, true);
}
