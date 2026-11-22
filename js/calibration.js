// Rullprov: inspelning och beräkning av bilens konstanter A och C.
import { G, fitAC, coastDistance } from './physics.js';
import { haversine } from './geo.js';

const KMH = 1 / 3.6;
export const CALIB = {
  armSpeed: 75 * KMH,     // farten som krävs innan provet startar
  armHold: 3,             // sekunder över armSpeed
  endSpeed: 30 * KMH,     // provet slutar här
  skipAfterCue: 2.0,      // sekunder efter "släpp gasen" som inte räknas (reaktion)
  vMin: 30 * KMH, vMax: 82 * KMH,
  maxGrade: 0.015,        // underkänn om snittlutningen är större
  brakeAccel: 3.0,        // m/s², accelerometerspik = broms
  brakeDecel: 2.0,        // m/s², GPS-inbromsning som är för stor för rullning
  speedUp: 0.6,           // m/s, ökning som räknas som gas
  minR2: 0.3,
};

/**
 * Tillståndsmaskin för ett prov. Matas med GPS- och accelerometerdata.
 * Tillstånd: waiting → armed (tillräcklig fart) → recording → done | failed
 */
export class CoastRecorder {
  constructor(onEvent = () => {}) {
    this.state = 'waiting';
    this.onEvent = onEvent;
    this.gps = [];
    this.acc = [];
    this.aboveSince = null;
    this.cueT = null;
    this.reason = null;
    this.maxBrakeAccel = 0;
  }

  addGps(p) { // {t (s), v (m/s), lat, lon, alt, accuracy}
    if (this.state === 'done' || this.state === 'failed') return;
    if (p.v == null || !Number.isFinite(p.v)) return;
    if (this.state === 'waiting') {
      if (p.v >= CALIB.armSpeed) {
        if (this.aboveSince == null) this.aboveSince = p.t;
        if (p.t - this.aboveSince >= CALIB.armHold) {
          this.state = 'recording';
          this.cueT = p.t;
          this.onEvent({ type: 'cue' });
        }
      } else this.aboveSince = null;
      return;
    }
    if (this.state === 'recording') {
      this.gps.push(p);
      if (p.v <= CALIB.endSpeed) {
        this.state = 'done';
        this.onEvent({ type: 'done' });
        return;
      }
      const recent = this.gps.filter(q => q.t >= p.t - 3 && q.t >= this.cueT + CALIB.skipAfterCue);
      if (recent.length >= 2) {
        const minV = Math.min(...recent.map(q => q.v));
        if (p.v - minV > CALIB.speedUp * 2) this.fail('Farten ökade – gasen användes under provet.');
      }
      if (p.t - this.cueT > 120) this.fail('Provet tog för lång tid.');
    }
  }

  addMotion(m) { // {t, ax, ay, az} utan tyngdkraft
    if (this.state !== 'recording') return;
    this.acc.push(m);
    const mag = Math.hypot(m.ax, m.ay, m.az);
    if (m.t > this.cueT + CALIB.skipAfterCue) {
      this.maxBrakeAccel = Math.max(this.maxBrakeAccel, mag);
      // Kräver ihållande spik (> 0,3 s) för att inte reagera på gupp.
      const win = this.acc.filter(q => q.t >= m.t - 0.3);
      if (win.length >= 5 && win.every(q => Math.hypot(q.ax, q.ay, q.az) > CALIB.brakeAccel)) {
        this.fail('Plötslig inbromsning – bromsen användes.');
      }
    }
  }

  fail(reason) {
    if (this.state === 'failed') return;
    this.state = 'failed';
    this.reason = reason;
    this.onEvent({ type: 'failed', reason });
  }

  /** Provets data för analys. */
  result() {
    return { gps: this.gps.filter(p => p.t >= this.cueT + CALIB.skipAfterCue), cueT: this.cueT };
  }
}

function movingAverage(arr, w) {
  return arr.map((_, i) => {
    let s = 0, c = 0;
    for (let k = Math.max(0, i - w); k <= Math.min(arr.length - 1, i + w); k++) { s += arr[k]; c++; }
    return s / c;
  });
}

/**
 * Analyserar ett prov. elev = höjder (m) per GPS-punkt eller null (då används GPS-höjden).
 * Returnerar {ok, reason?, points: [{v, a}], grade, distance, bearing}
 */
