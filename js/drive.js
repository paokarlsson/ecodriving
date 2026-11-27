// Körmotor: kartmatchning, val av styrande fartmål, släpp-signal och statistik.
// Ren logik utan DOM: matas med GPS-observationer, ger tillstånd och händelser.
import { matchToRoute, gradeAt, headingAt } from './route.js';
import { angleDiff, headingXY, makeProjector } from './geo.js';
import { releasePoint } from './physics.js';

export const DRIVE = {
  maxAccuracy: 30,     // m; sämre GPS → pausa
  offRouteDist: 40,    // m från rutten räknas som avvikelse (vid sämre GPS)
  offRouteMin: 25,     // m: lägsta gräns vid god GPS (gränsen är 15 m + 2 × noggrannheten)
  offRouteHold: 4,     // s innan avvikelse bekräftas
  headingOff: 60,      // grader mellan GPS-kurs och rutt som räknas som annan väg
  headingMinV: 8,      // m/s: kursen jämförs bara över ca 30 km/h
  headingMaxAcc: 15,   // m: och bara vid god GPS
  lookahead: 5000,     // m framåt som fartmål beaktas
  approachDist: 800,   // m kvar till signal då nedräkning visas
  followWindow: 4,     // s efter signal+marginal då släppt gas ska synas
  followDrop: 0.4,     // m/s fartminskning som räknas som släppt gas
  arriveDist: 25,      // m kvar till målet
  brakeSlack: 1.1,     // m/s över rullkurvan som tolereras under rullning
  pedalFresh: 3,       // s: så länge efter senaste pedalvärdet gäller pedalen i stället för GPS-farten
};

export class DriveEngine {
  /**
   * route, targets (från buildTargets), model {A, C},
   * settings {marginS}
   */
  constructor(route, targets, model, settings = {}) {
    this.route = route;
    this.targets = targets;
    this.model = model;
    this.marginS = settings.marginS ?? 1.5;
    this.sHint = null;
    this.s = 0;
    this.lastT = null;
    this.lastS = null;
    this.v = 0;
    this.offSince = null;
    this.paused = null;      // null | 'gps' | 'offroute'
    this.fired = new Set();
    this.coast = null;       // {target, t0, minV, vRelease}
    this.pending = [];       // uppföljning av signaler
    this.stats = { signals: 0, followed: 0, late: 0, brakeWarnings: 0, distance: 0, startT: null, endT: null };
    this.arrived = false;
    this.pedalT = null;      // tid för senaste pedalvärde (OBD)
    this.released = null;    // gasen släppt enligt pedalen
    this.gradeAt = s => gradeAt(route, s);
  }

