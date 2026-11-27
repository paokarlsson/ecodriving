import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRoute } from '../js/route.js';
import { DriveEngine, travelHeading } from '../js/drive.js';
import { DEFAULT_MODEL } from '../js/physics.js';
import { getRoute } from '../js/api.js';
import { demoData } from '../js/demo.js';

// Demobanan börjar med 1400 m rakt norrut från (0, 0).
function engine() {
  const r = buildRoute(demoData().coords);
  return { r, eng: new DriveEngine(r, [{ id: 0, s: r.length, v: 0, kind: 'end' }], DEFAULT_MODEL) };
}
function drive(r, eng, x, y, { heading = 0, accuracy = 5, speed = 15, from = 0, to = 8 } = {}) {
  let out;
  for (let t = from; t < to; t++) {
    const [lat, lon] = r.proj.toLL(x, y + t * speed);
    out = eng.update({ t, lat, lon, speed, accuracy, heading });
  }
  return out;
}

test('parallell väg 30 m bort räknas som avvikelse vid god GPS', () => {
  const { r, eng } = engine();
  assert.equal(drive(r, eng, 30, 100).view.paused, 'offroute');
});

test('30 m från rutten vid dålig GPS är inte avvikelse', () => {
  const { r, eng } = engine();
  assert.equal(drive(r, eng, 30, 100, { accuracy: 20 }).view.paused, null);
});

test('kurs som pekar en annan väg räknas som avvikelse', () => {
  const { r, eng } = engine();
  // Nära rutten men på väg österut, t.ex. en avfart
  const out = drive(r, eng, 10, 100, { heading: 90 });
  assert.equal(out.view.paused, 'offroute');
  const offroute = [];
  const { r: r2, eng: e2 } = engine();
  for (let t = 0; t < 8; t++) {
    const [lat, lon] = r2.proj.toLL(0, 100 + t * 15);
    offroute.push(...e2.update({ t, lat, lon, speed: 15, accuracy: 5, heading: 0 }).events.filter(e => e.type === 'offroute'));
  }
  assert.equal(offroute.length, 0, 'rätt kurs på rutten ger ingen avvikelse');
});

test('kursen jämförs inte vid låg fart', () => {
  const { r, eng } = engine();
  assert.equal(drive(r, eng, 0, 100, { heading: 180, speed: 3 }).view.paused, null);
});

test('färdriktning ur GPS-kurs eller ur tidigare positioner', () => {
  const r = buildRoute(demoData().coords);
  const at = (t, x, y, extra = {}) => { const [lat, lon] = r.proj.toLL(x, y); return { t, lat, lon, accuracy: 5, ...extra }; };
  assert.equal(travelHeading([], at(10, 0, 0, { heading: 123, speed: 10 })), 123);
  const trail = [at(0, 0, 0), at(3, 15, 0), at(5, 25, 0)];
  const h = travelHeading(trail, at(6, 40, 0, { heading: null, speed: 2 }));
  assert.ok(Math.abs(h - 90) < 1, `${h}`);
  assert.equal(travelHeading([at(0, 0, 0)], at(30, 40, 0)), null, 'för gamla positioner');
  assert.equal(travelHeading([at(5, 35, 0)], at(6, 40, 0)), null, 'för kort sträcka');
});

test('ny rutt skickar färdriktningen och försöker utan om den inte går', async () => {
  const bodies = [];
  const feature = { features: [{ geometry: { coordinates: [[11, 57, 0], [11.1, 57.1, 0]] }, properties: { summary: { distance: 1, duration: 2 } } }] };
  globalThis.fetch = async (url, opts) => {
    const b = JSON.parse(opts.body);
    bodies.push(b);
    if (b.bearings) return { ok: false, status: 404, json: async () => ({ error: { message: 'Could not find routable point' } }) };
    return { ok: true, json: async () => feature };
  };
  const res = await getRoute('k', { lat: 57, lon: 11, heading: 87.6 }, { lat: 57.1, lon: 11.1 });
  assert.deepEqual(bodies[0].bearings, [[88, 45], []]);
  assert.equal(bodies[1].bearings, undefined);
  assert.equal(res.distance, 1);

  bodies.length = 0;
  await assert.rejects(getRoute('k', { lat: 57, lon: 11, heading: 10 }, { lat: 57.1, lon: 11.1 }).then(() => {
    globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
    return getRoute('k', { lat: 57, lon: 11, heading: 10 }, { lat: 57.1, lon: 11.1 });
  }), /Ogiltig API-nyckel/);
});
