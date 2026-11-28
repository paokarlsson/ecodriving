// Rekommenderat gaspådrag (gaspedal i %, eller bränsleflöde i l/h, OBD). Appen lär sig vilken pedal
// som håller farten på plan väg och hur mycket extra pedal som ger en viss
// acceleration. Rekommendationen följer läget: släpp före ett mål, håll farten
// vid gränsen, accelerera lugnt upp till den, släpp när farten är för hög.
import { G } from './physics.js';

export const GAS = {
  ecoAccel: 0.9,      // m/s²: lugn acceleration (ca 0,1 g)
  holdBand: 3,        // ± % runt pedalen som håller farten
  accelBand: 5,       // ± % runt pedalen för lugn acceleration
  accelBelow: 6,      // km/h under målfarten: accelerera
  overBy: 3,          // km/h över målfarten: släpp
  releaseSoon: 150,   // m kvar till släpp-signal då gasen inte ska tryckas på mer
  minKmh: 8,          // under detta ges ingen rekommendation (start, kö)
  binKmh: 10,         // inlärning per 10 km/h
  steadyA: 0.15,      // m/s²: jämn fart
  learnRate: 0.08,    // vikt för nytt värde (glidande medel)
  minCount: 5,        // så många mätningar innan ett fack gäller
  gain: 14,           // % pedal per m/s² (typvärde)
};

/** Typvärde: pedal som håller farten på plan väg, % (ca 12 % vid 50, 18 % vid 90 km/h). */
export const typicalCruise = kmh => 6 + 0.13 * kmh;

/**
 * Värdet för farten ur inlärda fack {"50": {p, n}}, mellan facken linjärt;
 * med ett fack följer det typvärdets form, utan fack är det typvärdet.
 */
function fromBins(bins, kmh, typical) {
  const pts = Object.entries(bins)
    .filter(([, b]) => b.n >= GAS.minCount)
    .map(([k, b]) => [Number(k), b.p]).sort((a, b) => a[0] - b[0]);
  if (!pts.length) return { x: typical(kmh), learned: false };
  if (pts.length === 1) return { x: pts[0][1] + (typical(kmh) - typical(pts[0][0])), learned: true };
  let i = 0;
  while (i < pts.length - 2 && kmh > pts[i + 1][0]) i++;
  const [k0, p0] = pts[i], [k1, p1] = pts[i + 1];
  const t = (kmh - k0) / (k1 - k0);
  const lo = Math.min(p0, p1) * 0.5;
  return { x: Math.max(lo, p0 + t * (p1 - p0)), learned: true };
}

/** Glidande medel in i ett fack. */
function toBin(bins, kmh, value) {
  const k = String(Math.round(kmh / GAS.binKmh) * GAS.binKmh);
  const b = bins[k] || { p: value, n: 0 };
  b.p = b.n ? b.p + Math.max(GAS.learnRate, 1 / (b.n + 1)) * (value - b.p) : value;
  b.n++;
  bins[k] = b;
}

export class PedalModel {
  constructor(json = null) {
    this.bins = { ...(json?.bins || {}) };     // "50": {p, n}
    this.gain = json?.gain ?? null;            // % per m/s²
    this.gainN = json?.gainN ?? 0;
  }

  get unit() { return 'pct'; }
  get scale() { return 100; }

  /** Pedal (%) som håller farten kmh på plan väg; learned = ur egna mätningar. */
  cruise(kmh) {
    const c = fromBins(this.bins, kmh, typicalCruise);
    return { pct: c.x, learned: c.learned };
  }

  /** Gemensamt gränssnitt för rekommendationen: nivån som håller farten. */
  level(kmh) { const c = this.cruise(kmh); return { x: c.pct, learned: c.learned }; }
  /** Extra pedal för accelerationen a (m/s², backen räknad som acceleration). */
  extra(kmh, a) { return this.gainPct() * a; }
  band(kind) { return kind === 'accel' ? GAS.accelBand : GAS.holdBand; }

