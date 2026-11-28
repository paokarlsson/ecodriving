// OBD-II via en ELM327-kompatibel dosa med Bluetooth Low Energy (t.ex. Vgate
// iCar Pro BLE), med Web Bluetooth (Chrome på Android och datorn).
// Appen läser gaspedalen, farten, varvtalet och bränsleuppgifter; allt annat
// tas från GPS som förut.

/** Tjänster som ELM327-dosor med BLE brukar ha (Web Bluetooth kräver att de räknas upp). */
export const BLE_SERVICES = [
  0xfff0, 0xffe0, 0x18f0, 0xffb0, 0xfee7,
  'e7810a71-73ae-499d-8c15-faa9aef0c3f2', // Vgate
  '0000fff0-0000-1000-8000-00805f9b34fb',
];

export const OBD = {
  releasedPct: 3,    // % pedal: under detta räknas gasen som släppt
  pressedPct: 8,     // % pedal: över detta räknas gasen som nedtryckt (hysteres)
  slowEvery: 4,      // var 4:e varv läses bränsleuppgifterna
  cmdTimeout: 2500,  // ms per kommando
  searchTimeout: 12000, // ms för första frågan (dosan letar protokoll)
  engineBrakeRpm: 1100,
  engineBrakeKmh: 20,
  petrolAfr: 14.7,   // luft/bränsle, bensin
  petrolDensity: 745, // g/l
  // Farthållare: gasen släppt men motorn får bränsle som vid gaspådrag
  cruiseKmh: 25,      // km/h: farthållare räknas bara över detta
  cruiseHoldS: 3,     // s med bränsle utan pedal innan farthållaren räknas som på
  idleLh: 1.2,        // l/h: tomgång innan den har mätts
  otherRetryS: 30,    // s innan ett värde som slutat svara prövas igen (dubblas, högst 10 min)
};

/** Pedalkällor i prioritetsordning: relativ pedal, pedal D, relativt gasspjäll, gasspjäll. */
export const PEDAL_PIDS = [0x5a, 0x49, 0x45, 0x11];

const hex2 = n => n.toString(16).toUpperCase().padStart(2, '0');

/**
 * Svarsraderna från ELM327 utan eko, prompt och statusrader. Mellanslag tas
 * bort så att svaret ser likadant ut med och utan ATS0.
 */
export function responseLines(text) {
  return text.replace(/>/g, '').split(/[\r\n]+/)
    .map(l => l.trim())
    .filter(l => l && !/^SEARCHING/i.test(l) && !/^BUS INIT/i.test(l))
    .map(l => (/^[0-9A-F ]+$/i.test(l) ? l.replace(/\s+/g, '').toUpperCase() : l));
}

const ERRORS = ['NO DATA', 'UNABLE TO CONNECT', 'CAN ERROR', 'BUS ERROR', 'STOPPED', 'BUFFER FULL', 'ERROR', '?'];

/** Felet i ett svar, eller null. */
export function responseError(lines) {
  if (!lines.length) return 'NO DATA';
  if (lines.some(l => /^41|^[0-9A-F]+$/.test(l))) return null;
  for (const e of ERRORS) if (lines.some(l => l.toUpperCase().includes(e))) return e;
  return null;
}

/** Databytes för mode 01-svaret på pid (första styrdonet som svarar), eller null. */
export function pidBytes(lines, pid) {
  const head = '41' + hex2(pid);
  for (const l of lines) {
    const i = l.indexOf(head);
    if (i < 0 || !/^[0-9A-F]+$/.test(l)) continue;
    const body = l.slice(i + head.length);
    const out = [];
    for (let k = 0; k + 2 <= body.length; k += 2) out.push(parseInt(body.slice(k, k + 2), 16));
    if (out.length) return out;
  }
  return null;
}

/** Vilka pid som stöds, ur svaren på 0100, 0120, 0140 … (alla styrdon slås ihop). */
export function supportedFrom(lines, base) {
  const set = new Set();
  const head = '41' + hex2(base);
  for (const l of lines) {
    const i = l.indexOf(head);
    if (i < 0) continue;
    const body = l.slice(i + head.length, i + head.length + 8);
    if (body.length < 8) continue;
    const bits = parseInt(body, 16) >>> 0;
    for (let n = 1; n <= 32; n++) if (bits & (1 << (32 - n)) >>> 0) set.add(base + n);
  }
  return set;
}

