import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CoastSaving } from '../js/fuelsave.js';

const hold = () => 5; // l/h som håller farten

test('rullning: från släppt gas till gas igen; sparat = hålla farten samma sträcka minus det som gick åt', () => {
  const c = new CoastSaving();
  assert.equal(c.update({ t: 0, released: false, s: 900, v: 20, fuelL: 0.49 }), null);
  c.update({ t: 1, released: true, s: 1000, v: 20, fuelL: 0.5 });
  assert.equal(c.update({ t: 10, released: true, s: 1200, v: 18, fuelL: 0.5003 }), null);
  assert.equal(c.update({ t: 20, released: false, s: 1400, v: 15, fuelL: 0.5005 }), 'gas');
  const r = c.end({ s: 1400, fuelL: 0.5005, holdLh: hold, reason: 'gas' });
  // 400 m i 20 m/s = 20 s med 5 l/h = 27,8 ml
  assert.ok(Math.abs(r.altL - 5 * 20 / 3600) < 1e-9);
  assert.ok(Math.abs(r.savedL - (5 * 20 / 3600 - 0.0005)) < 1e-9);
  assert.equal(r.signal, false);
  assert.ok(Math.abs(c.totalL() - r.savedL) < 1e-12);
  assert.equal(c.signalL(), 0);
});

test('rullning efter en signal räknas som följd; stopp avslutar', () => {
  const c = new CoastSaving();
  c.signal(5, 'curve');
  c.update({ t: 6.2, released: true, s: 0, v: 20, fuelL: 0 });
  assert.equal(c.update({ t: 30, released: true, s: 300, v: 1, fuelL: 0 }), 'stopp');
  const r = c.end({ s: 300, fuelL: 0, holdLh: hold });
  assert.equal(r.signal, true);
  assert.equal(r.kind, 'curve');
  assert.ok(c.signalL() > 0);
  // Långt efter signalen: inte följd
  c.update({ t: 60, released: true, s: 1000, v: 20, fuelL: 0 });
  assert.equal(c.cur.signal, false);
});

test('för kort, för låg fart eller avbruten räknas inte', () => {
  const c = new CoastSaving();
  c.update({ t: 0, released: true, s: 0, v: 20, fuelL: 0 });
  assert.equal(c.end({ s: 10, fuelL: 0, holdLh: hold }), null, 'för kort');
  c.update({ t: 0, released: true, s: 0, v: 3, fuelL: 0 });
  assert.equal(c.cur, null, 'för låg fart');
  c.update({ t: 0, released: true, s: 0, v: 20, fuelL: null });
  assert.equal(c.cur, null, 'bränslet okänt');
  c.update({ t: 0, released: true, s: 0, v: 20, fuelL: 0 });
  c.abort();
  assert.equal(c.cur, null);
  assert.equal(c.list.length, 0);
});

test('rullning: backen skickas med till flödet som håller farten', () => {
  const c = new CoastSaving();
  let got = null;
  c.update({ t: 0, released: true, s: 0, v: 20, fuelL: 0 });
  const r = c.end({ s: 200, fuelL: 0, grade: -0.05, holdLh: (k, g) => { got = [k, g]; return 0; } });
  assert.deepEqual(got, [72, -0.05]);
  assert.equal(r.savedL, 0, 'nedför hade farten hållits utan bränsle');
});

test('rullning med tomgångsbränsle utför ger aldrig negativ besparing', () => {
  const c = new CoastSaving();
  c.update({ t: 0, released: true, s: 0, v: 8, fuelL: 0 });
  const r = c.end({ s: 150, fuelL: 0.005, holdLh: () => 0.2 });
  assert.equal(r.savedL, 0);
});
