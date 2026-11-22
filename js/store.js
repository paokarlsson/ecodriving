// Lokal lagring i telefonens webbläsare. Allt är frivilligt: om lagringen
// är blockerad fungerar appen ändå, men inget sparas.
const P = 'bromsfri.';

function get(k, fallback = null) {
  try {
    const v = localStorage.getItem(P + k);
    return v == null ? fallback : JSON.parse(v);
  } catch { return fallback; }
}
function set(k, v) {
  try {
    if (v == null) localStorage.removeItem(P + k);
    else localStorage.setItem(P + k, JSON.stringify(v));
    return true;
  } catch { return false; }
}

export const DEFAULT_SETTINGS = Object.freeze({
  marginS: 1.5,        // reaktionsmarginal (s)
  voice: true,         // röst eller bara ton
  aLat: 2.45,          // sidokraft i kurvor (m/s²), 0,25 g
  giveWayKmh: 20,
  roundaboutKmh: 25,
  trailer: false,      // släpvagnsläge
  trailerMaxKmh: 80,
  trailerALat: 1.77,   // 0,18 g
  learnCurves: true,      // låt svar om kurvkraft justera sidokraften
  askCurvesInDrive: true, // fråga direkt efter kurvan (annars i sammanfattningen)
});

export const store = {
  get key() { return get('orsKey'); },
  set key(v) { set('orsKey', v || null); },
  get calibration() { return get('calibration'); },
  set calibration(v) { set('calibration', v); },
  get settings() { return { ...DEFAULT_SETTINGS, ...(get('settings') || {}) }; },
  set settings(v) { set('settings', v); },
  get calibrationTrailer() { return get('calibrationTrailer'); },
  set calibrationTrailer(v) { set('calibrationTrailer', v); },
  /** Antal svar som justerat sidokraften: {car, trailer}. */
  get curveLearn() { return get('curveLearn', { car: 0, trailer: 0 }); },
  set curveLearn(v) { set('curveLearn', v); },
  /** De senaste svaren om kurvkraft (högst 200). */
  get curveAnswers() { return get('curveAnswers', []); },
  set curveAnswers(v) { set('curveAnswers', (v || []).slice(-200)); },
  /** Pågående resa, så att den överlever en omladdning: {dest, demo, stage, at}. */
  get lastTrip() { return get('lastTrip'); },
  set lastTrip(v) { set('lastTrip', v); },
  /** De senaste resmålen (högst 5). */
  get recents() { return get('recents', []); },
  set recents(v) { set('recents', (v || []).slice(0, 5)); },
  get favorites() { return get('favorites', []); },
  set favorites(v) { set('favorites', v); },
  get onboarded() { return get('onboarded', false); },
  set onboarded(v) { set('onboarded', v); },
  get safetyAck() { return get('safetyAck', false); },
  set safetyAck(v) { set('safetyAck', v); },
  get keySkipped() { return get('keySkipped', false); },
  set keySkipped(v) { set('keySkipped', v); },
};

export function maskKey(k) {
  if (!k) return '';
  if (k.length <= 8) return '••••';
  return k.slice(0, 4) + '••••••' + k.slice(-4);
}

// Vägdata per kartcell, så att samma område inte hämtas igen.
// OSM ändras sällan; 30 dagar räcker. Blir lagringen full rensas de äldsta.
const OSM_PREFIX = P + 'osm2.';
// Rensa vägdata från äldre versioner (saknade riktnings- och zontaggar).
try {
  Object.keys(localStorage).filter(k => k.startsWith(P + 'osm.')).forEach(k => localStorage.removeItem(k));
} catch { /* blockerad lagring */ }
const OSM_TTL = 30 * 24 * 3600 * 1000;

function evictOsm(fraction = 0.5) {
  try {
    const entries = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(OSM_PREFIX)) {
        let t = 0;
        try { t = JSON.parse(localStorage.getItem(k)).t || 0; } catch { /* trasig post */ }
        entries.push([k, t]);
      }
    }
    entries.sort((a, b) => a[1] - b[1]);
    entries.slice(0, Math.max(1, Math.ceil(entries.length * fraction))).forEach(([k]) => localStorage.removeItem(k));
    return entries.length > 0;
  } catch { return false; }
}

export const osmCache = {
  get(key) {
    try {
      const raw = localStorage.getItem(OSM_PREFIX + key);
      if (!raw) return null;
      const v = JSON.parse(raw);
      if (!v || Date.now() - v.t > OSM_TTL) { localStorage.removeItem(OSM_PREFIX + key); return null; }
      return v.els;
    } catch { return null; }
  },
  set(key, els) {
    const data = JSON.stringify({ t: Date.now(), els });
    for (let attempt = 0; attempt < 3; attempt++) {
      try { localStorage.setItem(OSM_PREFIX + key, data); return true; }
      catch { if (!evictOsm()) return false; }
    }
    return false;
  },
};
