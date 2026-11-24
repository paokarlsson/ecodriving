import { test } from 'node:test';
import assert from 'node:assert/strict';
import { yawFromGyro, LateralMeter, CurveTracker, routeYaw, isStraightAt } from '../js/lateral.js';
import { buildRoute, curveTargets } from '../js/route.js';
import { demoData } from '../js/demo.js';

const G = 9.81;
const DEGR = Math.PI / 180;

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
    m.addYaw(t, routeYaw(r, s, v, 10), 0.05);
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
    m.addYaw(t, routeYaw(r, s, 10, 10) * 0.4, 0.05); // lös hållare: bara 40 % av svängen syns
    tr.sample(t, m.current().a, 10, m.current().yaw);
    for (const e of tr.update(s, t, 10, m)) if (e.type === 'exit') rec = e.record;
  }
  assert.equal(rec.valid, false);
  assert.equal(rec.ask, false);
});

test('raksträcka känns igen', () => {
  const { coords } = demoData();
  const r = buildRoute(coords);
  assert.equal(isStraightAt(r, 500), true);
  assert.equal(isStraightAt(r, 1420), false);
});

test('bollen: vänstersväng trycker åt höger, tecknet lärs av rutten', () => {
  // Android-gyro: positiv rotation = vänster. Rutten säger vänstersväng (negativ högerrate).
  const m = new LateralMeter();
  m.setSpeed(15);
  for (let i = 0; i < 100; i++) {
    m.addYaw(i * 0.02, 0.2, 0.02);      // gyrot: +0,2 rad/s
    m.learnSign(-0.2);                   // rutten: vänster
  }
  assert.equal(m.sign, -1);
  assert.ok(m.current().side > 0.2, `side ${m.current().side}`); // kraft åt höger
  // iPhone-liknande omvänt tecken: samma vänstersväng, gyrot säger -0,2
  const i = new LateralMeter();
  i.setSpeed(15);
  for (let k = 0; k < 100; k++) { i.addYaw(k * 0.02, -0.2, 0.02); i.learnSign(-0.2); }
  assert.equal(i.sign, 1);
  assert.ok(i.current().side > 0.2);
  // Rakt fram: mitten
  const r = new LateralMeter();
  r.setSpeed(20);
  assert.equal(Math.abs(r.current().side), 0);
});

/**
 * Kör en bil med 50 Hz-gyro och GPS en gång i sekunden. turnRate(t) = sann
 * vridhastighet (rad/s, höger positiv). mapRot(degRight) ger webbläsarens
 * rotationRate för en sväng åt höger med degRight grader/s.
 */
function driveWithGps(m, { grav, mapRot, turnRate, seconds = 400, v = 12 }) {
  let t = 0, acc = 0;
  m.setSpeed(v);
  for (let sec = 0; sec < seconds; sec++) {
    for (let k = 0; k < 50; k++) {
      const w = turnRate(t);
      m.addMotion({ t, rot: mapRot(w * 180 / Math.PI), ...grav });
      acc += w * 0.02;
      t += 0.02;
    }
    m.learnInterval(acc); // GPS-kursens ändring sedan förra positionen
    acc = 0;
  }
  return t;
}
const kurvor = t => { const p = t % 40; return p < 8 ? 0.25 * Math.sin(p / 8 * Math.PI) * (Math.floor(t / 40) % 2 ? -1 : 1) : 0; };

