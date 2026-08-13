// Where the rig is, as seen from whatever is showing this page.
//
// Normally the answer is "the origin this document came from" — the dashboard is
// served by the rig itself. Two cases are not that:
//
//   vite dev server   `npm run dev` serves the page from localhost:5173 while
//                     the rig sits on its own access point, so REST and the
//                     WebSocket have to be aimed at 192.168.4.1 explicitly.
//   localhost proxy   a laptop forwarding a local port to the rig, which is how
//                     a desktop browser gets camera access without HTTPS:
//                     `http://localhost` is a secure context by definition, so
//                     getUserMedia works with no browser flags at all.
//
// Those two look identical if you only check the hostname, and the old rule did
// exactly that — which sent the proxied page's REST calls cross-origin to
// 192.168.4.1, where they died on CORS with the page still appearing to load.
// The dev ports below are the ones vite is configured with (see
// .claude/launch.json); anything else on localhost is treated as the rig.
const DEV_SERVER_PORTS = new Set(['5173', '4173']);

function isViteDevServer() {
  if (typeof location === 'undefined') return false;
  const local = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  return local && DEV_SERVER_PORTS.has(location.port);
}

/** Prefix for REST paths. Empty string means "same origin as this page". */
export const RIG_HTTP_BASE = isViteDevServer() ? 'http://192.168.4.1' : '';

/** host:port to open the live WebSocket against. */
export function rigWsHost() {
  return isViteDevServer() ? '192.168.4.1' : location.host;
}
