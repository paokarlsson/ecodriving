import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRoute, curveTargets, curveRadii } from '../js/route.js';
import { makeProjector } from '../js/geo.js';

const G = 9.81;

/** Rakt 1 km, båge med radie R och vinkel deg (punkter var stepM), rakt 1 km. */
function arcRoute(R, deg, stepM) {
  const proj = makeProjector(63.4, 14.9);
  const xy = [];
  for (let y = 0; y <= 1000; y += 100) xy.push([0, y]);
  const n = Math.max(1, Math.round((R * deg * Math.PI / 180) / stepM));
  for (let k = 1; k <= n; k++) {
    const a = (k / n) * deg * Math.PI / 180;
    xy.push([R - R * Math.cos(a), 1000 + R * Math.sin(a)]);
  }
  const [ex, ey] = xy[xy.length - 1];
  const a = deg * Math.PI / 180;
  for (let d = 100; d <= 1000; d += 100) xy.push([ex + d * Math.sin(a), ey + d * Math.cos(a)]);
  return buildRoute(xy.map(([x, y]) => { const [la, lo] = proj.toLL(x, y); return [lo, la, 300]; }));
}

const limit90 = r => new Array(r.n).fill(90);

test('lång mjuk kurva ritad med få hörn ger ingen falsk kurva', () => {
  // R = 1000 m, 25°, en punkt var 80:e meter: hörn på ca 4,6°
  const r = arcRoute(1000, 25, 80);
  const c = curveTargets(r, 0.25 * G, { limits: limit90(r) });
  assert.equal(c.length, 0, JSON.stringify(c.map(x => [Math.round(x.s), Math.round(x.v * 3.6)])));
});

test('riktig kurva med radie 150 m hittas med rätt radie', () => {
  const r = arcRoute(150, 60, 15);
  const c = curveTargets(r, 0.25 * G, { limits: limit90(r) });
  assert.equal(c.length, 1);
  assert.ok(c[0].radius > 120 && c[0].radius < 190, `R ${c[0].radius}`);
  assert.ok(c[0].v * 3.6 > 60 && c[0].v * 3.6 < 75, `${c[0].v * 3.6} km/h`);
});

test('tvär sväng i korsning (90° i en punkt) blir långsam', () => {
  const r = arcRoute(1, 90, 1); // i praktiken ett hörn
  const R = curveRadii(r);
  const minR = Math.min(...R);
  assert.ok(minR < 20, `R ${minR}`);
  const c = curveTargets(r, 0.25 * G, { limits: new Array(r.n).fill(50) });
  assert.equal(c.length, 1);
  assert.ok(c[0].v * 3.6 < 25, `${c[0].v * 3.6} km/h`);
});

test('kurvor tätt efter varandra blir en', () => {
  const proj = makeProjector(63.4, 14.9);
  // S-kurva: två bågar R=120 med 60 m rakt emellan
  const xy = [];
  for (let y = 0; y <= 600; y += 50) xy.push([0, y]);
  let x = 0, y = 600, h = 0;
  const arc = (R, deg, sign) => { const n = 12; for (let k = 0; k < n; k++) { h += sign * (deg / n) * Math.PI / 180; const d = R * (deg / n) * Math.PI / 180; x += d * Math.sin(h); y += d * Math.cos(h); xy.push([x, y]); } };
  arc(120, 40, 1);
  for (let k = 0; k < 3; k++) { x += 20 * Math.sin(h); y += 20 * Math.cos(h); xy.push([x, y]); }
  arc(120, 40, -1);
  for (let k = 0; k < 10; k++) { x += 60 * Math.sin(h); y += 60 * Math.cos(h); xy.push([x, y]); }
  const r = buildRoute(xy.map(([a, b]) => { const [la, lo] = proj.toLL(a, b); return [lo, la, 0]; }));
  const c = curveTargets(r, 0.25 * G, { limits: new Array(r.n).fill(80) });
  assert.equal(c.length, 1, JSON.stringify(c.map(q => [Math.round(q.s), Math.round(q.sEnd)])));
});
