// Rutt: omsampling, lutning, kartmatchning och kurvfart.
import { makeProjector, headingXY, projectOnSegment } from './geo.js';

export const STEP = 10; // meter mellan sampelpunkter

/**
 * Bygger en rutt ur koordinater [[lon, lat, ele?], ...] (GeoJSON-ordning).
 * Resultatet har originalpunkter (för kartmatchning) och jämnt samplade
 * punkter var STEP meter (för lutning, kurvor och fysik).
 */
export function buildRoute(coords, { step = STEP } = {}) {
  if (!coords || coords.length < 2) throw new Error('Rutten har för få punkter');
  const proj = makeProjector(coords[0][1], coords[0][0]);
  const pts = [];
  let s = 0;
  for (const c of coords) {
    const [x, y] = proj.toXY(c[1], c[0]);
    if (pts.length) {
      const p = pts[pts.length - 1];
      const d = Math.hypot(x - p.x, y - p.y);
      if (d < 0.01) continue; // dubblett
      s += d;
    }
    pts.push({ x, y, lat: c[1], lon: c[0], ele: c.length > 2 && c[2] != null ? c[2] : null, s });
  }
  if (pts.length < 2) throw new Error('Rutten har för få punkter');
  const length = s;
  const hasEle = pts.some(p => p.ele != null);

  const n = Math.floor(length / step) + 1;
  const S = new Float64Array(n), X = new Float64Array(n), Y = new Float64Array(n);
  const E = new Float64Array(n), H = new Float64Array(n);
  let j = 0;
  for (let i = 0; i < n; i++) {
    const si = i * step;
    while (j < pts.length - 2 && pts[j + 1].s < si) j++;
    const a = pts[j], b = pts[j + 1];
    const t = b.s > a.s ? Math.min(1, Math.max(0, (si - a.s) / (b.s - a.s))) : 0;
    S[i] = si;
    X[i] = a.x + t * (b.x - a.x);
    Y[i] = a.y + t * (b.y - a.y);
    const ea = a.ele ?? b.ele ?? 0, eb = b.ele ?? a.ele ?? 0;
    E[i] = hasEle ? ea + t * (eb - ea) : 0;
    H[i] = headingXY(b.x - a.x, b.y - a.y);
  }

  const G = gradeFromElevation(E, step);
  return { proj, pts, step, length, n, S, X, Y, E, G, H, hasEle };
}

/**
 * Lutning (andel, uppför positiv) ur höjdprofilen. Höjden jämnas först ut
 * över ca ±30 m, lutningen tas sedan över ca 60 m för att dämpa DEM-brus.
 */
export function gradeFromElevation(E, step) {
  const n = E.length;
  const w = Math.max(1, Math.round(30 / step));
  const sm = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0, c = 0;
    for (let k = Math.max(0, i - w); k <= Math.min(n - 1, i + w); k++) { sum += E[k]; c++; }
    sm[i] = sum / c;
  }
  const G = new Float64Array(n);
  const k = Math.max(1, Math.round(30 / step));
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - k), b = Math.min(n - 1, i + k);
    G[i] = b > a ? (sm[b] - sm[a]) / ((b - a) * step) : 0;
    G[i] = Math.max(-0.15, Math.min(0.15, G[i]));
  }
  return G;
}

function sampleIndex(route, s) {
  const f = s / route.step;
  const i = Math.max(0, Math.min(route.n - 1, Math.floor(f)));
  return { i, t: Math.min(1, Math.max(0, f - i)) };
}

function interp(route, arr, s) {
  const { i, t } = sampleIndex(route, s);
  if (i >= route.n - 1) return arr[route.n - 1];
  return arr[i] + t * (arr[i + 1] - arr[i]);
}

export const gradeAt = (route, s) => interp(route, route.G, s);
export const elevationAt = (route, s) => interp(route, route.E, s);

/**
 * Medellutningen över ±half m (andel). Höjddata kommer i hela meter med
 * hopp på flera meter; för gasrådet, som ska hålla farten jämn, duger bara
 * den långa lutningen, annars hoppar rådet med varje hopp i höjddatan.
 */
