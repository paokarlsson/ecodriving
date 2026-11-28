// Vägen framåt utan rutt: följer vägen bilen är på i OSM-datan en bit framåt
// (samma väg, samma vägnamn, annars rakt fram) och ger en rutt som resten av
// appen kan använda som vanligt. I en korsning där det inte går att gissa
// (T-korsning, två lika raka vägar, rondell) slutar vägen framåt där.
import { makeProjector, headingXY, angleDiff, projectOnSegment } from './geo.js';

export const HORIZON = {
  length: 1500,     // m framåt
  matchDist: 30,    // m: längsta avstånd från bilen till vägen
  matchAngle: 60,   // grader: största skillnad mellan färdriktning och väg
  straight: 45,     // grader: största sväng som räknas som "rakt fram"
  sameName: 100,    // grader: största sväng som följer samma vägnamn
  distinct: 30,     // grader: så mycket rakare måste den rakaste vägen vara
  minSpeed: 1.5,    // m/s: under detta är GPS-kursen opålitlig
};

const key = p => `${p.lat.toFixed(6)},${p.lon.toFixed(6)}`;
const isRoundabout = w => w.tags?.junction === 'roundabout' || w.tags?.junction === 'circular';
const isMinor = w => ['service', 'track'].includes(w.tags?.highway);

/** Får vägen köras i ritriktningen (+1) eller mot den (-1)? */
export function wayAllows(w, dir) {
  const t = w.tags || {};
  const ow = String(t.oneway ?? '').toLowerCase();
  if (ow === '-1' || ow === 'reverse') return dir === -1;
  if (ow === 'yes' || ow === 'true' || ow === '1') return dir === 1;
  if (ow === 'no') return true;
  if (isRoundabout(w) || t.highway === 'motorway') return dir === 1;
  return true;
}

/**
 * Vägnät ur OSM-element: alla vägar med geometri och, för varje punkt,
 * vilka vägar som går genom den (vägar som delar en nod har exakt samma
 * koordinater i Overpass-svaret).
 */
export function buildNetwork(elements, lat0, lon0) {
  const proj = makeProjector(lat0, lon0);
  const ways = [];
  const at = new Map();
  for (const el of elements) {
    if (el.type !== 'way' || !el.tags?.highway || !el.geometry || el.geometry.length < 2) continue;
    const g = el.geometry;
    const w = { el, id: el.id, tags: el.tags, g, xy: g.map(p => proj.toXY(p.lat, p.lon)) };
    ways.push(w);
    g.forEach((p, i) => {
      const k = key(p);
      if (!at.has(k)) at.set(k, []);
      at.get(k).push({ w, i });
    });
  }
  return { proj, ways, at, lat0, lon0 };
}

const segHeading = (w, i, dir) => {
  const a = w.xy[i], b = w.xy[i + dir];
  return headingXY(b[0] - a[0], b[1] - a[1]);
};

/** Vägen bilen är på: närmaste segment som går åt färdriktningen. */
export function matchNetwork(net, lat, lon, heading) {
  if (heading == null || !Number.isFinite(heading)) return null;
  const [px, py] = net.proj.toXY(lat, lon);
  let best = null;
  for (const w of net.ways) {
    for (let i = 0; i < w.xy.length - 1; i++) {
      const [ax, ay] = w.xy[i], [bx, by] = w.xy[i + 1];
      if (Math.min(ax, bx) > px + HORIZON.matchDist || Math.max(ax, bx) < px - HORIZON.matchDist
        || Math.min(ay, by) > py + HORIZON.matchDist || Math.max(ay, by) < py - HORIZON.matchDist) continue;
      const r = projectOnSegment(px, py, ax, ay, bx, by);
      if (r.d > HORIZON.matchDist) continue;
      for (const dir of [1, -1]) {
        if (!wayAllows(w, dir)) continue;
        const h = dir === 1 ? headingXY(bx - ax, by - ay) : headingXY(ax - bx, ay - by);
        const diff = angleDiff(h, heading);
        if (diff > HORIZON.matchAngle) continue;
        // Avstånd väger tyngst; riktningen skiljer parallella vägar och körfält åt
        const cost = r.d + diff * 0.3 + (isMinor(w) ? 8 : 0);
        if (!best || cost < best.cost) best = { cost, w, i, dir, t: r.t, x: r.x, y: r.y, dist: r.d };
      }
    }
  }
  return best;
}

