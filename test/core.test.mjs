import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRoute, matchToRoute, curveTargets, gradeAt } from '../js/route.js';
import { releasePoint, coastDistance, fitAC, decel, DEFAULT_MODEL } from '../js/physics.js';
import { parseMaxspeed, assignLimits, buildTargets, mergeTargets, countKinds } from '../js/osm.js';
import { CoastRecorder, analyzeRun, combineRuns } from '../js/calibration.js';
import { DriveEngine, releaseMessage } from '../js/drive.js';
import { demoData } from '../js/demo.js';
import { SimCar } from '../js/sim.js';
import { makeProjector } from '../js/geo.js';

const model = { A: 0.4, C: 0.0004 };
const flat = () => 0;

test('parseMaxspeed', () => {
  assert.equal(parseMaxspeed('50'), 50);
  assert.equal(parseMaxspeed('30 mph'), 48);
  assert.equal(parseMaxspeed('SE:urban'), 50);
  assert.equal(parseMaxspeed('SE:rural'), 70);
  assert.equal(parseMaxspeed('70;50'), 50);
  assert.equal(parseMaxspeed('none'), null);
  assert.equal(parseMaxspeed(undefined), null);
});

test('releasePoint på plan väg stämmer med rullsträckan', () => {
  const v0 = 70 / 3.6, vt = 50 / 3.6;
  const d = coastDistance(v0, vt, model);
  const rp = releasePoint({ s: 2000, v: vt }, v0, 0, flat, model, { step: 1 });
  assert.ok(Math.abs((2000 - rp.release) - d) < 3, `${2000 - rp.release} vs ${d}`);
  assert.equal(rp.late, false);
  assert.equal(rp.brakeNeeded, false);
});

test('releasePoint: uppför ger kortare rullsträcka, nedför längre', () => {
  const v0 = 70 / 3.6;
  const t = { s: 3000, v: 30 / 3.6 };
  const r0 = releasePoint(t, v0, 0, flat, model);
  const up = releasePoint(t, v0, 0, () => 0.02, model);
  const down = releasePoint(t, v0, 0, () => -0.02, model);
  assert.ok(3000 - up.release < 3000 - r0.release);
  assert.ok(3000 - down.release > 3000 - r0.release);
});

test('releasePoint: brant nedför kräver broms', () => {
  const rp = releasePoint({ s: 1000, v: 0 }, 20, 0, () => -0.08, model);
  assert.equal(rp.brakeNeeded, true);
});

test('releasePoint: för sent / onödigt', () => {
  const late = releasePoint({ s: 50, v: 0 }, 25, 0, flat, model);
  assert.equal(late.late, true);
  assert.equal(late.release, 0);
  const nn = releasePoint({ s: 500, v: 20 }, 15, 0, flat, model);
  assert.equal(nn.notNeeded, true);
});

test('fitAC återskapar A och C', () => {
  const pts = [];
  for (let v = 8; v <= 22; v += 0.5) pts.push({ v, a: 0.35 + 0.0005 * v * v + (Math.sin(v * 7) * 0.005) });
  const f = fitAC(pts);
  assert.ok(Math.abs(f.A - 0.35) < 0.02, `A=${f.A}`);
  assert.ok(Math.abs(f.C - 0.0005) < 0.0001, `C=${f.C}`);
  assert.ok(f.r2 > 0.95);
});

function synthRun({ A, C, grade = 0, wind = 0, dir = 1, t0 = 0 }) {
  // Simulerar ett rullprov 85 → 28 km/h med 1 Hz GPS
  const proj = makeProjector(57.7, 11.9);
  const out = [];
  let v = 85 / 3.6, s = 0, t = t0;
  while (v > 28 / 3.6) {
    const [lat, lon] = proj.toLL(dir * s, 0);
    out.push({ t, v, lat, lon, alt: 10 + grade * s, accuracy: 4 });
    const a = A + C * (v + wind * dir) ** 2 + 9.81 * grade;
    for (let k = 0; k < 10; k++) { s += v * 0.1; v -= a * 0.1; }
    t += 1;
  }
  return out;
}

