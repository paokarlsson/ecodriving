// Enkel vektorkarta på canvas: ruttöversikt och vriden körkarta.
// Ingen kartbakgrund (inga tiles) – bara rutten och fartmålen.

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
export function drawOverview(canvas, route, targets) {
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
  const [sx, sy] = P(route.X[0], route.Y[0]);
  dot(g, sx, sy, 7, css('--accent', '#2f855a'), '#fff');
  const [ex, ey] = P(route.X[route.n - 1], route.Y[route.n - 1]);
  dot(g, ex, ey, 7, css('--fg', '#111'), '#fff');
}

/** Körkarta runt bilen, vriden så att färdriktningen pekar uppåt. */
export function drawDrive(canvas, route, targets, s, headingDeg, viewMeters = 650) {
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
  const ahead = Math.min(route.n - 1, i + Math.round(viewMeters * 1.2 / route.step));
  drawRoute(g, route, P, back, i, css('--route-done', '#a0aec0'), 9);
  drawRoute(g, route, P, i, ahead, css('--route', '#4a5568'), 9);
  drawTargets(g, route, targets.filter(t => t.s >= s && t.s - s < viewMeters * 1.2), P);
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