  /** obs = {t (s), lat, lon, speed (m/s|null), accuracy (m), heading?} */
  update(obs) {
    const events = [];
    const { t } = obs;
    if (this.stats.startT == null) this.stats.startT = t;
    if (this.arrived) return { view: this.view('arrived'), events };

    // 1. GPS-kvalitet
    if (obs.accuracy != null && obs.accuracy > DRIVE.maxAccuracy) {
      this.setPaused('gps', events);
      return { view: this.view('paused'), events };
    }

    // 2. Kartmatchning
    const m = matchToRoute(this.route, obs.lat, obs.lon, this.sHint);
    if (!m || this.offRoute(m, obs)) {
      if (this.offSince == null) this.offSince = t;
      if (t - this.offSince >= DRIVE.offRouteHold) {
        if (this.paused !== 'offroute') events.push({ type: 'offroute' });
        this.setPaused('offroute', events);
      }
      return { view: this.view(this.paused ? 'paused' : 'free'), events };
    }
    this.offSince = null;
    if (this.paused) { this.paused = null; events.push({ type: 'resume' }); }

    const s = m.s;
    let v = obs.speed;
    if (v == null || !Number.isFinite(v) || v < 0) {
      v = (this.lastT != null && t > this.lastT) ? Math.max(0, (s - this.lastS) / (t - this.lastT)) : this.v;
    }
    if (this.lastS != null && s > this.lastS) this.stats.distance += s - this.lastS;
    this.sHint = s; this.s = s; this.v = v; this.lastT = t; this.lastS = s;

    // 3. Uppföljning: släppte föraren gasen? Med pedalen (OBD) avgör pedal(),
    //    annars syns det på att GPS-farten sjunker.
    const byPedal = this.pedalActive(t);
    for (const p of this.pending) {
      p.minV = Math.min(p.minV, v);
      if (!p.done && !byPedal && p.v0 - p.minV >= DRIVE.followDrop) {
        p.done = true; p.followed = true; this.stats.followed++;
        events.push({ type: 'follow', followed: true, target: p.target, afterS: t - p.t0 });
      }
      if (!p.done && t > p.t0 + this.marginS + DRIVE.followWindow) {
        p.done = true; p.followed = false;
        events.push({ type: 'follow', followed: false, target: p.target });
      }
    }
    this.pending = this.pending.filter(p => !p.done);

    // 4. Framme?
    if (s >= this.route.length - DRIVE.arriveDist) {
      this.arrived = true;
      this.stats.endT = t;
      events.push({ type: 'arrived', stats: { ...this.stats } });
      return { view: this.view('arrived'), events };
    }

    // 5. Rullar vi mot ett mål?
    if (this.coast) {
      const c = this.coast;
      c.minV = Math.min(c.minV, v);
      if (s >= c.target.s - 5) {
        events.push({ type: 'reached', target: c.target, v });
        this.coast = null;
      } else if (byPedal ? c.released && this.released === false : v - c.minV > 0.8) {
        // Föraren gav gas igen – sluta visa "rullar".
        this.coast = null;
      } else {
        const brakeNeeded = c.brakeNeeded || this.overCoastCurve(c.target, v, s);
        return { view: this.view('coasting', { target: c.target, distToTarget: c.target.s - s, brakeNeeded }), events };
      }
    }

    // 6. Hitta styrande mål: det som kräver tidigast släpp.
    let best = null;
    for (const tg of this.targets) {
      if (tg.s <= s + 2) continue;
      if (tg.s - s > DRIVE.lookahead) break;
      const rp = releasePoint(tg, v, s, this.gradeAt, this.model);
      if (rp.notNeeded || rp.release == null) continue;
      const signalS = rp.release - v * this.marginS;
      if (!best || signalS < best.signalS) best = { target: tg, rp, signalS };
    }

    if (!best) {
      const next = this.targets.find(tg => tg.s > s + 2);
      return { view: this.view('free', { next, distToNext: next ? next.s - s : null }), events };
    }

    const dist = best.signalS - s;
    if (dist <= 0 && !this.fired.has(best.target.id)) {
      this.fired.add(best.target.id);
      const late = best.rp.late || dist < -v * 2;
      this.stats.signals++;
      if (late) this.stats.late++;
      if (best.rp.brakeNeeded) this.stats.brakeWarnings++;
      events.push({ type: 'release', target: best.target, late, brakeNeeded: best.rp.brakeNeeded });
      this.pending.push({ t0: t, v0: v, minV: v, done: false, target: best.target });
      this.coast = { target: best.target, t0: t, minV: v, brakeNeeded: best.rp.brakeNeeded, released: this.released === true };
      return { view: this.view('coasting', { target: best.target, distToTarget: best.target.s - s, brakeNeeded: best.rp.brakeNeeded, justReleased: true }), events };
    }
    if (dist <= 0) {
      // Redan signalerat för detta mål men föraren gav gas igen.
      const brakeNeeded = best.rp.brakeNeeded || this.overCoastCurve(best.target, v, s);
      return { view: this.view('coasting', { target: best.target, distToTarget: best.target.s - s, brakeNeeded }), events };
    }
    const mode = dist <= DRIVE.approachDist ? 'approach' : 'free';
    return {
      view: this.view(mode, { target: best.target, distToRelease: dist, brakeNeeded: best.rp.brakeNeeded, next: best.target, distToNext: best.target.s - s }),
      events,
    };
  }

  /** Gäller pedalen (OBD) just nu? */
  pedalActive(t) {
    return this.pedalT != null && t - this.pedalT <= DRIVE.pedalFresh && this.released != null;
  }

  /**
   * Gaspedalen från OBD (t i samma tidsskala som GPS, released = gasen helt
   * släppt). Ger exakt när föraren släppte gasen efter en signal. Returnerar
   * händelser som update().
   */
  pedal(t, released) {
    const events = [];
    if (released == null) return events;
    this.pedalT = t;
    this.released = released;
    if (this.coast && released) this.coast.released = true;
    if (released) {
      for (const p of this.pending) {
        if (p.done) continue;
        p.done = true; p.followed = true; this.stats.followed++;
        events.push({ type: 'follow', followed: true, target: p.target, afterS: Math.max(0, t - p.t0), byPedal: true });
      }
      this.pending = this.pending.filter(p => !p.done);
    }
    return events;
  }

