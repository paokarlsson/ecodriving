// Höjdprofil ur bilen själv: OBD-backen (bränsleflöde mot acceleration med
// gas, inbromsning med släppt gas, se HillEstimate) slås ihop med GPS-höjden
// i ett Kalmanfilter längs körd sträcka.
//
// OBD ger lutningen bra på kort sikt men driver i nivå (ett litet fel i
// rullmotstånd eller bränslemodell blir en lutning som summeras). GPS-höjden
// driver inte men hoppar flera meter. Filtret har två tillstånd: höjden h (m,
// i GPS:ens höjdsystem) och OBD-lutningens fel b (andel). Efter körningen
// jämnas profilen ut bakåt (RTS), så att varje punkt får både tidigare och
// senare GPS-höjder, och sparas per kartruta så att den blir bättre för varje
// körning.

export const ELEV = {
  gradeSd: 0.012,      // OBD-lutningens slumpfel (andel) …
  gradeLenM: 30,       // … över ungefär så här lång sträcka
  unknownSd: 0.06,     // lutning när OBD inte kan skatta den (låg fart, broms)
  biasSd0: 0.004,      // OBD-lutningens fel från början (andel)
  biasWalk: 0.002,     // … som kan ändras så här mycket …
  biasWalkM: 2000,     // … på så här lång sträcka
  altSdMin: 8,         // m: GPS-höjdens fel, minst (felet hänger ihop över minuter)
  altSdPerAcc: 1.5,    // … annars 1,5 × den horisontella noggrannheten
  altEveryM: 200,      // … så den vägs in högst en gång per så här lång sträcka
  maxStepM: 60,        // längre steg (tappad dosa) börjar om lutningen som okänd
  cellLat: 1 / 5000,   // kartruta ca 22 m …
  cellLon: 1 / 2500,   // … gånger ca 25 m (vid 63°N)
  maxCells: 8000,      // ca 200 km väg
  profileStepM: 20,
};

/** Kalmanfilter för höjd och OBD-lutningens fel. */
export class ElevationFuser {
  constructor() {
    this.x = null;          // [h, b]
    this.P = null;          // [[Phh, Phb], [Pbh, Pbb]]
    this.steps = [];        // för utjämningen bakåt
    this.sinceAlt = Infinity;
    this.dist = 0;
  }

  /**
   * Ett steg: {ds (m körda sedan förra), grade (OBD-lutning, andel, eller null),
   * alt (GPS-höjd, m, eller null), altSd (m), lat, lon}.
   */
  step({ ds, grade = null, alt = null, altSd = null, lat = null, lon = null }) {
    if (!(ds >= 0) || !Number.isFinite(ds)) return;
    if (this.x == null) {
      if (alt == null || !Number.isFinite(alt)) return;
      const sd = altSd ?? ELEV.altSdMin * 2;
      this.x = [alt, 0];
      this.P = [[sd * sd, 0], [0, ELEV.biasSd0 ** 2]];
      this.sinceAlt = 0;
      this.record(0, null, alt, sd, lat, lon, true);
      return;
    }
    if (ds > ELEV.maxStepM) grade = null;
    // Förutsägelse: h += (lutning − fel) · ds
    const g = grade != null && Number.isFinite(grade) ? grade : 0;
    const known = grade != null && Number.isFinite(grade);
    const [h, b] = this.x;
    const P = this.P;
    const qh = (known ? ELEV.gradeSd ** 2 * Math.min(ds, ELEV.gradeLenM) * ds : (ELEV.unknownSd * ds) ** 2);
    const qb = ELEV.biasWalk ** 2 * ds / ELEV.biasWalkM;
    const u = known ? -ds : 0; // felet spelar bara roll när OBD-lutningen används
    this.x = [h + (g - (known ? b : 0)) * ds, b];
    const Phh = P[0][0] + 2 * u * P[0][1] + u * u * P[1][1] + qh;
    const Phb = P[0][1] + u * P[1][1];
    this.P = [[Phh, Phb], [Phb, P[1][1] + qb]];
    this.dist += ds;
    this.sinceAlt += ds;
    // Mätning: GPS-höjden
    let used = false;
    if (alt != null && Number.isFinite(alt) && this.sinceAlt >= ELEV.altEveryM) {
      const sd = Math.max(ELEV.altSdMin, altSd ?? ELEV.altSdMin);
      const S = this.P[0][0] + sd * sd;
      const k0 = this.P[0][0] / S, k1 = this.P[1][0] / S;
      const y = alt - this.x[0];
      this.x = [this.x[0] + k0 * y, this.x[1] + k1 * y];
      const [[a, c], [, d]] = this.P;
      this.P = [[(1 - k0) * a, (1 - k0) * c], [(1 - k0) * c, d - k1 * c]];
      this.sinceAlt = 0;
      used = true;
    }
    this.record(ds, known ? g : null, used ? alt : null, used ? Math.max(ELEV.altSdMin, altSd ?? ELEV.altSdMin) : null, lat, lon, false);
  }

