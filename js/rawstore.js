// Rådata från telefonens sensorer och API:erna, sparad i telefonens databas
// (IndexedDB – localStorage rymmer bara ca 5 MB, en timmes sensordata är
// 7–12 MB). Data samlas i minnet och skrivs i block var 5:e sekund.

export const MOTION_FIELDS = ['t', 'ax', 'ay', 'az', 'gx', 'gy', 'gz', 'alpha', 'beta', 'gamma'];
// t = sekunder sedan inspelningen började; a* = acceleration utan tyngdkraft,
// g* = acceleration med tyngdkraft (m/s²); alpha/beta/gamma = gyro (grader/s)
export const GPS_FIELDS = ['t', 'lat', 'lon', 'alt', 'acc', 'altAcc', 'speed', 'heading'];
export const COMPASS_FIELDS = ['t', 'heading'];
// OBD: kmh och rpm från bilen, pedal (%) och pedalRaw (givarens värde, %),
// maf (g/s), fuelLh (l/h, beräknat om bilen inte ger det), fuelCut (1 = bränslet avstängt),
// released (1 = gasen räknas som släppt), fuelLhCar (l/h enligt bilen, om den ger det),
// cruise (1 = farthållaren drar: pedalen släppt men bränsle som vid gaspådrag)
export const OBD_FIELDS = ['t', 'kmh', 'rpm', 'pedal', 'pedalRaw', 'maf', 'fuelLh', 'fuelCut', 'released', 'fuelLhCar', 'cruise'];
// Övriga OBD-värden, ett per avläsning: pid, avkodat värde (null om det saknas
// avkodning) och svarets fyra första databytes (A–D)
export const OBDX_FIELDS = ['t', 'pid', 'value', 'A', 'B', 'C', 'D'];

const DB_NAME = 'bromsfri-raw';
const STORE = 'chunks';
let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const st = req.result.createObjectStore(STORE, { autoIncrement: true });
      st.createIndex('logId', 'logId');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

/** Standardlagring: IndexedDB. Byts ut i tester. */
export const idbSink = {
  async put(rec) {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).add(rec);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  },
  async getAll(logId) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const req = db.transaction(STORE).objectStore(STORE).index('logId').getAll(logId);
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  },
  async remove(logId) {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const idx = tx.objectStore(STORE).index('logId');
      const req = idx.openKeyCursor(IDBKeyRange.only(logId));
      req.onsuccess = () => { const c = req.result; if (c) { tx.objectStore(STORE).delete(c.primaryKey); c.continue(); } };
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  },
};

const num = x => (x == null || !Number.isFinite(x) ? NaN : x);

/** Samlar rådata för en logg och skriver den i block. */
export class RawRecorder {
  constructor(logId, { sink = idbSink, flushMs = 5000 } = {}) {
    this.logId = logId;
    this.sink = sink;
    this.t0 = null;
    this.motion = []; this.gps = []; this.compass = []; this.obd = []; this.obdx = [];
    this.seq = 0;
    this.counts = { motion: 0, gps: 0, compass: 0, obd: 0, obdx: 0, api: 0 };
    this.pending = Promise.resolve();
    this.error = null;
    this.timer = flushMs ? setInterval(() => this.flush(), flushMs) : null;
  }

  rel(t) { if (this.t0 == null) this.t0 = t; return t - this.t0; }

  /** m från watchMotion: {t, ax, ay, az, gx, gy, gz, rot: {alpha, beta, gamma}} */
  addMotion(m) {
    const r = m.rot || {};
    this.motion.push(this.rel(m.t), num(m.ax), num(m.ay), num(m.az), num(m.gx), num(m.gy), num(m.gz), num(r.alpha), num(r.beta), num(r.gamma));
    this.counts.motion++;
  }

  /** o från watchGps: {t, lat, lon, alt, altAccuracy?, accuracy, speed, heading} */
  addGps(o) {
    this.gps.push(this.rel(o.t), num(o.lat), num(o.lon), num(o.alt), num(o.accuracy), num(o.altAccuracy), num(o.speed), num(o.heading));
    this.counts.gps++;
  }

  addCompass(t, heading) {
    this.compass.push(this.rel(t), num(heading));
    this.counts.compass++;
  }