/** Värdet för en pid ur dess databytes. */
export function decodePid(pid, b) {
  if (!b || !b.length) return null;
  const [A, B = 0] = b;
  switch (pid) {
    case 0x03: return A;                         // bränslesystemets status
    case 0x0c: return b.length < 2 ? null : (A * 256 + B) / 4; // varvtal
    case 0x0d: return A;                         // km/h
    case 0x10: return b.length < 2 ? null : (A * 256 + B) / 100; // luftflöde, g/s
    case 0x11: case 0x45: case 0x49: case 0x4a: case 0x5a: return A * 100 / 255; // %
    case 0x51: return A;                         // bränsletyp
    case 0x5e: return b.length < 2 ? null : (A * 256 + B) / 20; // l/h
    default: return null;
  }
}

// Övriga värden i mode 01 (SAE J1979): namn i loggen och avkodning.
// A, B, C, D = databytes. Värden utan avkodning sparas som hex.
const u16 = (A, B) => A * 256 + B;
const trim = A => (A - 128) * 100 / 128;
export const PID_INFO = {
  0x01: ['monitorStatus', null], 0x02: ['freezeDtc', null],
  0x04: ['loadPct', A => A * 100 / 255],
  0x05: ['coolantC', A => A - 40],
  0x06: ['stft1Pct', trim], 0x07: ['ltft1Pct', trim], 0x08: ['stft2Pct', trim], 0x09: ['ltft2Pct', trim],
  0x0a: ['fuelPressKpa', A => 3 * A],
  0x0b: ['mapKpa', A => A],
  0x0e: ['timingDeg', A => A / 2 - 64],
  0x0f: ['intakeC', A => A - 40],
  0x11: ['throttlePct', A => A * 100 / 255],
  0x12: ['secAirStatus', null], 0x13: ['o2Present', null],
  0x14: ['o2s1V', A => A / 200], 0x15: ['o2s2V', A => A / 200], 0x16: ['o2s3V', A => A / 200], 0x17: ['o2s4V', A => A / 200],
  0x18: ['o2s5V', A => A / 200], 0x19: ['o2s6V', A => A / 200], 0x1a: ['o2s7V', A => A / 200], 0x1b: ['o2s8V', A => A / 200],
  0x1c: ['obdStandard', A => A], 0x1d: ['o2Present4', null], 0x1e: ['auxInput', null],
  0x1f: ['runTimeS', u16],
  0x21: ['milDistKm', u16],
  0x22: ['railPressKpa', (A, B) => u16(A, B) * 0.079],
  0x23: ['railGaugeKpa', (A, B) => u16(A, B) * 10],
  0x24: ['lambda1', (A, B) => u16(A, B) * 2 / 65536], 0x25: ['lambda2', (A, B) => u16(A, B) * 2 / 65536],
  0x26: ['lambda3', (A, B) => u16(A, B) * 2 / 65536], 0x27: ['lambda4', (A, B) => u16(A, B) * 2 / 65536],
  0x28: ['lambda5', (A, B) => u16(A, B) * 2 / 65536], 0x29: ['lambda6', (A, B) => u16(A, B) * 2 / 65536],
  0x2a: ['lambda7', (A, B) => u16(A, B) * 2 / 65536], 0x2b: ['lambda8', (A, B) => u16(A, B) * 2 / 65536],
  0x2c: ['egrCmdPct', A => A * 100 / 255],
  0x2d: ['egrErrPct', trim],
  0x2e: ['evapPurgePct', A => A * 100 / 255],
  0x2f: ['fuelLevelPct', A => A * 100 / 255],
  0x30: ['warmups', A => A],
  0x31: ['clearedDistKm', u16],
  0x32: ['evapPressPa', (A, B) => ((A * 256 + B) << 16 >> 16) / 4],
  0x33: ['baroKpa', A => A],
  0x34: ['lambdaI1', (A, B) => u16(A, B) * 2 / 65536], 0x35: ['lambdaI2', (A, B) => u16(A, B) * 2 / 65536],
  0x36: ['lambdaI3', (A, B) => u16(A, B) * 2 / 65536], 0x37: ['lambdaI4', (A, B) => u16(A, B) * 2 / 65536],
  0x38: ['lambdaI5', (A, B) => u16(A, B) * 2 / 65536], 0x39: ['lambdaI6', (A, B) => u16(A, B) * 2 / 65536],
  0x3a: ['lambdaI7', (A, B) => u16(A, B) * 2 / 65536], 0x3b: ['lambdaI8', (A, B) => u16(A, B) * 2 / 65536],
  0x3c: ['catB1S1C', (A, B) => u16(A, B) / 10 - 40], 0x3d: ['catB2S1C', (A, B) => u16(A, B) / 10 - 40],
  0x3e: ['catB1S2C', (A, B) => u16(A, B) / 10 - 40], 0x3f: ['catB2S2C', (A, B) => u16(A, B) / 10 - 40],
  0x41: ['monitorDrive', null],
  0x42: ['moduleV', (A, B) => u16(A, B) / 1000],
  0x43: ['absLoadPct', (A, B) => u16(A, B) * 100 / 255],
  0x44: ['lambdaCmd', (A, B) => u16(A, B) * 2 / 65536],
  0x45: ['relThrottlePct', A => A * 100 / 255],
  0x46: ['ambientC', A => A - 40],
  0x47: ['throttleBPct', A => A * 100 / 255], 0x48: ['throttleCPct', A => A * 100 / 255],
  0x49: ['pedalDPct', A => A * 100 / 255], 0x4a: ['pedalEPct', A => A * 100 / 255], 0x4b: ['pedalFPct', A => A * 100 / 255],
  0x4c: ['throttleCmdPct', A => A * 100 / 255],
  0x4d: ['milTimeMin', u16], 0x4e: ['clearedTimeMin', u16],
  0x50: ['maxMafGs', A => A * 10],
  0x51: ['fuelType', A => A],
  0x52: ['ethanolPct', A => A * 100 / 255],
  0x53: ['evapAbsKpa', (A, B) => u16(A, B) / 200],
  0x54: ['evapPressPa2', (A, B) => (A * 256 + B) << 16 >> 16],
  0x55: ['st2ndO2b1Pct', trim], 0x56: ['lt2ndO2b1Pct', trim], 0x57: ['st2ndO2b2Pct', trim], 0x58: ['lt2ndO2b2Pct', trim],
  0x59: ['railAbsKpa', (A, B) => u16(A, B) * 10],
  0x5a: ['relPedalPct', A => A * 100 / 255],
  0x5b: ['hybridBattPct', A => A * 100 / 255],
  0x5c: ['oilC', A => A - 40],
  0x5d: ['injTimingDeg', (A, B) => u16(A, B) / 128 - 210],
  0x5e: ['fuelRateLh', (A, B) => u16(A, B) / 20],
  0x5f: ['emissionStd', A => A],
  0x61: ['torqueDemandPct', A => A - 125],
  0x62: ['torqueActualPct', A => A - 125],
  0x63: ['torqueRefNm', u16],
  0x67: ['coolant2C', (A, B, C) => B - 40],
  0x68: ['intake2C', (A, B, C) => B - 40],
  0x8e: ['frictionTorquePct', A => A - 125],
  0xa2: ['cylFuelMg', (A, B) => u16(A, B) / 32],
  0xa4: ['gear', (A, B) => (A & 2 ? (B >> 4) : null)],
  0xa6: ['odometerKm', (A, B, C, D) => ((A * 2 ** 24) + (B << 16) + (C << 8) + D) / 10],
};

