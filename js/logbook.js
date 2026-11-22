// Körlogg: allt som händer under en körning eller ett rullprov, som JSON.
// Den kompakta varianten är gjord för att klistras in i en chatt för analys.

export const LOG_VERSION = 1;

/** Fältordning för mätpunkterna (en rad per sekund). */
export const SAMPLE_FIELDS = [
  't',      // sekunder sedan start
  's',      // meter längs rutten
  'lat', 'lon',
  'kmh',    // GPS-fart
  'acc',    // GPS-noggrannhet (m)
  'mode',   // free | approach | coasting | paused | arrived
  'limit',  // hastighetsgräns där bilen är (km/h)
  'g',      // uppmätt sidokraft (g)
  'side',   // sidokraft med tecken, positiv = trycker åt höger (g)
  'rel',    // meter kvar till släpp-signal (om nedräkning pågår)
  'alt',    // GPS-höjd (m)
];

const r = (x, d) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);

export class DriveLog {
  /** meta: {kind, dest, demo, trailer, settings, model, route} */
  constructor(meta, now = Date.now()) {
    this.id = `${meta.kind || 'drive'}-${new Date(now).toISOString().replace(/[:.]/g, '-')}`;
    this.meta = meta;
    this.startedAt = now;
    this.t0 = null;
    this.rows = [];
    this.events = [];
    this.lastSampleT = -Infinity;
    this.stats = null;
    this.endedAt = null;
  }

  rel(t) {
    if (this.t0 == null) this.t0 = t;
    return r(t - this.t0, 1);
  }

  /** Högst en mätpunkt per sekund. */
  sample(t, p) {
    if (t - this.lastSampleT < 0.95) return;
    this.lastSampleT = t;
    this.rows.push([
      this.rel(t), r(p.s, 0), r(p.lat, 6), r(p.lon, 6), r(p.kmh, 1), r(p.acc, 0),
      p.mode ?? null, p.limit ?? null, r(p.g, 3), r(p.side, 3), r(p.rel, 0), r(p.alt, 1),
    ]);
  }

  event(t, type, data = {}) {
    this.events.push({ t: this.rel(t), type, ...roundAll(data) });
  }

  finish(stats, now = Date.now()) {
    this.stats = roundAll(stats || {});
    this.endedAt = now;
  }

  /**
   * full = alla mätpunkter; annars var 5:e sekund (händelser och kurvor alltid
   * med), vilket håller en timmes körning runt 40 kB.
   */
  toJSON({ full = false } = {}) {
    const every = full ? 1 : 5;
    const rows = full ? this.rows : this.rows.filter((row, i) => i % every === 0 || i === this.rows.length - 1);
    return {
      app: 'bromsfri-korning',
      version: LOG_VERSION,
      id: this.id,
      variant: full ? 'full' : 'kompakt (var 5:e s)',
      startedAt: new Date(this.startedAt).toISOString(),
      endedAt: this.endedAt ? new Date(this.endedAt).toISOString() : null,
      ...this.meta,
      stats: this.stats,
      events: this.events,
      samples: { fields: SAMPLE_FIELDS, every_s: every, rows },
    };
  }

  /** Kort rad för listan. */
  summary() {
    const last = this.rows[this.rows.length - 1];
    return {
      id: this.id, kind: this.meta.kind || 'drive',
      title: this.meta.kind === 'calibration' ? 'Rullprov' : (this.meta.dest?.name || 'Körning'),
      startedAt: this.startedAt,
      distanceM: this.stats?.distance ?? (last ? last[1] : null),
      events: this.events.length,
      samples: this.rows.length,
    };
  }

  /** Allt som behövs för att spara och läsa tillbaka. */
  serialize() {
    return { id: this.id, meta: this.meta, startedAt: this.startedAt, t0: this.t0, rows: this.rows, events: this.events, stats: this.stats, endedAt: this.endedAt };
  }

  static deserialize(o) {
    const l = new DriveLog(o.meta, o.startedAt);
    Object.assign(l, { id: o.id, t0: o.t0, rows: o.rows || [], events: o.events || [], stats: o.stats, endedAt: o.endedAt });
    return l;
  }
}

function roundAll(o) {
  const out = {};
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === 'number') out[k] = Math.abs(v) >= 100 ? r(v, 1) : r(v, 4);
    else out[k] = v;
  }
  return out;
}

/**
 * Lagring av loggar. storage = localStorage-liknande objekt.
 * Högst max loggar sparas; de äldsta tas bort först.
 */
export function makeLogStore(storage, { prefix = 'bromsfri.log.', max = 10 } = {}) {
  const indexKey = prefix + 'index';
  const readIndex = () => { try { return JSON.parse(storage.getItem(indexKey)) || []; } catch { return []; } };
  const writeIndex = idx => storage.setItem(indexKey, JSON.stringify(idx));
  return {
    list() { return readIndex().sort((a, b) => b.startedAt - a.startedAt); },
    save(log) {
      const data = JSON.stringify(log.serialize());
      let idx = readIndex().filter(e => e.id !== log.id);
      for (let attempt = 0; attempt < 12; attempt++) {
        try {
          storage.setItem(prefix + log.id, data);
          idx.push(log.summary());
          while (idx.length > max) {
            idx.sort((a, b) => a.startedAt - b.startedAt);
            const old = idx.shift();
            storage.removeItem(prefix + old.id);
          }
          writeIndex(idx);
          return true;
        } catch {
          // Fullt: ta bort äldsta loggen och försök igen
          if (!idx.length) return false;
          idx.sort((a, b) => a.startedAt - b.startedAt);
          const old = idx.shift();
          storage.removeItem(prefix + old.id);
          writeIndex(idx);
        }
      }
      return false;
    },
    load(id) {
      try { const o = JSON.parse(storage.getItem(prefix + id)); return o ? DriveLog.deserialize(o) : null; } catch { return null; }
    },
    remove(id) {
      storage.removeItem(prefix + id);
      writeIndex(readIndex().filter(e => e.id !== id));
    },
  };
}