  gainPct() { return this.gainN >= GAS.minCount ? this.gain : GAS.gain; }

  /**
   * En mätning: fart (km/h), acceleration (m/s²), pedal (%), lutning (andel,
   * 0 om okänd). Jämn fart med gas lär pedalen för farten; tydlig acceleration
   * lär hur mycket extra pedal den kräver.
   */
  learn(kmh, a, pedal, grade = 0) {
    if (kmh == null || a == null || pedal == null || !Number.isFinite(a) || kmh < 20 || pedal < 3) return;
    const lr = GAS.learnRate;
    // Backen räknas som acceleration: uppför kräver mer pedal
    const aEff = a + G * (grade || 0);
    if (Math.abs(aEff) < GAS.steadyA && Math.abs(a) < GAS.steadyA) {
      toBin(this.bins, kmh, pedal);
    } else if (aEff > 0.4) {
      const extra = pedal - this.cruise(kmh).pct;
      if (extra <= 0) return;
      const g = Math.max(4, Math.min(60, extra / aEff));
      this.gain = this.gainN ? this.gain + Math.max(lr, 1 / (this.gainN + 1)) * (g - this.gain) : g;
      this.gainN++;
    }
  }

  toJSON() { return { bins: this.bins, gain: this.gain, gainN: this.gainN }; }
}

// Bränsleflöde (l/h) i stället för pedal: fungerar även med farthållaren och
// mäter det som ska sparas. Motorn behöver ungefär effekten
// (rullmotstånd + acceleration + backe) · fart, och bränslet följer effekten.
export const FUEL = {
  q: 0.5,          // l/h per (m/s² · m/s), typvärde (bensin, ca 1 500 kg; körlogg 2026-11-28)
  idle: 1.1,       // l/h tomgång, typvärde
  overIdle: 0.5,   // l/h utöver tomgången när bilen rullar med gas (högre varv)
  holdRel: 0.12, holdMin: 0.5,   // ± runt flödet som håller farten (andel, minst l/h)
  accelRel: 0.15, accelMin: 1,   // ± för lugn acceleration
  scale: 20,       // l/h: gasradens fulla bredd
  maxGrade: 0.02,  // brantare än så (enligt höjddatan) lärs inte flödet för farten
  max: 40,
};

export class FuelModel {
  /** json: sparad modell; coast: rullmodellen {A, C} (rullmotståndet som ska övervinnas). */
  constructor(json = null, coast = null) {
    this.bins = { ...(json?.bins || {}) };     // flöde (l/h) som håller farten på plan väg
    this.q = json?.q ?? null;
    this.qN = json?.qN ?? 0;
    this.idle = json?.idle ?? null;
    this.idleN = json?.idleN ?? 0;
    this.A = coast?.A ?? 0.2;
    this.C = coast?.C ?? 0.00025;
  }

  get unit() { return 'lh'; }
  get scale() { return FUEL.scale; }

  idleLh() { return this.idleN >= 3 ? this.idle : FUEL.idle; }
  qLh() { return this.qN >= GAS.minCount ? this.q : FUEL.q; }

  /** Typvärde: flödet som håller farten på plan väg (l/h). */
  typical(kmh) {
    const v = kmh / 3.6;
    return this.idleLh() + FUEL.overIdle + this.qLh() * (this.A + this.C * v * v) * v;
  }

  level(kmh) { return fromBins(this.bins, kmh, k => this.typical(k)); }
  extra(kmh, a) { return this.qLh() * a * Math.max(0, kmh) / 3.6; }
  band(kind, mid) {
    return kind === 'accel' ? Math.max(FUEL.accelMin, FUEL.accelRel * mid) : Math.max(FUEL.holdMin, FUEL.holdRel * mid);
  }

  /** Flödet (l/h) för att hålla farten kmh i lutningen grade, aldrig under 0. */
  holdLh(kmh, grade = 0) {
    return Math.max(0, this.level(kmh).x + this.extra(kmh, G * (grade || 0)));
  }

