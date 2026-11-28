import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DriveLog, makeLogStore, SAMPLE_FIELDS } from '../js/logbook.js';

function memStorage(limitBytes = Infinity) {
  const m = new Map();
  const size = () => [...m.values()].reduce((a, v) => a + v.length, 0);
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { const old = m.get(k) || ''; if (size() - old.length + v.length > limitBytes) throw new Error('QuotaExceeded'); m.set(k, v); },
    removeItem: k => m.delete(k),
    map: m,
  };
}

function hourLog() {
  const l = new DriveLog({ kind: 'drive', dest: { name: 'Test' } }, 1_700_000_000_000);
  for (let t = 0; t < 3600; t++) {
    l.sample(1000 + t, { s: t * 20, lat: 57.7 + t * 1e-5, lon: 11.9, kmh: 72.3, acc: 4, mode: 'free', limit: 70, g: 0.123456, side: -0.1, rel: null });
    if (t % 120 === 0) l.event(1000 + t, 'release', { kind: 'traffic_signals', targetS: t * 20 + 400, late: false });
  }
  l.finish({ signals: 30, followed: 28, distance: 72000 });
  return l;
}

test('kompakt logg är liten nog att klistra in', () => {
  const l = hourLog();
  const compact = JSON.stringify(l.toJSON());
  const full = JSON.stringify(l.toJSON({ full: true }));
  assert.ok(compact.length < 60000, `kompakt ${compact.length} B`);
  assert.ok(full.length > compact.length * 3);
  const j = JSON.parse(compact);
  assert.deepEqual(j.samples.fields, SAMPLE_FIELDS);
  assert.equal(j.events.length, 30);
  assert.equal(j.samples.rows[0][0], 0);              // tid från start
  assert.equal(j.samples.rows[0][8], 0.123);           // avrundad sidokraft
});

test('högst en mätpunkt per sekund', () => {
  const l = new DriveLog({ kind: 'drive' });
  for (let i = 0; i < 100; i++) l.sample(i * 0.25, { s: i });
  assert.equal(l.rows.length, 25);
});

test('lagring: spara, lista, läsa, radera och rensa äldsta när det är fullt', () => {
  const st = memStorage(400_000);
  const store = makeLogStore(st, { max: 3 });
  const logs = [];
  for (let i = 0; i < 5; i++) {
    const l = new DriveLog({ kind: 'drive', dest: { name: `Resa ${i}` } }, 1_700_000_000_000 + i * 1000);
    for (let t = 0; t < 300; t++) l.sample(t, { s: t, kmh: 50 });
    l.finish({ distance: 300 });
    assert.equal(store.save(l), true);
    logs.push(l);
  }
  const list = store.list();
  assert.equal(list.length, 3);
  assert.equal(list[0].title, 'Resa 4');               // nyast först
  const back = store.load(list[0].id);
  assert.equal(back.rows.length, 300);
  store.remove(list[0].id);
  assert.equal(store.list().length, 2);

  // Litet utrymme: äldsta loggar får ge plats
  const tiny = makeLogStore(memStorage(1_000_000), { max: 10 });
  for (let i = 0; i < 6; i++) {
    const l = hourLog(); l.id += i; l.startedAt += i;
    assert.equal(tiny.save(l), true, `logg ${i}`);
  }
  assert.ok(tiny.list().length < 6);
});

test('alla fält sparas, tomma fält i slutet tas bort', () => {
  const l = new DriveLog({ kind: 'drive' });
  l.sample(0, { s: 1, kmh: 10, mode: 'free' });
  l.sample(1, {
    s: 2, kmh: 20, mode: 'approach', heading: 59.4, lonG: -0.031, coastAdj: 0.05,
    pedal: 0, rpm: 1100, obdKmh: 20, pedalRaw: 14.9, gas: false, fuelLh: 0, maf: 3.21, fuelCut: true, gasRec: 12.4, gasLo: 9.4, gasHi: 15.4, gasKind: 'hold', coolant: 82.4, load: 31.25, other: { oilC: 88 },
  });
  assert.equal(l.rows[0].length, 7);                    // slutar vid mode
  const f = n => l.rows[1][SAMPLE_FIELDS.indexOf(n)];
  assert.equal(l.rows[1].length, SAMPLE_FIELDS.length);
  assert.equal(f('heading'), 59);
  assert.equal(f('lonG'), -0.031);
  assert.equal(f('coastAdj'), 0.05);
  assert.equal(f('pedalRaw'), 14.9);
  assert.equal(f('gas'), 0);
  assert.equal(f('maf'), 3.2);
  assert.equal(f('fuelCut'), 1);
  assert.equal(f('gasRec'), 12.4);
  assert.equal(f('gasKind'), 'hold');
});

test('kompakt: korta körningar får alla mätpunkter, långa behåller lägesbyten', () => {
  const short = new DriveLog({ kind: 'drive' });
  for (let t = 0; t < 300; t++) short.sample(t, { s: t, mode: 'free' });
  assert.equal(short.toJSON().samples.rows.length, 300);
  const long = new DriveLog({ kind: 'drive' });
  for (let t = 0; t < 2000; t++) long.sample(t, { s: t, mode: t === 1001 ? 'approach' : 'free' });
  const rows = long.toJSON().samples.rows;
  assert.ok(rows.some(r => r[0] === 1001 && r[6] === 'approach'));
  assert.ok(rows.some(r => r[0] === 1002));            // tillbaka till free
  assert.ok(rows.length < 420);
});

test('övriga OBD-värden följer med till nästa mätpunkt i kompakt logg', () => {
  const l = new DriveLog({ kind: 'drive' });
  for (let t = 0; t < 1000; t++) l.sample(t, { s: t, mode: 'free', coolant: 80, load: 30, other: t === 3 ? { oilC: 90 } : t === 7 ? { baroKpa: 99 } : null });
  const full = l.toJSON({ full: true }).samples;
  const oi = full.fields.indexOf('other');
  assert.deepEqual(full.rows[3][oi], { oilC: 90 });
  assert.equal(full.rows[4][oi], undefined);              // tomt fält i slutet utelämnas
  const rows = l.toJSON().samples.rows;
  assert.deepEqual(rows[1][oi], { oilC: 90 });            // t = 5
  assert.deepEqual(rows[2][oi], { baroKpa: 99 });         // t = 10
  assert.equal(rows[1][full.fields.indexOf('coolant')], 80);
});
