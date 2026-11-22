import { test } from 'node:test';
import assert from 'node:assert/strict';
import { yawFromGyro, LateralMeter, CurveTracker, learnALat, routeYaw, isStraightAt } from '../js/lateral.js';
import { buildRoute, curveTargets } from '../js/route.js';
import { demoData } from '../js/demo.js';

const G = 9.81;

test('vridhastighet kring lodlinjen oavsett telefonens vinkel', () => {
  assert.ok(Math.abs(yawFromGyro({ alpha: 10, beta: 0, gamma: 0 }, [0, 0, 9.81]) - 10 * Math.PI / 180) < 1e-9);
  // Telefon lutad 60° i hållaren: samma sväng syns på två axlar
  const c = Math.cos(60 * Math.PI / 180), s = Math.sin(60 * Math.PI / 180);
  const grav = [0, 9.81 * s, 9.81 * c];
  const rot = { alpha: 10 * c, beta: 0, gamma: 10 * s };
  assert.ok(Math.abs(yawFromGyro(rot, grav) - 10 * Math.PI / 180) < 1e-9);
  // Rotation kring en vågrät axel (gupp) ger ingen sväng
  assert.ok(Math.abs(yawFromGyro({ alpha: 0, beta: 20, gamma: 0 }, [0, 0, 9.81])) < 1e-9);
});

test('mätaren lär sig nollpunkten på raksträcka', () => {
  const m = new LateralMeter();
  m.setSpeed(20);
  m.setStraight(true);
  for (let i = 0; i < 3000; i++) m.addMotion({ t: i * 0.02, rot: { alpha: 0.5, beta: 0, gamma: 0 }, gx: 0, gy: 0, gz: 9.81 });
  assert.ok(Math.abs(m.current().yaw) < 0.001, `yaw ${m.current().yaw}`);
  m.setStraight(false);
  for (let i = 3000; i < 3200; i++) m.addMotion({ t: i * 0.02, rot: { alpha: 10.5, beta: 0, gamma: 0 }, gx: 0, gy: 0, gz: 9.81 });
  const g = m.current().g;
  assert.ok(Math.abs(g - 20 * 10 * Math.PI / 180 / G) < 0.01, `g ${g}`);
});

function driveCurve(kmh) {
  const { coords } = demoData();
  const r = buildRoute(coords);
  const curves = curveTargets(r, 0.25 * G);
  const tr = new CurveTracker(r, curves, 0.25 * G);
  const m = new LateralMeter();
  const v = kmh / 3.6;
  let rec = null, t = 0;
  for (let s = 1200; s < 1700 && !rec; s += v * 0.05) {
    t += 0.05;
    m.setSpeed(v);
    m.addYaw(t, routeYaw(r, s, v), 0.05);
    tr.sample(t, m.current().a, v, m.current().yaw);
    for (const e of tr.update(s, t, v, m)) if (e.type === 'exit') rec = e.record;
  }
  return { rec, curve: curves[0], r };
}

test('för fort genom kurvan ger fråga, rätt fart gör det inte', () => {
  const fast = driveCurve(42).rec;
  assert.ok(fast.valid, fast.reason);
  assert.ok(fast.peakG > fast.plannedG * 1.15, `${fast.peakG} vs ${fast.plannedG}`);
  assert.equal(fast.ask, true);
  assert.ok(Math.abs(fast.gyroTurn - 90) < 20, `sväng ${fast.gyroTurn}`);
  const ok = driveCurve(31).rec;
  assert.equal(ok.ask, false, `${ok.peakG} vs ${ok.plannedG}`);
});

test('gyro som inte stämmer med kartan underkänns', () => {
  const { coords } = demoData();
  const r = buildRoute(coords);
  const curves = curveTargets(r, 0.25 * G);
  const tr = new CurveTracker(r, curves, 0.25 * G);
  const m = new LateralMeter();
  let rec = null, t = 0;
  for (let s = 1300; s < 1600 && !rec; s += 0.5) {
    t += 0.05; m.setSpeed(10);
    m.addYaw(t, routeYaw(r, s, 10) * 0.4, 0.05); // lös hållare: bara 40 % av svängen syns
    tr.sample(t, m.current().a, 10, m.current().yaw);
    for (const e of tr.update(s, t, 10, m)) if (e.type === 'exit') rec = e.record;
  }
  assert.equal(rec.valid, false);
  assert.equal(rec.ask, false);
});

test('inlärning: snabbt ner, långsamt upp (designens exempel)', () => {
  const rec = g => ({ peakG: g, speedAtPeak: 40 / 3.6 });
  let a = 0.25 * G;
  a = learnALat(a, rec(0.31), 'ok'); assert.ok(Math.abs(a / G - 0.268) < 0.001, a / G);
  a = learnALat(a, rec(0.30), 'ok'); assert.ok(Math.abs(a / G - 0.2776) < 0.001, a / G);
  a = learnALat(a, rec(0.29), 'too_much'); assert.ok(Math.abs(a / G - 0.27) < 0.001, a / G);
  a = learnALat(a, rec(0.28), 'ok'); assert.ok(Math.abs(a / G - 0.273) < 0.001, a / G);
  // Ett okej vid mycket hög kraft höjer högst 0,02 g
  assert.ok(Math.abs(learnALat(0.25 * G, rec(0.47), 'ok') / G - 0.27) < 1e-9);
  // Okej under nuvarande nivå höjer inte
  assert.equal(learnALat(a, rec(0.2), 'ok'), a);
  // Gränser
  assert.ok(learnALat(0.25 * G, rec(0.1), 'too_much') >= 0.15 * G - 1e-9);
  // Svar i hög fart räknas om till grundnivån (högre)
  const fast = learnALat(0.25 * G, { peakG: 0.2, speedAtPeak: 110 / 3.6 }, 'ok');
  assert.ok(fast > 0.25 * G, 'okej vid 0,2 g i 110 km/h motsvarar > 0,25 g i låg fart');
});

test('raksträcka känns igen', () => {
  const { coords } = demoData();
  const r = buildRoute(coords);
  assert.equal(isStraightAt(r, 500), true);
  assert.equal(isStraightAt(r, 1420), false);
});