test('kalibrering: två riktningar tar ut lutning och vind', () => {
  const A = 0.45, C = 0.00042;
  const r1 = analyzeRun(synthRun({ A, C, grade: 0.008, wind: 2, dir: 1 }));
  const r2 = analyzeRun(synthRun({ A, C, grade: -0.008, wind: 2, dir: -1 }));
  assert.ok(r1.ok && r2.ok, r1.reason || r2.reason);
  const c = combineRuns([r1, r2]);
  assert.ok(c.ok, c.reason);
  assert.ok(Math.abs(c.A - A) < 0.05, `A=${c.A}`);
  assert.ok(Math.abs(c.C - C) < 0.00015, `C=${c.C}`);
});

test('kalibrering: underkänner backe och gas', () => {
  const hill = analyzeRun(synthRun({ A: 0.4, C: 0.0004, grade: 0.03 }));
  assert.equal(hill.ok, false);
  const events = [];
  const rec = new CoastRecorder(e => events.push(e.type));
  for (let t = 0; t < 5; t++) rec.addGps({ t, v: 80 / 3.6, lat: 0, lon: 0 });
  assert.equal(rec.state, 'recording');
  assert.deepEqual(events, ['cue']);
  rec.addGps({ t: 6, v: 75 / 3.6 });
  rec.addGps({ t: 7, v: 72 / 3.6 });
  rec.addGps({ t: 8, v: 78 / 3.6 });
  assert.equal(rec.state, 'failed');
});

test('kalibrering: inspelning slutar vid 30 km/h', () => {
  const rec = new CoastRecorder();
  const run = synthRun({ A: 0.4, C: 0.0004 });
  for (let t = -4; t < 0; t++) rec.addGps({ t, v: 85 / 3.6, lat: run[0].lat, lon: run[0].lon });
  for (const p of run) rec.addGps(p);
  rec.addGps({ ...run[run.length - 1], t: 999, v: 25 / 3.6 });
  assert.equal(rec.state, 'done');
  const res = analyzeRun(rec.result().gps);
  assert.ok(res.ok, res.reason);
});

test('rutt: omsampling, kartmatchning och lutning', () => {
  const { coords } = demoData();
  const r = buildRoute(coords);
  assert.ok(Math.abs(r.length - (1400 + Math.PI * 35 / 2 + 2400)) < 30, `length ${r.length}`);
  const [lat, lon] = r.proj.toLL(5, 600);
  const m = matchToRoute(r, lat, lon);
  assert.ok(Math.abs(m.s - 600) < 1);
  assert.ok(Math.abs(m.dist - 5) < 0.5);
  // Nedförsbacken
  const sDown = 1400 + 55 + 1200;
  assert.ok(gradeAt(r, sDown) < -0.03, `grade ${gradeAt(r, sDown)}`);
  assert.ok(Math.abs(gradeAt(r, 300)) < 0.001);
});

test('kurva hittas med rimlig fart', () => {
  const { coords } = demoData();
  const r = buildRoute(coords);
  const c = curveTargets(r, 2.5);
  assert.equal(c.length, 1);
  assert.ok(c[0].s > 1350 && c[0].s < 1430, `s=${c[0].s}`);
  const kmh = c[0].v * 3.6;
  assert.ok(kmh > 25 && kmh < 40, `${kmh} km/h`);
});

