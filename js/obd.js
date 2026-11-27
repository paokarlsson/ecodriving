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
    for (const base of [0x20, 0x40]) {
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
}

/**
 * Läser bilen i en slinga: gaspedal, fart och varvtal varje varv,
 * bränsleuppgifterna var slowEvery:e. onSample får {t, kmh, rpm, pedalRaw,
 * pedal, released, maf, fuelLh, fuelCut, fuelRate, rate}.
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
        this.onSample({
          t: t / 1000, kmh, rpm, pedalRaw, pedal, released: this.pedal.released,
          maf: this.state.maf, fuelLh: this.state.fuelLh, fuelCut,
          fuelRate: fuelRate({ fuelLh: this.state.fuelLh, maf: this.state.maf, fuelCut, fuelType: this.s.info.fuelType }),
          rate,
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
