// Which origin the dashboard aims REST and the WebSocket at.
//
// The distinction that matters: a page served from localhost:5173 is the vite
// dev server and the rig is elsewhere, while a page served from localhost:8080
// is the rig itself behind tools/rig-localhost-proxy.py — the trick that gives a
// desktop browser camera access without HTTPS. Treating the second like the
// first sends its REST calls cross-origin to 192.168.4.1, where CORS kills them
// while the page still looks like it loaded.
import test from 'node:test';
import assert from 'node:assert/strict';

async function originFor(hostname, port) {
  Object.defineProperty(globalThis, 'location', {
    value: { hostname, port, host: port ? `${hostname}:${port}` : hostname, protocol: 'http:' },
    configurable: true,
  });
  return import(`../src/rigorigin.js?h=${hostname}&p=${port}`);
}

test('the vite dev server is told where the rig actually is', async () => {
  const dev = await originFor('localhost', '5173');
  assert.equal(dev.RIG_HTTP_BASE, 'http://192.168.4.1');
  assert.equal(dev.rigWsHost(), '192.168.4.1');
});

test('the preview server gets the same treatment', async () => {
  const preview = await originFor('127.0.0.1', '4173');
  assert.equal(preview.RIG_HTTP_BASE, 'http://192.168.4.1');
});

test('a localhost proxy is the rig, not a dev server', async () => {
  const proxied = await originFor('localhost', '8080');
  assert.equal(proxied.RIG_HTTP_BASE, '');
  assert.equal(proxied.rigWsHost(), 'localhost:8080');
});

test('the rig served directly stays on its own origin', async () => {
  const direct = await originFor('192.168.4.1', '');
  assert.equal(direct.RIG_HTTP_BASE, '');
  assert.equal(direct.rigWsHost(), '192.168.4.1');
});
