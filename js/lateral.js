// Uppmätt sidokraft i kurvor: gyro + GPS-fart, jämförelse med planerat
// och inlärning av förarens komfortnivå. Ren logik utan DOM.
import { angleDiff } from './geo.js';

const G = 9.81;
const DEG = Math.PI / 180;

export const LATERAL = {
  gravityTau: 2.0,     // s, lågpass för lodlinjen
  yawTau: 0.5,         // s, utjämning av vridhastigheten
  biasTau: 20,         // s, nollpunktens inlärning på raksträcka
  askFactor: 1.15,     // fråga när toppen är mer än 15 % över planerat
  maxMismatch: 0.30,   // gyrots och kartans svängvinkel får skilja högst 30 %
  minTurnForCheck: 15, // grader; kortare svängar kontrolleras inte
};

/**
 * Vridhastighet kring lodlinjen ur telefonens gyro, oavsett hur telefonen
 * sitter. rot = rotationRate i grader/s {alpha (z), beta (x), gamma (y)},
 * grav = tyngdkraftens riktning i telefonens axlar (x, y, z).
 * Returnerar rad/s (tecknet beror på plattformen; storleken används).
 */
export function yawFromGyro(rot, grav) {
  const n = Math.hypot(grav[0], grav[1], grav[2]);
  if (!(n > 1)) return null;
  const wx = rot.beta ?? 0, wy = rot.gamma ?? 0, wz = rot.alpha ?? 0;
  return ((wx * grav[0] + wy * grav[1] + wz * grav[2]) / n) * DEG;
}

/** Löser (M + λI) k = b för 3×3 med Gausselimination. */
function solve3(M, b, ridge) {
  const A = M.map((row, i) => [...row.map((x, j) => x + (i === j ? ridge : 0)), b[i]]);
  for (let c = 0; c < 3; c++) {
    let p = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < 1e-12) return null;
    [A[c], A[p]] = [A[p], A[c]];
    for (let r = 0; r < 3; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k < 4; k++) A[r][k] -= f * A[c][k];
    }
  }
  return [A[0][3] / A[0][0], A[1][3] / A[1][1], A[2][3] / A[2][2]];
}

/**
 * Håller lodlinje, nollpunkt och utjämnad vridhastighet (höger sväng positiv).
 *
 * Telefoner och webbläsare anger gyrots axlar, enheter och tecken olika.
 * Mätaren lär sig därför själv vilken kombination av gyrots tre axlar som är
 * "sväng" genom att jämföra med hur rutten svänger (minsta kvadrat). Tills
 * det är inlärt används rotationen kring tyngdkraftens riktning enligt
 * standarden, med tecken som också lärs in mot rutten.
 */
export class LateralMeter {
  constructor() {
    this.grav = null;
    this.lastT = null;
    this.bias = 0;
    this.biasReady = false;
    this.yaw = 0;          // utjämnad, nollpunktskorrigerad, höger positiv (rad/s)
    this.turn = 0;         // integrerad svängvinkel (rad)
    this.v = 0;
    this.straight = false; // sätts av appen ur rutten (rak väg eller stillastående)
    this.sign = null;      // reservvägens tecken
    this.signAcc = 0;
    this.defaultSign = -1; // standard: positiv rotation kring "upp" = vänster
    this.lastPlat = null;  // senaste vridhastighet enligt standarden (rad/s)
    this.lastRot = null;   // senaste råa gyrovektor [x, y, z] (grader/s enligt standarden)
    this.axis = null;      // inlärd: sväng höger (rad/s) = axis · rå gyrovektor
    this.axisR2 = null;
    this.reg = { M: [[0, 0, 0], [0, 0, 0], [0, 0, 0]], b: [0, 0, 0], ee: 0, n: 0, turns: 0, since: 0 };
    // Vridning summerad sedan förra GPS-positionen (råa gyroaxlar, grader)
    this.rotInt = [0, 0, 0];
    this.platInt = 0;          // samma enligt standarden (rad), för reservvägens tecken
    this.intOk = false;
    // Accelerometerkontroll: vågrät acceleration ur accelerationen med tyngdkraft
    this.gravSlow = null;      // tyngdkraften utjämnad över ca 20 s
    this.accH = 0;             // vågrät acceleration, utjämnad ca 0,7 s (m/s²)
  }

  setSpeed(v) { this.v = Math.max(0, v || 0); }
  setStraight(b) { this.straight = !!b; }

