// Fartkurva mot nästa mål: fart (km/h) mot sträcka. Den blå kurvan är farten
// bilen får om den rullar med släppt gas ända fram till målet (räknad
// baklänges från målet med rullmodellen och ruttens lutning). Den svarta
// linjen är förarens GPS-fart. Röd yta = över kurvan efter släpp-punkten
// (fart som måste bromsas bort), grön = under (släppte för tidigt).
import { decel } from './physics.js';

export const GRAPH = {
  behind: 150,     // m bakom bilen som syns
  after: 50,       // m efter målet
  maxAhead: 1500,  // m: mål längre bort visas inte
  histKeep: 400,   // m fartlinje som sparas bakåt
  step: 5,         // m mellan kurvans punkter
  vMax: 60,        // m/s, kurvan räknas inte högre än så
};

/**
 * Rullkurvan bakåt från målet till sFrom: [[s, v], …] i stigande s.
 * v är farten man måste ha vid s för att rulla ner till target.v vid target.s.
 * Där rullningen inte räcker (brant nedför) planar kurvan ut.
 */
export function coastProfile(target, sFrom, gradeAt, model, step = GRAPH.step) {
  const out = [];
  let s = target.s, v2 = target.v * target.v;
  out.push([s, Math.sqrt(v2)]);
  while (s > sFrom) {
    const ds = Math.min(step, s - sFrom);
    const v = Math.sqrt(v2);
    const a = decel(v, gradeAt(s - ds / 2), model);
    v2 = Math.min(GRAPH.vMax ** 2, Math.max(0, v2 + 2 * a * ds));
    s -= ds;
    out.push([s, Math.sqrt(v2)]);
  }
  return out.reverse();
}

/** Kurvans fart vid s (linjär interpolation), null utanför. */
export function profileAt(profile, s) {
  if (!profile.length || s < profile[0][0] || s > profile[profile.length - 1][0]) return null;
  let lo = 0, hi = profile.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (profile[mid][0] <= s) lo = mid; else hi = mid;
  }
  const [s0, v0] = profile[lo], [s1, v1] = profile[hi];
  return s1 === s0 ? v0 : v0 + (v1 - v0) * (s - s0) / (s1 - s0);
}

/** Släpp-punkten: närmast målet där kurvan når farten v (null om farten redan är lägre). */
export function releaseOnProfile(profile, v) {
  if (!profile.length || v <= profile[profile.length - 1][1]) return null;
  for (let i = profile.length - 1; i > 0; i--) {
    const [s0, v0] = profile[i - 1], [s1, v1] = profile[i];
    if (v0 >= v && v1 < v) return s0 + (s1 - s0) * (v0 - v) / (v0 - v1);
  }
  return profile[0][0]; // släppet ligger före kurvans början
}

