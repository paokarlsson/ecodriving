// Vad sparade rullningen? En rullning börjar när gasen släpps (över 20 km/h)
// och slutar när gasen trycks ned igen eller bilen stannar. Bränslet som gick
// åt jämförs med att hålla farten från början av rullningen över samma
// sträcka och sedan bromsa ner, vilket inte kostar något bränsle extra.
// Flödet som håller farten kommer från bränslemodellen (FuelModel.holdLh),
// med backen över sträckan. Rullningar som börjar strax efter en
// släpp-signal räknas som följda signaler.

export const SAVE = {
  minDistM: 30,   // kortare rullningar räknas inte
  minKmh: 20,     // farten när gasen släpps
  stopKmh: 5,     // under detta har bilen stannat: rullningen slutar
  signalS: 8,     // s: gasen släppt så här länge efter en signal räknas som följd
};

export class CoastSaving {
  constructor() {
    this.cur = null;
    this.list = [];
    this.signalT = null;
    this.signalKind = null;
  }

  /** En släpp-signal gavs (t i samma tidsskala som pedal()). */
  signal(t, kind = null) {
    this.signalT = t;
    this.signalKind = kind;
    if (this.cur && t - this.cur.t0 <= 2) { this.cur.signal = true; this.cur.kind = kind; }
  }

  /**
   * Varje OBD-värde: {t, released (gasen släppt, inte farthållare), s (m), v (m/s),
   * fuelL (bränsle hittills, l)}. Ger 'gas' eller 'stopp' när en rullning slutar,
   * annars null. Rullningen räknas sedan med end().
   */
  update({ t, released, s, v, fuelL }) {
    if (released == null || s == null || v == null) return null;
    const c = this.cur;
    if (!c) {
      if (released && v * 3.6 >= SAVE.minKmh && fuelL != null) {
        const signal = this.signalT != null && t - this.signalT >= -0.5 && t - this.signalT <= SAVE.signalS;
        this.cur = { t0: t, s0: s, v0: v, f0: fuelL, signal, kind: signal ? this.signalKind : null };
      }
      return null;
    }
    if (!released) return 'gas';
    if (v * 3.6 < SAVE.stopKmh) return 'stopp';
    return null;
  }

  abort() { this.cur = null; }

  /**
   * Rullningen slutade: {s, fuelL, holdLh: (kmh, grade) => l/h, grade: medellutning
   * över sträckan, reason}. Ger {distM, v0Kmh, usedL, altL, savedL, signal, kind, reason}
   * eller null om rullningen inte går att räkna (för kort, bränslet okänt).
   */
  end({ s, fuelL, holdLh, grade = 0, reason = null }) {
    const c = this.cur;
    this.cur = null;
    if (!c || fuelL == null || c.f0 == null || !(c.v0 > 0)) return null;
    const distM = s - c.s0;
    if (!(distM >= SAVE.minDistM)) return null;
    const v0Kmh = c.v0 * 3.6;
    const usedL = Math.max(0, fuelL - c.f0);
    const altL = Math.max(0, holdLh(v0Kmh, grade)) * (distM / c.v0) / 3600;
    // Gick det åt mer än att hålla farten (tomgång i nedförsbacke i låg fart)
    // hade det alternativet också varit att släppa gasen: inget sparat, inget förlorat.
    const r = { distM, v0Kmh, usedL, altL, savedL: Math.max(0, altL - usedL), signal: c.signal, kind: c.kind, reason };
    this.list.push(r);
    return r;
  }

  totalL() { return this.list.reduce((a, r) => a + r.savedL, 0); }
  signalL() { return this.list.filter(r => r.signal).reduce((a, r) => a + r.savedL, 0); }
}
