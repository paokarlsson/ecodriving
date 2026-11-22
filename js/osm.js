// OSM-data längs rutten via Overpass, och omvandling till fartmål.
import { projectOnSegment, headingXY, angleDiff } from './geo.js';
import { matchToRoute, curveTargets } from './route.js';

export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

/** Tolkar OSM:s maxspeed-tagg till km/h. */
export function parseMaxspeed(v) {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  const zones = {
    'se:urban': 50, 'se:rural': 70, 'se:motorway': 110, 'se:trunk': 90,
    'no:urban': 50, 'no:rural': 80, 'no:motorway': 110,
    'dk:urban': 50, 'dk:rural': 80, 'dk:motorway': 130,
    'fi:urban': 50, 'fi:rural': 80, 'fi:motorway': 120,
    'de:urban': 50, 'de:rural': 100, 'de:living_street': 7,
    'walk': 7, 'living_street': 7,
  };
  if (zones[s] != null) return zones[s];
  if (s.includes(';')) {
    const parts = s.split(';').map(parseMaxspeed).filter(x => x != null);
    return parts.length ? Math.min(...parts) : null;
  }
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(mph|km\/h|kmh)?$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return m[2] === 'mph' ? Math.round(n * 1.609) : n;
}

/** Punkter längs rutten (lat, lon) med ungefär jämnt avstånd, för Overpass around-filtret. */
export function corridorPoints(route, spacing = 80) {
  const out = [];
  const every = Math.max(1, Math.round(spacing / route.step));
  for (let i = 0; i < route.n; i += every) {
    const [lat, lon] = route.proj.toLL(route.X[i], route.Y[i]);
    out.push([lat, lon]);
  }
  const [lat, lon] = route.proj.toLL(route.X[route.n - 1], route.Y[route.n - 1]);
  out.push([lat, lon]);
  return out;
}

export function overpassQuery(points) {
  const ll = points.map(([a, b]) => `${a.toFixed(6)},${b.toFixed(6)}`).join(',');
  return `[out:json][timeout:90];
(
  way(around:20,${ll})[highway][maxspeed];
  way(around:20,${ll})[junction=roundabout];
  node(around:12,${ll})[highway~"^(traffic_signals|stop|give_way|mini_roundabout)$"];
);
out geom;`;
}

/** Hämtar OSM-element längs rutten. Långa rutter delas upp i bitar. */
export async function fetchOsmAlongRoute(route, { fetchImpl = fetch, signal } = {}) {
  const pts = corridorPoints(route);
  const chunk = 250;
  const elements = new Map();
  for (let i = 0; i < pts.length; i += chunk - 1) {
    const part = pts.slice(i, i + chunk);
    if (part.length < 2) break;
    const q = overpassQuery(part);
    let lastErr;
    let ok = false;
    for (const ep of OVERPASS_ENDPOINTS) {
      try {
        const res = await fetchImpl(ep, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'data=' + encodeURIComponent(q),
          signal,
        });
        if (!res.ok) throw new Error(`Overpass svarade ${res.status}`);
        const json = await res.json();
        for (const el of json.elements || []) elements.set(el.type + el.id, el);
        ok = true;
        break;
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        lastErr = e;
      }
    }
    if (!ok) throw lastErr || new Error('Overpass gick inte att nå');
  }
  return [...elements.values()];
}

/** Rumsligt rutnät över vägsegment för snabb närmaste-sökning. */
function segmentGrid(route, ways, cell = 50) {
  const grid = new Map();
  const key = (cx, cy) => cx + ',' + cy;
  for (const w of ways) {
    const g = (w.geometry || []).map(p => route.proj.toXY(p.lat, p.lon));
    for (let k = 0; k < g.length - 1; k++) {
      const [ax, ay] = g[k], [bx, by] = g[k + 1];
      const seg = { w, ax, ay, bx, by, h: headingXY(bx - ax, by - ay) };
      const x0 = Math.floor(Math.min(ax, bx) / cell), x1 = Math.floor(Math.max(ax, bx) / cell);
      const y0 = Math.floor(Math.min(ay, by) / cell), y1 = Math.floor(Math.max(ay, by) / cell);
      for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) {
        const kk = key(cx, cy);
        if (!grid.has(kk)) grid.set(kk, []);
        grid.get(kk).push(seg);
      }
    }
  }
  return {
    near(x, y) {
      const cx = Math.floor(x / cell), cy = Math.floor(y / cell);
      const out = [];
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const l = grid.get(key(cx + dx, cy + dy));
        if (l) out.push(...l);
      }
      return out;
    },
  };
}

/**
 * Hastighetsgräns (km/h) per sampel. Bara vägar som går parallellt med
 * rutten räknas, så att korsande vägar inte påverkar. Luckor fylls med
 * föregående värde och korta avvikelser (< 40 m) tas bort.
 */