  /** s från ObdPoller: {t, kmh, rpm, pedal, pedalRaw, maf, fuelRate, fuelCut} */
  addObd(s) {
    this.obd.push(this.rel(s.t), num(s.kmh), num(s.rpm), num(s.pedal), num(s.pedalRaw), num(s.maf), num(s.fuelRate), s.fuelCut == null ? NaN : s.fuelCut ? 1 : 0,
      s.released == null ? NaN : s.released ? 1 : 0, num(s.fuelLh), s.cruise == null ? NaN : s.cruise ? 1 : 0);
    this.counts.obd++;
  }

  /** Ett övrigt OBD-värde: x = {pid, value, bytes} från ObdPoller. */
  addObdExtra(t, x) {
    const b = x.bytes || [];
    this.obdx.push(this.rel(t), x.pid, typeof x.value === 'number' ? x.value : NaN, num(b[0]), num(b[1]), num(b[2]), num(b[3]));
    this.counts.obdx++;
  }

  /** Svar från API:erna (rutt, vägdata) – sparas som de är. */
  addApi(kind, data) {
    this.counts.api++;
    this.put({ kind: 'api', api: kind, at: new Date().toISOString(), data });
  }

  flush() {
    if (this.motion.length) { this.put({ kind: 'motion', data: Float32Array.from(this.motion) }); this.motion = []; }
    if (this.gps.length) { this.put({ kind: 'gps', data: Float64Array.from(this.gps) }); this.gps = []; }
    if (this.compass.length) { this.put({ kind: 'compass', data: Float32Array.from(this.compass) }); this.compass = []; }
    if (this.obd.length) { this.put({ kind: 'obd', w: OBD_FIELDS.length, data: Float32Array.from(this.obd) }); this.obd = []; }
    if (this.obdx.length) { this.put({ kind: 'obdx', data: Float64Array.from(this.obdx) }); this.obdx = []; }
  }

  put(rec) {
    rec.logId = this.logId;
    rec.seq = this.seq++;
    this.pending = this.pending.then(() => this.sink.put(rec)).catch(e => { this.error = e.message || String(e); });
  }

  async close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.flush();
    await this.pending;
    return { ...this.counts, error: this.error };
  }
}

function toRows(chunks, width, decimals, legacyWidth = width) {
  const rows = [];
  const f = 10 ** decimals;
  for (const c of chunks) {
    const d = c.data;
    // Äldre block kan ha färre fält (c.w, eller legacyWidth om bredden inte sparades); de som saknas blir null
    const w = c.w ?? legacyWidth;
    for (let i = 0; i + w <= d.length; i += w) {
      const row = new Array(width).fill(null);
      for (let k = 0; k < Math.min(w, width); k++) {
        const v = d[i + k];
        row[k] = Number.isNaN(v) ? null : (k === 0 ? Math.round(v * 1000) / 1000 : Math.round(v * f) / f);
      }
      rows.push(row);
    }
  }
  return rows;
}

/** Läser all rådata för en logg som tabeller (för export). */
export async function readRaw(logId, { sink = idbSink } = {}) {
  const all = (await sink.getAll(logId)).sort((a, b) => a.seq - b.seq);
  const by = k => all.filter(c => c.kind === k);
  const gpsRows = toRows(by('gps'), GPS_FIELDS.length, 7);
  return {
    motion: { fields: MOTION_FIELDS, rows: toRows(by('motion'), MOTION_FIELDS.length, 4) },
    gps: { fields: GPS_FIELDS, rows: gpsRows },
    compass: { fields: COMPASS_FIELDS, rows: toRows(by('compass'), COMPASS_FIELDS.length, 2) },
    // Block utan sparad bredd är från versionen med 10 fält (utan cruise)
    obd: { fields: OBD_FIELDS, rows: toRows(by('obd'), OBD_FIELDS.length, 2, 10) },
    obdx: { fields: OBDX_FIELDS, rows: toRows(by('obdx'), OBDX_FIELDS.length, 3) },
    api: by('api').map(c => ({ kind: c.api, at: c.at, data: c.data })),
  };
}

export async function deleteRaw(logId, { sink = idbSink } = {}) {
  try { await sink.remove(logId); } catch { /* ingen databas */ }
}

/** Ber webbläsaren att inte rensa databasen när lagringen blir full. */
export async function persistStorage() {
  try { if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist(); } catch { /* stöds inte */ }
  return false;
}
