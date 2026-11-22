// Fysikmodell för rullning med släppt gas:  a(v, s) = A + C·v² + g·θ(s)
// a är inbromsning i m/s² (positiv = farten minskar), θ lutning (uppför positiv).

export const G = 9.81;

/** Typvärden för en personbil i växel, används tills bilen är kalibrerad. */
export const DEFAULT_MODEL = Object.freeze({ A: 0.45, C: 0.00040 });

export function decel(v, grade, model) {
  return model.A + model.C * v * v + G * grade;
}

/**
 * Räknar baklänges från ett fartmål. Returnerar profilen "farten man måste
 * ha för att rulla ner exakt till målet" och var gasen ska släppas för
 * den som håller farten vNow fram till dess.
 *
 * - release: sträcka s där gasen ska släppas (null om det ligger längre bort än maxBack)
 * - late: föraren är redan förbi släpp-punkten
 * - brakeNeeded: nedförsbacke gör att målet inte nås utan broms
 */
export function releasePoint(target, vNow, sNow, gradeAt, model, { step = 5, maxBack = 5000 } = {}) {
  let s = target.s;
  let v2 = target.v * target.v;
  const goal = vNow * vNow;
  let brakeNeeded = false;
  let hill = false;
  if (v2 >= goal) return { release: null, late: false, brakeNeeded: false, hill: false, notNeeded: true };
  const sStop = Math.max(sNow, target.s - maxBack);
  while (s > sStop) {
    const ds = Math.min(step, s - sStop);
    const v = Math.sqrt(Math.max(0, v2));
    const a = decel(v, gradeAt(s - ds / 2), model);
    if (a < 0) hill = true;
    const nv2 = v2 + 2 * a * ds;
    if (nv2 <= 0) { brakeNeeded = true; }
    if (nv2 >= goal) {
      // Linjär interpolation av korsningen inom steget.
      const f = (goal - v2) / (nv2 - v2);
      return { release: s - f * ds, late: false, brakeNeeded, hill };
    }
    v2 = Math.max(0, nv2);
    s -= ds;
  }
  if (sStop === sNow) return { release: sNow, late: true, brakeNeeded, hill };
  return { release: null, late: false, brakeNeeded, hill };
}

/** Rullsträcka på plan väg från v1 ner till v2 (m/s). */
export function coastDistance(v1, v2, model, grade = 0) {
  let v = v1, d = 0;
  const dt = 0.05;
  for (let i = 0; i < 1e6 && v > v2; i++) {
    const a = decel(v, grade, model);
    if (a <= 0) return Infinity;
    d += v * dt;
    v -= a * dt;
  }
  return d;
}

/**
 * Minstakvadratanpassning a = A + C·v².
 * Ger {A, C, r2, n}. Om C blir negativ (för lite spridning i fart eller
 * brus) anpassas bara A med C = 0 och quality markeras som 'low'.
 */
export function fitAC(points) {
  const n = points.length;
  if (n < 3) return null;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const p of points) {
    const x = p.v * p.v;
    sx += x; sy += p.a; sxx += x * x; sxy += x * p.a;
  }
  const mx = sx / n, my = sy / n;
  const varx = sxx / n - mx * mx;
  let C = varx > 1e-9 ? (sxy / n - mx * my) / varx : 0;
  let A = my - C * mx;
  let quality = 'ok';
  if (C < 0) { C = 0; A = my; quality = 'low'; }
  let ssr = 0, sst = 0;
  for (const p of points) {
    const f = A + C * p.v * p.v;
    ssr += (p.a - f) ** 2;
    sst += (p.a - my) ** 2;
  }
  const r2 = sst > 0 ? 1 - ssr / sst : 0;
  return { A, C, r2, n, quality };
}