/** Namnet för en pid i loggen. */
export const pidName = pid => PID_INFO[pid]?.[0] ?? `pid${hex2(pid)}`;

/** Övrigt värde: avkodat tal, eller databytes som hex om det saknas avkodning. */
export function decodeOther(pid, b) {
  if (!b || !b.length) return null;
  const f = PID_INFO[pid]?.[1];
  if (f) {
    const v = f(b[0], b[1] ?? 0, b[2] ?? 0, b[3] ?? 0);
    if (v != null && Number.isFinite(v)) return Math.round(v * 1000) / 1000;
  }
  return b.map(hex2).join('');
}

/** Pid som är listor över pid (0x00, 0x20 …) och därför inte är värden. */
const isSupportPid = pid => pid % 0x20 === 0;

/**
 * Gaspedalen i procent av vägen. Pedal- och gasspjällsgivare visar sällan 0
 * när foten är borta, så viloläget lärs in som det lägsta värdet som setts.
 * released har hysteres: släppt under releasedPct, nedtryckt över pressedPct.
 */
export class PedalTracker {
  constructor({ pid = 0x5a, rest = null } = {}) {
    this.pid = pid;
    // Relativ pedal (5A) är redan räknad från viloläget
    this.rest = pid === 0x5a ? 0 : rest;
    this.top = null;
    this.released = null;
    this.pct = null;
  }