export function gradeAvg(route, s, half = 150) {
  const a = Math.max(0, s - half), b = Math.min(route.length ?? (route.n - 1) * route.step, s + half);
  if (b - a < route.step) return gradeAt(route, s);
  const ia = Math.max(0, Math.floor(a / route.step)), ib = Math.min(route.n - 1, Math.ceil(b / route.step));
  let sum = 0;
  for (let i = ia; i <= ib; i++) sum += route.G[i];
  return sum / (ib - ia + 1);
}
export function headingAt(route, s) {
  return route.H[sampleIndex(route, s).i];
}
export function xyAt(route, s) {
  return [interp(route, route.X, s), interp(route, route.Y, s)];
}
export function latLonAt(route, s) {
  const [x, y] = xyAt(route, s);
  return route.proj.toLL(x, y);
}

/**
 * Kartmatchning: projicera en position på rutten.
 * Med sHint söks bara ett fönster runt senast kända läge, så att rutter som
 * går nära sig själva (t.ex. fram och tillbaka) inte hoppar.
 */
export function matchToRoute(route, lat, lon, sHint = null, { back = 80, ahead = 400 } = {}) {
  const [px, py] = route.proj.toXY(lat, lon);
  const pts = route.pts;
  const lo = sHint == null ? -Infinity : sHint - back;
  const hi = sHint == null ? Infinity : sHint + ahead;
  let best = null;
  for (let k = 0; k < pts.length - 1; k++) {
    const a = pts[k], b = pts[k + 1];
    if (b.s < lo || a.s > hi) continue;
    const r = projectOnSegment(px, py, a.x, a.y, b.x, b.y);
    if (!best || r.d < best.dist) {
      best = { s: a.s + r.t * (b.s - a.s), dist: r.d, seg: k };
    }
  }
  if (!best && sHint != null) return matchToRoute(route, lat, lon, null);
  return best;
}

/**
 * Lagom sidoacceleration (m/s²) vid farten v. Vid låg fart accepteras mer
 * sidokraft än vid hög; base gäller upp till 50 km/h och sjunker sedan
 * linjärt till 65 % av base vid 110 km/h (jfr vägutformningens friktionstal).
 */
export function comfortLatAccel(v, base) {
  const kmh = v * 3.6;
  if (kmh <= 50) return base;
  const f = 1 - 0.35 * Math.min(1, (kmh - 50) / 60);
  return base * f;
}

/** Rekommenderad fart (m/s) i en kurva med radien R (m): löser v = √(a_lat(v) · R). */
export function curveSpeedForRadius(R, base) {
  if (!Number.isFinite(R)) return Infinity;
  let v = Math.sqrt(base * R);
  for (let k = 0; k < 8; k++) v = Math.sqrt(comfortLatAccel(v, base) * R);
  return v;
}

/** Hur mycket den verkliga vägen kan avvika från ruttens linje (m). */
export const GEOM_TOLERANCE = 5;

/**
 * Kurvradie vid varje sampel, räknad hörn för hörn i ruttens linje.
 *
 * Linjen är en förenkling av vägen: där den bryter med vinkeln θ svänger
 * den verkliga vägen θ i en båge någonstans runt hörnet. Varje hörn får den
 * största båge som ryms i linjens geometri:
 *  - bågen får avvika högst GEOM_TOLERANCE från hörnet:
 *      R ≤ tol / (1/cos(θ/2) − 1)
 *  - bågen måste få plats på halva sträckorna till grannhörnen
 *    (grannhörnens bågar delar på samma sträcka):
 *      R ≤ (min(l1, l2) / 2) / tan(θ/2)
 * Ett hörn på 13° mellan 150 m långa sträckor blir då en kurva med radie
 * runt 620 m (som i verkligheten), en kurva ritad med täta punkter får sin
 * verkliga radie, och ett hörn på 90° i en korsning kan bara rymma en båge
 * på ca 12 m. Punkter närmare än 5 m slås ihop så att små skakningar i
 * linjen inte blir skarpa kurvor.
 */
