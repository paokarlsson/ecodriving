import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PedalModel, FuelModel, FUEL, HillEstimate, recommendGas, gasWithin, gasHint, typicalCruise, GAS } from '../js/gasadvice.js';

test('typvärden utan inlärning', () => {
  const m = new PedalModel();
  assert.equal(m.cruise(50).learned, false);
  assert.ok(Math.abs(m.cruise(50).pct - typicalCruise(50)) < 1e-9);
});

test('lär pedalen som håller farten, och extra pedal för acceleration', () => {
  const m = new PedalModel();
  for (let i = 0; i < 20; i++) m.learn(50 + (i % 3) - 1, 0.02, 15);
  for (let i = 0; i < 20; i++) m.learn(90, -0.05, 22);
  const c = m.cruise(70);
  assert.equal(c.learned, true);
  assert.ok(c.pct > 15 && c.pct < 22, `70 km/h: ${c.pct}`);
  for (let i = 0; i < 10; i++) m.learn(50, 1.0, 15 + 20);
  assert.ok(Math.abs(m.gainPct() - 20) < 1, `gain ${m.gainPct()}`);
  const back = new PedalModel(JSON.parse(JSON.stringify(m.toJSON())));
  assert.equal(back.cruise(70).pct, c.pct);
});

test('rekommendation efter läge', () => {
  const m = new PedalModel();
  assert.equal(recommendGas(m, { kmh: 3 }).kind, 'none');
  assert.equal(recommendGas(m, { kmh: 50, mode: 'coasting', limitKmh: 50 }).kind, 'release');
  const soon = recommendGas(m, { kmh: 50, mode: 'approach', distToRelease: 90, limitKmh: 50 });
  assert.equal(soon.kind, 'release');
  assert.equal(recommendGas(m, { kmh: 50, mode: 'approach', distToRelease: 400, limitKmh: 50 }).kind, 'hold');
  assert.equal(recommendGas(m, { kmh: 58, mode: 'free', limitKmh: 50 }).kind, 'release');
  const acc = recommendGas(m, { kmh: 30, mode: 'free', limitKmh: 50 });
  assert.equal(acc.kind, 'accel');
  const hold = recommendGas(m, { kmh: 49, mode: 'free', limitKmh: 50 });
  assert.equal(hold.kind, 'hold');
  assert.ok(acc.mid > hold.mid + 8);
  // Kurvfarten går före gränsen
  assert.equal(recommendGas(m, { kmh: 45, mode: 'free', limitKmh: 70, curveKmh: 35 }).kind, 'release');
  // Uppför kräver mer
  const up = recommendGas(m, { kmh: 49, mode: 'free', limitKmh: 50, grade: 0.04 });
  assert.ok(up.mid > hold.mid + 3);
});

test('inom rekommendationen och texten', () => {
  const m = new PedalModel();
  const hold = recommendGas(m, { kmh: 49, mode: 'free', limitKmh: 50 });
  assert.equal(gasWithin(hold, hold.mid), true);
  assert.equal(gasWithin(hold, hold.hi + 8), false);
  assert.match(gasHint(hold, hold.hi + 8), /Håll 50: lätta/);
  const rel = recommendGas(m, { kmh: 50, mode: 'coasting' });
  assert.equal(gasWithin(rel, 0, true), true);
  assert.equal(gasWithin(rel, 20, false), false);
  assert.equal(gasWithin({ kind: 'none' }, 10), null);
  assert.ok(GAS.ecoAccel > 0);
});

test('med farthållaren: släpp betyder slå av farthållaren, håll bedöms inte', () => {
  const m = new PedalModel();
  const hold = recommendGas(m, { kmh: 70, mode: 'free', limitKmh: 70 });
  assert.equal(gasWithin(hold, 0, false, true), null);
  assert.match(gasHint(hold, 0, false, true), /Farthållaren/);
  const rel = recommendGas(m, { kmh: 70, mode: 'coasting' });
  assert.equal(gasWithin(rel, 0, false, true), false);
  assert.match(gasHint(rel, 0, false, true), /Slå av farthållaren/);
});

