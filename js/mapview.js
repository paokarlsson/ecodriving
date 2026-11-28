// Enkel vektorkarta på canvas: ruttöversikt och vriden körkarta.
// Ingen kartbakgrund (inga tiles) – bara rutten och fartmålen.

/** Kurvor snävare än så här får radien utskriven på kartan (m). */
export const TIGHT_RADIUS = 100;

export const KIND_COLOR = {
  traffic_signals: '#e5484d', stop: '#e5484d', give_way: '#f5a524',
  roundabout: '#8e4ec6', curve: '#0090ff', limit: '#30a46c', end: '#888',
};

function css(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function setup(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  return { g, w, h };
}

/** Hela rutten inpassad i canvasen, norr upp. */
export function drawOverview(canvas, route, targets, curves = null) {
  const { g, w, h } = setup(canvas);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < route.n; i++) {
    minX = Math.min(minX, route.X[i]); maxX = Math.max(maxX, route.X[i]);
    minY = Math.min(minY, route.Y[i]); maxY = Math.max(maxY, route.Y[i]);
  }
  const pad = 22;
  const sc = Math.min((w - 2 * pad) / Math.max(1, maxX - minX), (h - 2 * pad) / Math.max(1, maxY - minY));
  const ox = (w - (maxX - minX) * sc) / 2, oy = (h - (maxY - minY) * sc) / 2;
  const P = (x, y) => [ox + (x - minX) * sc, h - (oy + (y - minY) * sc)];
  drawRoute(g, route, P, 0, route.n - 1, css('--route', '#4a5568'), 5);
  drawTargets(g, route, targets, P);
  // Radien för snäva kurvor. Etiketter som skulle hamna på varandra hoppas
  // över, snävast kurva först så att den viktigaste syns.
  const placed = [];
  const tight = (curves || []).filter(c => c.radius < TIGHT_RADIUS).sort((a, b) => a.radius - b.radius);
  for (const c of tight) {
    const [x, y] = P(...xyAtIndex(route, c.s));
    const box = radiusLabel(g, x, y, c.radius, placed, w, h);
    if (box) placed.push(box);
  }
  const [sx, sy] = P(route.X[0], route.Y[0]);
  dot(g, sx, sy, 7, css('--accent', '#2f855a'), '#fff');
  const [ex, ey] = P(route.X[route.n - 1], route.Y[route.n - 1]);
  dot(g, ex, ey, 7, css('--fg', '#111'), '#fff');
}

/** Körkarta runt bilen, vriden så att färdriktningen pekar uppåt. */
/**
 * free = {roads: [[{lat, lon}, …], …], trail: [{lat, lon}, …], horizon: bool}:
 * körning utan rutt. Vägarna runt bilen och spåret ritas, och vägen framåt
 * streckad (eller inte alls när den inte är känd).
 */
export function drawDrive(canvas, route, targets, s, headingDeg, { limits = null, curves = null, viewMeters = 650, free = null } = {}) {
  const { g, w, h } = setup(canvas);
  const i = Math.min(route.n - 1, Math.max(0, Math.round(s / route.step)));
  const cx = route.X[i], cy = route.Y[i];
  const sc = h / viewMeters;
  const rot = (headingDeg ?? route.H[i]) * Math.PI / 180;
  const cos = Math.cos(rot), sin = Math.sin(rot);
  const px = w / 2, py = h * 0.8;
  const P = (x, y) => {
    const dx = x - cx, dy = y - cy;
    const rx = dx * cos - dy * sin, ry = dx * sin + dy * cos;
    return [px + rx * sc, py - ry * sc];
  };
  const back = Math.max(0, i - Math.round(200 / route.step));
  const end = Math.min(route.n - 1, i + Math.round(viewMeters * 1.2 / route.step));
  if (free) {
    const far = viewMeters * 1.5;
    const toP = p => { const [x, y] = route.proj.toXY(p.lat, p.lon); return [x, y]; };
    g.lineCap = 'round'; g.lineJoin = 'round';
    g.strokeStyle = css('--line', '#dfe3df');
    g.lineWidth = 7;
    g.beginPath();
    for (const way of free.roads || []) {
      let inside = false;
      const pts = way.map(toP);
      for (const [x, y] of pts) if (Math.abs(x - cx) < far && Math.abs(y - cy) < far) { inside = true; break; }
      if (!inside) continue;
      pts.forEach(([x, y], k) => { const [a, b] = P(x, y); if (k) g.lineTo(a, b); else g.moveTo(a, b); });
    }
    g.stroke();
    if (free.trail && free.trail.length > 1) {
      g.strokeStyle = '#2f80d8';
      g.lineWidth = 5;
      g.beginPath();
      free.trail.forEach((p, k) => { const [a, b] = P(...toP(p)); if (k) g.lineTo(a, b); else g.moveTo(a, b); });
      g.stroke();
    }
    if (free.horizon) {
      g.setLineDash([10, 8]);
      drawRoute(g, route, P, i, end, css('--route', '#4a5568'), 5);
      g.setLineDash([]);
    }
  } else {
    drawRoute(g, route, P, back, i, css('--route-done', '#a0aec0'), 9);
    drawRoute(g, route, P, i, end, css('--route', '#4a5568'), 9);
  }
  drawTargets(g, route, targets.filter(t => t.s >= s && t.s - s < viewMeters * 1.2), P);
  const ahead = t => t >= s - 20 && t - s < viewMeters;
  // Rekommenderad kurvfart som skylt vid kurvans början
  for (const c of curves || []) {
    if (!ahead(c.s)) continue;
    const [x, y] = P(...xyAtIndex(route, c.s));
    curveSign(g, x + 16, y - 16, Math.round(c.v * 3.6));
    if (c.radius < TIGHT_RADIUS) radiusTag(g, x + 16, y - 16 + 19, c.radius);
  }
  // Hastighetsgräns där den ändras framför bilen
  if (limits) {
    for (let k = Math.max(1, i); k <= Math.min(route.n - 1, i + Math.round(viewMeters / route.step)); k++) {
      if (limits[k] != null && limits[k] !== limits[k - 1]) {
        const [x, y] = P(route.X[k], route.Y[k]);
        limitSign(g, x - 18, y - 14, limits[k]);
      }
    }
  }
  // Bilen
  g.save();
  g.translate(px, py);
  g.fillStyle = css('--accent', '#2f855a');
  g.strokeStyle = '#fff';
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(0, -12); g.lineTo(9, 10); g.lineTo(0, 5); g.lineTo(-9, 10); g.closePath();
  g.fill(); g.stroke();
  g.restore();
}

