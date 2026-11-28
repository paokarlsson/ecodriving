// OSM-data längs rutten via Overpass, och omvandling till fartmål.
import { projectOnSegment, headingXY, angleDiff } from './geo.js';
import { matchToRoute, curveTargets } from './route.js';

export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Avbruten', 'AbortError')); }, { once: true });
});

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
  // Zoner som "SE:zone30" eller "DE:zone:30"
  const z = s.match(/^[a-z]{2}:zone:?(\d+)$/);
  if (z) return parseFloat(z[1]);
  if (s.includes(';')) {
    const parts = s.split(';').map(parseMaxspeed).filter(x => x != null);
    return parts.length ? Math.min(...parts) : null;
  }
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(mph|km\/h|kmh)?$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return m[2] === 'mph' ? Math.round(n * 1.609) : n;
}

/** Taggar som kan ge en hastighetsgräns, i prioritetsordning efter riktningen. */
const LIMIT_TAGS = ['maxspeed', 'maxspeed:type', 'zone:maxspeed', 'source:maxspeed'];

/**
 * Gräns (km/h) för en väg i färdriktningen. forward = rutten följer vägens
 * ritriktning. Riktningsbundna taggar går före maxspeed, som går före zon.
 */
export function wayLimit(tags, forward = true) {
  if (!tags) return null;
  const dir = parseMaxspeed(tags[forward ? 'maxspeed:forward' : 'maxspeed:backward']);
  if (dir != null) return dir;
  for (const k of LIMIT_TAGS) {
    const v = parseMaxspeed(tags[k]);
    if (v != null) return v;
  }
  return null;
}

// Vägdata hämtas i små rutor (celler) längs rutten i stället för med
// Overpass "around" längs en lång linje, som är mycket långsammare. Cellerna
// har fasta gränser, så samma område kan sparas i telefonen och återanvändas.
export const CELL_LAT = 0.005;   // ca 555 m
export const CELL_LON = 0.008;   // ca 470–600 m i Sverige
const DRIVABLE = 'motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|road|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link';

const cellKey = (i, j) => `${i}_${j}`;
export function cellBounds(key) {
  const [i, j] = key.split('_').map(Number);
  return { s: i * CELL_LAT, w: j * CELL_LON, n: (i + 1) * CELL_LAT, e: (j + 1) * CELL_LON };
}

/** Cellerna som rutten (med marginal pad meter) passerar, i ruttens ordning. */
export function routeCells(route, pad = 40) {
  return routeCellsAt(route, pad).map(c => c.key);
}

/** Som routeCells, men med sträckan s (m) där rutten först når varje cell. */
export function routeCellsAt(route, pad = 40) {
  const seen = new Set();
  const out = [];
  const dLat = pad / 111320;
  for (let k = 0; k < route.n; k++) {
    const [lat, lon] = route.proj.toLL(route.X[k], route.Y[k]);
    const dLon = dLat / Math.max(0.2, Math.cos(lat * Math.PI / 180));
    const i0 = Math.floor((lat - dLat) / CELL_LAT), i1 = Math.floor((lat + dLat) / CELL_LAT);
    const j0 = Math.floor((lon - dLon) / CELL_LON), j1 = Math.floor((lon + dLon) / CELL_LON);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const key = cellKey(i, j);
      if (!seen.has(key)) { seen.add(key); out.push({ key, s: route.S[k] }); }
    }
  }
  return out;
}

export function overpassQuery(cells) {
  const parts = [];
  for (const key of cells) {
    const b = cellBounds(key);
    const bb = `${b.s.toFixed(4)},${b.w.toFixed(4)},${b.n.toFixed(4)},${b.e.toFixed(4)}`;
    parts.push(
      `way[highway~"^(${DRIVABLE})$"][~"^(maxspeed|maxspeed:forward|maxspeed:backward|maxspeed:type|zone:maxspeed|source:maxspeed)$"~"."](${bb});`,
      `way[junction~"^(roundabout|circular)$"](${bb});`,
      `node[highway~"^(traffic_signals|stop|give_way|mini_roundabout)$"](${bb});`,
    );
  }
  return `[out:json][timeout:60];\n(\n${parts.join('\n')}\n);\nout geom qt;`;
}

/**
 * Hela vägnätet i cellerna (alla körbara vägar, med eller utan gräns), för
 * körning utan rutt där appen själv följer vägen framåt.
 */
export function networkQuery(cells) {
  const parts = [];
  for (const key of cells) {
    const b = cellBounds(key);
    const bb = `${b.s.toFixed(4)},${b.w.toFixed(4)},${b.n.toFixed(4)},${b.e.toFixed(4)}`;
    parts.push(
      `way[highway~"^(${DRIVABLE})$"](${bb});`,
      `node[highway~"^(traffic_signals|stop|give_way|mini_roundabout)$"](${bb});`,
    );
  }
  return `[out:json][timeout:60];\n(\n${parts.join('\n')}\n);\nout geom qt;`;
}

