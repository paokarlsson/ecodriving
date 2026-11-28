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
  learnCoast: true,       // förfina rullmodellen av rullningar under körning
});

export const store = {
  get key() { return get('orsKey'); },
  set key(v) { set('orsKey', v || null); },
  get calibration() { return get('calibration'); },
  set calibration(v) { set('calibration', v); },
  get settings() { return { ...DEFAULT_SETTINGS, ...(get('settings') || {}) }; },
  set settings(v) { set('settings', v); },
  /** Pågående resa, så att den överlever en omladdning: {dest, demo, stage, at}. */
  get lastTrip() { return get('lastTrip'); },
  set lastTrip(v) { set('lastTrip', v); },
  /** De senaste resmålen (högst 5). */
  get recents() { return get('recents', []); },
  set recents(v) { set('recents', (v || []).slice(0, 5)); },
  /** Inlärd gyroaxel {axis: [x, y, z], r2, date}. */
  /** Vald OBD-dosa: {id, name, auto}. */
  get obd() { return get('obd'); },
  set obd(v) { set('obd', v); },
  get gyroAxis() { return get('gyroAxis'); },
  set gyroAxis(v) { set('gyroAxis', v); },
  /** Inlärd framåtaxel för accelerometern (gas/broms) {axis: [x, y, z], r2, date}. */
  /** Fartkurvan i stället för kartan nära ett mål (false = alltid karta). */
  get driveGraph() { return get('driveGraph', true); },
  set driveGraph(v) { set('driveGraph', v); },
  get accAxis() { return get('accAxis'); },
  set accAxis(v) { set('accAxis', v); },
  /** Inlärda rullningar: {car: CoastStats-JSON}. */
  get coastLearn() { return get('coastLearn', {}); },
  set coastLearn(v) { set('coastLearn', v); },
  /** Inlärd gaspedal för att hålla farten och accelerera (gasadvice.js). */
  get pedalModel() { return get('pedalModel'); },
  set pedalModel(v) { set('pedalModel', v); },
  // Bränsleflödet som håller farten, för gasrådet i l/h
  get fuelModel() { return get('fuelModel'); },
  set fuelModel(v) { set('fuelModel', v); },
  // Inlärd höjd per kartruta (OBD-backen och GPS-höjden ihop)
  get elevMap() { return get('elevMap'); },
  set elevMap(v) { set('elevMap', v); },
  get favorites() { return get('favorites', []); },
  set favorites(v) { set('favorites', v); },
  get onboarded() { return get('onboarded', false); },
  set onboarded(v) { set('onboarded', v); },
  get installDismissed() { return get('installDismissed', 0); },
  set installDismissed(v) { set('installDismissed', v); },
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

function evictOsm(fraction = 0.5, prefix = OSM_PREFIX) {
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

/** Cache per kartcell med eget prefix i localStorage. */
function makeCellCache(prefix) {
  return {
    get(key) {
      try {
        const raw = localStorage.getItem(prefix + key);
        if (!raw) return null;
        const v = JSON.parse(raw);
        if (!v || Date.now() - v.t > OSM_TTL) { localStorage.removeItem(prefix + key); return null; }
        return v.els;
      } catch { return null; }
    },
    set(key, els) {
      const data = JSON.stringify({ t: Date.now(), els });
      for (let attempt = 0; attempt < 3; attempt++) {
        try { localStorage.setItem(prefix + key, data); return true; }
        // Fullt: rensa äldsta vägnätet först (störst), sedan vägdata för rutter
        catch { if (!evictOsm(0.5, NET_PREFIX) && !evictOsm()) return false; }
      }
      return false;
    },
  };
}

const NET_PREFIX = P + 'osmnet1.';
/** Vägdata längs rutter (gränser, trafikljus, rondeller). */
export const osmCache = makeCellCache(OSM_PREFIX);
/** Hela vägnätet per cell, för körning utan rutt. */
export const netCache = makeCellCache(NET_PREFIX);
