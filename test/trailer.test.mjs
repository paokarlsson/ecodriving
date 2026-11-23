import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trailerLimits, TRAILER_MAX_KMH } from '../js/trailer.js';
import { buildRoute, curveTargets } from '../js/route.js';
import { assignLimits, buildTargets } from '../js/osm.js';
import { demoData } from '../js/demo.js';

test('gränser med släp: tak 80 och okänd gräns', () => {
  assert.equal(TRAILER_MAX_KMH, 80);
  assert.deepEqual(trailerLimits([50, 70, 90, 110, null]), [50, 70, 80, 80, 80]);
});

test('släpläge: samma sidokraft, kurvfart aldrig över 80', () => {
  const { coords, elements } = demoData();
  const r = buildRoute(coords);
  const raw = assignLimits(r, elements);
  const aLat = 0.25 * 9.81;
  const L = trailerLimits(raw);
  assert.ok(Math.max(...L) <= 80);
  for (const c of curveTargets(r, aLat, { limits: L })) assert.ok(c.v * 3.6 <= 80 + 1e-9);
  const t = buildTargets(r, elements, L, { aLat });
  assert.ok(t.every(x => x.kind !== 'limit' || x.kmh <= 80));
});