function css(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/**
 * Ritar grafen. d = {s, v, hist: [[s, v], …], target, profile, releaseS}
 * (m och m/s). Fönstret följer bilen: GRAPH.behind bakom till GRAPH.after
 * efter målet, minst 300 m brett.
 */
export function drawSpeedGraph(canvas, d) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);

  const fg = css('--fg', '#141a16'), muted = css('--muted', '#5b665f'), grid = css('--line', '#dfe3df');
  const blue = css('--release', '#0b6bcb'), red = css('--danger', '#c53030'), green = css('--zone-green', '#1f9d5c');
  const font = '600 11px system-ui, sans-serif';

  const { s, v, hist, target, profile, releaseS } = d;
  const x0 = Math.min(s - GRAPH.behind, target.s + GRAPH.after - 300);
  const x1 = target.s + GRAPH.after;
  // Fartskala: 0 till närmaste 25-tal över det högsta som syns
  let top = Math.max(v, target.v, ...hist.map(p => p[1]));
  for (const [ps, pv] of profile) if (ps >= x0) top = Math.max(top, Math.min(pv, v * 1.25 + 3));
  const yMaxK = Math.max(50, Math.ceil((top * 3.6 + 5) / 25) * 25);

  const L = 30, R = 10, T = 10, B = 20;
  const X = m => L + (m - x0) / (x1 - x0) * (w - L - R);
  const Y = ms => T + (1 - Math.min(yMaxK, Math.max(0, ms * 3.6)) / yMaxK) * (h - T - B);

  g.font = font;
  g.textBaseline = 'middle';
  // Rutnät och fartaxel
  g.lineWidth = 1;
  g.fillStyle = muted;
  g.textAlign = 'right';
  for (let k = 0; k <= yMaxK; k += 25) {
    g.strokeStyle = grid;
    g.beginPath(); g.moveTo(L, Y(k / 3.6)); g.lineTo(w - R, Y(k / 3.6)); g.stroke();
    g.fillText(String(k), L - 5, Y(k / 3.6));
  }
  // Sträckaxel: meter kvar till målet
  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';
  const span = x1 - x0, tick = span > 900 ? 500 : span > 450 ? 200 : 100;
  for (let m = 0; m <= target.s - x0; m += tick) {
    const xx = X(target.s - m);
    if (xx < L + 10) continue;
    g.fillText(m === 0 ? 'mål' : String(m), xx, h - 5);
  }

  // Avvikelse efter släpp-punkten: röd över kurvan, grön under
  const after = hist.filter(([m]) => releaseS != null && m >= releaseS && m <= target.s && m >= x0);
  if (after.length > 1) {
    for (const [col, pick] of [[red, (a, b) => Math.max(a, b)], [green, (a, b) => Math.min(a, b)]]) {
      g.beginPath();
      after.forEach(([m, val], i) => { const pv = profileAt(profile, m) ?? val; (i ? g.lineTo : g.moveTo).call(g, X(m), Y(pick(val, pv))); });
      for (let i = after.length - 1; i >= 0; i--) { const m = after[i][0]; g.lineTo(X(m), Y(profileAt(profile, m) ?? after[i][1])); }
      g.closePath();
      g.globalAlpha = 0.28; g.fillStyle = col; g.fill(); g.globalAlpha = 1;
    }
  }

  // Målet och målfarten
  g.strokeStyle = muted; g.lineWidth = 1;
  g.beginPath(); g.moveTo(X(target.s), T); g.lineTo(X(target.s), h - B); g.stroke();
  g.setLineDash([2, 3]);
  g.beginPath(); g.moveTo(X(target.s) - 14, Y(target.v)); g.lineTo(w - R, Y(target.v)); g.stroke();
  g.setLineDash([]);

  // Släpp-punkten
  if (releaseS != null && X(releaseS) >= L) {
    const rv = profileAt(profile, releaseS) ?? v;
    g.strokeStyle = blue; g.lineWidth = 1.5; g.setLineDash([4, 3]);
    g.beginPath(); g.moveTo(X(releaseS), Y(rv) - 10); g.lineTo(X(releaseS), h - B); g.stroke();
    g.setLineDash([]);
    g.fillStyle = blue; g.textAlign = 'left'; g.font = '700 11px system-ui, sans-serif';
    g.fillText('släpp', Math.min(X(releaseS) + 4, w - R - 30), Math.max(T + 9, Y(rv) - 12));
    g.font = font;
  }

  // Rullkurvan
  g.save();
  g.beginPath(); g.rect(L, 0, w - L - R, h); g.clip();
  g.strokeStyle = blue; g.lineWidth = 2.5; g.lineJoin = 'round';
  g.beginPath();
  let started = false;
  for (const [m, pv] of profile) {
    if (m < x0 - GRAPH.step) continue;
    if (!started) { g.moveTo(X(m), Y(pv)); started = true; } else g.lineTo(X(m), Y(pv));
  }
  g.stroke();

  // Förarens fart
  const vis = hist.filter(([m]) => m >= x0 - 10);
  if (vis.length > 1) {
    g.strokeStyle = fg; g.lineWidth = 2;
    g.beginPath();
    vis.forEach(([m, val], i) => (i ? g.lineTo : g.moveTo).call(g, X(m), Y(val)));
    g.stroke();
  }
  g.restore();
  // Teckenförklaring uppe till höger, på egen bakgrund så att linjerna inte syns igenom
  g.textAlign = 'right'; g.textBaseline = 'middle';
  const legW = g.measureText('din fart').width + g.measureText('rullkurva').width + 5 * 2 + 14 * 2 + 24 + 8;
  g.fillStyle = css('--surface', '#fff');
  g.fillRect(w - R - legW, T - 2, legW + 2, 16);
  let lx = w - R - 2;
  for (const [txt, col] of [['din fart', fg], ['rullkurva', blue]]) {
    g.fillStyle = muted; g.fillText(txt, lx, T + 6);
    lx -= g.measureText(txt).width + 5;
    g.strokeStyle = col; g.lineWidth = 2.5;
    g.beginPath(); g.moveTo(lx - 14, T + 6); g.lineTo(lx, T + 6); g.stroke();
    lx -= 24;
  }
  // Bilen nu
  g.fillStyle = fg; g.strokeStyle = css('--surface', '#fff'); g.lineWidth = 2;
  g.beginPath(); g.arc(X(s), Y(v), 5, 0, Math.PI * 2); g.fill(); g.stroke();
}
