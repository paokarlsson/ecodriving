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
  aLat: 2.5,           // komfort i kurvor (m/s²)
  giveWayKmh: 20,
  roundaboutKmh: 25,
});

export const store = {
  get key() { return get('orsKey'); },
  set key(v) { set('orsKey', v || null); },
  get calibration() { return get('calibration'); },
  set calibration(v) { set('calibration', v); },
  get settings() { return { ...DEFAULT_SETTINGS, ...(get('settings') || {}) }; },
  set settings(v) { set('settings', v); },
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
