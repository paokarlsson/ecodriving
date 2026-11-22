// Inlärning av rullmodellen (A, C) under vanlig körning.
// Varje gång bilen rullar med släppt gas blir det ett litet rullprov: appen
// hittar rullningen i GPS-farten, klipper bort gas och broms, korrigerar för
// backen med ruttens höjddata och väger ihop alla rullningar med rullprovet.
import { G, decel } from './physics.js';

const KMH = 1 / 3.6;

export const COAST = {
  vMin: 30 * KMH, vMax: 110 * KMH,
  startDecel: 0.12,  // m/s², jämn inbromsning som kan vara rullning
  maxDecel: 1.6,     // m/s², mer än så är broms
  brakeMargin: 0.8,  // m/s² mer än modellen förutsäger, två gånger i rad = broms
  brakeAccel: 2.2,   // m/s², ihållande accelerometerutslag = broms
  maxAcc: 15,        // m, sämre GPS avbryter
  maxGap: 3,         // s mellan GPS-punkter
  minDur: 5,         // s
  minDrop: 4 * KMH,  // m/s fartminskning
  skipStart: 1.5,    // s i början (foten lämnar gasen)
  skipEnd: 1.0,      // s i slutet (innan gas eller broms)
  heavierMax: 0.3,   // m/s²: bromsade mer än modellen → broms eller fel
  lighterMax: 0.18,  // m/s²: rullade lättare än modellen → troligen friläge (med kalibrerad modell)
  lighterMaxTypical: 0.35, // samma med bara typvärden, som kan ligga långt från bilen
  segWeight: 3,      // en rullning väger högst som 3 punkter
  priorPoints: 7,    // rullprovet som startvärde: 7 punkter mellan 30 och 90 km/h …
  priorWeight: 3,    // … med vikt 3 var (≈ 7 rullningar)
};

/**
 * Hittar rullningar i GPS-farten. addGps() returnerar en färdig rullning
 * (eller null) när en rullning tar slut.
 */
export class CoastLearner {
  constructor(model) {
    this.model = model;
    this.buf = [];
    this.seg = null;
    this.brakeT = null;
    this.acc = [];
  }

  setModel(m) { this.model = m; }

  /** Accelerometerns linjära acceleration (m/s², storlek) – ihållande stöt = broms. */
  addAccel(t, mag) {
    if (!Number.isFinite(mag)) return;
    this.acc.push({ t, mag });
    while (this.acc.length && this.acc[0].t < t - 0.5) this.acc.shift();
    if (this.acc.length >= 5 && this.acc.reduce((a, x) => a + x.mag, 0) / this.acc.length > COAST.brakeAccel) this.brakeT = t;
  }

  /** p = {t, v (m/s), grade, acc (m), ok (på rutten, inte pausad)} */
  addGps(p) {
    if (!p.ok || p.v == null || !Number.isFinite(p.v) || (p.acc != null && p.acc > COAST.maxAcc)) return this.cut('gps');
    const last = this.buf[this.buf.length - 1];
    if (last && p.t - last.t > COAST.maxGap) { const r = this.cut('lucka'); this.buf = [p]; return r; }
    this.buf.push(p);
    while (this.buf.length > 3) this.buf.shift();

    if (!this.seg) {
      if (this.buf.length < 3) return null;
      const a = this.buf[0], b = this.buf[this.buf.length - 1];
      const d = -(b.v - a.v) / (b.t - a.t);
      if (d >= COAST.startDecel && d <= COAST.maxDecel && b.v >= COAST.vMin && a.v <= COAST.vMax) {
        this.seg = { samples: this.buf.slice(), hard: 0, minV: Math.min(...this.buf.map(x => x.v)) };
      }
      return null;
    }

    const seg = this.seg;
    const prev = seg.samples[seg.samples.length - 1];
    if (p.v > seg.minV + 0.5) return this.cut('gas');
    if (this.brakeT != null && p.t - this.brakeT < 2) { seg.samples.splice(-1, 1); return this.cut('broms'); }
    const di = -(p.v - prev.v) / Math.max(0.2, p.t - prev.t);
    const pred = decel(p.v, p.grade ?? 0, this.model);
    if (di > pred + COAST.brakeMargin || di > COAST.maxDecel) {
      if (++seg.hard >= 2) { seg.samples.splice(-1, 1); return this.cut('broms'); }
    } else seg.hard = 0;
    seg.samples.push(p);
    seg.minV = Math.min(seg.minV, p.v);
    if (p.v < COAST.vMin) return this.cut('låg fart');
    return null;
  }

  /** Avslutar pågående rullning (t.ex. när körningen slutar). */
  cut(reason) {
    const seg = this.seg;
    this.seg = null;
    this.buf = [];
    if (!seg) return null;
    return finalizeSegment(seg.samples, reason);
  }
}

