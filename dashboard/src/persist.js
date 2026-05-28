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
};
