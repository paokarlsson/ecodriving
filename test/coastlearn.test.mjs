import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CoastLearner, CoastStats, acceptSegment, COAST } from '../js/coastlearn.js';

const G = 9.81;
const TRUE = { A: 0.34, C: 0.00045 };

/** Pseudo-slump så att testerna blir likadana varje gång. */
function rng(seed) { let s = seed; return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; }; }

/**
 * Simulerar en körning: håll farten, släpp gasen (rulla med sann modell i en
 * backe), ge gas igen. kind: 'coast' | 'neutral' (friläge, rullar lättare) | 'brake'
 */
function drive(learner, rand, { segments = 1, grade = 0, kind = 'coast', from = 90, to = 55 } = {}) {
  const out = [];
  let t = 0, v = from / 3.6;
  const step = (vNew, g) => {
    t += 1;
    v = vNew;
    const seg = learner.addGps({ t, v: v + (rand() - 0.5) * 0.2, grade: g, acc: 5, ok: true });
    if (seg) out.push(seg);
  };
  for (let n = 0; n < segments; n++) {
    for (let i = 0; i < 8; i++) step(from / 3.6, 0);                       // håll farten
    while (v > to / 3.6) {                                                 // rulla
      const model = kind === 'neutral' ? { A: 0.12, C: 0.0004 } : TRUE;
      let a = model.A + model.C * v * v + G * grade;
      if (kind === 'brake' && v < (from - 10) / 3.6) a = 3.0;
      step(v - a, grade);
    }
    for (let i = 0; i < 12 && v < from / 3.6; i++) step(Math.min(from / 3.6, v + 1.2), 0); // gas
  }
  return out;
}

test('rullning hittas, klipps vid gas och korrigeras för backen', () => {
  const L = new CoastLearner({ A: 0.24, C: 0.0003 });
  const segs = drive(L, rng(1), { segments: 2, grade: -0.02 });
  assert.equal(segs.length, 2);
  for (const s of segs) {
    assert.equal(s.ok, true, s.reason);
    assert.equal(s.end, 'gas');
    assert.ok(s.dur > 15);
    // Korrigerad inbromsning ska ligga nära sann modell trots nedförsbacken
    const meanErr = s.points.reduce((a, p) => a + (p.a - (TRUE.A + TRUE.C * p.v * p.v)), 0) / s.points.length;
    assert.ok(Math.abs(meanErr) < 0.05, `fel ${meanErr}`);
  }
});

test('broms klipper rullningen', () => {
  const L = new CoastLearner(TRUE);
  const segs = drive(L, rng(2), { kind: 'brake' });
  assert.equal(segs.length >= 1, true);
  assert.equal(segs[0].end, 'broms');
  // Inga punkter från inbromsningen
  assert.ok(segs[0].points.every(p => p.a < 1.5), JSON.stringify(segs[0].points.map(p => p.a)));
});

test('accelerometerns stöt räknas som broms', () => {
  const L = new CoastLearner(TRUE);
  let t = 0, v = 25, cut = null;
  for (let i = 0; i < 3; i++) L.addGps({ t: t++, v: (v -= 0.5), grade: 0, acc: 4, ok: true });
  for (let i = 0; i < 4; i++) L.addGps({ t: t++, v: (v -= 0.6), grade: 0, acc: 4, ok: true });
  for (let k = 0; k < 30; k++) L.addAccel(t + k * 0.02, 3.5);
  cut = L.addGps({ t: t + 0.6, v: v - 0.6, grade: 0, acc: 4, ok: true });
  assert.ok(cut);
  assert.equal(cut.end, 'broms');
});

test('rullning som är lättare än modellen (frikopplande bil) godkänns', () => {
  const L = new CoastLearner(TRUE);
  const [seg] = drive(L, rng(3), { kind: 'neutral' });
  const v = acceptSegment(seg, TRUE);
  assert.equal(v.ok, true, v.reason);
  assert.ok(v.resid < 0);
});

test('rullning utan fartförlust på plan väg (gas eller fel höjd) sorteras bort', () => {
  const seg = { ok: true, points: [{ v: 22, a: -0.2 }, { v: 21.8, a: -0.15 }, { v: 21.6, a: -0.18 }] };
  const v = acceptSegment(seg, TRUE);
  assert.equal(v.ok, false);
  assert.match(v.reason, /plan väg/);
});