  /** m = {t (s), rot: {alpha, beta, gamma}, gx, gy, gz} från devicemotion. */
  addMotion(m) {
    if (!m.rot) return;
    const dt = this.dt(m.t);
    if (m.gx != null) {
      const g = [m.gx, m.gy, m.gz];
      if (!this.grav) this.grav = g;
      else {
        const k = dt / (LATERAL.gravityTau + dt);
        this.grav = this.grav.map((x, i) => x + k * (g[i] - x));
      }
    }
    const r = [m.rot.beta ?? 0, m.rot.gamma ?? 0, m.rot.alpha ?? 0];
    this.lastRot = r;
    this.lastPlat = this.grav ? yawFromGyro(m.rot, this.grav) : null;
    // Summera vridningen till nästa GPS-position (stötar räknas inte)
    if (Math.hypot(r[0], r[1], r[2]) < 120) {
      for (let q = 0; q < 3; q++) this.rotInt[q] += r[q] * dt;
      if (this.lastPlat != null) this.platInt += this.lastPlat * dt;
      this.intOk = true;
    }
    if (m.gx != null) this.addAccel([m.gx, m.gy, m.gz], dt);
    let wRight;
    if (this.axis) wRight = this.axis[0] * r[0] + this.axis[1] * r[1] + this.axis[2] * r[2];
    else if (this.lastPlat != null) wRight = this.lastPlat * (this.sign ?? this.defaultSign);
    else return;
    this.integrate(wRight, dt);
  }

  /** Vridhastighet enligt standardens tecken (rad/s), t.ex. från simulering. */
  addYaw(t, w, dt = this.dt(t)) {
    this.lastPlat = w;
    this.integrate(w * (this.sign ?? this.defaultSign), dt);
  }

  integrate(wRight, dt) {
    // Ingen bil svänger fortare än ca 70°/s; större värden är stötar mot telefonen.
    if (!Number.isFinite(wRight) || Math.abs(wRight) > 1.2) return;
    if (this.straight) {
      const k = dt / (LATERAL.biasTau + dt);
      this.bias += (this.biasReady ? k : Math.min(1, k * 10)) * (wRight - this.bias);
      this.biasReady = true;
    }
    const wc = wRight - this.bias;
    const k = dt / (LATERAL.yawTau + dt);
    this.yaw += k * (wc - this.yaw);
    this.turn += wc * dt;
  }

  /**
   * Jämför med förväntad sväng ur rutten (rad/s, höger positiv): lär in
   * reservvägens tecken och gyrots axel.
   */
  /**
   * Reservvägens tecken mot förväntad vridhastighet i stunden (rad/s, höger
   * positiv), t.ex. ur rutten. Gyrots axel lärs per GPS-intervall i
   * learnInterval(), som är betydligt säkrare.
   */
  learn(expectedRight) {
    if (Math.abs(expectedRight) < 0.03) return;
    if (this.lastPlat != null && Math.abs(this.lastPlat) > 0.01) {
      this.signAcc = Math.max(-1, Math.min(1, this.signAcc + expectedRight * this.lastPlat));
      if (Math.abs(this.signAcc) > 0.05) this.sign = Math.sign(this.signAcc);
    }
  }

  /** Glöm vridningen sedan förra GPS-positionen (t.ex. vid stillastående eller lucka). */
  resetInterval() {
    this.rotInt = [0, 0, 0];
    this.platInt = 0;
    this.intOk = false;
  }

