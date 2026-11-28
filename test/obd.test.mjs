import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  responseLines, responseError, pidBytes, supportedFrom, decodePid, PedalTracker,
  fuelRate, ElmSession, ObdPoller, engineBraking, decodeOther, pidName,
} from '../js/obd.js';
import { DriveEngine } from '../js/drive.js';
import { buildRoute } from '../js/route.js';
import { demoData } from '../js/demo.js';
import { DEFAULT_MODEL } from '../js/physics.js';
import { CoastLearner } from '../js/coastlearn.js';

test('svarsrader utan eko, prompt och statusrader', () => {
  assert.deepEqual(responseLines('SEARCHING...\r41 0D 3C\r\r>'), ['410D3C']);
  assert.deepEqual(responseLines('NO DATA\r\r>'), ['NO DATA']);
  assert.equal(responseError(['NO DATA']), 'NO DATA');
  assert.equal(responseError(['UNABLE TO CONNECT']), 'UNABLE TO CONNECT');
  assert.equal(responseError(['410D3C']), null);
});

test('mätvärden avkodas', () => {
  assert.equal(decodePid(0x0d, pidBytes(['410D3C'], 0x0d)), 60);
  assert.equal(decodePid(0x0c, pidBytes(['410C1AF8'], 0x0c)), 1726);
  assert.equal(Math.round(decodePid(0x49, pidBytes(['414926'], 0x49))), 15);
  assert.equal(decodePid(0x10, pidBytes(['411001F4'], 0x10)), 5);
  assert.equal(decodePid(0x5e, pidBytes(['415E0064'], 0x5e)), 5);
  assert.equal(decodePid(0x03, pidBytes(['41030400'], 0x03)), 4);
  assert.equal(pidBytes(['410C1AF8'], 0x0d), null, 'fel pid');
  // Två styrdon svarar: det första används
  assert.equal(decodePid(0x0d, pidBytes(['410D3C', '410D3D'], 0x0d)), 60);
});

test('stödda pid ur bitmasken, flera styrdon slås ihop', () => {
  const sup = supportedFrom(['4100BE1FA813', '410080000001'], 0x00);
  for (const p of [0x01, 0x03, 0x04, 0x05, 0x06, 0x07, 0x0c, 0x0d, 0x10, 0x11, 0x20]) assert.ok(sup.has(p), `pid ${p.toString(16)}`);
  assert.ok(!sup.has(0x02));
  assert.ok(sup.has(0x20));
});

test('pedalen: viloläget lärs in och släppt har hysteres', () => {
  const p = new PedalTracker({ pid: 0x49 });
  p.update(15.7);                // foten borta
  assert.equal(p.released, true);
  assert.equal(Math.round(p.pct), 0);
  p.update(30);                  // gas
  assert.equal(p.released, false);
  p.update(17.5);                // mellan gränserna: fortfarande gas
  assert.equal(p.released, false);
  p.update(15.9);
  assert.equal(p.released, true);
  const rel = new PedalTracker({ pid: 0x5a });
  rel.update(0);
  assert.equal(rel.released, true);
  rel.update(25);
  assert.ok(rel.pct > 50 && !rel.released);
});

test('bränsle: flöde, luftflöde för bensin, avstängt', () => {
  assert.equal(fuelRate({ fuelLh: 4 }), 4);
  assert.ok(Math.abs(fuelRate({ maf: 5 }) - 1.64) < 0.01);
  assert.equal(fuelRate({ maf: 5, fuelType: 4 }), null, 'diesel: luftflödet räcker inte');
  assert.equal(fuelRate({ maf: 5, fuelCut: true }), 0);
  assert.ok(engineBraking({ released: true, rpm: 1800, kmh: 60 }));
  assert.ok(!engineBraking({ released: false, rpm: 1800, kmh: 60 }));
});

/** En låtsasdosa som svarar som en ELM327 med CAN. */
function fakeElm({ pedal = 0x26, sup = '4100BE1FA813', sup40 = '414000800000' } = {}) {
  let handler = () => {};
  const sent = [];
  const reply = {
    ATZ: 'ELM327 v2.3', ATE0: 'OK', ATL0: 'OK', ATS0: 'OK', ATH0: 'OK', ATAT1: 'OK', ATSP0: 'OK',
    ATI: 'ELM327 v2.3', ATDPN: 'A6', '0100': 'SEARCHING...\r' + sup, '0120': '412000000001', '0140': sup40,
    '010D': '410D3C', '010C': '410C1AF8', '0103': '41030200', '0110': '411001F4',
    '0104': '410480', '0105': '41057B', '0106': '410690', '0101': '410100076500',
  };
  const t = {
    sent,
    set pedal(v) { pedal = v; },
    async write(text) {
      const cmd = text.trim();
      sent.push(cmd);
      let r = reply[cmd];
      if (cmd === '0149') r = '4149' + pedal.toString(16).toUpperCase().padStart(2, '0');
      setTimeout(() => handler((r ?? 'NO DATA') + '\r\r>'), 1);
    },
    onText(cb) { handler = cb; },
  };
  return t;
}

test('dosan startas och bilens stöd läses', async () => {
  const tr = fakeElm({ sup: '4100BE1FA813', sup40: '414000800000' });
  const s = new ElmSession(tr);
  const info = await s.init();
  assert.equal(info.version, 'ELM327 v2.3');
  assert.equal(info.protocol, 'A6');
  assert.ok(info.supported.has(0x0d) && info.supported.has(0x0c));
  assert.equal(info.pedalPid, 0x49, 'pedal D finns (bit för 0x49 i 0140-svaret)');
  assert.equal(await s.read(0x0d), 60);
});