export function curveRadii(route, { tol = GEOM_TOLERANCE, minSeg = 5 } = {}) {
  const P = route.pts;
  const V = [P[0]];
  for (let k = 1; k < P.length; k++) {
    const last = V[V.length - 1];
    if (Math.hypot(P[k].x - last.x, P[k].y - last.y) >= minSeg || k === P.length - 1) V.push(P[k]);
  }
  const R = new Float64Array(route.n).fill(Infinity);
  for (let j = 1; j < V.length - 1; j++) {
    const a = V[j - 1], b = V[j], c = V[j + 1];
    const l1 = Math.hypot(b.x - a.x, b.y - a.y), l2 = Math.hypot(c.x - b.x, c.y - b.y);
    if (l1 < 1e-6 || l2 < 1e-6) continue;
    let th = Math.abs(Math.atan2(c.y - b.y, c.x - b.x) - Math.atan2(b.y - a.y, b.x - a.x));
    if (th > Math.PI) th = 2 * Math.PI - th;
    if (th < 1e-4) continue;
    const half = Math.min(th / 2, Math.PI / 2 - 1e-3);
    const rTangent = (Math.min(l1, l2) / 2) / Math.tan(half);
    const rTol = tol / (1 / Math.cos(half) - 1);
    const r = Math.min(rTangent, rTol);
    // Bågen sträcker sig tangentlängden r·tan(θ/2) åt båda håll från hörnet
    const reach = Math.max(route.step / 2, r * Math.tan(half));
    const i0 = Math.max(0, Math.floor((b.s - reach) / route.step));
    const i1 = Math.min(route.n - 1, Math.ceil((b.s + reach) / route.step));
    for (let i = i0; i <= i1; i++) if (r < R[i]) R[i] = r;
  }
  return R;
}

/** Rekommenderad kurvfart (m/s) vid varje sampel. */
export function curveSpeeds(route, aLat) {
  const Rs = curveRadii(route);
  const V = new Float64Array(route.n).fill(Infinity);
  for (let i = 0; i < route.n; i++) V[i] = curveSpeedForRadius(Rs[i], aLat);
  V.radius = Rs;
  return V;
}

/**
 * Kurvor där rekommenderad fart understiger gränsen (minus 5 km/h), eller
 * 115 km/h där gränsen är okänd (okänd gräns räknas som 120). Målet läggs där kurvfarten först närmar sig
 * kurvans lägsta fart, så att bilen har rätt fart vid insläppet.
 * Varje kurva: {s, sEnd, v (m/s), radius (m), kind: 'curve'}.
 */
export function curveTargets(route, aLat, { limits = null, skipStart = 60, skipEnd = 30 } = {}) {
  const V = curveSpeeds(route, aLat);
  const cap = i => {
    const lim = limits && limits[i] != null && Number.isFinite(limits[i]) ? limits[i] : 120;
    return (lim - 5) / 3.6;
  };
  const out = [];
  let i = 0;
  while (i < route.n) {
    if (V[i] < cap(i)) {
      let j = i, vmin = V[i], imin = i;
      while (j < route.n && V[j] < cap(j)) {
        if (V[j] < vmin) { vmin = V[j]; imin = j; }
        j++;
      }
      let entry = i;
      for (let q = i; q <= imin; q++) { if (V[q] <= vmin * 1.15) { entry = q; break; } }
      const s = route.S[entry];
      if (s > skipStart && s < route.length - skipEnd) {
        out.push({
          s, sEnd: route.S[Math.min(route.n - 1, j - 1)], v: vmin,
          radius: V.radius[imin], kind: 'curve', label: 'kurva', dir: curveDir(route, imin),
        });
      }
      i = j + 1;
    } else i++;
  }
  return mergeCurves(out);
}

/**
 * Kurvor med mindre än 150 m emellan blir en: en slingrig sträcka ger en
 * signal före första kurvan med den lägsta farten, inte en kedja av sena
 * signaler.
 */
export function mergeCurves(curves, gap = 150) {
  const out = [];
  for (const c of curves) {
    const last = out[out.length - 1];
    if (last && c.s - last.sEnd < gap) {
      last.sEnd = Math.max(last.sEnd, c.sEnd);
      if (c.v < last.v) { last.v = c.v; last.radius = c.radius; last.dir = c.dir; }
    } else out.push({ ...c });
  }
  return out;
}

/** 'right' eller 'left' för kurvan vid sampel i (tecknet på kryssprodukten). */
function curveDir(route, i) {
  const k = Math.max(1, Math.round(20 / route.step));
  const a = Math.max(0, i - k), c = Math.min(route.n - 1, i + k);
  const cross = (route.X[i] - route.X[a]) * (route.Y[c] - route.Y[i]) - (route.Y[i] - route.Y[a]) * (route.X[c] - route.X[i]);
  return cross < 0 ? 'right' : 'left';
}
