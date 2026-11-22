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

/** Riktningsändring (rad, utan tecken) mellan sträckan in mot i och ut från i, k sampel långa. */
function turnAngle(route, i, k) {
  const a = Math.max(0, i - k), c = Math.min(route.n - 1, i + k);
  if (a === i || c === i) return 0;
  const h1 = Math.atan2(route.Y[i] - route.Y[a], route.X[i] - route.X[a]);
  const h2 = Math.atan2(route.Y[c] - route.Y[i], route.X[c] - route.X[i]);
  let d = Math.abs(h2 - h1);
  if (d > Math.PI) d = 2 * Math.PI - d;
  return d;
}

/**
 * Kurvradie vid varje sampel. Ruttens linje är förenklad: en lång, mjuk
 * kurva kan ritas som några få hörn på 3–8°. Radien från bara ±20 m gör
 * ett sådant hörn till en skarp kurva. Därför:
 *  - tvär sväng (minst 30° inom ±20 m, t.ex. korsning eller rondell):
 *    radien från ±20 m,
 *  - annars den största av radierna från ±20 m och ±50 m, så att ett
 *    enstaka hörn sprids ut över den sträcka bilen har på sig.
 * Radie = halva fönstret / riktningsändringen (cirkelbåge).
 */
export function curveRadii(route) {
  const k20 = Math.max(1, Math.round(20 / route.step));
  const k50 = Math.max(k20 + 1, Math.round(50 / route.step));
  const R = new Float64Array(route.n).fill(Infinity);
  for (let i = 1; i < route.n - 1; i++) {
    const t20 = turnAngle(route, i, k20);
    const t50 = turnAngle(route, i, k50);
    const r20 = t20 > 1e-6 ? (k20 * route.step) / t20 : Infinity;
    const r50 = t50 > 1e-6 ? (k50 * route.step) / t50 : Infinity;
    R[i] = t20 >= 30 * Math.PI / 180 ? r20 : Math.max(r20, r50);
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
 * 100 km/h där gränsen är okänd. Målet läggs där kurvfarten först närmar sig
 * kurvans lägsta fart, så att bilen har rätt fart vid insläppet.
 * Varje kurva: {s, sEnd, v (m/s), radius (m), kind: 'curve'}.
 */
export function curveTargets(route, aLat, { limits = null, skipStart = 60, skipEnd = 30 } = {}) {
  const V = curveSpeeds(route, aLat);
  const cap = i => {
    const lim = limits && limits[i] != null && Number.isFinite(limits[i]) ? limits[i] : 105;
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