test('gyrot lär sig axeln när webbläsaren lägger svängen i fel värde (som telefonen i loggen)', () => {
  // Telefonen lutad 55° bakåt: uppåt i telefonen = (0; 0,57; 0,82).
  // Sväng höger = negativ rotation kring uppåt. Webbläsaren lägger x-rotationen
  // i alpha, y i gamma och z i beta (det inspelningen visade).
  const up = [0, Math.cos(55 * DEGR), Math.sin(55 * DEGR)];
  const grav = { gx: 9.81 * up[0], gy: 9.81 * up[1], gz: 9.81 * up[2] };
  const mapRot = d => { const w = up.map(u => -d * u); return { alpha: w[0], gamma: w[1], beta: w[2] }; };
  const m = new LateralMeter();
  driveWithGps(m, { grav, mapRot, turnRate: kurvor, seconds: 30 });
  // Före inlärning (standardordning): för lite eller fel
  driveWithGps(m, { grav, mapRot, turnRate: kurvor, seconds: 400 });
  assert.ok(m.axis, 'axeln inlärd');
  assert.ok(m.axisR2 > 0.95, `R² ${m.axisR2}`);
  // Mät en stadig högersväng på 0,2 rad/s
  for (let k = 0; k < 200; k++) m.addMotion({ t: 1e4 + k * 0.02, rot: mapRot(0.2 * 180 / Math.PI), ...grav });
  const c = m.current();
  assert.ok(Math.abs(c.yaw - 0.2) < 0.01, `yaw ${c.yaw}`);
  assert.ok(c.side < 0, 'högersväng trycker åt vänster');
});

test('gyrot klarar rad/s i stället för grader/s', () => {
  const grav = { gx: 0, gy: 0, gz: 9.81 };
  const mapRot = d => ({ alpha: -d * Math.PI / 180, beta: 0, gamma: 0 });
  const m = new LateralMeter();
  driveWithGps(m, { grav, mapRot, turnRate: kurvor, seconds: 400 });
  for (let k = 0; k < 200; k++) m.addMotion({ t: 1e4 + k * 0.02, rot: mapRot(0.15 * 180 / Math.PI), ...grav });
  assert.ok(Math.abs(m.current().yaw - 0.15) < 0.01, `${m.current().yaw}`);
});

test('inlärningen tål att GPS-kursen är brusig och att gyrot har en nollpunkt', () => {
  const grav = { gx: 0, gy: 9.81, gz: 0 };
  const mapRot = d => ({ alpha: 0, beta: 0.3, gamma: -d });   // standard, med nollpunktsfel 0,3°/s på x
  const m = new LateralMeter();
  let seed = 3;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 - 0.5; };
  let t = 0, acc = 0;
  m.setSpeed(12);
  for (let sec = 0; sec < 500; sec++) {
    for (let k = 0; k < 50; k++) { const w = kurvor(t); m.addMotion({ t, rot: mapRot(w * 180 / Math.PI), ...grav }); acc += w * 0.02; t += 0.02; }
    m.learnInterval(acc + rnd() * 0.03);  // ±1° brus i GPS-kursen
    acc = 0;
  }
  assert.ok(m.axis);
  const k = Math.hypot(...m.axis) * 180 / Math.PI;
  assert.ok(Math.abs(k - 1) < 0.1, `skala ${k}`);
});

test('stötar mot telefonen ignoreras', () => {
  const m = new LateralMeter();
  m.setSpeed(25);
  for (let i = 0; i < 50; i++) m.addMotion({ t: i * 0.02, rot: { alpha: 0, beta: 0, gamma: 0 }, gx: 0, gy: 0, gz: 9.81 });
  m.addMotion({ t: 1.0, rot: { alpha: 400, beta: 300, gamma: 0 }, gx: 0, gy: 0, gz: 9.81 });
  assert.ok(m.current().g < 0.05, `${m.current().g}`);
});

test('curveRadiusText: kartans radie och uppmätt radie', async () => {
  const { curveRadiusText } = await import('../js/lateral.js');
  assert.equal(curveRadiusText({ radius: 84, radiusMeas: 91.2, valid: true }), 'R 85 m (kört 90 m)');
  assert.equal(curveRadiusText({ radius: 141, radiusMeas: 150, valid: false }), 'R 140 m');
  assert.equal(curveRadiusText({ radius: 60, radiusMeas: null, valid: true }), 'R 60 m');
  assert.equal(curveRadiusText({ radius: 300, radiusMeas: 5000, valid: true }), 'R 300 m');
});