  /**
   * Lär gyrots axel per GPS-intervall: hur mycket bilen svängt (rad, höger
   * positiv) sedan förra anropet – från GPS-kursen eller rutten – jämförs med
   * gyrots summerade vridning över samma tid. Att jämföra mätvärde för
   * mätvärde fungerar dåligt eftersom GPS-kursen kommer en gång i sekunden
   * och ligger efter. Minsta kvadrat över intervallen hittar axlarnas
   * ordning, skala och tecken oavsett hur telefonen eller webbläsaren anger dem.
   */
  learnInterval(expectedTurn) {
    const r = this.rotInt, plat = this.platInt, ok = this.intOk;
    this.resetInterval();
    if (!ok || !Number.isFinite(expectedTurn) || Math.abs(expectedTurn) > 1.2) return;
    // Reservvägens tecken
    if (Math.abs(expectedTurn) > 0.05 && Math.abs(plat) > 0.01) {
      this.signAcc = Math.max(-1, Math.min(1, this.signAcc + expectedTurn * plat * 20));
      if (Math.abs(this.signAcc) > 0.05) this.sign = Math.sign(this.signAcc);
    }
    const R = this.reg;
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) R.M[i][j] += r[i] * r[j];
      R.b[i] += r[i] * expectedTurn;
    }
    R.ee += expectedTurn * expectedTurn;
    R.n++;
    if (Math.abs(expectedTurn) > 3 * DEG) R.turns++;
    if (R.turns >= 12 && R.n - R.since >= 10) {
      R.since = R.n;
      const tr = R.M[0][0] + R.M[1][1] + R.M[2][2];
      const k = solve3(R.M, R.b, 1e-3 * tr / 3);
      if (!k) return;
      // R² för passningen: 1 − SSR/Σe², SSR = Σe² − 2k·b + kᵀMk
      let kMk = 0;
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) kMk += k[i] * R.M[i][j] * k[j];
      const kb = k[0] * R.b[0] + k[1] * R.b[1] + k[2] * R.b[2];
      const r2 = 1 - (R.ee - 2 * kb + kMk) / R.ee;
      if (r2 > 0.6) { this.axis = k; this.axisR2 = r2; }
    }
  }

  /** Accelerometerkontroll: vågrät acceleration ur accelerationen med tyngdkraft. */
  addAccel(g, dt) {
    if (!this.gravSlow) { this.gravSlow = g.slice(); return; }
    const k = dt / (20 + dt);
    this.gravSlow = this.gravSlow.map((x, i) => x + k * (g[i] - x));
    const n = Math.hypot(...this.gravSlow);
    if (!(n > 1)) return;
    const up = this.gravSlow.map(x => x / n);
    const a = g.map((x, i) => x - this.gravSlow[i]);
    const vert = a[0] * up[0] + a[1] * up[1] + a[2] * up[2];
    const h = Math.hypot(a[0] - vert * up[0], a[1] - vert * up[1], a[2] - vert * up[2]);
    const kk = dt / (0.7 + dt);
    this.accH += kk * (Math.min(h, 15) - this.accH);
  }

  /** Bakåtkompatibelt namn. */
  learnSign(expectedRight) { this.learn(expectedRight); }

  /** Vridhastighet med höger sväng positiv (rad/s). */
  rightYaw() { return this.yaw; }

  dt(t) {
    const d = this.lastT == null ? 0.02 : Math.min(0.5, Math.max(0, t - this.lastT));
    this.lastT = t;
    return d;
  }

  /**
   * Sidokraft just nu: a = v · |ω|. side = kraften som föraren känner,
   * positiv åt höger (vänstersväng trycker åt höger), i g.
   */
  current() {
    const a = this.v * Math.abs(this.yaw);
    const side = -(this.v * this.yaw) / G;
    return { a, g: a / G, yaw: this.yaw, side, accG: this.accH / G };
  }
}

/** Kursändring längs rutten mellan s0 och s1 (grader, utan tecken). */
function routeTurnDeg(route, s0, s1) {
  const idx = s => Math.min(route.n - 1, Math.max(0, Math.round(s / route.step)));
  let total = 0;
  for (let i = idx(s0) + 1; i <= idx(s1); i++) {
    let d = route.H[i] - route.H[i - 1];
    d = ((d + 540) % 360) - 180;
    total += d;
  }
  return Math.abs(total);
}

function percentile(arr, p) {
  if (!arr.length) return 0;
  const a = arr.slice().sort((x, y) => x - y);
  const i = Math.min(a.length - 1, Math.max(0, Math.ceil(p * a.length) - 1));
  return a[i];
}

/**
 * Följer kurvorna längs rutten. update() med bilens läge ger händelser när
 * en kurva börjar och slutar; sample() matas med sidokraften medan bilen är
 * i kurvan. Vid slutet kommer en post med uppmätt och planerat.
 */
export class CurveTracker {
  constructor(route, curves, baseALat) {
    this.route = route;
    this.curves = curves || [];
    this.base = baseALat;
    this.active = null;
    this.done = new Set();
  }

  setCurves(curves, baseALat) { this.curves = curves || []; this.base = baseALat; }

  inside() { return !!this.active; }