/** Cellerna inom radius meter från en punkt, närmast först. */
export function cellsAround(lat, lon, radius) {
  const dLat = radius / 111320;
  const dLon = dLat / Math.max(0.2, Math.cos(lat * Math.PI / 180));
  const i0 = Math.floor((lat - dLat) / CELL_LAT), i1 = Math.floor((lat + dLat) / CELL_LAT);
  const j0 = Math.floor((lon - dLon) / CELL_LON), j1 = Math.floor((lon + dLon) / CELL_LON);
  const out = [];
  for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
    const b = cellBounds(cellKey(i, j));
    const d = Math.hypot(((b.s + b.n) / 2 - lat) / CELL_LAT, ((b.w + b.e) / 2 - lon) / CELL_LON);
    out.push({ key: cellKey(i, j), d });
  }
  return out.sort((a, b) => a.d - b.d).map(c => c.key);
}

/**
 * Hämtar vägnätet för cellerna (från cachen om de finns där). Ger
 * {elements, fetched: [nycklar], failed: [nycklar], error}.
 */
export async function fetchOsmNetwork(keys, { fetchImpl = fetch, signal, cache = null, firstRequest = 4, cellsPerRequest = 12, timeoutMs = 25000, hedgeMs = 4000, waits = [0, 3000] } = {}) {
  const elements = new Map();
  const missing = [];
  for (const k of keys) {
    const hit = cache && cache.get(k);
    if (hit) for (const el of hit) elements.set(el.type + el.id, el);
    else missing.push(k);
  }
  const fetched = [], failed = [];
  let error = null;
  // De närmaste cellerna först i ett litet anrop, så att vägen framåt kommer fort
  const batches = [missing.slice(0, firstRequest)];
  for (let b = firstRequest; b < missing.length; b += cellsPerRequest) batches.push(missing.slice(b, b + cellsPerRequest));
  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    if (!batch.length) continue;
    try {
      const json = await overpassFetch(networkQuery(batch), { fetchImpl, signal, timeoutMs, hedgeMs, waits, first: b });
      const wanted = new Set(batch);
      const perCell = new Map(batch.map(k => [k, []]));
      for (const raw of json.elements || []) {
        const el = compactElement(raw);
        elements.set(el.type + el.id, el);
        for (const k of cellsOfElement(el, wanted)) perCell.get(k).push(el);
      }
      if (cache) for (const [k, els] of perCell) cache.set(k, els);
      fetched.push(...batch);
    } catch (e) {
      if (signal?.aborted) throw e;
      failed.push(...batch);
      error = e.message;
    }
  }
  return { elements: [...elements.values()], fetched, failed, error };
}

/** Behåller bara det appen använder, så att svaret blir litet att spara. */
export function compactElement(el) {
  const r6 = x => Math.round(x * 1e6) / 1e6;
  if (el.type === 'node') {
    return { type: 'node', id: el.id, lat: r6(el.lat), lon: r6(el.lon), tags: { highway: el.tags?.highway } };
  }
  const tags = {};
  for (const k of ['maxspeed', 'maxspeed:forward', 'maxspeed:backward', ...LIMIT_TAGS.slice(1)]) {
    if (el.tags?.[k]) tags[k] = el.tags[k];
  }
  for (const k of ['junction', 'highway', 'oneway', 'name', 'ref']) if (el.tags?.[k]) tags[k] = el.tags[k];
  return { type: 'way', id: el.id, tags, geometry: (el.geometry || []).filter(Boolean).map(p => ({ lat: r6(p.lat), lon: r6(p.lon) })) };
}

/** Cellerna (bland de efterfrågade) som ett element berör. */
function cellsOfElement(el, wanted) {
  const out = new Set();
  const add = (i, j) => { const k = cellKey(i, j); if (wanted.has(k)) out.add(k); };
  if (el.type === 'node') { add(Math.floor(el.lat / CELL_LAT), Math.floor(el.lon / CELL_LON)); return out; }
  const g = el.geometry || [];
  for (let k = 0; k < g.length; k++) {
    const a = g[k], b = g[Math.min(g.length - 1, k + 1)];
    const i0 = Math.floor(Math.min(a.lat, b.lat) / CELL_LAT), i1 = Math.floor(Math.max(a.lat, b.lat) / CELL_LAT);
    const j0 = Math.floor(Math.min(a.lon, b.lon) / CELL_LON), j1 = Math.floor(Math.max(a.lon, b.lon) / CELL_LON);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) add(i, j);
  }
  return out;
}

