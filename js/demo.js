// Syntetisk demo-rutt med OSM-liknande data, för test utan nyckel och utan bil.
import { makeProjector } from './geo.js';

/**
 * Ca 4 km: rakt 70-väg med trafikljus, högerkurva, 50-sträcka med rondell,
 * nedförsbacke och sänkt gräns före målet.
 */
export function demoData(lat0 = 57.700, lon0 = 11.970) {
  const proj = makeProjector(lat0, lon0);
  const xy = [];
  const ele = [];
  let h = 20;
  // 1) Norrut 1400 m, plant
  for (let y = 0; y <= 1400; y += 20) { xy.push([0, y]); ele.push(h); }
  // 2) Högerkurva, radie 35 m (90°): cirkel med centrum (R, 1400), vinkel 180° → 90°
  const R = 35, cx = R, cy = 1400;
  const arc = [];
  for (let a = 170; a >= 90; a -= 10) {
    const r = a * Math.PI / 180;
    arc.push([cx + R * Math.cos(r), cy + R * Math.sin(r)]);
  }
  for (const p of arc) { xy.push(p); ele.push(h); }
  // 3) Österut 2400 m: plant till 900 m, sedan nedför 4 % i 600 m, sedan plant
  const x0 = xy[xy.length - 1][0], y0 = xy[xy.length - 1][1];
  for (let d = 20; d <= 2400; d += 20) {
    if (d > 900 && d <= 1500) h -= 0.04 * 20;
    xy.push([x0 + d, y0]);
    ele.push(h);
  }
  const coords = xy.map(([x, y], i) => { const [la, lo] = proj.toLL(x, y); return [lo, la, ele[i]]; });

  const ll = (x, y) => { const [lat, lon] = proj.toLL(x, y); return { lat, lon }; };
  const geom = pts => pts.map(([x, y]) => ll(x, y));
  const eastStart = [x0, y0];
  const elements = [
    { type: 'way', id: 1, tags: { highway: 'secondary', maxspeed: '70' }, geometry: geom([[0, 0], [0, 1300]]) },
    { type: 'way', id: 2, tags: { highway: 'secondary', maxspeed: '50' }, geometry: geom([[0, 1300], [0, 1400], ...arc, [eastStart[0] + 800, eastStart[1]]]) },
    { type: 'way', id: 3, tags: { highway: 'secondary', maxspeed: '70' }, geometry: geom([[eastStart[0] + 800, eastStart[1]], [eastStart[0] + 1800, eastStart[1]]]) },
    { type: 'way', id: 4, tags: { highway: 'secondary', maxspeed: '40' }, geometry: geom([[eastStart[0] + 1800, eastStart[1]], [eastStart[0] + 2400, eastStart[1]]]) },
    // korsande väg med annan gräns, ska ignoreras
    { type: 'way', id: 5, tags: { highway: 'residential', maxspeed: '30' }, geometry: geom([[-300, 900], [300, 900]]) },
    { type: 'node', id: 10, tags: { highway: 'traffic_signals' }, ...ll(0, 900) },
    { type: 'node', id: 11, tags: { highway: 'traffic_signals' }, ...ll(3, 915) },
    { type: 'node', id: 12, tags: { highway: 'mini_roundabout' }, ...ll(eastStart[0] + 500, eastStart[1]) },
    { type: 'node', id: 13, tags: { highway: 'give_way' }, ...ll(eastStart[0] + 1300, eastStart[1]) },
  ];
  return { coords, elements, name: 'Demorutt (simulerad)' };
}