test('slingan ger mätvärden med pedalen', async () => {
  const tr = fakeElm({ sup40: '414000800000' });
  const s = new ElmSession(tr);
  await s.init();
  const samples = [];
  let now = 1000;
  const poller = new ObdPoller(s, x => { samples.push(x); if (samples.length >= 3) poller.stop(); }, { now: () => (now += 100) });
  await poller.loop();
  assert.equal(samples.length, 3);
  assert.equal(samples[0].kmh, 60);
  assert.equal(samples[0].rpm, 1726);
  assert.equal(samples[0].released, true);
  assert.equal(samples[0].fuelCut, false);
  assert.ok(samples[0].fuelRate > 1.6, 'beräknat ur luftflödet');
});

test('dosan som inte når bilen ger ett begripligt fel', async () => {
  const tr = fakeElm({ sup: 'UNABLE TO CONNECT' });
  await assert.rejects(new ElmSession(tr).init(), /tändningen/);
});

function engineAtSignal() {
  const r = buildRoute(demoData().coords);
  const target = { id: 1, s: 1300, v: 0, kind: 'traffic_signals' };
  const eng = new DriveEngine(r, [target, { id: 2, s: r.length, v: 0, kind: 'end' }], DEFAULT_MODEL, { marginS: 1 });
  let t = 0, y = 0, ev = [];
  // Kör norrut i 20 m/s tills släpp-signalen kommer
  while (!ev.some(e => e.type === 'release') && y < 1300) {
    const [lat, lon] = r.proj.toLL(0, y);
    eng.pedal(t, false);
    ev = eng.update({ t, lat, lon, speed: 20, accuracy: 5 }).events;
    t += 1; y += 20;
  }
  assert.ok(ev.some(e => e.type === 'release'), 'signal');
  return { r, eng, t: t - 1, y: y - 20 };
}

test('pedalen avgör när gasen släpptes efter signalen', () => {
  const { eng, t } = engineAtSignal();
  assert.deepEqual(eng.pedal(t + 0.4, false), []);
  const ev = eng.pedal(t + 0.7, true);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].type, 'follow');
  assert.equal(ev[0].byPedal, true);
  assert.ok(Math.abs(ev[0].afterS - 0.7) < 1e-9);
  assert.equal(eng.stats.followed, 1);
});

test('med pedalen räknas inte en fartminskning som släppt gas', () => {
  const { r, eng, t, y } = engineAtSignal();
  // Farten sjunker (t.ex. uppför) men pedalen är nedtryckt
  let follows = [];
  for (let k = 1; k <= 3; k++) {
    eng.pedal(t + k - 0.5, false);
    const [lat, lon] = r.proj.toLL(0, y + 18 * k);
    follows.push(...eng.update({ t: t + k, lat, lon, speed: 20 - 2 * k, accuracy: 5 }).events.filter(e => e.type === 'follow'));
  }
  assert.equal(follows.length, 0);
  // Gas igen efter släppt avbryter rullningen
  eng.pedal(t + 3.5, true);
  assert.ok(eng.coast);
  eng.pedal(t + 4, false);
  const [lat, lon] = r.proj.toLL(0, y + 70);
  const out = eng.update({ t: t + 4.2, lat, lon, speed: 14, accuracy: 5 });
  assert.notEqual(out.view.mode, 'coasting');
});

test('rullningsinlärningen avbryts när pedalen trycks ned', () => {
  const cl = new CoastLearner(DEFAULT_MODEL);
  for (let k = 0; k < 6; k++) cl.addGps({ t: k, v: 25 - 0.4 * k, grade: 0, acc: 5, ok: true });
  assert.ok(cl.seg);
  const seg = cl.addGps({ t: 6, v: 22.6, grade: 0, acc: 5, ok: true, gas: true });
  assert.ok(seg);
  assert.equal(seg.end, 'gas');
});

test('övriga värden: avkodning, namn och hex för okända', () => {
  assert.equal(decodeOther(0x05, pidBytes(['41057B'], 0x05)), 83);           // 123 − 40 °C
  assert.equal(decodeOther(0x04, [0x80]), Math.round(128 * 100 / 255 * 1000) / 1000);
  assert.equal(decodeOther(0x06, [0x90]), 12.5);                              // bränsletrim
  assert.equal(decodeOther(0xa6, [0, 0x01, 0xe2, 0x40]), 12345.6);            // mätarställning km
  assert.equal(decodeOther(0x01, [0x00, 0x07, 0x65, 0x00]), '00076500');      // statusbitar som hex
  assert.equal(pidName(0x05), 'coolantC');
  assert.equal(pidName(0xc3), 'pidC3');
});

test('slingan läser kylvätska, last och resten av det bilen redovisar', async () => {
  const tr = fakeElm({ sup40: '414000800000' });
  const s = new ElmSession(tr);
  await s.init();
  const samples = [];
  let now = 1000;
  const poller = new ObdPoller(s, x => { samples.push(x); if (samples.length >= 40) poller.stop(); }, { now: () => (now += 100) });
  await poller.loop();
  const last = samples[samples.length - 1];
  assert.equal(last.coolant, 83);
  assert.ok(Math.abs(last.load - 50.2) < 0.1);
  assert.equal(last.other.stft1Pct, 12.5);
  assert.equal(last.other.monitorStatus, '00076500');
  const extras = samples.filter(x => x.extra).map(x => x.extra.name);
  assert.ok(extras.length >= 8 && extras.length <= 20, `övriga ${extras.length}`);
  // Pid som inte svarar hoppas över efter tre försök
  const tries = tr.sent.filter(c => c === '0107').length;
  assert.ok(tries <= 3, `0107 försökt ${tries} gånger`);
  // Pedalen läses fortfarande varje varv
  assert.equal(tr.sent.filter(c => c === '0149').length, 40);
});
