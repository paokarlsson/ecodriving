import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRoute, curveRadii, curveTargets } from '../js/route.js';
import { makeProjector } from '../js/geo.js';

const G = 9.81, V90 = 25;

/** Douglas–Peucker: förenklar en linje som en ruttjänst gör. */
function simplify(pts, eps) {
  if (pts.length < 3) return pts;
  const [a, b] = [pts[0], pts[pts.length - 1]];
  const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1;
  let max = 0, idx = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = Math.abs(dy * pts[i][0] - dx * pts[i][1] + b[0] * a[1] - b[1] * a[0]) / L;
    if (d > max) { max = d; idx = i; }
  }
  if (max <= eps) return [a, b];
  return [...simplify(pts.slice(0, idx + 1), eps).slice(0, -1), ...simplify(pts.slice(idx), eps)];
}

/** Väg av raka sträckor och bågar [{straight: m} | {R, deg, dir}], ritad var 2:a meter. */
function road(parts) {
  let x = 0, y = 0, h = 0;
  const pts = [[0, 0]], marks = [];
  for (const p of parts) {
    if (p.straight) {
      for (let d = 2; d <= p.straight; d += 2) pts.push([x + d * Math.sin(h), y + d * Math.cos(h)]);
      x += p.straight * Math.sin(h); y += p.straight * Math.cos(h);
    } else {
      const len = p.R * p.deg * Math.PI / 180, n = Math.ceil(len / 2);
      const start = pts.length;
      for (let k = 1; k <= n; k++) {
        h += p.dir * (len / n) / p.R;
        x += (len / n) * Math.sin(h); y += (len / n) * Math.cos(h);
        pts.push([x, y]);
      }
      marks.push({ ...p, from: start, to: pts.length - 1 });
    }
  }
  return { pts, marks };
}

function toRoute(pts) {
  const proj = makeProjector(63.4, 14.9);
  return buildRoute(pts.map(([x, y]) => { const [la, lo] = proj.toLL(x, y); return [lo, la, 300]; }));
}

// Kurvorna på landsvägen Östersund–Brunflo enligt GPS-spåret
const RURAL = [
  { R: 656, deg: 38, dir: 1 }, { R: 655, deg: 45, dir: -1 }, { R: 400, deg: 25, dir: 1 },
  { R: 523, deg: 11, dir: 1 }, { R: 570, deg: 11, dir: -1 }, { R: 421, deg: 39, dir: -1 },
  { R: 557, deg: 40, dir: -1 }, { R: 574, deg: 19, dir: 1 }, { R: 420, deg: 25, dir: 1 },
  { R: 374, deg: 28, dir: 1 }, { R: 535, deg: 77, dir: -1 }, { R: 449, deg: 37, dir: -1 },
  { R: 1000, deg: 13, dir: 1 }, { R: 1080, deg: 13, dir: -1 },
];

test('landsväg ritad förenklad: rätt radie och aldrig över ~0,17 g i 90 km/h', () => {
  const parts = [];
  for (const c of RURAL) parts.push({ straight: 400 }, c);
  parts.push({ straight: 400 });
  const { pts } = road(parts);
  for (const eps of [1, 3, 5]) {
    const simple = simplify(pts, eps);
    const r = toRoute(simple);
    const R = curveRadii(r);
    const maxG = Math.max(...Array.from(R).map(x => V90 * V90 / x / G));
    assert.ok(maxG <= 0.19, `tolerans ${eps} m: ${maxG.toFixed(3)} g (punkter ${simple.length})`);
    // Inga kurvsignaler på en 90-väg där alla kurvor klaras i 90
    const c = curveTargets(r, 0.25 * G, { limits: new Array(r.n).fill(90) });
    assert.equal(c.length, 0, `tolerans ${eps}: ${JSON.stringify(c.map(q => [Math.round(q.s), Math.round(q.v * 3.6), Math.round(q.radius)]))}`);
  }
});

test('varje kurva får ungefär sin verkliga radie', () => {
  for (const c of [{ R: 374, deg: 28 }, { R: 535, deg: 77 }, { R: 150, deg: 60 }, { R: 130, deg: 78 }]) {
    const { pts } = road([{ straight: 400 }, { ...c, dir: 1 }, { straight: 400 }]);
    const r = toRoute(simplify(pts, 3));
    const minR = Math.min(...curveRadii(r));
    assert.ok(minR > c.R * 0.7 && minR < c.R * 1.4, `R ${c.R}: fick ${Math.round(minR)}`);
  }
});

test('korsning och skarp kurva vid Brunflo förblir långsamma', () => {
  // 90° i korsning: vägarna är raka fram till korsningen
  const { pts } = road([{ straight: 300 }, { R: 12, deg: 90, dir: -1 }, { straight: 300 }]);
  const r = toRoute(simplify(pts, 3));
  const minR = Math.min(...curveRadii(r));
  assert.ok(minR < 20, `korsning ${minR}`);
  const c = curveTargets(r, 0.25 * G, { limits: new Array(r.n).fill(50) });
  assert.equal(c.length, 1);
  assert.ok(c[0].v * 3.6 < 25, `${c[0].v * 3.6} km/h`);
  // Radie 130 m, 78° (85,2 km i loggen): ska ge en kurvsignal under 70 km/h på en 90-väg
  const k = road([{ straight: 400 }, { R: 130, deg: 78, dir: 1 }, { straight: 400 }]);
  const rk = toRoute(simplify(k.pts, 3));
  const ck = curveTargets(rk, 0.25 * G, { limits: new Array(rk.n).fill(90) });
  assert.equal(ck.length, 1);
  assert.ok(ck[0].v * 3.6 > 55 && ck[0].v * 3.6 < 70, `${ck[0].v * 3.6} km/h`);
});

test('små skakningar i linjen blir inte skarpa kurvor', () => {
  // Rak väg med punkter som skakar ±0,4 m var 3:e meter
  const pts = [];
  for (let y = 0; y <= 1500; y += 3) pts.push([(Math.sin(y * 7.3) * 0.4), y]);
  const r = toRoute(pts);
  const minR = Math.min(...curveRadii(r));
  assert.ok(minR > 1000, `R ${minR}`);
});