  update(raw) {
    if (raw == null || !Number.isFinite(raw)) return this.pct;
    if (this.rest == null || raw < this.rest) this.rest = raw;
    // Vägen pedalen kan röra sig; minst 40 procentenheter innan mer har setts
    this.top = Math.max(this.top ?? 0, raw, this.rest + 40);
    const pct = Math.max(0, Math.min(100, (raw - this.rest) / (this.top - this.rest) * 100));
    this.pct = pct;
    if (pct <= OBD.releasedPct) this.released = true;
    else if (pct >= OBD.pressedPct) this.released = false;
    else if (this.released == null) this.released = false;
    return pct;
  }
}

/**
 * Farthållare: med farthållaren på visar pedalgivaren 0 fast motorn drar.
 * Den känns igen på att gasen är släppt men bränsleflödet ligger klart över
 * tomgång (och bränslet inte är avstängt) i några sekunder. Tomgången lärs
 * när bilen står still.
 */
export class CruiseDetector {
  constructor() { this.idle = null; this.since = null; this.on = false; }

  /** Gränsen (l/h) över vilken släppt gas ändå betyder att motorn drar. */
  limit() {
    const b = this.idle ?? OBD.idleLh;
    return Math.max(2 * b, b + 1);
  }

  update(t, { released, kmh, fuelRate, fuelCut }) {
    if (kmh === 0 && released && fuelRate != null && fuelRate > 0) {
      this.idle = this.idle == null ? fuelRate : this.idle + 0.1 * (fuelRate - this.idle);
    }
    if (!released || fuelCut || kmh == null || kmh < OBD.cruiseKmh - 5) return this.reset();
    if (fuelRate == null) return this.on;
    const lim = this.limit();
    if (fuelRate > lim && kmh >= OBD.cruiseKmh) {
      if (this.since == null) this.since = t;
      if (t - this.since >= OBD.cruiseHoldS) this.on = true;
    } else if (fuelRate <= lim - 0.5) this.reset();
    return this.on;
  }

  reset() { this.since = null; this.on = false; return false; }
}

/** Bränsle i l/h: bränsleflödet om bilen har det, annars ur luftflödet (bara bensin). */
export function fuelRate({ fuelLh = null, maf = null, fuelCut = false, fuelType = null }) {
  if (fuelCut) return 0;
  if (fuelLh != null) return fuelLh;
  if (maf == null) return null;
  if (fuelType != null && fuelType !== 1) return null; // luftflödet räcker bara för bensin
  return maf / OBD.petrolAfr / OBD.petrolDensity * 3600;
}

/**
 * Samtal med en ELM327 över en transport {write(text): Promise, onText(cb)}.
 * Ett kommando i taget; svaret är klart när prompten '>' kommer.
 */
export class ElmSession {
  constructor(transport, { now = () => Date.now() } = {}) {
    this.t = transport;
    this.now = now;
    this.buf = '';
    this.wait = null;
    this.queue = Promise.resolve();
    transport.onText(s => this.onText(s));
    this.info = { version: null, protocol: null, supported: new Set(), pedalPid: null, fuelType: null };
  }

  onText(s) {
    this.buf += s;
    if (this.wait && this.buf.includes('>')) {
      const text = this.buf;
      this.buf = '';
      const w = this.wait;
      this.wait = null;
      clearTimeout(w.timer);
      w.resolve(text);
    }
  }