  /** Tomgång: bilen står still med motorn igång. */
  learnIdle(lh) {
    if (lh == null || !(lh > 0.2) || lh > 4) return;
    this.idle = this.idleN ? this.idle + Math.max(GAS.learnRate, 1 / (this.idleN + 1)) * (lh - this.idle) : lh;
    this.idleN++;
  }

  /**
   * En mätning med gas (pedal eller farthållare, inte avstängt bränsle): fart
   * (km/h), acceleration (m/s²), flöde (l/h), lutning. Jämn fart lär flödet för
   * farten, omräknat till plan väg; tydlig acceleration lär q.
   */
  learn(kmh, a, lh, grade = 0) {
    if (kmh == null || a == null || lh == null || !Number.isFinite(a) || !Number.isFinite(lh) || kmh < 20 || lh <= 0) return;
    const gr = grade || 0;
    const aEff = a + G * gr;
    if (Math.abs(a) < GAS.steadyA && Math.abs(gr) <= FUEL.maxGrade) {
      const flat = lh - this.extra(kmh, G * gr);
      if (flat > this.idleLh() * 0.5) toBin(this.bins, kmh, flat);
    } else if (aEff > 0.4) {
      const extra = lh - this.level(kmh).x;
      if (extra <= 0) return;
      const q = Math.max(0.15, Math.min(2, extra / (aEff * kmh / 3.6)));
      this.q = this.qN ? this.q + Math.max(GAS.learnRate, 1 / (this.qN + 1)) * (q - this.q) : q;
      this.qN++;
    }
  }

  /**
   * Backen (m/s², g·lutning) ur en mätning med gas: det flöde som inte går
   * till farten på plan väg eller till accelerationen a går till backen.
   */
  hillWithGas(kmh, a, lh) {
    const v = kmh / 3.6;
    if (v < 5 || lh == null) return null;
    return (lh - this.level(kmh).x) / (this.qLh() * v) - a;
  }

  /** Backen ur en rullning: inbromsningen utöver rullmodellen. */
  hillCoasting(kmh, a) {
    const v = kmh / 3.6;
    return -a - (this.A + this.C * v * v);
  }

  toJSON() { return { bins: this.bins, q: this.q, qN: this.qN, idle: this.idle, idleN: this.idleN }; }
}

/**
 * Backen som bilen känner den, ur OBD: bränsleflöde mot acceleration med gas,
 * inbromsning när gasen är släppt. Höjddatan har fel på flera procent; i l/h
 * väger backen tungt (2 % i 70 km/h är ca 2 l/h), så gasrådet använder den
 * här skattningen när den finns. Utjämnad över ca 6 s.
 */
export class HillEstimate {
  constructor() { this.a = null; this.n = 0; }
  add(est) {
    if (est == null || !Number.isFinite(est)) return;
    const x = Math.max(-1.5, Math.min(1.5, est));
    this.a = this.a == null ? x : this.a + 0.15 * (x - this.a);
    this.n++;
  }
  /** Lutning (andel), eller null innan det finns nog med mätningar. */
  grade() { return this.n >= 5 ? this.a / G : null; }
  reset() { this.a = null; this.n = 0; }
}

const fmtKmh = k => `${Math.round(k)}`;

/**
 * Rekommendation för läget. model = PedalModel (pedal i %) eller FuelModel
 * (bränsleflöde i l/h). in = {kmh, mode, distToRelease (m), limitKmh,
 * curveKmh (rekommenderad kurvfart om bilen är i eller nära en kurva), grade}.
 * Ger {kind: 'release' | 'hold' | 'accel' | 'none', lo, hi, mid, goal, learned, unit, scale}.
 */