test('gränser och fartmål ur OSM-data', () => {
  const { coords, elements } = demoData();
  const r = buildRoute(coords);
  const L = assignLimits(r, elements);
  assert.equal(L[Math.round(500 / r.step)], 70);   // korsande 30-väg ignoreras vid 900 m
  assert.equal(L[Math.round(900 / r.step)], 70);
  assert.equal(L[Math.round(2000 / r.step)], 50);
  assert.equal(L[Math.round(3000 / r.step)], 70);
  assert.equal(L[r.n - 1], 40);
  const t = buildTargets(r, elements, L, { aLat: 2.5, giveWayKmh: 20, roundaboutKmh: 25 });
  const kinds = countKinds(t);
  assert.equal(kinds.traffic_signals, 1, JSON.stringify(t));
  assert.equal(kinds.roundabout, 1);
  assert.equal(kinds.give_way, 1);
  assert.equal(kinds.curve, 1);
  assert.ok(kinds.limit >= 2);
  assert.equal(t[t.length - 1].kind, 'end');
  const tl = t.find(x => x.kind === 'traffic_signals');
  assert.ok(Math.abs(tl.s - 900) < 2);
});

test('mergeTargets behåller tidigaste läge och lägsta fart', () => {
  const m = mergeTargets([{ s: 100, v: 5, kind: 'a' }, { s: 120, v: 0, kind: 'b' }, { s: 300, v: 3, kind: 'c' }]);
  assert.equal(m.length, 2);
  assert.equal(m[0].s, 100);
  assert.equal(m[0].v, 0);
  assert.equal(m[0].kind, 'b');
});

test('körning på demorutten: signaler ges före varje fartmål och följs', () => {
  const { coords, elements } = demoData();
  const r = buildRoute(coords);
  const L = assignLimits(r, elements);
  const targets = buildTargets(r, elements, L, { aLat: 2.5, giveWayKmh: 20, roundaboutKmh: 25 });
  const eng = new DriveEngine(r, targets, model, { marginS: 1.5 });
  const car = new SimCar(r, L, model, { startV: 0 });
  const releases = [];
  let arrived = null;
  for (let i = 0; i < 3000 && !arrived; i++) {
    const obs = car.step(1, targets);
    const { events } = eng.update(obs);
    for (const e of events) {
      if (e.type === 'release') { releases.push({ s: obs.lat && eng.s, e }); car.onRelease(e.target); }
      if (e.type === 'arrived') arrived = e.stats;
    }
  }
  assert.ok(arrived, 'kom fram');
  assert.ok(releases.length >= 5, `releases ${releases.length}`);
  for (const r0 of releases) assert.ok(r0.s < r0.e.target.s, 'signal före målet');
  assert.ok(arrived.followed >= arrived.signals - 1, JSON.stringify(arrived));
  assert.ok(releaseMessage(releases[0].e).startsWith('Släpp'));
});

test('fartmål som kommer under körningen används, och redan signalerade mål upprepas inte', () => {
  const { coords, elements } = demoData();
  const r = buildRoute(coords);
  const L = assignLimits(r, elements);
  const full = buildTargets(r, elements, L, { aLat: 2.5, giveWayKmh: 20, roundaboutKmh: 25 });
  // Bara de första 400 m med vägdata, resten kurvor
  const near = elements.filter(el => {
    const p = el.type === 'node' ? el : el.geometry[0];
    const m = matchToRoute(r, p.lat, p.lon);
    return m && m.s < 400;
  });
  const partial = buildTargets(r, near, assignLimits(r, near), { aLat: 2.5, giveWayKmh: 20, roundaboutKmh: 25 });
  assert.ok(partial.length < full.length, `${partial.length} < ${full.length}`);
  const eng = new DriveEngine(r, partial, model, { marginS: 1.5 });
  const car = new SimCar(r, L, model, { startV: 0 });
  const fired = [];
  let swapped = false, arrived = null;
  for (let i = 0; i < 3000 && !arrived; i++) {
    const obs = car.step(1, full);
    if (!swapped && eng.s > 300) { eng.setTargets(full); swapped = true; }
    for (const e of eng.update(obs).events) {
      if (e.type === 'release') { fired.push(e.target.s); car.onRelease(e.target); }
      if (e.type === 'arrived') arrived = e.stats;
    }
  }
  assert.ok(swapped && arrived);
  for (let i = 1; i < fired.length; i++) assert.ok(fired[i] - fired[i - 1] >= 40, `dubbelsignal vid ${fired[i]}`);
  // Mål längre fram som bara finns i full data ger signal
  const late = full.filter(t => t.s > 800 && t.kind !== 'end' && !partial.some(p => Math.abs(p.s - t.s) < 40));
  if (late.length) assert.ok(late.some(t => fired.some(s => Math.abs(s - t.s) < 40)), 'nya mål signaleras');
});

