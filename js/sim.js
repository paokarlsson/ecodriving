// Simulerad bil som följer rutten. Används i demoläget och i tester.
// Föraren håller gränsen, släpper gasen vid signal och bromsar bara om det behövs.
import { latLonAt, gradeAt, curveRadii } from './route.js';

/** Högsta sidokraft föraren tar en kurva med (g) och fart där gräns saknas (km/h). */
export const DEMO_MAX_G = 0.25;
export const DEMO_MAX_KMH = 120;
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
    // Kurvfart ur vägens radie: aldrig över 0,25 g (lite marginal: 0,97)
    const R = curveRadii(route);
    this.vCurve = new Float64Array(route.n);
    for (let i = 0; i < route.n; i++) this.vCurve[i] = Math.min(DEMO_MAX_KMH / 3.6, 0.97 * Math.sqrt(DEMO_MAX_G * 9.81 * R[i]));
    this.s = 0; this.v = 0; this.t = 0; this.a = 0;
    this.stoppedUntil = null;
    this.decided = new Map();   // trafikljus → 'red' | 'green'
    this.passed = new Set();
    this.coast = null;          // {target, at}
    this.stats = { stops: 0, redLights: 0, greenLights: 0, brakes: 0, ignored: 0 };
    this.braking = false;
    this.hold = null;           // håller farten efter rullning: {v, until}
  }

  limitAt(s) {
    const i = Math.min(this.route.n - 1, Math.max(0, Math.round(s / this.route.step)));
    const l = this.limits ? this.limits[i] : null;
    return l != null && Number.isFinite(l) ? l / 3.6 : null;
  }

  curveAt(s) {
    return this.vCurve[Math.min(this.route.n - 1, Math.max(0, Math.round(s / this.route.step)))];
  }

  /** Önskad fart: gränsen plus egen marginal (max 120 utan gräns), aldrig över 0,25 g i kurva. */
  desiredAt(s) {
    const lim = this.limitAt(s);
    const v = Math.min(lim != null ? lim + this.offset : DEMO_MAX_KMH / 3.6 + Math.min(0, this.offset), this.curveAt(s));
    return Math.max(2, v);
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
        if (tg.kind !== 'curve') out.push({ s: tg.s, v: tg.v + this.offset, stop: false, id: tg.id });
      }
    }
    // Kurvor och lägre gränser framåt: farten vid varje punkt inom 500 m
    const st = this.route.step;
    for (let i = Math.ceil((this.s + 1) / st); i < this.route.n && i * st - this.s <= 500; i++) {
      // Ett sampel gäller ±st/2; föraren vill ha rätt fart några meter före
      const v = this.desiredAt(i * st);
      if (v < this.v) out.push({ s: Math.max(this.s + 0.5, i * st - st / 2 - 4), v, stop: false, id: null });
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
      // Har bilen redan rullat ner till målets fart slutar föraren rulla och
      // håller farten (annars skulle den rulla till stopp långt före målet)
      const slowEnough = this.t >= this.coast.at && this.v <= Math.max(tg.v ?? 0, 4);
      if (slowEnough && !greenNear) this.hold = { v: this.v, until: tg.sEnd ?? tg.s };
      if (this.s >= tg.s - 5 || greenNear || slowEnough || this.passed.has(tg.id)) this.coast = null;
    }
    if (this.hold && this.s > this.hold.until) this.hold = null;
    const coasting = this.coast && this.t >= this.coast.at;
    let a;
    // Hysteres: en börjad inbromsning fortsätter tills behovet tydligt sjunkit
    const braking = this.braking ? need >= 0.4 : need >= (coasting ? 1.1 : 0.9);
    if (braking) a = -Math.min(4.5, Math.max(need * 1.05, 0.5));
    else if (coasting) {
      // Rullar, men håller emot i nedförsbacke så att kurvfarten inte överskrids
      const want = Math.min(this.desiredAt(this.s), this.desiredAt(this.s + 2 * this.v + 10));
      a = Math.min(-decel(this.v, g, this.trueModel), this.v > want ? 0.6 * (want - this.v) : Infinity);
    }
    else {
      // Föraren gasar inte in i en kurva: tittar ca 2 s framåt
      let want = Math.min(this.desiredAt(this.s), this.desiredAt(this.s + 2 * this.v + 10));
      if (this.hold) want = Math.min(want, this.hold.v);
      const err = want - this.v;
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
