// Detect a dashboard the browser is serving from its own cache after the rig has
// been re-flashed.
//
// The rig now sends `Cache-Control: no-store`, but a copy cached under the old
// `max-age=86400` header keeps being served for up to a day without the browser
// ever asking the server — so a phone can sit on a dashboard from before the
// flash while a laptop that cached later shows the new one. The symptom is not
// obviously a cache problem: the page renders, and then behaves like the build it
// came from, which for one bad build meant every control was dead.
//
// So: ask the rig what it is actually serving, and if that is a different build
// from the one running, reload once.

const KEY = 'ss.freshReload';   // which build the coach chose to reload into

/** Pull the build id out of a dashboard document without executing it.
 *
 *  Parsed, not matched with a regular expression: the dashboard is a SINGLE FILE
 *  with every script inlined, so this module's own source is part of the document
 *  it is searching. A pattern looking for the build-id markup found the pattern
 *  itself first, and the "served build" came back as a fragment of regex. A
 *  DOMParser document runs nothing and never looks inside <script>. */
function stampOf(html) {
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return doc.querySelector('meta[name="ss-build"]')?.content?.trim() || '';
  } catch { return ''; }
}

/**
 * @param {string} running  the build id compiled into this page
 * @param {boolean} isDemo  skip entirely when there is no rig to ask
 */
export async function checkFreshness(running, isDemo) {
  if (isDemo || !running) return;
  // On HTTPS, ask the cheap way. Re-downloading the whole 400 KB document to
  // read one meta tag would compete with the live stream for the rig's two TLS
  // sockets — but skipping the check entirely (as this did) left phones running
  // JavaScript cached under the old `max-age=86400` header for a day after a
  // flash, with no symptom other than the dashboard behaving like the build it
  // came from. /api/secure-status names the build the rig actually serves.
  if (location.protocol === 'https:') {
    try {
      const res = await fetch('/api/secure-status', { cache: 'no-store' });
      if (!res.ok) return;
      const served = (await res.json())?.build || '';
      if (served && served !== running) offerReload(served);
    } catch { /* rig unreachable — the page in front of the coach still works */ }
    return;
  }
  try {
    const res = await fetch('/index.html', { cache: 'reload' });
    if (!res.ok) return;
    const served = stampOf(await res.text());
    if (!served || served === running) return;
    offerReload(served);
  } catch {
    /* rig unreachable — the page in front of the coach is better than nothing */
  }
}

/**
 * Tell the coach, do not act.
 *
 * This used to call location.replace() by itself. Auto-navigating a page the
 * user is touching is hostile in every case and was actively harmful on iOS,
 * where the reload landed mid-interaction and the page came back seemingly dead
 * — "ใช้ได้แปปเดียว แล้วพอรีเฟรชก็กดไม่ได้". A reload is also never urgent: the
 * old dashboard still works, it is just old. So offer it, and let the tap that
 * accepts it be the coach's.
 */
function offerReload(served) {
  if (document.getElementById('freshBar')) return;
  const bar = document.createElement('button');
  bar.id = 'freshBar';
  bar.type = 'button';
  bar.textContent = '↻ มีเวอร์ชันใหม่ในเครื่อง — แตะเพื่อโหลดใหม่';
  bar.style.cssText = [
    'position:fixed', 'left:12px', 'right:12px', 'bottom:12px', 'z-index:9990',
    'min-height:48px', 'padding:12px 16px', 'border-radius:10px',
    'background:#d62631', 'color:#fff', 'border:0',
    'font:600 13px/1.3 system-ui,sans-serif', 'box-shadow:0 8px 30px rgba(0,0,0,.5)',
  ].join(';');
  bar.addEventListener('click', () => {
    try { sessionStorage.setItem(KEY, served); } catch {}
    location.replace(location.pathname + '?fresh=' + encodeURIComponent(served));
  });
  document.body.appendChild(bar);
}