export function analyzeRun(gps, elev = null) {
  if (gps.length < 8) return { ok: false, reason: 'För få mätpunkter. Kontrollera GPS-signalen.' };
  const t = gps.map(p => p.t);
  const v = movingAverage(gps.map(p => p.v), 2);
  // Sträcka längs provet
  const d = [0];
  for (let i = 1; i < gps.length; i++) d.push(d[i - 1] + haversine(gps[i - 1].lat, gps[i - 1].lon, gps[i].lat, gps[i].lon));
  const distance = d[d.length - 1];
  if (distance < 200) return { ok: false, reason: 'Provsträckan blev för kort.' };

  // Snittlutning ur höjddata (linjär regression höjd mot sträcka)
  const h = elev || gps.map(p => p.alt);
  let grade = 0;
  if (h.every(x => Number.isFinite(x))) {
    const n = h.length;
    const md = d.reduce((a, b) => a + b, 0) / n, mh = h.reduce((a, b) => a + b, 0) / n;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) { num += (d[i] - md) * (h[i] - mh); den += (d[i] - md) ** 2; }
    grade = den > 0 ? num / den : 0;
  }
  if (Math.abs(grade) > CALIB.maxGrade) {
    return { ok: false, reason: `Vägen lutar för mycket (${(grade * 100).toFixed(1)} %). Välj en planare sträcka.`, grade };
  }

  const points = [];
  // Bara punkter där utjämningen har fullt fönster, annars blir kanterna snedvridna.
  for (let i = 3; i < gps.length - 3; i++) {
    const dt = t[i + 1] - t[i - 1];
    if (dt <= 0) continue;
    const a = -(v[i + 1] - v[i - 1]) / dt;
    if (a > CALIB.brakeDecel) return { ok: false, reason: 'För kraftig inbromsning – bromsen användes troligen.' };
    if (v[i] < CALIB.vMin || v[i] > CALIB.vMax) continue;
    points.push({ v: v[i], a: a - G * grade });
  }
  if (points.length < 5) return { ok: false, reason: 'För få användbara punkter mellan 30 och 80 km/h.' };

  const a0 = gps[0], a1 = gps[gps.length - 1];
  const bearing = Math.atan2(a1.lon - a0.lon, a1.lat - a0.lat) * 180 / Math.PI;
  return { ok: true, points, grade, distance, bearing };
}

/**
 * Kombinerar prov (helst ett i varje riktning). Varje prov vägs lika
 * oavsett antal punkter, så att vind och lutning tar ut varandra.
 */
export function combineRuns(runs) {
  const good = runs.filter(r => r && r.ok);
  if (!good.length) return { ok: false, reason: 'Inget godkänt prov.' };
  const maxN = Math.max(...good.map(r => r.points.length));
  const pts = [];
  for (const r of good) {
    const rep = Math.max(1, Math.round(maxN / r.points.length));
    for (let k = 0; k < rep; k++) pts.push(...r.points);
  }
  const fit = fitAC(pts);
  if (!fit) return { ok: false, reason: 'Kunde inte anpassa modellen.' };
  const warnings = [];
  if (good.length < 2) warnings.push('Bara ett prov – kör även i motsatt riktning för bättre resultat.');
  if (fit.r2 < CALIB.minR2) warnings.push(`Kurvanpassningen är osäker (R² = ${fit.r2.toFixed(2)}).`);
  if (fit.quality === 'low') warnings.push('Luftmotståndet gick inte att skilja ut; bara rullmotstånd används.');
  if (fit.A < 0.05 || fit.A > 1.5) return { ok: false, reason: `Orimligt rullmotstånd (A = ${fit.A.toFixed(2)} m/s²). Gör om provet.` };
  if (fit.r2 < 0.1 && good.length >= 2 && fit.quality !== 'low') return { ok: false, reason: `Dålig kurvanpassning (R² = ${fit.r2.toFixed(2)}). Gör om provet.` };
  return { ok: true, A: fit.A, C: fit.C, r2: fit.r2, n: fit.n, runs: good.length, warnings };
}

/** Text för föraren: hur långt bilen rullar mellan två farter. */
export function describeModel(model, fromKmh = 70, toKmh = 50) {
  const d = coastDistance(fromKmh / 3.6, toKmh / 3.6, model);
  return `Från ${fromKmh} till ${toKmh} km/h rullar bilen ca ${Math.round(d / 10) * 10} m`;
}
