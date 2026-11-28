import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DriveEngine } from '../js/drive.js';
import { buildRoute, latLonAt } from '../js/route.js';
import { makeProjector } from '../js/geo.js';

const P = makeProjector(63.15, 14.7);
const line = (y0, y1) => [[0, y0], [0, y1]].map(([x, y]) => { const [lat, lon] = P.toLL(x, y); return [lon, lat]; });
const light = (route, s) => { const [lat, lon] = latLonAt(route, s); return { s, v: 0, kind: 'traffic_signals', id: 0, lat, lon }; };

test('utan resmål: aldrig framme, och ny väg framåt signalerar inte samma mål igen', () => {
  const r1 = buildRoute(line(0, 1500));
  const e = new DriveEngine(r1, [light(r1, 600)], { A: 0.2, C: 0.00025 }, { marginS: 1.5, endless: true });
  const obs = (y, t) => { const [lat, lon] = P.toLL(0, y); return { t, lat, lon, speed: 14, accuracy: 4 }; };
  let fired = 0, t = 0;
  for (let y = 0; y < 560; y += 14) {
    const { events } = e.update(obs(y, t++));
    fired += events.filter(x => x.type === 'release').length;
  }
  assert.equal(fired, 1);
  // Ny väg framåt från bilen: samma trafikljus ligger nu 40 m bort
  const r2 = buildRoute(line(560, 2000));
  e.setRoute(r2, [light(r2, 40)]);
  for (let y = 560; y < 1990; y += 14) {
    const { view, events } = e.update(obs(y, t++));
    fired += events.filter(x => x.type === 'release').length;
    assert.notEqual(view.mode, 'arrived');
  }
  assert.equal(fired, 1);
});
