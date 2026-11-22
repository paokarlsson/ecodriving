// Geometri: avstånd, riktning och lokal plan projektion (meter).

export const R_EARTH = 6371008.8;
const RAD = Math.PI / 180;

export function haversine(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * RAD;
  const dLon = (lon2 - lon1) * RAD;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Ekvirektangulär projektion runt en referenspunkt. Räcker för rutter på några mil. */
export function makeProjector(lat0, lon0) {
  const ky = R_EARTH * RAD;
  const kx = ky * Math.cos(lat0 * RAD);
  return {
    lat0, lon0,
    toXY(lat, lon) { return [(lon - lon0) * kx, (lat - lat0) * ky]; },
    toLL(x, y) { return [lat0 + y / ky, lon0 + x / kx]; },
  };
}

/** Kurs i grader (0 = norr, medurs) för en vektor i lokala xy-koordinater. */
export function headingXY(dx, dy) {
  const h = Math.atan2(dx, dy) / RAD;
  return (h + 360) % 360;
}

/** Minsta vinkelskillnad i grader, 0..180. */
export function angleDiff(a, b) {
  const d = Math.abs(((a - b) % 360 + 540) % 360 - 180);
  return d;
}

/** Radie för cirkeln genom tre punkter (Infinity om de ligger på linje). */
export function circumradius(ax, ay, bx, by, cx, cy) {
  const ab = Math.hypot(bx - ax, by - ay);
  const bc = Math.hypot(cx - bx, cy - by);
  const ca = Math.hypot(ax - cx, ay - cy);
  const cross = Math.abs((bx - ax) * (cy - ay) - (by - ay) * (cx - ax));
  if (cross < 1e-9) return Infinity;
  return (ab * bc * ca) / (2 * cross);
}

/** Närmaste punkt på segmentet a-b från p. Returnerar {t, d, x, y}. */
export function projectOnSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const x = ax + t * dx, y = ay + t * dy;
  return { t, d: Math.hypot(px - x, py - y), x, y };
}
