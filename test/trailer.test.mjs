import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateTrailerModel, trailerLimits, TRAILER_DEFAULTS } from '../js/trailer.js';
import { coastDistance, DEFAULT_MODEL } from '../js/physics.js';
import { buildRoute, curveTargets } from '../js/route.js';
import { assignLimits, buildTargets, countKinds } from '../js/osm.js';
import { demoData } from '../js/demo.js';

test('gränser med släp: tak och okänd gräns', () => {
  assert.deepEqual(trailerLimits([50, 70, 90, 110, null], 80), [50, 70, 80, 80, 80]);
  assert.deepEqual(trailerLimits([30, null], 40), [30, 40]);
});

test('uppskattad släpmodell rullar längre från 80 km/h', () => {
  const t = estimateTrailerModel(DEFAULT_MODEL);
  assert.ok(t.estimated);
  assert.ok(coastDistance(80 / 3.6, 50 / 3.6, t) > coastDistance(80 / 3.6, 50 / 3.6, DEFAULT_MODEL));
});

test('släpläge ger lägre kurvfart och färre gränsbyten över taket', () => {
  const { coords, elements } = demoData();
  const r = buildRoute(coords);
  const raw = assignLimits(r, elements);
  const car = curveTargets(r, 0.25 * 9.81, { limits: raw })[0];
  const tr = curveTargets(r, TRAILER_DEFAULTS.trailerALat, { limits: trailerLimits(raw, 80) })[0];
  assert.ok(tr.v < car.v, `${tr.v * 3.6} < ${car.v * 3.6}`);

  // Med 60 som tak försvinner 70-sträckorna och gränsbytet 70→50 blir 60→50
  const L60 = trailerLimits(raw, 60);
  assert.equal(Math.max(...L60), 60);
  const t = buildTargets(r, elements, L60, { aLat: TRAILER_DEFAULTS.trailerALat });
  const limitTargets = t.filter(x => x.kind === 'limit').map(x => x.kmh);
  assert.ok(limitTargets.every(k => k <= 50), JSON.stringify(limitTargets));
  assert.ok(countKinds(t).curve >= 1);
});
