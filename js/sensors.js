// Telefonens sensorer: GPS, rörelse (accelerometer/gyro), kompass och skärmlås.

export const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export function needsMotionPermission() {
  return typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function';
}

/** Måste anropas från en knapptryckning på iOS. */
export async function requestMotionPermission() {
  const res = { motion: 'granted', orientation: 'granted' };
  try {
    if (needsMotionPermission()) res.motion = await DeviceMotionEvent.requestPermission();
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      res.orientation = await DeviceOrientationEvent.requestPermission();
    }
  } catch (e) {
    res.motion = res.motion === 'granted' ? 'granted' : 'denied';
    res.error = e.message;
  }
  return res;
}

export function requestLocationOnce() {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) return reject(new Error('Platstjänster saknas i webbläsaren'));
    navigator.geolocation.getCurrentPosition(
      p => resolve(toObs(p)),
      e => reject(new Error(e.code === 1 ? 'Platsbehörighet nekades' : 'Kunde inte hämta position')),
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 10000 },
    );
  });
}

function toObs(p) {
  const c = p.coords;
  return {
    t: p.timestamp / 1000,
    lat: c.latitude, lon: c.longitude,
    alt: c.altitude, accuracy: c.accuracy,
    speed: c.speed != null && Number.isFinite(c.speed) ? c.speed : null,
    heading: c.heading != null && Number.isFinite(c.heading) ? c.heading : null,
  };
}

export function watchGps(onObs, onError = () => {}) {
  if (!('geolocation' in navigator)) { onError(new Error('Platstjänster saknas')); return () => {}; }
  const id = navigator.geolocation.watchPosition(
    p => onObs(toObs(p)),
    e => onError(new Error(e.code === 1 ? 'Platsbehörighet nekades' : 'GPS-fel: ' + e.message)),
    { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 },
  );
  return () => navigator.geolocation.clearWatch(id);
}

/** Linjär acceleration utan tyngdkraft (m/s²) och rotationshastighet. */
export function watchMotion(onMotion) {
  const h = e => {
    const a = e.acceleration;
    const r = e.rotationRate;
    if (!a || a.x == null) return;
    onMotion({ t: Date.now() / 1000, ax: a.x, ay: a.y, az: a.z, rot: r ? { a: r.alpha, b: r.beta, g: r.gamma } : null });
  };
  window.addEventListener('devicemotion', h);
  return () => window.removeEventListener('devicemotion', h);
}

/** Kompasskurs i grader (0 = norr). */
export function watchCompass(onHeading) {
  const iosH = e => { if (e.webkitCompassHeading != null) onHeading(e.webkitCompassHeading); };
  const absH = e => { if (e.absolute && e.alpha != null) onHeading((360 - e.alpha) % 360); };
  if (isIOS) window.addEventListener('deviceorientation', iosH);
  else window.addEventListener('deviceorientationabsolute', absH);
  return () => {
    window.removeEventListener('deviceorientation', iosH);
    window.removeEventListener('deviceorientationabsolute', absH);
  };
}

/** Håller skärmen vaken. Skaffar nytt lås när sidan blir synlig igen. */
export function keepAwake() {
  let lock = null, active = true;
  const acquire = async () => {
    try { if ('wakeLock' in navigator && active && document.visibilityState === 'visible') lock = await navigator.wakeLock.request('screen'); }
    catch { /* stöds inte eller nekat */ }
  };
  const onVis = () => { if (document.visibilityState === 'visible') acquire(); };
  document.addEventListener('visibilitychange', onVis);
  acquire();
  return () => {
    active = false;
    document.removeEventListener('visibilitychange', onVis);
    try { lock && lock.release(); } catch { /* redan släppt */ }
  };
}