/** Gör en rullning till mätpunkter {v, a} med inbromsningen korrigerad för backen. */
export function finalizeSegment(samples, end) {
  const t0 = samples[0]?.t, t1 = samples[samples.length - 1]?.t;
  const use = samples.filter(s => s.t >= t0 + COAST.skipStart && s.t <= t1 - COAST.skipEnd);
  const points = [];
  for (let i = 1; i < use.length - 1; i++) {
    const dt = use[i + 1].t - use[i - 1].t;
    if (dt <= 0) continue;
    const a = -(use[i + 1].v - use[i - 1].v) / dt;
    const grade = (use[i - 1].grade + use[i].grade + use[i + 1].grade) / 3 || 0;
    if (use[i].v < COAST.vMin || use[i].v > COAST.vMax) continue;
    points.push({ v: use[i].v, a: a - G * grade, grade });
  }
  const dur = samples.length ? t1 - t0 : 0;
  const drop = samples.length ? samples[0].v - Math.min(...samples.map(s => s.v)) : 0;
  let ok = true, reason = null;
  if (dur < COAST.minDur) { ok = false; reason = 'för kort'; }
  else if (drop < COAST.minDrop) { ok = false; reason = 'för liten fartminskning'; }
  else if (points.length < 3) { ok = false; reason = 'för få mätpunkter'; }
  return {
    startT: t0, endT: t1, dur, fromV: samples[0]?.v, toV: samples[samples.length - 1]?.v,
    s: samples[0]?.s ?? null, end, points, ok, reason,
  };
}

/** Avvikelse från modellen (m/s², medel av mätt − förutsagt). */
export function segmentResidual(seg, model) {
  if (!seg.points.length) return null;
  return seg.points.reduce((sum, p) => sum + (p.a - (model.A + model.C * p.v * p.v)), 0) / seg.points.length;
}

/**
 * Godkänn en rullning mot nuvarande modell (sorterar bort friläge, broms och
 * fel). calibrated = modellen bygger på ett rullprov; annars är gränsen mot
 * "lättare än väntat" generösare, eftersom typvärdena kan ligga långt ifrån.
 */
export function acceptSegment(seg, model, { calibrated = true } = {}) {
  if (!seg.ok) return { ok: false, reason: seg.reason };
  const resid = segmentResidual(seg, model);
  if (resid > COAST.heavierMax) return { ok: false, reason: 'bromsade mer än väntat (broms?)', resid };
  if (resid < -(calibrated ? COAST.lighterMax : COAST.lighterMaxTypical)) return { ok: false, reason: 'rullade lättare än väntat (friläge?)', resid };
  return { ok: true, resid };
}

/**
 * Samlade rullningar som summor för minstakvadrat a = A + C·v².
 * fit(prior) väger ihop dem med rullprovet (eller typvärdena).
 */
export class CoastStats {
  constructor(o = {}) {
    this.sw = o.sw || 0; this.sx = o.sx || 0; this.sy = o.sy || 0;
    this.sxx = o.sxx || 0; this.sxy = o.sxy || 0;
    this.segments = o.segments || 0; this.points = o.points || 0;
    this.updated = o.updated || null;
  }

  add(points, now = Date.now()) {
    if (!points.length) return;
    const w = Math.min(1, COAST.segWeight / points.length);
    for (const p of points) {
      const x = p.v * p.v;
      this.sw += w; this.sx += w * x; this.sy += w * p.a;
      this.sxx += w * x * x; this.sxy += w * x * p.a;
    }
    this.segments++;
    this.points += points.length;
    this.updated = new Date(now).toISOString();
  }

  /** Modell ur rullprovet (prior) och alla rullningar. null om inga rullningar finns. */
  fit(prior) {
    if (!this.segments) return null;
    let { sw, sx, sy, sxx, sxy } = this;
    for (let k = 0; k < COAST.priorPoints; k++) {
      const v = (30 + (60 * k) / (COAST.priorPoints - 1)) * KMH;
      const x = v * v, y = prior.A + prior.C * x, w = COAST.priorWeight;
      sw += w; sx += w * x; sy += w * y; sxx += w * x * x; sxy += w * x * y;
    }
    const mx = sx / sw, my = sy / sw;
    const varx = sxx / sw - mx * mx;
    let C = varx > 1e-9 ? (sxy / sw - mx * my) / varx : prior.C;
    if (!(C >= 0)) C = prior.C;
    C = Math.min(0.0015, C);
    let A = my - C * mx;
    A = Math.max(0.05, Math.min(1.5, A));
    return { A, C, segments: this.segments, points: this.points };
  }

  toJSON() {
    const { sw, sx, sy, sxx, sxy, segments, points, updated } = this;
    return { sw, sx, sy, sxx, sxy, segments, points, updated };
  }
}
