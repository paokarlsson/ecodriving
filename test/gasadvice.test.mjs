import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PedalModel, recommendGas, gasWithin, gasHint, typicalCruise, GAS } from '../js/gasadvice.js';

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
