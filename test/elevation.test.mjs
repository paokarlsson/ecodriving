import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ElevationFuser, ElevationMap, ELEV, thinProfile, compareProfile, cellKey } from '../js/elevation.js';

function rng(seed) {
  let s = seed;
  const u = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  return () => Math.sqrt(-2 * Math.log(u() + 1e-12)) * Math.cos(2 * Math.PI * u());
}
const H = d => 300 + 12 * Math.sin(d / 400) + 4 * Math.sin(d / 90);
const rms = a => Math.sqrt(a.reduce((s, x) => s + x * x, 0) / a.length);

/** 10 km med OBD-lutning (fel 0,26 % + brus) och GPS-höjd med fel som hänger ihop över minuter. */
function drive(seed) {
  const gauss = rng(seed);
  const f = new ElevationFuser();
  let gpsErr = 0;
  const gpsE = [];
  for (let d = 0; d <= 10000; d += 18) {
    gpsErr = 0.97 * gpsErr + 1.25 * gauss();
    gpsE.push(gpsErr);
    const g = d ? (H(d) - H(d - 18)) / 18 + 0.0026 + 0.012 * gauss() : null;
    f.step({ ds: d ? 18 : 0, grade: g, alt: H(d) + 30 + gpsErr, altSd: 6, lat: 63, lon: 14 + d / 50000 });
  }
  return { f, gpsE };
}

test('höjdfiltret: bättre höjd än GPS, lutning nära OBD:s och felet i OBD-lutningen hittas', () => {
  let eF = 0, eG = 0, eS = 0, b = 0;
  const seeds = [1, 7, 42, 99, 1234];
  for (const seed of seeds) {
    const { f, gpsE } = drive(seed);
    const prof = f.smooth();
    eF += rms(prof.map(p => p.h - 30 - H(p.d))) / seeds.length;
    eG += rms(gpsE) / seeds.length;
    const gE = [];
    for (let i = 0; i + 8 < prof.length; i += 8) {
      const a = prof[i], c = prof[i + 8];
      gE.push(((c.h - a.h) - (H(c.d) - H(a.d))) / (c.d - a.d));
    }
    eS += rms(gE) / seeds.length;
    b += prof[prof.length >> 1].bias / seeds.length;
  }
  assert.ok(eF < eG * 0.75, `höjdfel ${eF.toFixed(2)} m mot GPS ${eG.toFixed(2)} m`);
  assert.ok(eS < 0.006, `lutningsfel ${(eS * 100).toFixed(2)} %`);
  assert.ok(Math.abs(b - 0.0026) < 0.0015, `fel i OBD-lutningen ${b}`);
});

test('utjämningen bakåt är den exakta minsta-kvadratlösningen', () => {
  const gauss = rng(3);
  const save = ELEV.altEveryM;
  ELEV.altEveryM = 0;
  try {
    const N = 30, ds = 20, f = new ElevationFuser(), obs = [];
    for (let i = 0; i < N; i++) {
      const g = 0.01 * gauss(), alt = 100 + 5 * gauss();
      obs.push({ g, alt });
      f.step({ ds: i ? ds : 0, grade: i ? g : null, alt, altSd: 5 });
    }
    const prof = f.smooth();
    // Normalekvationer för h0..h(N-1), b0..b(N-1)
    const n = 2 * N, A = Array.from({ length: n }, () => new Float64Array(n)), y = new Float64Array(n);
    const row = (coef, val, w) => { for (const [i, ci] of coef) { y[i] += w * ci * val; for (const [j, cj] of coef) A[i][j] += w * ci * cj; } };
    const qh = ELEV.gradeSd ** 2 * Math.min(ds, ELEV.gradeLenM) * ds, qb = ELEV.biasWalk ** 2 * ds / ELEV.biasWalkM;
    const R = Math.max(ELEV.altSdMin, 5) ** 2;
    row([[0, 1]], obs[0].alt, 1 / 25);
    row([[N, 1]], 0, 1 / ELEV.biasSd0 ** 2);
    for (let i = 1; i < N; i++) {
      row([[i, 1], [i - 1, -1], [N + i - 1, ds]], obs[i].g * ds, 1 / qh);
      row([[N + i, 1], [N + i - 1, -1]], 0, 1 / qb);
      row([[i, 1]], obs[i].alt, 1 / R);
    }
    for (let c = 0; c < n; c++) for (let r = c + 1; r < n; r++) { const k = A[r][c] / A[c][c]; for (let j = c; j < n; j++) A[r][j] -= k * A[c][j]; y[r] -= k * y[c]; }
    const x = new Float64Array(n);
    for (let r = n - 1; r >= 0; r--) { let s = y[r]; for (let j = r + 1; j < n; j++) s -= A[r][j] * x[j]; x[r] = s / A[r][r]; }
    for (let i = 0; i < N; i++) assert.ok(Math.abs(prof[i].h - x[i]) < 1e-6, `punkt ${i}`);
  } finally { ELEV.altEveryM = save; }
});

