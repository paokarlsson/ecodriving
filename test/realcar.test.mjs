import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRoute, curveTargets } from '../js/route.js';
import { assignLimits, buildTargets } from '../js/osm.js';
import { DriveEngine } from '../js/drive.js';
import { RealCar, seededRandom } from '../js/sim.js';
import { demoData } from '../js/demo.js';

function run(seed, obeyProb = 0.85) {
  const { coords, elements } = demoData();
  const r = buildRoute(coords);
  const L = assignLimits(r, elements);
  const targets = buildTargets(r, elements, L, { aLat: 2.45 });
  const curves = curveTargets(r, 2.45, { limits: L });
  const model = { A: 0.4, C: 0.0004 };
  const eng = new DriveEngine(r, targets, model, { marginS: 1.5 });
  const car = new RealCar(r, targets, L, curves, model, { rand: seededRandom(seed), obeyProb });
  let arrived = null, maxV = 0, maxA = 0, prevV = 0, releases = 0;
  for (let i = 0; i < 1500 && !arrived; i++) {
    const obs = car.step(1);
    maxV = Math.max(maxV, car.v);
    maxA = Math.max(maxA, car.v - prevV);
    prevV = car.v;
    for (const e of eng.update(obs).events) {
      if (e.type === 'release') { releases++; car.onRelease(e.target); }
      if (e.type === 'arrived') arrived = e.stats;
    }
  }
  return { arrived, car, maxV, maxA, releases };
}

test('realistisk bil kommer fram med rimlig fart och acceleration', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const { arrived, car, maxV, maxA, releases } = run(seed);
    assert.ok(arrived, `seed ${seed} kom fram`);
    assert.ok(maxV * 3.6 < 78, `maxfart ${maxV * 3.6}`);   // 70-väg + egen marginal
    assert.ok(maxA < 2.1, `acceleration ${maxA}`);
    assert.ok(releases >= 3);
    const st = car.stats;
    assert.equal(st.redLights + st.greenLights, 1, 'ett trafikljus');
    if (st.redLights) assert.ok(st.stops >= 1, 'stannar vid rött');
  }
});

test('förare som inte följer signalerna bromsar oftare', () => {
  let obedient = 0, ignoring = 0;
  for (const seed of [11, 12, 13, 14]) {
    obedient += run(seed, 1).car.stats.brakes;
    ignoring += run(seed, 0).car.stats.brakes;
  }
  assert.ok(ignoring > obedient, `${ignoring} > ${obedient}`);
});

test('GPS-observationer har brus men ligger nära vägen', () => {
  const { coords } = demoData();
  const r = buildRoute(coords);
  const car = new RealCar(r, [{ id: 0, s: r.length, v: 0, kind: 'end' }], null, [], { A: 0.4, C: 0.0004 }, { rand: seededRandom(7) });
  let maxOff = 0;
  for (let i = 0; i < 60; i++) {
    const o = car.step(1);
    const [x, y] = r.proj.toXY(o.lat, o.lon);
    const i0 = Math.round(car.s / r.step);
    maxOff = Math.max(maxOff, Math.hypot(x - r.X[i0], y - r.Y[i0]));
    assert.ok(o.accuracy >= 3 && o.accuracy <= 7);
  }
  assert.ok(maxOff > 0.5 && maxOff < 15, `avvikelse ${maxOff}`);
});

test('riktig väg utan vägdata: kommer fram, max 120 km/h och högst 0,25 g', async () => {
  const { readFileSync } = await import('node:fs');
  const { curveRadii } = await import('../js/route.js');
  const d = JSON.parse(readFileSync(new URL('./fixtures/ost-brunflo.json', import.meta.url)));
  const r = buildRoute(d.coords);
  const L = new Array(r.n).fill(null);
  // Samma fartmål och motor som appen (vägdata saknas)
  const targets = buildTargets(r, [], L, { aLat: 2.45 });
  const curves = curveTargets(r, 2.45, { limits: L });
  const R = curveRadii(r);
  const model = { A: 0.4, C: 0.0004 };
  for (const seed of [1, 2, 3, 4, 5]) {
    const eng = new DriveEngine(r, targets, model, { marginS: 1.5 });
    const car = new RealCar(r, targets, L, curves, model, { rand: seededRandom(seed) });
    let maxV = 0, maxG = 0, arrived = null, releases = 0, t = 0;
    for (; t < 3000 && !arrived; t++) {
      const obs = car.step(1);
      maxV = Math.max(maxV, car.v);
      const Ri = R[Math.min(r.n - 1, Math.round(car.s / r.step))];
      maxG = Math.max(maxG, car.v ** 2 / Ri / 9.81);
      for (const e of eng.update(obs).events) {
        if (e.type === 'release') { releases++; car.onRelease(e.target); }
        if (e.type === 'arrived') arrived = e.stats;
      }
    }
    assert.ok(arrived, `seed ${seed} kom fram (stod på ${Math.round(car.s)} m)`);
    assert.ok(t < 1500, `körtid ${t} s`);
    assert.ok(releases >= 5, `släpp-signaler ${releases}`);
    assert.ok(maxV * 3.6 <= 120.5, `maxfart ${maxV * 3.6}`);
    assert.ok(maxV * 3.6 > 100, `kör upp mot 120 där vägen är rak (${maxV * 3.6})`);
    assert.ok(maxG <= 0.25, `sidokraft ${maxG}`);
  }
});
