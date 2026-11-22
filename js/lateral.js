// Uppmätt sidokraft i kurvor: gyro + GPS-fart, jämförelse med planerat
// och inlärning av förarens komfortnivå. Ren logik utan DOM.
import { comfortLatAccel } from './route.js';
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
  learnUp: 0.3,        // "Okej" flyttar 30 % mot uppmätt …
  maxStepUp: 0.02 * G, // … men höjer högst 0,02 g per svar
  downMargin: 0.02 * G,// "För mycket" sätter högst uppmätt − 0,02 g
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

/** Håller lodlinje, nollpunkt och utjämnad vridhastighet. */
export class LateralMeter {
  constructor() {
    this.grav = null;
    this.lastT = null;
    this.bias = 0;
    this.biasReady = false;
    this.yaw = 0;          // utjämnad, nollpunktskorrigerad (rad/s)
    this.turn = 0;         // integrerad svängvinkel (rad)
    this.v = 0;
    this.straight = false; // sätts av appen ur rutten (rak väg eller stillastående)
  }

  setSpeed(v) { this.v = Math.max(0, v || 0); }
  setStraight(b) { this.straight = !!b; }

  /** m = {t (s), rot: {alpha, beta, gamma}, gx, gy, gz} från devicemotion. */
  addMotion(m) {
    if (m.gx == null || !m.rot) return;
    const dt = this.dt(m.t);
    const g = [m.gx, m.gy, m.gz];
    if (!this.grav) this.grav = g;
    else {
      const k = dt / (LATERAL.gravityTau + dt);
      this.grav = this.grav.map((x, i) => x + k * (g[i] - x));
    }
    const w = yawFromGyro(m.rot, this.grav);
    if (w != null) this.addYaw(m.t, w, dt);
  }

  /** Direkt vridhastighet (rad/s), t.ex. från simulering. */
  addYaw(t, w, dt = this.dt(t)) {
    if (this.straight) {
      const k = dt / (LATERAL.biasTau + dt);
      this.bias += (this.biasReady ? k : Math.min(1, k * 10)) * (w - this.bias);
      this.biasReady = true;
    }
    const wc = w - this.bias;
    const k = dt / (LATERAL.yawTau + dt);
    this.yaw += k * (wc - this.yaw);
    this.turn += wc * dt;
  }

  dt(t) {
    const d = this.lastT == null ? 0.02 : Math.min(0.5, Math.max(0, t - this.lastT));
    this.lastT = t;
    return d;
  }

  /** Sidokraft just nu: a = v · |ω|. */
  current() {
    const a = this.v * Math.abs(this.yaw);
    return { a, g: a / G, yaw: this.yaw };
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
  sample(t, a, v, yaw) {
    if (!this.active) return;
    const key = Math.floor(t);
    const b = this.active.bins.get(key) || { sum: 0, n: 0 };
    b.sum += a; b.n++;
    this.active.bins.set(key, b);
    if (a > this.active.peak.a) this.active.peak = { a, v, yaw };
  }

  finish(meter) {
    const { curve: c, bins, vmax, turn0, peak } = this.active;
    const means = [...bins.values()].map(b => b.sum / b.n);
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
      gyroTurn, routeTurn, valid, reason,
      ask: valid && peakG > plannedG * LATERAL.askFactor,
    };
  }
}

/**
 * Ny inställd sidokraft (m/s², grundnivå ≤ 50 km/h) efter ett svar.
 * Snabbt ner, långsamt upp. Uppmätt kraft räknas om till grundnivån
 * eftersom appen tillåter mindre sidokraft i högre fart.
 */
export function learnALat(current, record, answer, { min = 0.15 * G, max = 0.35 * G } = {}) {
  const factor = comfortLatAccel(record.speedAtPeak, 1);
  const x = (record.peakG * G) / factor;
  let next = current;
  if (answer === 'ok' && x > current) next = current + Math.min(LATERAL.maxStepUp, LATERAL.learnUp * (x - current));
  if (answer === 'too_much') next = Math.min(current, x - LATERAL.downMargin);
  return Math.max(min, Math.min(max, next));
}

/** Rak väg kring s: kursändringen ±30 m är under 3°. */
export function isStraightAt(route, s) {
  const i0 = Math.max(0, Math.round((s - 30) / route.step));
  const i1 = Math.min(route.n - 1, Math.round((s + 30) / route.step));
  return angleDiff(route.H[i0], route.H[i1]) < 3;
}

/** Signerad vridhastighet (rad/s) för en bil som följer rutten i farten v – för simulering. */
export function routeYaw(route, s, v) {
  const a = Math.max(0, s - 10), b = Math.min(route.length, s + 10);
  if (b - a < 1) return 0;
  const ia = Math.round(a / route.step), ib = Math.round(b / route.step);
  let d = route.H[Math.min(route.n - 1, ib)] - route.H[Math.min(route.n - 1, ia)];
  d = ((d + 540) % 360) - 180;
  return (d * DEG) / (b - a) * v;
}