  record(ds, grade, alt, altSd, lat, lon, first) {
    this.steps.push({ ds, grade, alt, altSd, lat, lon, x: this.x.slice(), P: this.P.map(r => r.slice()), first });
  }

  /** Höjden just nu {h, sd, bias} eller null. */
  current() {
    if (!this.x) return null;
    return { h: this.x[0], sd: Math.sqrt(this.P[0][0]), bias: this.x[1], biasSd: Math.sqrt(this.P[1][1]) };
  }

  /**
   * Utjämnad profil bakåt (Rauch–Tung–Striebel): [{d (m från start), h, sd, lat, lon}].
   */
  smooth() {
    const st = this.steps;
    const n = st.length;
    if (!n) return [];
    const xs = new Array(n), Ps = new Array(n);
    xs[n - 1] = st[n - 1].x.slice(); Ps[n - 1] = st[n - 1].P;
    for (let i = n - 2; i >= 0; i--) {
      const nx = st[i + 1];
      const known = nx.grade != null;
      const ds = nx.ds, u = known ? -ds : 0;
      const P = st[i].P;
      // Förutsägelsen till i+1 (före mätningen där)
      const qh = known ? ELEV.gradeSd ** 2 * Math.min(ds, ELEV.gradeLenM) * ds : (ELEV.unknownSd * ds) ** 2;
      const qb = ELEV.biasWalk ** 2 * ds / ELEV.biasWalkM;
      const xp = [st[i].x[0] + (known ? (nx.grade - st[i].x[1]) * ds : 0), st[i].x[1]];
      const Pp = [[P[0][0] + 2 * u * P[0][1] + u * u * P[1][1] + qh, P[0][1] + u * P[1][1]], [0, P[1][1] + qb]];
      Pp[1][0] = Pp[0][1];
      // C = P F' Pp⁻¹, F = [[1, u], [0, 1]]
      const PF = [[P[0][0] + u * P[0][1], P[0][1]], [P[1][0] + u * P[1][1], P[1][1]]];
      const det = Pp[0][0] * Pp[1][1] - Pp[0][1] * Pp[1][0];
      if (!(Math.abs(det) > 1e-18)) { xs[i] = st[i].x.slice(); Ps[i] = P; continue; }
      const inv = [[Pp[1][1] / det, -Pp[0][1] / det], [-Pp[1][0] / det, Pp[0][0] / det]];
      const C = [[PF[0][0] * inv[0][0] + PF[0][1] * inv[1][0], PF[0][0] * inv[0][1] + PF[0][1] * inv[1][1]],
        [PF[1][0] * inv[0][0] + PF[1][1] * inv[1][0], PF[1][0] * inv[0][1] + PF[1][1] * inv[1][1]]];
      const dx = [xs[i + 1][0] - xp[0], xs[i + 1][1] - xp[1]];
      xs[i] = [st[i].x[0] + C[0][0] * dx[0] + C[0][1] * dx[1], st[i].x[1] + C[1][0] * dx[0] + C[1][1] * dx[1]];
      const dP = [[Ps[i + 1][0][0] - Pp[0][0], Ps[i + 1][0][1] - Pp[0][1]], [Ps[i + 1][1][0] - Pp[1][0], Ps[i + 1][1][1] - Pp[1][1]]];
      // P + C dP C'
      const CdP = [[C[0][0] * dP[0][0] + C[0][1] * dP[1][0], C[0][0] * dP[0][1] + C[0][1] * dP[1][1]],
        [C[1][0] * dP[0][0] + C[1][1] * dP[1][0], C[1][0] * dP[0][1] + C[1][1] * dP[1][1]]];
      Ps[i] = [[P[0][0] + CdP[0][0] * C[0][0] + CdP[0][1] * C[0][1], P[0][1] + CdP[0][0] * C[1][0] + CdP[0][1] * C[1][1]],
        [P[1][0] + CdP[1][0] * C[0][0] + CdP[1][1] * C[0][1], P[1][1] + CdP[1][0] * C[1][0] + CdP[1][1] * C[1][1]]];
    }
    let d = 0;
    return st.map((p, i) => {
      d += p.ds;
      return { d, h: xs[i][0], sd: Math.sqrt(Math.max(0, Ps[i][0][0])), bias: xs[i][1], lat: p.lat, lon: p.lon };
    });
  }
}

