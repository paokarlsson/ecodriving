import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RawRecorder, readRaw, deleteRaw, MOTION_FIELDS, GPS_FIELDS } from '../js/rawstore.js';
import { makeLogStore, DriveLog } from '../js/logbook.js';

function memSink() {
  const recs = [];
  return {
    recs,
    async put(r) { recs.push(structuredClone(r)); },
    async getAll(id) { return recs.filter(r => r.logId === id); },
    async remove(id) { for (let i = recs.length - 1; i >= 0; i--) if (recs[i].logId === id) recs.splice(i, 1); },
  };
}

test('rådata sparas i block och läses tillbaka som tabeller', async () => {
  const sink = memSink();
  const rec = new RawRecorder('logg-1', { sink, flushMs: 0 });
  const t0 = 1_800_000_000;
  for (let i = 0; i < 120; i++) {
    rec.addMotion({ t: t0 + i * 0.02, ax: 0.1, ay: -0.2, az: null, gx: 0, gy: 9.8, gz: 0.5, rot: { alpha: 1.5, beta: -0.25, gamma: 3 } });
    if (i === 60) rec.flush();
  }
  rec.addGps({ t: t0, lat: 63.1234567, lon: 14.7654321, alt: 350, accuracy: 4, speed: 25, heading: 90 });
  rec.addCompass(t0 + 0.5, 271.3);
  rec.addApi('route', { coords: [[14.7, 63.1, 300]], distance: 1000 });
  const counts = await rec.close();
  assert.deepEqual({ ...counts, error: undefined }, { motion: 120, gps: 1, compass: 1, obd: 0, obdx: 0, api: 1, error: undefined });
  const raw = await readRaw('logg-1', { sink });
  assert.deepEqual(raw.motion.fields, MOTION_FIELDS);
  assert.equal(raw.motion.rows.length, 120);
  assert.equal(raw.motion.rows[1][0], 0.02);
  assert.equal(raw.motion.rows[0][3], null);            // saknat värde
  assert.equal(raw.motion.rows[0][7], 1.5);
  assert.deepEqual(raw.gps.fields, GPS_FIELDS);
  assert.equal(raw.gps.rows[0][1], 63.1234567);          // full GPS-precision
  assert.equal(raw.api[0].kind, 'route');
  assert.equal(raw.api[0].data.distance, 1000);
  await deleteRaw('logg-1', { sink });
  assert.equal(sink.recs.length, 0);
});

test('loggar som rensas bort tar sin rådata med sig', () => {
  const m = new Map();
  const storage = { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: k => m.delete(k) };
  const removed = [];
  const store = makeLogStore(storage, { max: 2, onRemove: id => removed.push(id) });
  const ids = [];
  for (let i = 0; i < 3; i++) { const l = new DriveLog({ kind: 'recording' }, 1e12 + i); store.save(l); ids.push(l.id); }
  assert.deepEqual(removed, [ids[0]]);
  store.remove(ids[2]);
  assert.deepEqual(removed, [ids[0], ids[2]]);
});