test('utan OBD-lutning följer filtret GPS-höjden; utan GPS-höjd börjar det inte', () => {
  const f = new ElevationFuser();
  f.step({ ds: 0, grade: 0.05, alt: null });
  assert.equal(f.current(), null);
  for (let d = 0; d <= 3000; d += 20) f.step({ ds: d ? 20 : 0, grade: null, alt: 200 + d * 0.01, altSd: 5 });
  const p = f.smooth();
  assert.ok(Math.abs(p[p.length - 1].h - 230) < 4);
});

test('kartrutor: höjden vägs ihop över körningar efter osäkerheten', () => {
  const m = new ElevationMap();
  const prof = [{ d: 0, h: 100, sd: 2, lat: 63.1, lon: 14.6 }, { d: 20, h: 101, sd: 2, lat: 63.1002, lon: 14.6 }];
  assert.equal(m.add(prof, 1), 2);
  m.add([{ d: 0, h: 104, sd: 4, lat: 63.1, lon: 14.6 }], 2);
  const c = m.at(63.1, 14.6);
  assert.equal(c.n, 2);
  assert.ok(c.h > 100 && c.h < 101.5, `sammanvägd ${c.h}`);
  assert.ok(c.sd < 2);
  assert.equal(m.at(63.2, 14.6), null);
  // Samma ruta två gånger i en körning räknas en gång
  const m2 = new ElevationMap();
  assert.equal(m2.add([{ d: 0, h: 1, sd: 1, lat: 63.1, lon: 14.6 }, { d: 1, h: 2, sd: 1, lat: 63.10001, lon: 14.6 }]), 1);
  assert.equal(cellKey(63.1, 14.6), cellKey(63.10001, 14.6));
  // Sparas och läses tillbaka
  const back = new ElevationMap(JSON.parse(JSON.stringify(m.toJSON())));
  assert.deepEqual(back.at(63.1, 14.6), c);
});

test('kartrutor: de äldsta tas bort när det blir för många', () => {
  const save = ELEV.maxCells;
  ELEV.maxCells = 10;
  try {
    const m = new ElevationMap();
    for (let i = 0; i < 15; i++) m.add([{ d: 0, h: i, sd: 1, lat: 63 + i * 0.001, lon: 14 }], i);
    assert.equal(m.size(), 10);
    assert.equal(m.at(63, 14), null, 'äldsta borta');
    assert.ok(m.at(63.014, 14));
  } finally { ELEV.maxCells = save; }
});

test('jämförelse med en annan höjdkälla: nivå och lutning', () => {
  const prof = [];
  for (let d = 0; d <= 3000; d += 20) prof.push({ d, h: 300 + d * 0.01 });
  // Samma backe 30 m lägre: bara nivån skiljer
  const same = compareProfile(prof, p => p.h - 30);
  assert.ok(Math.abs(same.offsetM + 30) < 1e-9);
  assert.ok(same.gradeRms < 1e-9);
  // Platt: lutningen skiljer 1 %
  const flat = compareProfile(prof, () => 270);
  assert.ok(Math.abs(flat.gradeRms - 0.01) < 1e-9);
  assert.equal(compareProfile(prof, () => null), null);
  assert.equal(thinProfile(prof, 100).length, 31);
});
