import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildNetwork, buildHorizon, matchNetwork, wayAllows } from '../js/horizon.js';
import { makeProjector } from '../js/geo.js';

const LAT0 = 63.15, LON0 = 14.7;
const P = makeProjector(LAT0, LON0);
const ll = (x, y) => { const [lat, lon] = P.toLL(x, y); return { lat: Math.round(lat * 1e6) / 1e6, lon: Math.round(lon * 1e6) / 1e6 }; };
let nextId = 1;
const way = (pts, tags = {}) => ({ type: 'way', id: nextId++, tags: { highway: 'residential', ...tags }, geometry: pts.map(([x, y]) => ll(x, y)) });
const node = (x, y, highway) => ({ type: 'node', id: nextId++, ...ll(x, y), tags: { highway } });
const at = (x, y) => ll(x, y);

test('följer samma väg rakt igenom en fyrvägskorsning', () => {
  const els = [
    way([[0, -500], [0, 0], [0, 800]], { name: 'Storgatan' }),
    way([[-300, 0], [0, 0], [300, 0]], { name: 'Tvärgatan' }),
  ];
  const net = buildNetwork(els, LAT0, LON0);
  const p = at(3, -200);
  const h = buildHorizon(net, p.lat, p.lon, 0, { length: 600 });
  assert.ok(h);
  assert.equal(h.name, 'Storgatan');
  assert.equal(h.reason, 'length');
  assert.ok(Math.abs(h.length - 600) < 1, `längd ${h.length}`);
  const [lon, lat] = h.coords[h.coords.length - 1];
  const [x, y] = P.toXY(lat, lon);
  assert.ok(Math.abs(x) < 1 && y > 300);
});

test('rakt fram över korsningen även när vägen byter id', () => {
  const els = [
    way([[0, -500], [0, 0]], { name: 'A' }),
    way([[0, 0], [5, 600]], { name: 'B' }),
    way([[0, 0], [400, 10]], { name: 'C' }),
  ];
  const net = buildNetwork(els, LAT0, LON0);
  const p = at(0, -100);
  const h = buildHorizon(net, p.lat, p.lon, 2, { length: 2000 });
  assert.equal(h.reason, 'deadend');
  assert.ok(h.length > 650);
});

test('T-korsning: vägen framåt slutar i korsningen', () => {
  const els = [
    way([[0, -500], [0, 0]]),
    way([[-300, 0], [0, 0], [300, 0]]),
  ];
  const net = buildNetwork(els, LAT0, LON0);
  const p = at(0, -300);
  const h = buildHorizon(net, p.lat, p.lon, 0);
  assert.equal(h.reason, 'junction');
  assert.ok(Math.abs(h.length - 300) < 2);
});

test('kurvig väg utan korsning följs, och färdriktningen väljer håll', () => {
  const pts = [];
  for (let a = 0; a <= 180; a += 10) pts.push([200 - 200 * Math.cos(a * Math.PI / 180), 200 * Math.sin(a * Math.PI / 180)]);
  const net = buildNetwork([way(pts)], LAT0, LON0);
  const p = at(0, 0);
  const fwd = buildHorizon(net, p.lat, p.lon, 0);
  assert.ok(fwd.length > 600);
  const back = buildHorizon(net, p.lat, p.lon, 180);
  assert.ok(!back || back.length < 5, `bakåt ${back?.length}`);
});

test('enkelriktat: kan inte matchas mot ritriktningen', () => {
  const w = way([[0, 0], [0, 500]], { oneway: 'yes' });
  assert.equal(wayAllows(w, 1), true);
  assert.equal(wayAllows(w, -1), false);
  const net = buildNetwork([w], LAT0, LON0);
  const p = at(0, 200);
  assert.equal(matchNetwork(net, p.lat, p.lon, 180), null);
  assert.ok(matchNetwork(net, p.lat, p.lon, 0));
});

test('infarter (service) räknas inte som val; rondell stoppar strax efter infarten', () => {
  const els = [
    way([[0, -500], [0, 0], [0, 300]]),
    way([[0, 0], [60, 5]], { highway: 'service' }),
    way([[0, 300], [20, 320], [0, 340], [-20, 320], [0, 300]], { highway: 'primary', junction: 'roundabout' }),
  ];
  const net = buildNetwork(els, LAT0, LON0);
  const p = at(0, -200);
  const h = buildHorizon(net, p.lat, p.lon, 0);
  assert.equal(h.reason, 'roundabout');
  assert.ok(h.length > 500 && h.length < 520, `längd ${h.length}`);
});

test('ingen väg i närheten ger null', () => {
  const net = buildNetwork([way([[0, 0], [0, 500]])], LAT0, LON0);
  const p = at(200, 200);
  assert.equal(buildHorizon(net, p.lat, p.lon, 0), null);
  assert.equal(buildHorizon(net, p.lat, p.lon, null), null);
});
