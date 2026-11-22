import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRoute } from '../js/route.js';
import { routeCells, cellBounds, overpassQuery, fetchOsmAlongRoute, assignLimits, buildTargets, countKinds } from '../js/osm.js';
import { demoData } from '../js/demo.js';

function fakeOverpass(elements) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const q = decodeURIComponent(opts.body.slice(5));
    calls.push(q);
    // Svara med de element som ligger i någon av frågans rutor
    const boxes = [...q.matchAll(/\(([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\);/g)].map(m => m.slice(1).map(Number));
    const inBox = (lat, lon) => boxes.some(([s, w, n, e]) => lat >= s && lat <= n && lon >= w && lon <= e);
    const hit = elements.filter(el => el.type === 'node' ? inBox(el.lat, el.lon) : el.geometry.some(p => inBox(p.lat, p.lon)));
    return { ok: true, json: async () => ({ elements: hit }) };
  };
  return { fetchImpl, calls };
}

test('rutten täcks av celler och frågan innehåller dem', () => {
  const { coords } = demoData();
  const r = buildRoute(coords);
  const cells = routeCells(r);
  assert.ok(cells.length >= 8 && cells.length < 40, `${cells.length} celler`);
  for (let k = 0; k < r.n; k += 10) {
    const [lat, lon] = r.proj.toLL(r.X[k], r.Y[k]);
    assert.ok(cells.some(c => { const b = cellBounds(c); return lat >= b.s && lat <= b.n && lon >= b.w && lon <= b.e; }));
  }
  const q = overpassQuery(cells.slice(0, 2));
  assert.match(q, /out geom qt;/);
  assert.equal((q.match(/traffic_signals/g) || []).length, 2);
  assert.ok(!q.includes('around'));
});

test('hämtning i delar ger samma fartmål, och cachen gör andra hämtningen gratis', async () => {
  const { coords, elements } = demoData();
  const r = buildRoute(coords);
  const { fetchImpl, calls } = fakeOverpass(elements);
  const store = new Map();
  const cache = { get: k => store.get(k) || null, set: (k, v) => store.set(k, v) };
  const progress = [];
  const got = await fetchOsmAlongRoute(r, { fetchImpl, cache, cellsPerRequest: 4, onProgress: (d, t) => progress.push([d, t]) });
  assert.ok(calls.length >= 2, `${calls.length} anrop`);
  assert.deepEqual(progress[progress.length - 1], [calls.length, calls.length]);

  const L = assignLimits(r, got);
  const t = buildTargets(r, got, L, { aLat: 2.5 });
  const L0 = assignLimits(r, elements);
  const t0 = buildTargets(r, elements, L0, { aLat: 2.5 });
  assert.deepEqual(countKinds(t), countKinds(t0));
  assert.deepEqual(t.map(x => Math.round(x.s)), t0.map(x => Math.round(x.s)));

  const before = calls.length;
  const again = await fetchOsmAlongRoute(r, { fetchImpl, cache, cellsPerRequest: 4 });
  assert.equal(calls.length, before, 'inga nya anrop');
  assert.equal(again.length, got.length);
});

test('svarar en server inte används nästa', async () => {
  const { coords, elements } = demoData();
  const r = buildRoute(coords);
  const ok = fakeOverpass(elements);
  let n = 0;
  const fetchImpl = async (url, opts) => {
    if (url.includes('overpass-api.de')) { n++; return { ok: false, status: 504 }; }
    return ok.fetchImpl(url, opts);
  };
  const got = await fetchOsmAlongRoute(r, { fetchImpl, waits: [0] });
  assert.ok(n >= 1);
  assert.ok(got.length > 0);
});

test('"för många anrop" ger nytt försök, och en trasig del stoppar inte resten', async () => {
  const { coords, elements } = demoData();
  const r = buildRoute(coords);
  const ok = fakeOverpass(elements);
  let calls = 0;
  // Var tredje anrop nekas med 429 första gången
  const seen = new Set();
  const fetch429 = async (url, opts) => {
    calls++;
    if (!seen.has(opts.body)) { seen.add(opts.body); return { ok: false, status: 429 }; }
    return ok.fetchImpl(url, opts);
  };
  const got = await fetchOsmAlongRoute(r, { fetchImpl: fetch429, cellsPerRequest: 4, waits: [0, 0] });
  assert.equal(got.stats.failed, 0);
  assert.ok(calls > got.stats.batches);
  assert.equal(countKinds(buildTargets(r, got, assignLimits(r, got), { aLat: 2.5 })).traffic_signals, 1);

  // En del misslyckas alltid: resten kommer ändå, och statistiken säger det
  let first = null;
  const fetchOneBad = async (url, opts) => {
    if (first == null) first = opts.body;
    if (opts.body === first) return { ok: false, status: 504 };
    return ok.fetchImpl(url, opts);
  };
  const part = await fetchOsmAlongRoute(r, { fetchImpl: fetchOneBad, cellsPerRequest: 4, waits: [0, 0] });
  assert.equal(part.stats.failed, 1);
  assert.ok(part.stats.batches > 1);
  assert.ok(part.length > 0);
  assert.match(part.stats.error, /504/);
});