/**
 * Ett anrop till Overpass. Servrarna är gratis och delade: "för många anrop"
 * (429), överbelastning (502–504) och timeout är vanliga. Varje omgång frågar
 * servrarna parallellt med försprång (se overpassRound); upp till tre omgångar
 * med väntan emellan.
 */
async function overpassFetch(query, { fetchImpl, signal, timeoutMs, hedgeMs, first = 0, waits = [0, 3000, 8000] }) {
  let lastErr;
  for (const wait of waits) {
    if (wait) await sleep(wait, signal);
    try {
      return await overpassRound(query, { fetchImpl, signal, timeoutMs, hedgeMs, first });
    } catch (e) {
      if (signal?.aborted) throw e;
      lastErr = e;
    }
  }
  throw lastErr;
}

/**
 * En omgång: frågar först servern med index first. Har den inte svarat inom
 * hedgeMs, eller svarar den med fel, skickas samma fråga också till nästa
 * server. Första giltiga svaret vinner och de andra anropen avbryts. Så kostar
 * en server som hänger några sekunder i stället för hela timeouten.
 */
function overpassRound(query, { fetchImpl, signal, timeoutMs, hedgeMs = 5000, first = 0 }) {
  const eps = OVERPASS_ENDPOINTS.map((_, k) => OVERPASS_ENDPOINTS[(first + k) % OVERPASS_ENDPOINTS.length]);
  return new Promise((resolve, reject) => {
    const ctrls = [];
    let started = 0, failed = 0, settled = false, lastErr = null, hedgeTimer = null;
    const finish = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(hedgeTimer);
      signal?.removeEventListener('abort', onAbort);
      for (const c of ctrls) c.abort();
      fn(v);
    };
    const onAbort = () => finish(reject, new DOMException('Avbruten', 'AbortError'));
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort);

    const startNext = () => {
      clearTimeout(hedgeTimer);
      if (settled || started >= eps.length) return;
      const ep = eps[started++];
      if (started < eps.length) hedgeTimer = setTimeout(startNext, hedgeMs);
      const ctrl = new AbortController();
      ctrls.push(ctrl);
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      (async () => {
        const res = await fetchImpl(ep, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'data=' + encodeURIComponent(query),
          signal: ctrl.signal,
        });
        if (!res.ok) throw new Error(`Overpass svarade ${res.status}`);
        const json = await res.json();
        // Overpass kan svara 200 med tom lista och en felnotering (t.ex. timeout).
        // Ett sådant svar får inte sparas som "inga vägar här".
        if (json.remark && /error|timed out|rate|out of memory/i.test(json.remark)) {
          throw new Error('Overpass: ' + json.remark.slice(0, 80));
        }
        return json;
      })().then(json => finish(resolve, json), e => {
        if (settled) return;
        lastErr = e.name === 'AbortError' ? new Error('Overpass svarade inte i tid') : e;
        failed++;
        if (failed >= eps.length) finish(reject, lastErr);
        else if (failed >= started) startNext();   // inget anrop pågår: ta nästa server direkt
      }).finally(() => clearTimeout(timer));
    };
    startNext();
  });
}

/**
 * Hämtar OSM-element längs rutten. En del som inte går att hämta stoppar inte
 * de andra; resultatet har statistik i .stats ({cells, cached, batches,
 * failed, error, ms}). Fel kastas bara om ingenting alls gick att hämta.
 * cache = {get(key) → elements|null, set(key, elements)} (valfri, t.ex. localStorage)
 * onProgress(done, total) anropas efter varje hämtad del.
 * onReady(elements) anropas en gång när rutans första readyDist meter är klara
 * men resten fortfarande hämtas, så att körningen kan börja. Elementen har
 * .stats med partial: true och readyS (m). Är allt klart på en gång anropas
 * den inte. Har början inte kommit inom readyTimeoutMs (t.ex. när alla
 * servrar hänger) anropas onReady ändå med det som finns, så att körningen
 * kan börja med bara kurvor; .stats.readyTimeout är då true.
 */