test('körmotor pausar vid dålig GPS och utanför rutten', () => {
  const { coords } = demoData();
  const r = buildRoute(coords);
  const eng = new DriveEngine(r, [{ id: 0, s: r.length, v: 0, kind: 'end' }], DEFAULT_MODEL);
  const [lat, lon] = r.proj.toLL(0, 100);
  let out = eng.update({ t: 0, lat, lon, speed: 15, accuracy: 80 });
  assert.equal(out.view.mode, 'paused');
  assert.equal(out.events[0].type, 'pause');
  out = eng.update({ t: 1, lat, lon, speed: 15, accuracy: 5 });
  assert.equal(out.events[0].type, 'resume');
  const [la2, lo2] = r.proj.toLL(200, 120);
  for (let t = 2; t < 8; t++) out = eng.update({ t, lat: la2, lon: lo2, speed: 15, accuracy: 5 });
  assert.equal(out.view.paused, 'offroute');
});

test('decel är positiv på plan väg', () => {
  assert.ok(decel(20, 0, DEFAULT_MODEL) > 0);
});

import { curveSpeedForRadius, comfortLatAccel } from '../js/route.js';

test('rekommenderad kurvfart: lagom sidokraft, mindre i hög fart', () => {
  const g = 9.81, base = 0.25 * g;
  const v35 = curveSpeedForRadius(35, base) * 3.6;
  assert.ok(v35 > 30 && v35 < 36, `R=35: ${v35}`);
  const v400 = curveSpeedForRadius(400, base);
  const aUsed = v400 * v400 / 400;
  assert.ok(Math.abs(aUsed - comfortLatAccel(v400, base)) < 0.01, 'självkonsistent');
  assert.ok(aUsed < base, 'mindre sidokraft i hög fart');
  assert.equal(curveSpeedForRadius(Infinity, base), Infinity);
  const { coords } = demoData();
  const c = curveTargets(buildRoute(coords), base)[0];
  assert.ok(c.sEnd > c.s && c.radius > 25 && c.radius < 50, JSON.stringify(c));
  assert.equal(c.dir, 'right');
});

test('under rullning varnar motorn för broms om modellen visar att farten inte räcker', async () => {
  const { DriveEngine } = await import('../js/drive.js');
  const { buildRoute } = await import('../js/route.js');
  const coords = [];
  for (let i = 0; i <= 60; i++) coords.push([18 + i * 0.0009, 59]); // rak väg ca 3 km österut
  const route = buildRoute(coords);
  const target = { s: 2000, v: 30 / 3.6, kind: 'limit', id: 1 };
  const e = new DriveEngine(route, [target], { A: 0.15, C: 0.00025 }, { marginS: 0 });
  const at = s => { const f = s / route.length; return { lat: 59, lon: 18 + f * 60 * 0.0009 }; };
  let t = 0, view;
  for (let s = 0; s < 1990; s += 25) {
    t += 1;
    ({ view } = e.update({ t, ...at(s), speed: 80 / 3.6, accuracy: 5 }));
    if (view.mode === 'coasting') break;
  }
  assert.equal(view.mode, 'coasting');
  assert.ok(!view.brakeNeeded);
  // Bilen rullar lättare än modellen trodde: modellen justeras, farten räcker inte längre utan broms
  e.model = { A: 0.02, C: 0.0001 };
  t += 1;
  ({ view } = e.update({ t, ...at(e.s + 20), speed: 78 / 3.6, accuracy: 5 }));
  assert.equal(view.mode, 'coasting');
  assert.ok(view.brakeNeeded);
});
