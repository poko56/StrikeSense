// Demo / simulator mode. Activated by ?demo=1 in URL.
// Fakes API responses + injects synthetic IMU batches to drive the UI for dev/UX work.

import { state, scheduleRender } from './state.js';
import { ingestBatch } from './analyzer.js';

const DEMO_NODES = [
  { mac: 'AA:BB:CC:DD:EE:01', slot: 1, rssi: -45, ageMs: 30, batteryPct: 87, nodeUptimeMs: 130_000, firmware: (1<<8)|3, packetsRx: 0, seqGaps: 0 },
  { mac: 'AA:BB:CC:DD:EE:02', slot: 2, rssi: -52, ageMs: 80, batteryPct: 64, nodeUptimeMs: 130_000, firmware: (1<<8)|3, packetsRx: 0, seqGaps: 0 },
  { mac: 'AA:BB:CC:DD:EE:03', slot: 3, rssi: -61, ageMs: 50, batteryPct: 92, nodeUptimeMs: 90_000,  firmware: (1<<8)|3, packetsRx: 0, seqGaps: 0 },
  { mac: 'AA:BB:CC:DD:EE:04', slot: 4, rssi: -58, ageMs: 70, batteryPct: 18, nodeUptimeMs: 30_000,  firmware: (1<<8)|3, packetsRx: 0, seqGaps: 0 },
];

const DEMO_SESSIONS = [
  { id: '1738291201', bytes: 1_240_000, modTime: Math.floor(Date.now()/1000) - 86400  },
  { id: '1738378900', bytes:   820_000, modTime: Math.floor(Date.now()/1000) - 3600*5 },
  { id: '1738411115', bytes: 2_560_000, modTime: Math.floor(Date.now()/1000) - 600    },
];

export function isDemo() {
  return new URLSearchParams(location.search).get('demo') === '1';
}

export function startDemo() {
  state.demoMode  = true;
  state.connected = true;
  state.hostStatus = {
    uptimeMs: 543_210,
    heap: 184_000, psram: 8_200_000,
    rx: 12_400, dropped: 3, wsClients: 1,
    session: { active: false, id: '', startedAtMs: 0, durationMs: 0, packets: 0, samples: 0 },
    sd: { ready: true, cardMB: 14_800, usedMB: 240, rows: 18_000, bytes: 1_240_000 },
  };
  state.nodes    = DEMO_NODES.map(n => ({ ...n }));
  state.sessions = DEMO_SESSIONS.map(s => ({ ...s }));
  scheduleRender();

  // periodic noise per slot (low magnitude, baseline movement)
  setInterval(() => {
    for (const n of DEMO_NODES) {
      pushSyntheticBatch(n.slot, baseline(n.slot));
    }
    // gentle host updates
    state.hostStatus.uptimeMs += 1000;
    state.hostStatus.rx += DEMO_NODES.length * 50;
    scheduleRender();
  }, 1000);

  // strikes — random, weighted by slot
  setInterval(() => {
    const n = DEMO_NODES[Math.floor(Math.random() * DEMO_NODES.length)];
    pushSyntheticBatch(n.slot, strikeWave(n.slot));
  }, 1100);
}

function baseline(slot) {
  // 8 samples, low magnitude ±0.3g, gyro near 0
  return Array.from({length: 8}, () => ({
    ax: (Math.random()-.5)*.6, ay: (Math.random()-.5)*.6, az: 1 + (Math.random()-.5)*.4,
    gx: (Math.random()-.5)*40, gy: (Math.random()-.5)*40, gz: (Math.random()-.5)*40,
  }));
}

function strikeWave(slot) {
  // Build a packet whose peak |a| crosses threshold.
  // hands → moderate g + high gyro; shins → high g + roundhouse gyro
  const isHand = slot === 1 || slot === 2;
  const peakG  = isHand ? (3.5 + Math.random()*7) : (4 + Math.random()*9);
  const peakDps= isHand ? (200 + Math.random()*2000) : (400 + Math.random()*1800);
  return Array.from({length: 8}, (_, i) => {
    const env = Math.exp(-((i-3)**2) / 2); // peak around middle sample
    return {
      ax: env * peakG * (Math.random() < .5 ? 1 : -1),
      ay: env * peakG * .3 * (Math.random() < .5 ? 1 : -1),
      az: env * peakG * .2,
      gx: env * peakDps * (Math.random() < .5 ? 1 : -1) * .5,
      gy: env * peakDps * (Math.random() < .5 ? 1 : -1),
      gz: env * peakDps * .4,
    };
  });
}

function pushSyntheticBatch(slot, samples) {
  ingestBatch({
    slot, rssi: -45 - Math.floor(Math.random()*30),
    mac: null, samples,
    seq: ++_seq, recvMs: Date.now(),
  });
  // increment node packet count
  const node = state.nodes.find(n => n.slot === slot);
  if (node) { node.packetsRx++; node.ageMs = 20; }
}
let _seq = 0;

// API overrides for demo mode (called by main.js)
export const demoApi = {
  status:        async () => state.hostStatus,
  nodes:         async () => state.nodes,
  assignSlot:    async (mac, slot) => {
    const n = state.nodes.find(x => x.mac === mac); if (n) n.slot = Number(slot);
    return { ok: true };
  },
  sessionStart:  async (athlete) => {
    state.hostStatus.session = { active: true, id: String(Date.now()), startedAtMs: 0, durationMs: 0, packets: 0, samples: 0 };
    state.session.active = true; state.session.id = state.hostStatus.session.id;
    state.session.startedAtMs = Date.now();
    return { sessionId: state.session.id, sdLogging: true };
  },
  sessionStop:   async () => {
    state.hostStatus.session.active = false; state.session.active = false; return { ok: true };
  },
  sessions:      async () => state.sessions,
  sessionDelete: async (id) => { state.sessions = state.sessions.filter(s => s.id !== id); return { ok: true }; },
  sessionDownloadUrl: (id) => '#demo-download-' + id,
};
