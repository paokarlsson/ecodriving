// Simulerad bil som följer rutten. Används i demoläget och i tester.
// Föraren håller gränsen, släpper gasen vid signal och bromsar bara om det behövs.
import { latLonAt, gradeAt } from './route.js';
import { decel } from './physics.js';

export class SimCar {
  constructor(route, limits, model, { obey = true, reactS = 0.8, startV = 0 } = {}) {
    this.route = route;
    this.limits = limits;
    this.model = model;
    this.obey = obey;
    this.reactS = reactS;
    this.s = 0;
    this.v = startV;
    this.t = 0;
    this.coastUntil = null;   // fartmål vi rullar mot
    this.releaseAt = null;    // tid då föraren reagerar
    this.brakes = 0;          // antal inbromsningar
    this.braking = false;
  }

  limitAt(s) {
    const i = Math.min(this.route.n - 1, Math.max(0, Math.floor(s / this.route.step)));
    const l = this.limits ? this.limits[i] : null;
    return (l ?? 50) / 3.6;
  }

  onRelease(target) {
    if (!this.obey) return;
    this.releaseAt = this.t + this.reactS;
    this.coastUntil = target;
  }

  /** Stegar dt sekunder och returnerar en GPS-liknande observation. */
  step(dt, targets) {
    const g = gradeAt(this.route, this.s);
    let a; // acceleration (positiv = snabbare)
    const coasting = this.coastUntil && this.releaseAt != null && this.t >= this.releaseAt;
    if (coasting && this.s >= this.coastUntil.s - 5) { this.coastUntil = null; this.releaseAt = null; }
    // Nästa mål som kräver broms om vi inte hinner rulla ner
    const next = targets.find(x => x.s > this.s + 1);
    const distNext = next ? next.s - this.s : Infinity;
    const needBrake = next && this.v > next.v + 0.5 && (this.v ** 2 - next.v ** 2) / (2 * 2.5) >= distNext - 3;
    let braking = false;
    if (needBrake) { a = -2.5; braking = true; }
    else if (this.coastUntil && this.releaseAt != null && this.t >= this.releaseAt && !(this.v < 1.5 && distNext > 8)) a = -decel(this.v, g, this.model);
    else if (this.v < 1.5 && distNext > 8 && next && next.v < 1) a = 0.5; // krypa fram till stopplinjen
    else {
      const vt = this.limitAt(this.s);
      a = this.v < vt - 0.3 ? 1.2 : (this.v > vt + 0.3 ? -decel(this.v, g, this.model) : 0);
    }
    if (braking && !this.braking) this.brakes++;
    this.braking = braking;
    this.v = Math.max(0, this.v + a * dt);
    if (next && next.v === 0 && this.v < 0.5 && distNext < 8) {
      // Stopp vid ljus/stopplikt: stå 2 s och kör sedan vidare.
      this.stoppedFor = (this.stoppedFor || 0) + dt;
      if (this.stoppedFor > 2) { this.s = next.s + 1; this.stoppedFor = 0; this.v = 1; }
    }
    this.s = Math.min(this.route.length, this.s + this.v * dt);
    this.t += dt;
    const [lat, lon] = latLonAt(this.route, this.s);
    return { t: this.t, lat, lon, speed: this.v, accuracy: 5 };
  }
}

// ---------------------------------------------------------------------------
// Realistisk bil för demorutter på riktiga vägar.