export async function fetchOsmAlongRoute(route, {
  fetchImpl = fetch, signal, cache = null, onProgress = () => {}, onReady = null,
  readyDist = 3000, readyTimeoutMs = 15000, cellsPerRequest = 12, concurrency = 3, timeoutMs = 30000, hedgeMs = 5000, waits,
} = {}) {
  const t0 = Date.now();
  const cells = routeCellsAt(route);
  const elements = new Map();
  const missingNear = [], missingFar = [];
  for (const { key, s } of cells) {
    const hit = cache && cache.get(key);
    if (hit) for (const el of hit) elements.set(el.type + el.id, el);
    else (s < readyDist ? missingNear : missingFar).push(key);
  }
  // Början av rutten i egna, små anrop som går först.
  const batches = [];
  const nearSize = Math.max(1, Math.min(cellsPerRequest, Math.ceil(missingNear.length / 2)));
  for (let i = 0; i < missingNear.length; i += nearSize) batches.push(missingNear.slice(i, i + nearSize));
  const nearBatches = batches.length;
  for (let i = 0; i < missingFar.length; i += cellsPerRequest) batches.push(missingFar.slice(i, i + cellsPerRequest));
  let done = 0, nearDone = 0, readySent = false;
  onProgress(done, batches.length);

  let next = 0, failed = 0, lastError = null;
  const stats = (extra = {}) => ({
    cells: cells.length, cached: cells.length - missingNear.length - missingFar.length,
    batches: batches.length, failed, error: lastError, ms: Date.now() - t0, ...extra,
  });
  const maybeReady = (timedOut = false) => {
    if (readySent || !onReady || done >= batches.length) return;
    if (!timedOut && nearDone < nearBatches) return;
    readySent = true;
    clearTimeout(readyTimer);
    const part = [...elements.values()];
    part.stats = stats({ partial: true, readyS: readyDist, readyTimeout: timedOut });
    onReady(part);
  };
  const readyTimer = onReady ? setTimeout(() => maybeReady(true), readyTimeoutMs) : null;
  maybeReady();   // början kanske redan finns i cachen
  const worker = async () => {
    while (next < batches.length) {
      const idx = next++;
      const batch = batches[idx];
      let json = null;
      try {
        // Sprid anropen över servrarna så att de inte köar hos samma.
        // Början av rutten håller upp starten: fråga nästa server tidigare.
        const hedge = idx < nearBatches ? hedgeMs / 2 : hedgeMs;
        json = await overpassFetch(overpassQuery(batch), { fetchImpl, signal, timeoutMs, hedgeMs: hedge, waits, first: idx });
      } catch (e) {
        if (signal?.aborted) throw e;
        failed++;
        lastError = e.message;
      }
      if (json) {
        const wanted = new Set(batch);
        const perCell = new Map(batch.map(k => [k, []]));
        for (const raw of json.elements || []) {
          const el = compactElement(raw);
          elements.set(el.type + el.id, el);
          for (const k of cellsOfElement(el, wanted)) perCell.get(k).push(el);
        }
        if (cache) for (const [k, els] of perCell) cache.set(k, els);
      }
      if (idx < nearBatches) nearDone++;
      onProgress(++done, batches.length);
      maybeReady();
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, worker));
  } finally {
    clearTimeout(readyTimer);
  }
  const out = [...elements.values()];
  out.stats = stats({ readyEarly: readySent });
  if (batches.length && failed === batches.length && out.stats.cached === 0) {
    const e = new Error(lastError || 'Overpass gick inte att nå');
    e.stats = out.stats;
    throw e;
  }
  return out;
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
  const ways = elements.filter(e => e.type === 'way' && (wayLimit(e.tags, true) != null || wayLimit(e.tags, false) != null));
  const grid = segmentGrid(route, ways);
  const L = new Array(route.n).fill(null);
  for (let i = 0; i < route.n; i++) {
    let best = null;
    for (const seg of grid.near(route.X[i], route.Y[i])) {
      const diff = angleDiff(seg.h, route.H[i]);
      if (diff > 45 && diff < 135) continue;
      const r = projectOnSegment(route.X[i], route.Y[i], seg.ax, seg.ay, seg.bx, seg.by);
      if (r.d < 15 && (!best || r.d < best.d)) best = { d: r.d, w: seg.w, forward: diff <= 90 };
    }
    if (best) L[i] = wayLimit(best.w.tags, best.forward);
  }
  const found = L.filter(x => x != null).length;
  const out = smoothLimits(fillGaps(L), Math.round(40 / route.step));
  out.coverage = route.n ? found / route.n : 0;  // andel av rutten med känd gräns
  return out;
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
 * settings: { aLat (m/s²), giveWayKmh, roundaboutKmh, noEnd, minTargetS (m), skipStart (m) }
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
  const skipStart = settings.skipStart ?? 60;
  t.push(...curveTargets(route, settings.aLat ?? 2.5, { limits, skipStart }));
  // Utan resmål (vägen framåt) finns inget slutmål, och mål nära bilen behålls
  if (!settings.noEnd) t.push({ s: route.length, v: 0, kind: 'end' });
  const minS = settings.minTargetS ?? 40;
  return mergeTargets(t.filter(x => x.s > minS || x.kind === 'end'));
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