/** Profilen glesad till var ELEV.profileStepM meter (för loggen och kartrutorna). */
export function thinProfile(prof, step = ELEV.profileStepM) {
  const out = [];
  let next = 0;
  for (const p of prof) {
    if (p.d >= next) { out.push(p); next = p.d + step; }
  }
  if (prof.length && out[out.length - 1] !== prof[prof.length - 1]) out.push(prof[prof.length - 1]);
  return out;
}

export const cellKey = (lat, lon) => `${Math.round(lat / ELEV.cellLat)}:${Math.round(lon / ELEV.cellLon)}`;

/**
 * Inlärd höjd per kartruta, sammanvägd över körningar efter osäkerheten.
 * json: {cells: {key: [h, w, n, dag]}} där w = 1/varians.
 */
export class ElevationMap {
  constructor(json = null) { this.cells = { ...(json?.cells || {}) }; }

  /** Lägger in en utjämnad profil. Ger antalet rutor som uppdaterades. */
  add(prof, day = Math.floor(Date.now() / 86400000)) {
    const seen = new Set();
    let n = 0;
    for (const p of prof) {
      if (p.lat == null || p.lon == null || !Number.isFinite(p.h) || !(p.sd > 0)) continue;
      const k = cellKey(p.lat, p.lon);
      if (seen.has(k)) continue;   // en gång per körning och ruta
      seen.add(k);
      const w = 1 / (p.sd * p.sd);
      const c = this.cells[k];
      if (!c) this.cells[k] = [round1(p.h), round6(w), 1, day];
      else {
        // Gamla mätningar väger lite mindre (vägbygge, ny GPS)
        const wOld = c[1] * 0.9;
        this.cells[k] = [round1((c[0] * wOld + p.h * w) / (wOld + w)), round6(wOld + w), c[2] + 1, day];
      }
      n++;
    }
    this.prune();
    return n;
  }

  /** Höjd för en punkt {h, sd, n} eller null. */
  at(lat, lon) {
    const c = this.cells[cellKey(lat, lon)];
    return c ? { h: c[0], sd: 1 / Math.sqrt(c[1]), n: c[2] } : null;
  }

  prune() {
    const keys = Object.keys(this.cells);
    if (keys.length <= ELEV.maxCells) return;
    keys.sort((a, b) => this.cells[a][3] - this.cells[b][3]);
    for (const k of keys.slice(0, keys.length - ELEV.maxCells)) delete this.cells[k];
  }

  size() { return Object.keys(this.cells).length; }
  toJSON() { return { cells: this.cells }; }
}

const round1 = x => Math.round(x * 10) / 10;
const round6 = x => Number(x.toPrecision(6));

/**
 * Jämför profilen med en annan höjdkälla (t.ex. ruttens höjddata) som kan ha
 * ett annat nollplan: lutningarnas skillnad per ca 150 m (rms, andel) och
 * nivåskillnaden (median, m). other(p) ger höjden för punkten eller null.
 */
export function compareProfile(prof, other, segM = 150) {
  const pts = prof.map(p => ({ d: p.d, h: p.h, o: other(p) })).filter(p => p.o != null && Number.isFinite(p.o));
  if (pts.length < 2) return null;
  const off = median(pts.map(p => p.o - p.h));
  let sum = 0, n = 0, j = 0;
  for (let i = 0; i < pts.length; i++) {
    while (j < pts.length && pts[j].d - pts[i].d < segM) j++;
    if (j >= pts.length) break;
    const ds = pts[j].d - pts[i].d;
    const gd = ((pts[j].o - pts[i].o) - (pts[j].h - pts[i].h)) / ds;
    sum += gd * gd; n++;
    i = j - 1;
  }
  return { offsetM: off, gradeRms: n ? Math.sqrt(sum / n) : null, segments: n };
}

function median(xs) {
  const s = xs.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