  /**
   * Byter fartmål under körning (t.ex. när vägdata för resten av rutten har
   * kommit). Mål som redan har gett signal känns igen på läget, så att de
   * inte signaleras igen.
   */
  setTargets(targets) {
    const old = this.targets.filter(t => this.fired.has(t.id));
    this.targets = targets;
    this.fired = new Set();
    for (const t of targets) {
      if (old.some(o => Math.abs(o.s - t.s) < 40) || (this.coast && Math.abs(this.coast.target.s - t.s) < 40)) this.fired.add(t.id);
    }
  }

  /**
   * Räcker rullningen fram till målet med nuvarande modell (som kan ha
   * justerats under rullningen)? Mer än ca 4 km/h över rullkurvan betyder
   * att broms kan behövas.
   */
  overCoastCurve(target, v, s) {
    const rp = releasePoint(target, Math.max(0, v - DRIVE.brakeSlack), s, this.gradeAt, this.model);
    return !!rp.brakeNeeded || !!rp.late;
  }

  /**
   * Har bilen lämnat rutten fast positionen matchar? Gränsen för avståndet
   * krymper med bättre GPS (en parallell väg 30 m bort syns då), och en
   * GPS-kurs som pekar en annan väg än rutten räknas också som avvikelse.
   */
  offRoute(m, obs) {
    const acc = obs.accuracy ?? DRIVE.offRouteDist;
    const limit = Math.max(DRIVE.offRouteMin, Math.min(DRIVE.offRouteDist, 15 + 2 * acc));
    if (m.dist > limit) return true;
    const h = obs.heading, v = obs.speed;
    if (h == null || !Number.isFinite(h) || v == null || v < DRIVE.headingMinV || acc > DRIVE.headingMaxAcc) return false;
    return angleDiff(h, headingAt(this.route, m.s)) > DRIVE.headingOff;
  }

  setPaused(reason, events) {
    if (this.paused !== reason) {
      if (!this.paused) events.push({ type: 'pause', reason });
      this.paused = reason;
      this.coast = null;
    }
  }

  view(mode, extra = {}) {
    return { mode, s: this.s, v: this.v, paused: this.paused, remaining: this.route.length - this.s, ...extra };
  }
}

/**
 * Färdriktning (grader, 0 = norr) för en ny rutt: GPS-kursen vid fart och god
 * GPS, annars riktningen från en position minst 20 m bakåt de senaste 20 s.
 * trail = tidigare observationer, äldst först. null om riktningen är okänd.
 */
export function travelHeading(trail, obs) {
  const h = obs.heading;
  if (h != null && Number.isFinite(h) && (obs.speed ?? 0) > 3 && (obs.accuracy ?? 99) <= 30) return h;
  const proj = makeProjector(obs.lat, obs.lon);
  for (let i = trail.length - 1; i >= 0; i--) {
    const p = trail[i];
    if (obs.t - p.t > 20) break;
    if ((p.accuracy ?? 0) > 30) continue;
    const [x, y] = proj.toXY(p.lat, p.lon);
    if (Math.hypot(x, y) >= 20) return headingXY(-x, -y);
  }
  return null;
}

/** Talat meddelande för en släpp-händelse. */
export function releaseMessage(ev) {
  const t = ev.target;
  let what;
  switch (t.kind) {
    case 'traffic_signals': what = 'rulla mot ljuset'; break;
    case 'roundabout': what = 'rondell'; break;
    case 'curve': what = 'kurva'; break;
    case 'limit': what = `sänkt hastighet, ${t.kmh ?? Math.round(t.v * 3.6)}`; break;
    case 'stop': what = 'stopplikt'; break;
    case 'give_way': what = 'väjningsplikt'; break;
    case 'end': what = 'framme snart'; break;
    default: what = '';
  }
  let msg = ev.late ? 'Släpp nu' : 'Släpp gasen';
  if (what) msg += ', ' + what;
  if (ev.brakeNeeded) msg += '. Nedförsbacke, broms kan behövas';
  else if (ev.late) msg += '. Broms kan behövas';
  return msg;
}
