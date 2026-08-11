import test from 'node:test';
import assert from 'node:assert/strict';

const originalLocation = globalThis.location;
const originalFetch = globalThis.fetch;
Object.defineProperty(globalThis, 'location', {
  value: { hostname: '192.168.4.1', protocol: 'https:' }, configurable: true,
});

const { api, releaseInitialRequestGate, openRequestLane } = await import('../src/api.js?request-gate-test');

test('no REST leaves the page until the live stream has claimed its TLS socket', async (t) => {
  t.after(() => { globalThis.fetch = originalFetch; });
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    return { ok: true, status: 200, statusText: 'OK', text: async () => '{}' };
  };

  const early = api.status();
  await Promise.resolve();
  await Promise.resolve();
  // The rig admits two TLS clients. REST before WSS meant the stream never got
  // in and the dashboard sat on Offline, so the lane starts closed on HTTPS.
  assert.deepEqual(calls, []);

  openRequestLane();
  await early;
  assert.deepEqual(calls, ['/api/status']);
});

test('every rig call carries an abort deadline', async (t) => {
  t.after(() => { globalThis.fetch = originalFetch; });
  let seenSignal = null;
  globalThis.fetch = async (url, opts) => {
    seenSignal = opts?.signal;
    return { ok: true, status: 200, statusText: 'OK', text: async () => '{}' };
  };
  await api.status();
  // Without a deadline one stalled read wedges the single-request lane for as
  // long as the browser's own socket timeout, and nothing queued behind it runs.
  assert.ok(seenSignal instanceof AbortSignal);
  assert.equal(seenSignal.aborted, false);
});

test('startup API gate waits for a response body before opening the next TLS request', async (t) => {
  t.after(() => {
    releaseInitialRequestGate();
    globalThis.fetch = originalFetch;
    if (originalLocation === undefined) delete globalThis.location;
    else Object.defineProperty(globalThis, 'location', { value: originalLocation, configurable: true });
  });
  const calls = [];
  let releaseStatusBody;
  globalThis.fetch = async (url) => {
    calls.push(url);
    if (url === '/api/status') {
      return {
        ok: true, status: 200, statusText: 'OK',
        text: () => new Promise(resolve => { releaseStatusBody = () => resolve('{"ready":true}'); }),
      };
    }
    return { ok: true, status: 200, statusText: 'OK', text: async () => '[]' };
  };

  const status = api.status();
  const nodes = api.nodes();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(calls, ['/api/status']);

  releaseStatusBody();
  assert.deepEqual(await status, { ready: true });
  assert.deepEqual(await nodes, []);
  assert.deepEqual(calls, ['/api/status', '/api/nodes']);

  // Secure mode keeps the lane after hydration: WSS owns the other TLS client
  // slot, so later polling must not issue overlapping HTTPS handshakes.
  releaseInitialRequestGate();
  calls.length = 0;
  let releaseLaterBody;
  globalThis.fetch = async (url) => {
    calls.push(url);
    if (url === '/api/status') {
      return {
        ok: true, status: 200, statusText: 'OK',
        text: () => new Promise(resolve => { releaseLaterBody = () => resolve('{}'); }),
      };
    }
    return { ok: true, status: 200, statusText: 'OK', text: async () => '[]' };
  };
  const laterStatus = api.status();
  const laterNodes = api.nodes();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(calls, ['/api/status']);
  releaseLaterBody();
  await laterStatus;
  await laterNodes;
  assert.deepEqual(calls, ['/api/status', '/api/nodes']);
});
