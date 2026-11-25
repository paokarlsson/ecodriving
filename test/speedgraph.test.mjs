import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coastProfile, profileAt, releaseOnProfile } from '../js/speedgraph.js';
import { coastDistance, releasePoint } from '../js/physics.js';

const model = { A: 0.15, C: 0.00025 };
const flat = () => 0;

test('rullkurvan slutar på målfarten och stiger bakåt', () => {
  const target = { s: 1000, v: 50 / 3.6 };
  const p = coastProfile(target, 0, flat, model);
  assert.equal(p[p.length - 1][0], 1000);
  assert.ok(Math.abs(p[p.length - 1][1] - target.v) < 1e-9);
  for (let i = 1; i < p.length; i++) assert.ok(p[i][1] <= p[i - 1][1] + 1e-9, 'farten sjunker mot målet');
  assert.equal(p[0][0], 0);
});

test('släpp-punkten på kurvan stämmer med rullsträckan och körmotorn', () => {
  const target = { s: 2000, v: 50 / 3.6 };
  const v = 90 / 3.6;
  const p = coastProfile(target, 0, flat, model);
  const rel = releaseOnProfile(p, v);
  const d = coastDistance(v, target.v, model);
  assert.ok(Math.abs((target.s - rel) - d) < 15, `kurva ${target.s - rel} m, rullsträcka ${d} m`);
  const rp = releasePoint(target, v, 0, flat, model);
  assert.ok(Math.abs(rp.release - rel) < 5, `motor ${rp.release}, kurva ${rel}`);
  assert.ok(Math.abs(profileAt(p, rel) - v) < 0.01);
});

test('lägre fart än målet ger ingen släpp-punkt, utanför kurvan ger null', () => {
  const p = coastProfile({ s: 500, v: 20 }, 0, flat, model);
  assert.equal(releaseOnProfile(p, 15), null);
  assert.equal(profileAt(p, 600), null);
});

test('nedförsbacke: kurvan planar ut där rullningen inte bromsar', () => {
  const p = coastProfile({ s: 1000, v: 15 }, 0, () => -0.05, model);
  // −5 % ger acceleration, så farten bakåt blir lägre, aldrig negativ
  for (const [, v] of p) assert.ok(v >= 0 && v <= 15 + 1e-9);
});
