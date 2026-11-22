import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRoute } from '../js/route.js';
import { parseMaxspeed, wayLimit, assignLimits, fetchOsmAlongRoute, overpassQuery, routeCells } from '../js/osm.js';
import { demoData } from '../js/demo.js';
import { makeProjector } from '../js/geo.js';

test('zoner och riktningsbundna taggar', () => {
  assert.equal(parseMaxspeed('SE:zone30'), 30);
  assert.equal(parseMaxspeed('DE:zone:30'), 30);
  assert.equal(wayLimit({ 'maxspeed:forward': '70', 'maxspeed:backward': '50' }, true), 70);
  assert.equal(wayLimit({ 'maxspeed:forward': '70', 'maxspeed:backward': '50' }, false), 50);
  assert.equal(wayLimit({ maxspeed: '60', 'maxspeed:backward': '40' }, true), 60);
  assert.equal(wayLimit({ 'maxspeed:type': 'SE:urban' }), 50);
  assert.equal(wayLimit({ 'source:maxspeed': 'SE:rural' }), 70);
  assert.equal(wayLimit({ highway: 'primary' }), null);
});

function straight(lenM) {
  const proj = makeProjector(57.7, 11.97);
  const coords = [];
  for (let y = 0; y <= lenM; y += 20) { const [la, lo] = proj.toLL(0, y); coords.push([lo, la, 10]); }
  const ll = (x, y) => { const [lat, lon] = proj.toLL(x, y); return { lat, lon }; };
  return { coords, ll };
}

test('gräns i färdriktningen när vägen är ritad åt andra hållet', () => {
  const { coords, ll } = straight(1000);
  const r = buildRoute(coords);
  // Vägen är ritad söderut (motsatt rutten): backward gäller för oss
  const way = { type: 'way', id: 1, tags: { highway: 'primary', 'maxspeed:forward': '90', 'maxspeed:backward': '60' }, geometry: [ll(0, 1000), ll(0, 0)] };
  const L = assignLimits(r, [way]);
  assert.equal(L[50], 60);
  assert.ok(L.coverage > 0.95);
});

test('täckning när gräns bara finns på en del av rutten', () => {
  const { coords, ll } = straight(1000);
  const r = buildRoute(coords);
  const way = { type: 'way', id: 1, tags: { highway: 'primary', maxspeed: '70' }, geometry: [ll(0, 0), ll(0, 300)] };
  const L = assignLimits(r, [way]);
  assert.ok(L.coverage > 0.25 && L.coverage < 0.35, `${L.coverage}`);
  assert.equal(L[90], 70); // utfyllt med senast kända
  assert.equal(assignLimits(r, []).coverage, 0);
});

test('frågan tar med vägar utan maxspeed men med riktnings- eller zontagg', () => {
  const q = overpassQuery(['11540_1496']);
  assert.match(q, /maxspeed:forward\|maxspeed:backward\|maxspeed:type/);
});

test('timeout-svar från Overpass sparas inte i cachen', async () => {
  const { coords } = demoData();
  const r = buildRoute(coords);
  const store = new Map();
  const cache = { get: k => store.get(k) || null, set: (k, v) => store.set(k, v) };
  let calls = 0;
  const fetchImpl = async () => { calls++; return { ok: true, json: async () => ({ elements: [], remark: 'runtime error: Query timed out in "query" at line 3 after 60 seconds.' }) }; };
  await assert.rejects(fetchOsmAlongRoute(r, { fetchImpl, cache }), /Overpass/);
  assert.equal(store.size, 0);
  assert.ok(calls >= 2, 'provade båda servrarna');
  assert.ok(routeCells(r).length > 0);
});