/**
 * Väljer fortsättning i en punkt. inH = kursen in i punkten. Ger {w, i, dir}
 * eller {stop: orsak}.
 */
function chooseNext(net, cur, j, inH) {
  const p = cur.w.g[j];
  const opts = [];
  for (const { w, i } of net.at.get(key(p)) || []) {
    for (const dir of [1, -1]) {
      const n = i + dir;
      if (n < 0 || n >= w.g.length) continue;
      if (w === cur.w && dir === -cur.dir) continue;     // tillbaka samma väg
      if (!wayAllows(w, dir)) continue;
      opts.push({ w, i, dir, turn: angleDiff(segHeading(w, i, dir), inH) });
    }
  }
  if (!opts.length) return { stop: 'deadend' };
  // In- och utfarter, parkeringar och skogsvägar räknas inte som val
  const main = isMinor(cur.w) ? opts : opts.filter(o => !isMinor(o.w));
  const cand = main.length ? main : opts;
  if (cand.some(o => isRoundabout(o.w)) && !isRoundabout(cur.w)) return { stop: 'roundabout', next: cand.find(o => isRoundabout(o.w)) };
  if (cand.length === 1 && cand[0].turn < 135) return cand[0];
  const same = cand.find(o => o.w === cur.w);
  if (same && same.turn <= HORIZON.straight) return same;
  const name = cur.w.tags?.name;
  const named = name ? cand.filter(o => o.w.tags?.name === name && o.turn <= HORIZON.sameName) : [];
  if (named.length === 1) return named[0];
  const sorted = cand.slice().sort((a, b) => a.turn - b.turn);
  const [a, b] = sorted;
  if (a.turn > HORIZON.straight) return { stop: 'junction' };
  if (b && b.turn - a.turn < HORIZON.distinct) return { stop: 'junction' };
  return a;
}

/**
 * Vägen framåt från bilens läge. Ger {coords: [[lon, lat], …], length,
 * reason ('length' | 'junction' | 'roundabout' | 'deadend' | 'loop'), wayId,
 * name, dist} eller null om bilen inte är på någon känd väg.
 */
export function buildHorizon(net, lat, lon, heading, { length = HORIZON.length } = {}) {
  const m = matchNetwork(net, lat, lon, heading);
  if (!m) return null;
  const toLL = (x, y) => { const [la, lo] = net.proj.toLL(x, y); return [lo, la]; };
  const coords = [toLL(m.x, m.y)];
  let total = 0, px = m.x, py = m.y;
  let cur = { w: m.w, dir: m.dir };
  let j = m.dir === 1 ? m.i + 1 : m.i;          // nästa punkt på vägen
  const seen = new Set();
  let reason = 'length';
  const push = (x, y) => { total += Math.hypot(x - px, y - py); px = x; py = y; coords.push(toLL(x, y)); };
  for (let guard = 0; guard < 5000; guard++) {
    const [x, y] = cur.w.xy[j];
    const d = Math.hypot(x - px, y - py);
    if (total + d >= length) {
      const f = (length - total) / d;
      push(px + (x - px) * f, py + (y - py) * f);
      break;
    }
    push(x, y);
    const k = key(cur.w.g[j]);
    if (seen.has(k)) { reason = 'loop'; break; }
    seen.add(k);
    const inH = segHeading(cur.w, j - cur.dir, cur.dir);
    const nx = chooseNext(net, { w: cur.w, dir: cur.dir }, j, inH);
    if (nx.stop) {
      reason = nx.stop;
      // In i rondellen en bit, så att infarten kommer med som mål
      if (nx.stop === 'roundabout' && nx.next) {
        const [rx, ry] = nx.next.w.xy[nx.next.i + nx.next.dir];
        const d = Math.hypot(rx - x, ry - y);
        const f = Math.min(1, 15 / Math.max(1, d));
        push(x + (rx - x) * f, y + (ry - y) * f);
      }
      break;
    }
    cur = { w: nx.w, dir: nx.dir };
    j = nx.i + nx.dir;
  }
  if (coords.length < 2 || total < 1) return null;
  return { coords, length: total, reason, wayId: m.w.id, name: m.w.tags?.name || null, dist: m.dist };
}