  /** Skickar ett kommando och väntar på svaret (svarsraderna). */
  send(cmd, timeout = OBD.cmdTimeout) {
    const run = () => new Promise((resolve, reject) => {
      this.buf = '';
      const timer = setTimeout(() => { this.wait = null; reject(new Error(`Dosan svarade inte på ${cmd}`)); }, timeout);
      this.wait = { resolve: text => resolve(responseLines(text).filter(l => l.replace(/\s/g, '') !== cmd)), timer };
      this.t.write(cmd + '\r').catch(e => { clearTimeout(timer); this.wait = null; reject(e); });
    });
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  /** Startar dosan och tar reda på vad bilen redovisar. */
  async init(onStep = () => {}) {
    onStep('dosa');
    try { await this.send('ATZ', 4000); } catch { /* vissa dosor svarar inte på återställning */ }
    for (const c of ['ATE0', 'ATL0', 'ATS0', 'ATH0', 'ATAT1', 'ATSP0']) await this.send(c);
    const ver = await this.send('ATI');
    this.info.version = ver.find(l => /ELM|v\d/i.test(l)) || ver[0] || null;
    onStep('protokoll');
    const l0 = await this.send('0100', OBD.searchTimeout);
    const err = responseError(l0);
    if (err) throw new Error(err === 'UNABLE TO CONNECT' || err === 'NO DATA'
      ? 'Bilen svarar inte. Är tändningen på?' : `Bilen svarade med fel (${err})`);
    const sup = supportedFrom(l0, 0x00);
    for (const base of [0x20, 0x40, 0x60, 0x80, 0xa0, 0xc0]) {
      if (!sup.has(base)) break;
      try { for (const p of supportedFrom(await this.send('01' + hex2(base)), base)) sup.add(p); }
      catch { break; }
    }
    this.info.supported = sup;
    try { this.info.protocol = (await this.send('ATDPN'))[0] || null; } catch { /* inte viktigt */ }
    this.info.pedalPid = PEDAL_PIDS.find(p => sup.has(p)) ?? null;
    if (sup.has(0x51)) {
      try { this.info.fuelType = decodePid(0x51, pidBytes(await this.send('0151'), 0x51)); } catch { /* okänd */ }
    }
    onStep('klar');
    return this.info;
  }

  /** Läser en pid; null om bilen inte svarar. */
  async read(pid) {
    const lines = await this.send('01' + hex2(pid));
    return decodePid(pid, pidBytes(lines, pid));
  }

  /** Läser en pid som rå databytes; null om bilen inte svarar. */
  async readBytes(pid) {
    return pidBytes(await this.send('01' + hex2(pid)), pid);
  }
}

/**
 * Läser bilen i en slinga: gaspedal, fart och varvtal varje varv,
 * bränsleuppgifterna var slowEvery:e och ett övrigt värde varannan varv.
 * onSample får {t, kmh, rpm, pedalRaw, pedal, released (gasen släppt och ingen
 * farthållare), pedalReleased, cruise, maf, fuelLh, fuelCut,
 * fuelRate, rate, coolant, load, other: {namn: senaste värde}, extra: det
 * övriga värde som lästes detta varv {pid, name, value, bytes} eller null}.
 */
export class ObdPoller {
  constructor(session, onSample, { now = () => Date.now() } = {}) {
    this.s = session;
    this.onSample = onSample;
    this.now = now;
    this.running = false;
    this.pedal = new PedalTracker({ pid: session.info.pedalPid ?? 0x5a });
    this.state = { maf: null, fuelLh: null, fuelCut: null };
    this.times = [];
    // Övriga värden: allt bilen redovisar som inte redan läses. Kylvätska och
    // last varannan gång, resten i tur och ordning.
    const sup = session.info.supported || new Set();
    const fast = new Set([session.info.pedalPid, 0x0d, 0x0c, 0x03, 0x5e, 0x10]);
    this.prio = [0x04, 0x05].filter(p => sup.has(p) && !fast.has(p));
    this.rest = [...sup].filter(p => !isSupportPid(p) && !fast.has(p) && !this.prio.includes(p)).sort((a, b) => a - b);
    this.other = {};         // namn → senaste värde
    this.otherT = {};        // namn → tid (ms)
    this.fails = new Map();  // pid → antal tomma svar i rad
    this.retryAt = new Map(); // pid → tid (ms) då ett värde som slutat svara prövas igen
    this.retryS = new Map();  // pid → nästa väntetid (s)
    this.turn = 0;
    this.cruise = new CruiseDetector();
  }

  /** Nästa övriga pid att läsa, eller null. */
  nextOther(t = this.now()) {
    const ok = p => (this.fails.get(p) || 0) < 3 || t >= (this.retryAt.get(p) ?? Infinity);
    const prio = this.prio.filter(ok), rest = this.rest.filter(ok);
    if (!prio.length && !rest.length) return null;
    this.turn++;
    if (prio.length && (this.turn % 2 === 0 || !rest.length)) return prio[(this.turn >> 1) % prio.length];
    return rest[(this.turn >> 1) % rest.length] ?? prio[0];
  }

