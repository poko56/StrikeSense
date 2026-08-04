// Thin localStorage wrapper with namespacing + JSON safety.
const NS = 'ss:';

export const persist = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(NS + key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(NS + key, JSON.stringify(value)); }
    catch { /* quota or disabled */ }
  },
  del(key) { try { localStorage.removeItem(NS + key); } catch {} },

  /**
   * Drop every StrikeSense key — the browser half of a factory reset. Namespaced
   * so a shared origin (another app on the same host) keeps its own storage.
   * Covers the ad-hoc keys too (calibration, cached AI model), since they all go
   * through this wrapper and inherit the prefix.
   */
  clearAll() {
    try {
      const doomed = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(NS)) doomed.push(k);
      }
      for (const k of doomed) localStorage.removeItem(k);
      return doomed.length;
    } catch { return 0; }
  },
};

export const PERSIST_KEYS = {
  athlete:        'athlete',
  athleteHistory: 'athleteHistory',  // string[]
  tuning:         'tuning',          // { thresholdG, refractoryMs }
  preset:         'preset',          // string
  drill:          'drill',           // string
  goals:          'goals',           // { targetStrikes, targetPeakG, targetSpm }
  theme:          'theme',           // 'dark' | 'light'
  modes:          'modes',           // { bodyHeatmap, stopwatch }
  compare:        'compare',         // string[] session ids
  devMode:        'devMode',         // bool — reveal AI Training Data Logger
  tourSeen:       'tourSeen',        // bool — onboarding tour completed/skipped
  setupDone:      'setupDone',       // bool — local fallback when the rig is unreachable
};