test('modellen närmar sig den sanna efter många rullningar i olika backar', () => {
  const prior = { A: 0.24, C: 0.0003 };          // som i loggen: ett osäkert rullprov
  const stats = new CoastStats();
  const L = new CoastLearner(prior);
  const rand = rng(4);
  let used = 0;
  const grades = [0, 0.01, -0.01, 0.02, -0.02, 0.005, -0.015];
  for (let k = 0; k < 40; k++) {
    const segs = drive(L, rand, { grade: grades[k % grades.length], from: 80 + (k % 3) * 10, to: 45 + (k % 4) * 5 });
    for (const s of segs) {
      if (acceptSegment(s, stats.fit(prior) || prior).ok) { stats.add(s.points); used++; }
    }
    L.setModel(stats.fit(prior) || prior);
  }
  const m = stats.fit(prior);
  assert.ok(used >= 35, `använda ${used}`);
  assert.ok(Math.abs(m.A - TRUE.A) < 0.04, `A ${m.A}`);
  assert.ok(Math.abs(m.C - TRUE.C) < 0.00012, `C ${m.C}`);
});

test('en enda rullning flyttar modellen bara lite', () => {
  const prior = { A: 0.24, C: 0.0003 };
  const stats = new CoastStats();
  const L = new CoastLearner(prior);
  const [seg] = drive(L, rng(5), {});
  stats.add(seg.points);
  const m = stats.fit(prior);
  const at80 = mm => mm.A + mm.C * (80 / 3.6) ** 2;
  const moved = (at80(m) - at80(prior)) / (at80(TRUE) - at80(prior));
  assert.ok(moved > 0.05 && moved < 0.35, `flyttade ${moved}`);
  // Sparas och läses tillbaka
  const back = new CoastStats(JSON.parse(JSON.stringify(stats)));
  assert.deepEqual(back.fit(prior), m);
});

test('dålig GPS och korta rullningar ger inget', () => {
  const L = new CoastLearner(TRUE);
  let t = 0;
  assert.equal(L.addGps({ t: t++, v: 25, grade: 0, acc: 40, ok: true }), null);
  for (let i = 0; i < 4; i++) L.addGps({ t: t++, v: 25 - i * 0.5, grade: 0, acc: 4, ok: true });
  const seg = L.addGps({ t: t++, v: 26, grade: 0, acc: 4, ok: true });
  assert.ok(seg);
  assert.equal(seg.ok, false);
  assert.ok(COAST.minDur > seg.dur);
});

test('nyare rullningar väger mer: modellen följer en bil som ändrats (t.ex. vinterdäck)', () => {
  const prior = { A: 0.24, C: 0.0003 };
  const stats = new CoastStats();
  const rand = rng(11);
  const at80 = mm => mm.A + mm.C * (80 / 3.6) ** 2;
  // 40 rullningar med den sanna bilen …
  for (let k = 0; k < 40; k++) {
    const L = new CoastLearner(prior);
    for (const s of drive(L, rand, { from: 80 + (k % 3) * 10, to: 45 + (k % 4) * 5 })) stats.add(s.points);
  }
  const before = at80(stats.fit(prior));
  // … sedan rullar den tyngre (+0,12 m/s²). Efter 20 rullningar ska modellen ha följt med det mesta.
  const heavier = { A: TRUE.A + 0.12, C: TRUE.C };
  for (let k = 0; k < 20; k++) {
    const pts = [];
    for (let v = 85 / 3.6; v > 50 / 3.6; v -= 1) pts.push({ v, a: heavier.A + heavier.C * v * v + (rand() - 0.5) * 0.02 });
    stats.add(pts);
  }
  const after = at80(stats.fit(prior));
  const moved = (after - before) / (at80(heavier) - before);
  assert.ok(moved > 0.6, `följde ${Math.round(moved * 100)} %`);
});

test('under rullningen: avvikelsen mot modellen mäts och vägs in gradvis', () => {
  const model = { A: 0.2, C: 0.0003 };
  const real = { A: 0.35, C: 0.0003 }; // bilen bromsar mer än modellen (t.ex. motvind)
  const L = new CoastLearner(model);
  let t = 0, v = 90 / 3.6;
  const gps = () => L.addGps({ t, v, grade: 0.01, acc: 5, ok: true });
  for (let i = 0; i < 4; i++) { t += 1; gps(); }
  assert.equal(L.live(model), null, 'ingen rullning ännu');
  const seen = [];
  for (let i = 0; i < 14; i++) {
    t += 1;
    v -= real.A + real.C * v * v + G * 0.01;
    gps();
    seen.push(L.live(model));
  }
  assert.ok(seen.slice(0, 3).every(x => x == null), 'inget de första sekunderna');
  const last = seen[seen.length - 1];
  assert.ok(last && Math.abs(last.dA - (real.A - model.A)) < 0.03, `dA ${last?.dA}`);
  const firstLive = seen.find(x => x);
  assert.ok(firstLive.dA < last.dA, 'vägs in gradvis');
  // Gas: rullningen tar slut och justeringen försvinner
  t += 1; v += 2; gps(); t += 1; v += 2; gps();
  assert.equal(L.live(model), null);
});