export function assignLimits(route, elements) {
  const ways = elements.filter(e => e.type === 'way' && e.tags && e.tags.maxspeed && parseMaxspeed(e.tags.maxspeed) != null);
  const grid = segmentGrid(route, ways);
  const L = new Array(route.n).fill(null);
  for (let i = 0; i < route.n; i++) {
    let best = null;
    for (const seg of grid.near(route.X[i], route.Y[i])) {
      if (angleDiff(seg.h, route.H[i]) > 35 && angleDiff(seg.h, route.H[i]) < 145) continue;
      const r = projectOnSegment(route.X[i], route.Y[i], seg.ax, seg.ay, seg.bx, seg.by);
      if (r.d < 15 && (!best || r.d < best.d)) best = { d: r.d, w: seg.w };
    }
    if (best) {
      const t = best.w.tags;
      // Riktningsspecifika gränser om de finns.
      L[i] = parseMaxspeed(t.maxspeed);
    }
  }
  return smoothLimits(fillGaps(L), Math.round(40 / route.step));
}

function fillGaps(L) {
  const out = L.slice();
  let last = null;
  for (let i = 0; i < out.length; i++) { if (out[i] == null) out[i] = last; else last = out[i]; }
  const first = out.find(x => x != null) ?? null;
  for (let i = 0; i < out.length && out[i] == null; i++) out[i] = first;
  return out;
}

function smoothLimits(L, minRun) {
  const out = L.slice();
  let i = 0;
  while (i < out.length) {
    let j = i;
    while (j < out.length && out[j] === out[i]) j++;
    if (j - i < minRun && i > 0 && j < out.length) {
      for (let k = i; k < j; k++) out[k] = out[i - 1];
    }
    i = j;
  }
  return out;
}

/** Infarter i rondeller längs rutten (sträcka s). */
export function roundaboutEntries(route, elements) {
  const ways = elements.filter(e => e.type === 'way' && e.tags && (e.tags.junction === 'roundabout' || e.tags.junction === 'circular'));
  if (!ways.length) return [];
  const grid = segmentGrid(route, ways);
  const out = [];
  let inside = false;
  for (let i = 0; i < route.n; i++) {
    let hit = false;
    for (const seg of grid.near(route.X[i], route.Y[i])) {
      if (projectOnSegment(route.X[i], route.Y[i], seg.ax, seg.ay, seg.bx, seg.by).d < 8) { hit = true; break; }
    }
    if (hit && !inside) out.push(Math.max(0, route.S[i] - 5));
    inside = hit;
  }
  return out;
}

const KIND_LABEL = {
  traffic_signals: 'trafikljus', stop: 'stopplikt', give_way: 'väjningsplikt',
  roundabout: 'rondell', curve: 'kurva', limit: 'sänkt gräns', end: 'målet',
};
export const kindLabel = k => KIND_LABEL[k] || k;

/**
 * Bygger den sorterade listan med fartmål {s (m), v (m/s), kind, label}.
 * settings: { aLat (m/s²), giveWayKmh, roundaboutKmh }
 */
export function buildTargets(route, elements, limits, settings) {
  const giveWay = (settings.giveWayKmh ?? 20) / 3.6;
  const rb = (settings.roundaboutKmh ?? 25) / 3.6;
  const t = [];

  for (const el of elements) {
    if (el.type !== 'node' || !el.tags) continue;
    const kind = el.tags.highway;
    const m = matchToRoute(route, el.lat, el.lon);
    if (!m || m.dist > 10) continue;
    if (kind === 'traffic_signals' || kind === 'stop') t.push({ s: m.s, v: 0, kind });
    else if (kind === 'give_way') t.push({ s: m.s, v: giveWay, kind });
    else if (kind === 'mini_roundabout') t.push({ s: m.s, v: rb, kind: 'roundabout' });
  }
  for (const s of roundaboutEntries(route, elements)) t.push({ s, v: rb, kind: 'roundabout' });

  if (limits) {
    for (let i = 1; i < route.n; i++) {
      if (limits[i] != null && limits[i - 1] != null && limits[i] < limits[i - 1]) {
        t.push({ s: route.S[i], v: limits[i] / 3.6, kind: 'limit', kmh: limits[i] });
      }
    }
  }
  t.push(...curveTargets(route, settings.aLat ?? 2.5, { limits }));
  t.push({ s: route.length, v: 0, kind: 'end' });
  return mergeTargets(t.filter(x => x.s > 40 || x.kind === 'end'));
}

/**
 * Slår ihop mål som ligger inom 40 m från varandra (t.ex. flera
 * trafikljus i samma korsning): tidigaste läget och lägsta farten gäller.
 */
export function mergeTargets(list, within = 40) {
  const sorted = list.slice().sort((a, b) => a.s - b.s);
  const out = [];
  for (const x of sorted) {
    const last = out[out.length - 1];
    if (last && x.s - last.s < within) {
      if (x.v < last.v) { last.v = x.v; last.kind = x.kind; last.kmh = x.kmh; }
    } else out.push({ ...x });
  }
  out.forEach((x, i) => { x.id = i; x.label = kindLabel(x.kind); });
  return out;
}

export function countKinds(targets) {
  const c = {};
  for (const t of targets) if (t.kind !== 'end') c[t.kind] = (c[t.kind] || 0) + 1;
  return c;
}
