// Rekommenderat gaspådrag (gaspedal i %, OBD). Appen lär sig vilken pedal
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

export class PedalModel {
  constructor(json = null) {
    this.bins = { ...(json?.bins || {}) };     // "50": {p, n}
    this.gain = json?.gain ?? null;            // % per m/s²
    this.gainN = json?.gainN ?? 0;
  }

  /** Pedal (%) som håller farten kmh på plan väg; learned = ur egna mätningar. */
  cruise(kmh) {
    const pts = Object.entries(this.bins)
      .filter(([, b]) => b.n >= GAS.minCount)
      .map(([k, b]) => [Number(k), b.p]).sort((a, b) => a[0] - b[0]);
    if (!pts.length) return { pct: typicalCruise(kmh), learned: false };
    if (pts.length === 1) return { pct: pts[0][1] + (typicalCruise(kmh) - typicalCruise(pts[0][0])), learned: true };
    let i = 0;
    while (i < pts.length - 2 && kmh > pts[i + 1][0]) i++;
    const [k0, p0] = pts[i], [k1, p1] = pts[i + 1];
    const t = (kmh - k0) / (k1 - k0);
    const lo = Math.min(p0, p1) * 0.5;
    return { pct: Math.max(lo, p0 + t * (p1 - p0)), learned: true };
  }

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
      const k = String(Math.round(kmh / GAS.binKmh) * GAS.binKmh);
      const b = this.bins[k] || { p: pedal, n: 0 };
      b.p = b.n ? b.p + Math.max(lr, 1 / (b.n + 1)) * (pedal - b.p) : pedal;
      b.n++;
      this.bins[k] = b;
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

const clamp = x => Math.max(0, Math.min(100, x));
const fmtKmh = k => `${Math.round(k)}`;

/**
 * Rekommendation för läget. in = {kmh, mode, distToRelease (m), limitKmh,
 * curveKmh (rekommenderad kurvfart om bilen är i eller nära en kurva), grade}.
 * Ger {kind: 'release' | 'hold' | 'accel' | 'none', lo, hi, mid, goal, learned}.
 */
export function recommendGas(model, { kmh, mode, distToRelease = null, limitKmh = null, curveKmh = null, grade = 0 }) {
  if (kmh == null || kmh < GAS.minKmh) return { kind: 'none' };
  if (mode === 'coasting') return { kind: 'release', lo: 0, hi: 0, mid: 0, why: 'coast' };
  if (mode === 'approach' && distToRelease != null && distToRelease < GAS.releaseSoon) {
    return { kind: 'release', lo: 0, hi: 0, mid: 0, why: 'soon', dist: distToRelease };
  }
  const goals = [limitKmh, curveKmh].filter(x => x != null && Number.isFinite(x));
  const goal = goals.length ? Math.min(...goals) : null;
  if (goal != null && kmh > goal + GAS.overBy) return { kind: 'release', lo: 0, hi: 0, mid: 0, why: 'over', goal };
  const slope = model.gainPct() * G * (grade || 0);
  if (goal != null && kmh < goal - GAS.accelBelow) {
    const c = model.cruise(kmh);
    const mid = clamp(c.pct + model.gainPct() * GAS.ecoAccel + slope);
    return { kind: 'accel', lo: clamp(mid - GAS.accelBand), hi: clamp(mid + GAS.accelBand), mid, goal, learned: c.learned };
  }
  const c = model.cruise(goal != null ? Math.min(kmh, goal) : kmh);
  const mid = clamp(c.pct + slope);
  return { kind: 'hold', lo: clamp(mid - GAS.holdBand), hi: clamp(mid + GAS.holdBand), mid, goal, learned: c.learned };
}

/**
 * Ligger pedalen inom rekommendationen? null om det inte går att säga.
 * Med farthållaren (cruise) visar pedalen inget: släpp räknas som inte följt,
 * håll och accelerera går inte att bedöma.
 */
export function gasWithin(rec, pedal, released = null, cruise = false) {
  if (!rec || rec.kind === 'none') return null;
  if (cruise) return rec.kind === 'release' ? false : null;
  if (pedal == null) return null;
  if (rec.kind === 'release') return released ?? pedal < 3;
  return pedal >= rec.lo - 1 && pedal <= rec.hi + 1;
}

/** Kort text under gasraden. */
export function gasHint(rec, pedal, released = null, cruise = false) {
  if (!rec || rec.kind === 'none') return '';
  if (cruise) {
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
      return pedal > rec.hi ? `${what}: lätta lite på gasen` : `${what}: lite mer gas`;
    }
    default: return '';
  }
}