  /**
   * Läser en övrig pid. Efter tre tomma svar i rad hoppas den över en stund
   * (30 s, sedan dubbelt så länge varje gång) och prövas sedan en gång igen.
   */
  async readOther(t) {
    const pid = this.nextOther(t);
    if (pid == null) return null;
    const b = await this.s.readBytes(pid);
    if (!b) {
      const n = (this.fails.get(pid) || 0) + 1;
      this.fails.set(pid, n);
      if (n >= 3) {
        const wait = this.retryS.get(pid) ?? OBD.otherRetryS;
        this.retryAt.set(pid, t + wait * 1000);
        this.retryS.set(pid, Math.min(600, wait * 2));
      }
      return null;
    }
    this.fails.set(pid, 0);
    this.retryAt.delete(pid);
    this.retryS.delete(pid);
    const value = decodeOther(pid, b);
    const name = pidName(pid);
    this.other[name] = value;
    this.otherT[name] = t;
    return { pid, name, value, bytes: b };
  }

  async loop() {
    this.running = true;
    const sup = this.s.info.supported;
    const pedalPid = this.s.info.pedalPid;
    let n = 0, fails = 0;
    while (this.running) {
      try {
        const pedalRaw = pedalPid != null ? await this.s.read(pedalPid) : null;
        const kmh = sup.has(0x0d) ? await this.s.read(0x0d) : null;
        const rpm = sup.has(0x0c) ? await this.s.read(0x0c) : null;
        // Ett övrigt värde varannan varv, så att pedalen fortfarande läses ofta
        const extra = n % 2 === 1 ? await this.readOther(this.now()) : null;
        if (n % OBD.slowEvery === 0) {
          if (sup.has(0x03)) { const st = await this.s.read(0x03); this.state.fuelCut = st == null ? null : st === 4; }
          if (sup.has(0x5e)) this.state.fuelLh = await this.s.read(0x5e);
          else if (sup.has(0x10)) this.state.maf = await this.s.read(0x10);
        }
        n++;
        fails = 0;
        if (!this.running) break;
        const t = this.now();
        this.times.push(t);
        while (this.times.length > 1 && t - this.times[0] > 3000) this.times.shift();
        const rate = this.times.length > 1 ? (this.times.length - 1) / ((t - this.times[0]) / 1000) : null;
        const pedal = this.pedal.update(pedalRaw);
        // Bränslestatus 4 betyder hög last eller avstängt bränsle vid motorbroms
        const fuelCut = this.state.fuelCut && this.pedal.released ? true : this.state.fuelCut === null ? null : false;
        const fr = fuelRate({ fuelLh: this.state.fuelLh, maf: this.state.maf, fuelCut, fuelType: this.s.info.fuelType });
        const pedalReleased = this.pedal.released;
        const cruise = this.cruise.update(t / 1000, { released: pedalReleased, kmh, fuelRate: fr, fuelCut });
        // Kylvätska och last bara om de lästs nyligen, annars visas gamla värden
        const fresh = k => this.other[k] != null && t - (this.otherT[k] ?? -Infinity) <= 60000 ? this.other[k] : null;
        this.onSample({
          t: t / 1000, kmh, rpm, pedalRaw, pedal,
          // Med farthållaren drar motorn fast pedalen är släppt: gasen räknas som på
          released: pedalReleased == null ? null : pedalReleased && !cruise,
          pedalReleased, cruise,
          maf: this.state.maf, fuelLh: this.state.fuelLh, fuelCut,
          fuelRate: fr,
          rate,
          coolant: fresh('coolantC'), load: fresh('loadPct'),
          other: this.other, extra,
        });
      } catch (e) {
        if (!this.running) break;
        if (++fails >= 3) { this.running = false; throw e; }
      }
    }
  }