export function recommendGas(model, { kmh, mode, distToRelease = null, limitKmh = null, curveKmh = null, grade = 0 }) {
  if (kmh == null || kmh < GAS.minKmh) return { kind: 'none' };
  const unit = model.unit, scale = model.scale;
  const rel = extra => ({ kind: 'release', lo: 0, hi: 0, mid: 0, unit, scale, ...extra });
  if (mode === 'coasting') return rel({ why: 'coast' });
  if (mode === 'approach' && distToRelease != null && distToRelease < GAS.releaseSoon) {
    return rel({ why: 'soon', dist: distToRelease });
  }
  const goals = [limitKmh, curveKmh].filter(x => x != null && Number.isFinite(x));
  const goal = goals.length ? Math.min(...goals) : null;
  if (goal != null && kmh > goal + GAS.overBy) return rel({ why: 'over', goal });
  const top = unit === 'lh' ? FUEL.max : 100;
  const lim = x => Math.max(0, Math.min(top, x));
  const out = (kind, mid, learned) => {
    const b = model.band(kind, mid);
    return { kind, lo: lim(mid - b), hi: lim(mid + b), mid, goal, learned, unit, scale };
  };
  const hill = G * (grade || 0);
  if (goal != null && kmh < goal - GAS.accelBelow) {
    const c = model.level(kmh);
    return out('accel', lim(c.x + model.extra(kmh, GAS.ecoAccel + hill)), c.learned);
  }
  const k = goal != null ? Math.min(kmh, goal) : kmh;
  const c = model.level(k);
  return out('hold', lim(c.x + model.extra(k, hill)), c.learned);
}

/**
 * Ligger pedalen inom rekommendationen? null om det inte går att säga.
 * Med farthållaren (cruise) visar pedalen inget: släpp räknas som inte följt,
 * håll och accelerera går inte att bedöma.
 */
export function gasWithin(rec, pedal, released = null, cruise = false) {
  if (!rec || rec.kind === 'none') return null;
  // Med bränsleflödet syns farthållarens pådrag; bara släpp kräver att den slås av
  const fuel = rec.unit === 'lh';
  if (cruise && (rec.kind === 'release' || !fuel)) return rec.kind === 'release' ? false : null;
  if (pedal == null) return null;
  if (rec.kind === 'release') return released ?? pedal < (fuel ? 0.5 : 3);
  const tol = fuel ? 0.2 : 1;
  return pedal >= rec.lo - tol && pedal <= rec.hi + tol;
}

/** Kort text under gasraden. */
export function gasHint(rec, pedal, released = null, cruise = false) {
  if (!rec || rec.kind === 'none') return '';
  if (cruise && (rec.kind === 'release' || rec.unit !== 'lh')) {
    if (rec.kind === 'release') return rec.why === 'over' ? `Över ${fmtKmh(rec.goal)}: slå av farthållaren` : 'Slå av farthållaren – rulla';
    return 'Farthållaren håller farten';
  }
  const ok = gasWithin(rec, pedal, released);
  switch (rec.kind) {
    case 'release':
      if (rec.why === 'coast') return ok ? 'Rullar – ingen gas' : 'Släpp gasen helt – rulla';
      if (rec.why === 'soon') return `Släpp snart – gasa inte upp farten`;
      return `Över ${fmtKmh(rec.goal)}: släpp gasen`;
    case 'accel':
      if (ok) return `Lugn acceleration mot ${fmtKmh(rec.goal)}`;
      return pedal > rec.hi ? `Accelerera lugnare mot ${fmtKmh(rec.goal)}` : `Mer gas går bra, upp mot ${fmtKmh(rec.goal)}`;
    case 'hold': {
      const what = rec.goal != null ? `Håll ${fmtKmh(rec.goal)}` : 'Håll farten';
      if (ok) return what;
      if (cruise) return pedal > rec.hi ? `${what}: farthållaren drar mycket` : what;
      return pedal > rec.hi ? `${what}: lätta lite på gasen` : `${what}: lite mer gas`;
    }
    default: return '';
  }
}
