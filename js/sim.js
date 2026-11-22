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