/** Liten, sådd slumpgenerator så att en demo kan upprepas. */
export function seededRandom(seed = Date.now()) {
  let s = (seed >>> 0) || 1;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

function gauss(rand) {
  let u = 0;
  while (u === 0) u = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

/**
 * Bil med förare som beter sig som i verkligheten:
 * - håller gränsen med en egen marginal (−2…+4 km/h), mjuk acceleration
 *   (svagare i hög fart) och begränsat ryck
 * - tar kurvor nära rekommenderad fart och bromsar bekvämt när det behövs
 * - följer "släpp gasen" efter 0,8–1,6 s, men inte alltid (obeyProb)
 * - trafikljus är rött eller grönt slumpvis; stannar 5–30 s vid rött,
 *   2 s vid stopplikt och ibland vid väjningsplikt
 * - rullar med något andra värden än appens modell (som en riktig bil)
 * - GPS med brus i position och fart, gyro med brus
 */
export class RealCar {
  constructor(route, targets, limits, curves, model, { rand = seededRandom(), obeyProb = 0.85 } = {}) {
    this.route = route;
    this.targets = targets;
    this.limits = limits;
    this.curves = curves || [];
    this.rand = rand;
    this.obeyProb = obeyProb;
    // Bilens verkliga rullegenskaper avviker lite från appens modell
    this.trueModel = { A: model.A * (0.88 + 0.24 * rand()), C: model.C * (0.85 + 0.3 * rand()) };
    this.offset = (-2 + 6 * rand()) / 3.6;
    this.curveFactor = 1 + 0.08 * rand();
    this.s = 0; this.v = 0; this.t = 0; this.a = 0;
    this.stoppedUntil = null;
    this.decided = new Map();   // trafikljus → 'red' | 'green'
    this.passed = new Set();
    this.coast = null;          // {target, at}
    this.stats = { stops: 0, redLights: 0, greenLights: 0, brakes: 0, ignored: 0 };
    this.braking = false;
  }

  limitAt(s) {
    const i = Math.min(this.route.n - 1, Math.max(0, Math.round(s / this.route.step)));
    const l = this.limits ? this.limits[i] : null;
    return (l ?? 70) / 3.6;
  }

  desiredAt(s) {
    let v = this.limitAt(s) + this.offset;
    for (const c of this.curves) if (s >= c.s && s <= c.sEnd) v = Math.min(v, c.v * this.curveFactor);
    return Math.max(3, v);
  }

  onRelease(target) {
    if (this.rand() > this.obeyProb) { this.stats.ignored++; return; }
    this.coast = { target, at: this.t + 0.8 + 0.8 * this.rand() };
  }

  /** Mål framför bilen som föraren måste anpassa farten till: {s, v, stop, id}. */
  constraints() {
    const out = [];
    for (const tg of this.targets) {
      if (tg.s <= this.s + 1 || this.passed.has(tg.id)) continue;
      if (tg.s - this.s > 500) break;
      if (tg.kind === 'traffic_signals') {
        if (!this.decided.has(tg.id) && tg.s - this.s < 300) {
          const red = this.rand() < 0.55;
          this.decided.set(tg.id, red ? 'red' : 'green');
          red ? this.stats.redLights++ : this.stats.greenLights++;
        }
        if (this.decided.get(tg.id) !== 'red') continue;
        out.push({ s: tg.s, v: 0, stop: true, id: tg.id, wait: 5 + 25 * this.rand() });
      } else if (tg.kind === 'stop') {
        out.push({ s: tg.s, v: 0, stop: true, id: tg.id, wait: 2 });
      } else if (tg.kind === 'give_way') {
        if (!this.decided.has(tg.id)) this.decided.set(tg.id, this.rand() < 0.3 ? 'stop' : 'go');
        const stop = this.decided.get(tg.id) === 'stop';
        out.push({ s: tg.s, v: stop ? 0 : tg.v, stop, id: tg.id, wait: 2 + 4 * this.rand() });
      } else if (tg.kind === 'end') {
        out.push({ s: tg.s, v: 0, stop: true, id: tg.id, wait: 1e9 });
      } else {
        out.push({ s: tg.s, v: tg.kind === 'curve' ? tg.v * this.curveFactor : tg.v + this.offset, stop: false, id: tg.id });
      }
    }
    return out;
  }

  /** Stegar dt sekunder (i 0,1 s-delsteg) och returnerar en GPS-observation. */
  step(dt = 1) {
    const h = 0.1;
    for (let k = 0; k < Math.round(dt / h); k++) this.substep(h);
    return this.observe();
  }

  substep(h) {
    this.t += h;
    if (this.stoppedUntil != null) {
      this.v = 0; this.a = 0;
      if (this.t >= this.stoppedUntil) { this.stoppedUntil = null; this.passed.add(this.stopId); }
      return;
    }
    const g = gradeAt(this.route, this.s);
    // Hur hårt måste föraren bromsa för det mest krävande målet?
    let need = 0, stopAt = null;
    for (const c of this.constraints()) {
      if (c.v >= this.v) continue;
      const d = c.s - this.s - (c.stop ? 3 : 0);
      const n = d <= 0.5 ? 9 : (this.v ** 2 - c.v ** 2) / (2 * d);
      if (n > need) need = n;
      if (c.stop && d < 2 && this.v < 0.8) stopAt = c;
    }
    if (stopAt) {
      this.stoppedUntil = this.t + stopAt.wait;
      this.stopId = stopAt.id;
      this.stats.stops++;
      this.v = 0; this.a = 0;
      return;
    }
    // Rullar föraren mot ett mål efter signal?
    if (this.coast) {
      const tg = this.coast.target;
      const greenNear = tg.kind === 'traffic_signals' && this.decided.get(tg.id) === 'green' && tg.s - this.s < 80;
      if (this.s >= tg.s - 5 || greenNear || this.passed.has(tg.id)) this.coast = null;
    }
    const coasting = this.coast && this.t >= this.coast.at;
    let a;
    // Hysteres: en börjad inbromsning fortsätter tills behovet tydligt sjunkit
    const braking = this.braking ? need >= 0.4 : need >= (coasting ? 1.1 : 0.9);
    if (braking) a = -Math.min(4.5, Math.max(need * 1.05, 0.5));
    else if (coasting) a = -decel(this.v, g, this.trueModel);
    else {
      const err = this.desiredAt(this.s) - this.v;
      const maxAcc = Math.max(0.6, 2.0 - this.v / 25);
      a = err > 0 ? Math.min(maxAcc, 0.45 * err + 0.15) : Math.max(-decel(this.v, g, this.trueModel), 0.6 * err);
      if (this.v < 1 && err > 0) a = Math.max(a, 1.2);
    }
    if (braking && !this.braking) this.stats.brakes++;
    this.braking = braking;
    // Begränsat ryck: mjukt på gasen, snabbare mot broms
    const da = a - this.a;
    this.a += Math.max(-8 * h, Math.min(2.5 * h, da));
    this.v = Math.max(0, this.v + this.a * h);
    this.s = Math.min(this.route.length, this.s + this.v * h);
    for (const tg of this.targets) if (tg.s < this.s - 2) this.passed.add(tg.id);
  }

  observe() {
    const [x, y] = [interpX(this.route, this.s), interpY(this.route, this.s)];
    const nx = x + gauss(this.rand) * 2.5, ny = y + gauss(this.rand) * 2.5;
    const [lat, lon] = this.route.proj.toLL(nx, ny);
    const speed = Math.max(0, this.v + gauss(this.rand) * 0.12);
    return { t: this.t, lat, lon, speed, accuracy: 3 + 4 * this.rand(), alt: null };
  }

  /** Simulerad vridhastighet (rad/s, höger positiv) med brus. */
  yaw(routeYaw) {
    return routeYaw(this.route, this.s, this.v, 10) + gauss(this.rand) * 0.004;
  }
}

function interpX(route, s) { const f = s / route.step, i = Math.min(route.n - 2, Math.max(0, Math.floor(f))); return route.X[i] + (f - i) * (route.X[i + 1] - route.X[i]); }
function interpY(route, s) { const f = s / route.step, i = Math.min(route.n - 2, Math.max(0, Math.floor(f))); return route.Y[i] + (f - i) * (route.Y[i + 1] - route.Y[i]); }