  update(s, t, v, meter) {
    const events = [];
    if (this.active) {
      const c = this.active.curve;
      this.active.vmax = Math.max(this.active.vmax, v);
      if (s > c.sEnd + 10) {
        events.push({ type: 'exit', record: this.finish(meter) });
        this.active = null;
      }
      return events;
    }
    const c = this.curves.find(c => !this.done.has(c.s) && s >= c.s - 10 && s <= c.sEnd + 10);
    if (c) {
      this.done.add(c.s);
      this.active = { curve: c, t0: t, turn0: meter.turn, bins: new Map(), vmax: v, peak: { a: 0, v: 0, yaw: 0 } };
      events.push({ type: 'enter', curve: c });
    }
    return events;
  }

  /** Sidokraft (m/s²) vid tiden t; samlas i 1-sekundersfack. */
  sample(t, a, v, yaw, accG = null) {
    if (!this.active) return;
    const key = Math.floor(t);
    const b = this.active.bins.get(key) || { sum: 0, n: 0, acc: 0, nacc: 0 };
    b.sum += a; b.n++;
    if (accG != null && Number.isFinite(accG)) { b.acc += accG; b.nacc++; }
    this.active.bins.set(key, b);
    if (a > this.active.peak.a) this.active.peak = { a, v, yaw };
  }

  finish(meter) {
    const { curve: c, bins, vmax, turn0, peak } = this.active;
    const means = [...bins.values()].map(b => b.sum / b.n);
    const accMeans = [...bins.values()].filter(b => b.nacc).map(b => b.acc / b.nacc);
    const accPeakG = accMeans.length ? percentile(accMeans, 0.9) : null;
    const peakA = percentile(means, 0.9);
    const plannedA = (c.v * c.v) / c.radius;
    const gyroTurn = Math.abs(meter.turn - turn0) / DEG;
    const routeTurn = routeTurnDeg(this.route, c.s - 10, c.sEnd + 10);
    let valid = true, reason = null;
    if (means.length < 2) { valid = false; reason = 'för kort mätning'; }
    else if (routeTurn >= LATERAL.minTurnForCheck && Math.abs(gyroTurn - routeTurn) / routeTurn > LATERAL.maxMismatch) {
      valid = false; reason = 'gyrot och kartan stämmer inte (lös hållare?)';
    }
    const peakG = peakA / G, plannedG = plannedA / G;
    return {
      s: c.s, dir: c.dir, radius: c.radius,
      plannedV: c.v, plannedG, peakG, maxV: vmax,
      speedAtPeak: peak.v || vmax,
      radiusMeas: peak.yaw ? (peak.v / Math.abs(peak.yaw)) : null,
      gyroTurn, routeTurn, valid, reason, accPeakG,
      ask: valid && peakG > plannedG * LATERAL.askFactor,
    };
  }
}

/**
 * Kurvradien som text för sammanfattningen: kartans radie och, om kurvan är
 * mätt, radien bilen faktiskt körde (fart / vridhastighet vid toppen).
 * Avrundas till 5 m; över 1 km visas inte den uppmätta (då var det nästan rakt).
 */
export function curveRadiusText(rec) {
  const r5 = m => Math.round(m / 5) * 5;
  let txt = Number.isFinite(rec.radius) ? `R ${r5(rec.radius)} m` : '';
  const meas = rec.radiusMeas;
  if (txt && rec.valid && Number.isFinite(meas) && meas > 0 && meas < 1000) txt += ` (kört ${r5(meas)} m)`;
  return txt;
}

/** Rak väg kring s: kursändringen ±30 m är under 3°. */
export function isStraightAt(route, s) {
  const i0 = Math.max(0, Math.round((s - 30) / route.step));
  const i1 = Math.min(route.n - 1, Math.round((s + 30) / route.step));
  return angleDiff(route.H[i0], route.H[i1]) < 3;
}

/** Signerad vridhastighet (rad/s) för en bil som följer rutten i farten v – för simulering. */
export function routeYaw(route, s, v, half = 30) {
  const a = Math.max(0, s - half), b = Math.min(route.length, s + half);
  if (b - a < 1) return 0;
  const ia = Math.round(a / route.step), ib = Math.round(b / route.step);
  let d = route.H[Math.min(route.n - 1, ib)] - route.H[Math.min(route.n - 1, ia)];
  d = ((d + 540) % 360) - 180;
  return (d * DEG) / (b - a) * v;
}