test('bränslemodellen: typvärden ur rullmodellen, inlärning per fart och för acceleration', () => {
  const m = new FuelModel(null, { A: 0.28, C: 0.00003 });
  const t60 = m.level(60), t70 = m.level(70);
  assert.equal(t60.learned, false);
  assert.ok(t60.x > 3.5 && t60.x < 5, `60 km/h: ${t60.x}`);
  assert.ok(t70.x > t60.x);
  // Lär tomgången och flödet som håller farten (uppför räknas om till plan väg)
  for (let i = 0; i < 5; i++) m.learnIdle(0.9);
  assert.ok(Math.abs(m.idleLh() - 0.9) < 0.01);
  for (let i = 0; i < 20; i++) m.learn(60, 0.02, 4.2);
  for (let i = 0; i < 20; i++) m.learn(70, 0, 4.9 + m.extra(70, 9.81 * 0.02), 0.02);
  assert.equal(m.level(65).learned, true);
  assert.ok(Math.abs(m.level(70).x - 4.9) < 0.05, `70: ${m.level(70).x}`);
  // För brant: lärs inte
  m.learn(80, 0, 15, 0.08);
  assert.equal(m.bins['80'], undefined);
  // Acceleration lär q
  for (let i = 0; i < 10; i++) m.learn(50, 1.0, m.level(50).x + 0.6 * 1.0 * 50 / 3.6);
  assert.ok(Math.abs(m.qLh() - 0.6) < 0.02, `q ${m.qLh()}`);
  const back = new FuelModel(JSON.parse(JSON.stringify(m.toJSON())), { A: 0.28, C: 0.00003 });
  assert.equal(back.level(70).x, m.level(70).x);
  // Nedför: flödet som håller farten blir aldrig negativt
  assert.equal(m.holdLh(70, -0.1), 0);
});

test('gasrådet i l/h: band, backe, och farthållaren bedöms på flödet', () => {
  const m = new FuelModel(null, { A: 0.28, C: 0.00003 });
  const hold = recommendGas(m, { kmh: 70, mode: 'free', limitKmh: 70 });
  assert.equal(hold.unit, 'lh');
  assert.equal(hold.scale, FUEL.scale);
  assert.ok(hold.hi - hold.lo >= 2 * FUEL.holdMin - 1e-9);
  const up = recommendGas(m, { kmh: 70, mode: 'free', limitKmh: 70, grade: 0.03 });
  assert.ok(up.mid > hold.mid + 1.5, `uppför ${up.mid} mot ${hold.mid}`);
  const acc = recommendGas(m, { kmh: 40, mode: 'free', limitKmh: 70 });
  assert.equal(acc.kind, 'accel');
  assert.ok(acc.mid > m.level(40).x + 3);
  assert.equal(gasWithin(hold, hold.mid, false, true), true, 'farthållaren inom flödet');
  assert.equal(gasWithin(hold, hold.hi + 2, false, true), false);
  assert.match(gasHint(hold, hold.hi + 2, false, true), /farthållaren drar mycket/);
  const rel = recommendGas(m, { kmh: 70, mode: 'coasting' });
  assert.equal(gasWithin(rel, 0, true), true);
  assert.equal(gasWithin(rel, 5, false, true), false);
  assert.match(gasHint(rel, 5, false, true), /Slå av farthållaren/);
});

test('backen ur OBD: flöde med gas och inbromsning vid rullning', () => {
  const m = new FuelModel(null, { A: 0.28, C: 0.00003 });
  // Uppför 3 %: flödet som håller 70 km/h där
  const lh = m.holdLh(70, 0.03);
  assert.ok(Math.abs(m.hillWithGas(70, 0, lh) - 9.81 * 0.03) < 1e-9);
  // Rullning nedför 2 %: inbromsningen blir mindre än modellens
  const v = 70 / 3.6, a = -(0.28 + 0.00003 * v * v - 9.81 * 0.02);
  assert.ok(Math.abs(m.hillCoasting(70, a) + 9.81 * 0.02) < 1e-9);
  const h = new HillEstimate();
  for (let i = 0; i < 4; i++) h.add(0.3);
  assert.equal(h.grade(), null, 'för få mätningar');
  for (let i = 0; i < 30; i++) h.add(9.81 * 0.03);
  assert.ok(Math.abs(h.grade() - 0.03) < 0.002);
  h.add(NaN);
  h.reset();
  assert.equal(h.grade(), null);
});