  stop() { this.running = false; }
}

/** Motorbroms: gasen släppt, motorn snurrar och bilen rullar. */
export function engineBraking(sample) {
  return !!(sample && sample.released && sample.rpm != null && sample.rpm >= OBD.engineBrakeRpm
    && sample.kmh != null && sample.kmh >= OBD.engineBrakeKmh);
}

// ---------- Web Bluetooth ----------

export const bleSupported = () => typeof navigator !== 'undefined' && !!navigator.bluetooth;

/** Hittar en karakteristik att lyssna på och en att skriva till. */
async function findChannels(server) {
  const services = await server.getPrimaryServices();
  let best = null;
  for (const svc of services) {
    let chars;
    try { chars = await svc.getCharacteristics(); } catch { continue; }
    const notify = chars.find(c => c.properties.notify || c.properties.indicate);
    const write = chars.find(c => c.properties.write || c.properties.writeWithoutResponse);
    if (notify && write) { best = { notify, write }; if (notify === write || svc.uuid.includes('fff0') || svc.uuid.startsWith('e7810a71')) break; }
  }
  if (!best) throw new Error('Dosan har ingen tjänst för OBD. Är det en BLE-dosa?');
  return best;
}

/** Transport över BLE: text in och ut, skriven i bitar om 20 byte. */
export async function bleTransport(device) {
  const server = await device.gatt.connect();
  const { notify, write } = await findChannels(server);
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  let handler = () => {};
  notify.addEventListener('characteristicvaluechanged', e => handler(dec.decode(e.target.value)));
  await notify.startNotifications();
  const noResp = !write.properties.write && write.properties.writeWithoutResponse;
  return {
    async write(text) {
      const bytes = enc.encode(text);
      for (let i = 0; i < bytes.length; i += 20) {
        const part = bytes.slice(i, i + 20);
        if (noResp) await write.writeValueWithoutResponse(part);
        else await write.writeValue(part);
      }
    },
    onText(cb) { handler = cb; },
  };
}

/** Låter användaren välja dosan i Chromes lista. Måste anropas direkt ur en tryckning. */
export async function chooseDevice() {
  if (!bleSupported()) throw new Error('Webbläsaren saknar Bluetooth. Använd Chrome på Android.');
  try {
    return await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: BLE_SERVICES });
  } catch (e) {
    if (e.name === 'NotFoundError') throw new Error('Ingen dosa valdes.');
    throw e;
  }
}

/** En dosa som valts tidigare, utan att visa listan (kräver stöd för getDevices). */
export async function knownDevice(id) {
  if (!bleSupported() || !navigator.bluetooth.getDevices || !id) return null;
  try { return (await navigator.bluetooth.getDevices()).find(d => d.id === id) || null; }
  catch { return null; }
}

/**
 * Anslutningen till dosan: ansluter, startar dosan, läser i en slinga och
 * ansluter igen av sig själv om den tappas. onState får
 * 'connecting' | 'testing' | 'connected' | 'lost' | 'off', onSample mätvärdena.
 */
export class ObdLink {
  constructor({ onState = () => {}, onSample = () => {}, onStep = () => {} } = {}) {
    this.onState = onState;
    this.onSample = onSample;
    this.onStep = onStep;
    this.device = null;
    this.session = null;
    this.poller = null;
    this.state = 'off';
    this.wanted = false;
    this.retry = 0;
    this.retryTimer = null;
    this.error = null;
    this.onDisc = () => this.lost(new Error('Anslutningen bröts'));
  }

  setState(s) { this.state = s; this.onState(s, this); }

  async connect(device) {
    if (this.device && this.device !== device) this.device.removeEventListener('gattserverdisconnected', this.onDisc);
    this.device = device;
    this.wanted = true;
    device.addEventListener('gattserverdisconnected', this.onDisc);
    return this.open();
  }

  async open() {
    clearTimeout(this.retryTimer);
    this.setState(this.state === 'lost' ? 'lost' : 'connecting');
    try {
      const tr = await bleTransport(this.device);
      this.session = new ElmSession(tr);
      this.setState('testing');
      const info = await this.session.init(step => this.onStep(step));
      this.retry = 0;
      this.error = null;
      this.setState('connected');
      this.poller = new ObdPoller(this.session, s => this.onSample(s));
      this.poller.loop().catch(e => this.lost(e));
      return info;
    } catch (e) {
      this.error = e.message || String(e);
      this.lost(e);
      throw e;
    }
  }

  lost(e) {
    this.poller?.stop();
    this.poller = null;
    if (e) this.error = e.message || String(e);
    if (!this.wanted) { this.setState('off'); return; }
    this.setState('lost');
    clearTimeout(this.retryTimer);
    const wait = Math.min(30000, 3000 * 2 ** this.retry++);
    this.retryTimer = setTimeout(() => { if (this.wanted) this.open().catch(() => {}); }, wait);
  }

  disconnect() {
    this.wanted = false;
    clearTimeout(this.retryTimer);
    this.poller?.stop();
    this.poller = null;
    try { this.device?.gatt?.connected && this.device.gatt.disconnect(); } catch { /* redan frånkopplad */ }
    this.setState('off');
  }
}