function drawRoute(g, route, P, from, to, color, width) {
  if (to <= from) return;
  g.strokeStyle = color;
  g.lineWidth = width;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.beginPath();
  for (let i = from; i <= to; i++) {
    const [x, y] = P(route.X[i], route.Y[i]);
    if (i === from) g.moveTo(x, y); else g.lineTo(x, y);
  }
  g.stroke();
}

function drawTargets(g, route, targets, P) {
  for (const t of targets) {
    if (t.kind === 'end') continue;
    const i = Math.min(route.n - 1, Math.round(t.s / route.step));
    const [x, y] = P(route.X[i], route.Y[i]);
    dot(g, x, y, 6, KIND_COLOR[t.kind] || '#666', '#fff');
  }
}

function dot(g, x, y, r, fill, stroke) {
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.fillStyle = fill;
  g.fill();
  g.lineWidth = 2;
  g.strokeStyle = stroke;
  g.stroke();
}

function xyAtIndex(route, s) {
  const k = Math.min(route.n - 1, Math.max(0, Math.round(s / route.step)));
  return [route.X[k], route.Y[k]];
}

function limitSign(g, x, y, kmh) {
  g.beginPath();
  g.arc(x, y, 14, 0, Math.PI * 2);
  g.fillStyle = '#fff';
  g.fill();
  g.lineWidth = 4;
  g.strokeStyle = '#d0021b';
  g.stroke();
  g.fillStyle = '#111';
  g.font = '800 12px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(String(kmh), x, y + 0.5);
}

function curveSign(g, x, y, kmh) {
  const w = 30, h = 22;
  g.fillStyle = '#f7c600';
  g.strokeStyle = '#111';
  g.lineWidth = 1.5;
  g.beginPath();
  g.roundRect ? g.roundRect(x - w / 2, y - h / 2, w, h, 4) : g.rect(x - w / 2, y - h / 2, w, h);
  g.fill();
  g.stroke();
  g.fillStyle = '#111';
  g.font = '800 12px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(String(kmh), x, y + 0.5);
}

const fmtRadius = r => `R ${Math.max(1, Math.round(r))} m`;

/**
 * Radie som etikett bredvid en punkt i översikten. Provar fyra lägen runt
 * punkten och tar det första som inte krockar med tidigare etiketter eller
 * kanten. Returnerar etikettens ruta, eller null om den inte fick plats.
 */
function radiusLabel(g, x, y, r, placed, w, h) {
  g.font = '700 11px system-ui, sans-serif';
  const text = fmtRadius(r);
  const bw = g.measureText(text).width + 10, bh = 17;
  const spots = [[10, -bh - 4], [10, 4], [-bw - 10, -bh - 4], [-bw - 10, 4]];
  for (const [dx, dy] of spots) {
    const b = { x: x + dx, y: y + dy, w: bw, h: bh };
    if (b.x < 2 || b.y < 2 || b.x + b.w > w - 2 || b.y + b.h > h - 2) continue;
    if (placed.some(o => b.x < o.x + o.w + 2 && o.x < b.x + b.w + 2 && b.y < o.y + o.h + 2 && o.y < b.y + b.h + 2)) continue;
    pill(g, b, text);
    return b;
  }
  return null;
}

/** Radie under kurvskylten i körkartan. */
function radiusTag(g, x, y, r) {
  g.font = '700 11px system-ui, sans-serif';
  const text = fmtRadius(r);
  const bw = g.measureText(text).width + 10, bh = 16;
  pill(g, { x: x - bw / 2, y: y - bh / 2, w: bw, h: bh }, text);
}

function pill(g, b, text) {
  g.fillStyle = 'rgba(17,17,17,0.82)';
  g.beginPath();
  g.roundRect ? g.roundRect(b.x, b.y, b.w, b.h, b.h / 2) : g.rect(b.x, b.y, b.w, b.h);
  g.fill();
  g.fillStyle = '#fff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, b.x + b.w / 2, b.y + b.h / 2 + 0.5);
}
