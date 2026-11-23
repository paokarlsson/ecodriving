// Bromsfri körning – appens vyer och flöden.
import { haversine } from './geo.js';
import { store, maskKey, DEFAULT_SETTINGS, osmCache } from './store.js';
import { getRoute, geocode, testKey, elevations, ApiError } from './api.js';
import { buildRoute, headingAt, xyAt, curveTargets, gradeAt } from './route.js';
import { fetchOsmAlongRoute, assignLimits, buildTargets, countKinds, kindLabel } from './osm.js';
import { DEFAULT_MODEL } from './physics.js';
import { CoastRecorder, analyzeRun, combineRuns, describeModel, CALIB } from './calibration.js';
import { DriveEngine, releaseMessage } from './drive.js';
import { demoData } from './demo.js';
import { estimateTrailerModel, trailerLimits } from './trailer.js';
import { LateralMeter, CurveTracker, learnALat, isStraightAt, routeYaw } from './lateral.js';
import { DriveLog, makeLogStore } from './logbook.js';
import { RawRecorder, readRaw, deleteRaw, persistStorage } from './rawstore.js';
import { CoastLearner, CoastStats, acceptSegment } from './coastlearn.js';

// Körloggar i telefonens lagring
const safeStorage = {
  getItem: k => { try { return localStorage.getItem(k); } catch { return null; } },
  setItem: (k, v) => localStorage.setItem(k, v),
  removeItem: k => { try { localStorage.removeItem(k); } catch { /* blockerad */ } },
};
const logStore = makeLogStore(safeStorage, { onRemove: id => deleteRaw(id) });
import { SimCar, RealCar, seededRandom } from './sim.js';
import { DEMO_ROUTES, compactCoords } from './demoroutes.js';
import { drawOverview, drawDrive, KIND_COLOR } from './mapview.js';
import { unlockAudio, sounds, speak } from './audio.js';
import {
  isIOS, needsMotionPermission, requestMotionPermission, requestLocationOnce, startPosition, locationGranted,
  watchGps, watchMotion, watchCompass, keepAwake,
} from './sensors.js';

const $ = id => document.getElementById(id);
const kmh = v => Math.round(v * 3.6);
function fmtDist(m) {
  if (m == null || !Number.isFinite(m)) return '';
  if (m >= 1000) return (m / 1000).toFixed(m >= 10000 ? 0 : 1).replace('.', ',') + ' km';
  if (m >= 100) return Math.round(m / 10) * 10 + ' m';
  return Math.max(0, Math.round(m / 5) * 5) + ' m';
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- Navigering ----------
const stack = [];
let onboarding = false;

function show(id, { replace = false } = {}) {
  // Tillbaka på hemskärmen = ingen pågående resa att återställa vid omladdning
  if (id === 'home') setTripStage(null);
  document.querySelectorAll('.screen').forEach(s => { s.hidden = s.id !== id; });
  if (replace && stack.length) stack[stack.length - 1] = id;
  else if (stack[stack.length - 1] !== id) stack.push(id);
  window.scrollTo(0, 0);
  const enter = screens[id];
  if (enter) enter();
}
function back() {
  if (stack.length > 1) {
    const leaving = stack.pop();
    if (leaving === 'calib') stopCalibration();
    const id = stack[stack.length - 1];
    if (id === 'home') setTripStage(null);
    document.querySelectorAll('.screen').forEach(s => { s.hidden = s.id !== id; });
    const enter = screens[id];
    if (enter) enter();
  }
}
document.querySelectorAll('[data-back]').forEach(b => b.addEventListener('click', back));

let toastTimer = null;
function toast(msg, isErr = false, ms = 4000) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.toggle('err', isErr);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

function nextOnboardingStep(from) {
  if (!onboarding) { back(); return; }
  const order = ['welcome', 'key', 'perms', 'calib', 'home'];
  const i = order.indexOf(from);
  let next = order[i + 1] || 'home';
  // Nyckeln kom redan med länken: hoppa över nyckelsteget
  if (next === 'key' && store.key) next = 'perms';
  if (next === 'home') {
    onboarding = false;
    store.onboarded = true;
    stack.length = 0;
  }
  show(next);
}

const screens = {
  key: enterKey,
  perms: enterPerms,
  calib: enterCalib,
  home: enterHome,
  settings: enterSettings,
};

// ---------- Välkommen ----------
$('welcome-ok').addEventListener('click', () => {
  store.safetyAck = true;
  unlockAudio();
  if (onboarding) nextOnboardingStep('welcome'); else back();
});

// ---------- API-nyckel ----------
function enterKey() {
  $('key-input').value = store.key || '';
  $('key-status').hidden = true;
  $('key-skip').hidden = !onboarding;
  renderDemoRoutes();
}
function keyStatus(cls, html) {
  const s = $('key-status');
  s.className = 'status ' + cls;
  s.innerHTML = html;
  s.hidden = false;
}
$('key-save').addEventListener('click', async () => {
  const k = $('key-input').value.trim();
  if (!k) { keyStatus('err', 'Klistra in en nyckel först.'); return; }
  $('key-save').disabled = true;
  keyStatus('busy', '<span class="spinner"></span>Testar nyckeln…');
  try {
    await testKey(k);
    store.key = k;
    store.keySkipped = false;
    keyStatus('ok', '✓ Nyckeln fungerar och är sparad.');
    setTimeout(() => nextOnboardingStep('key'), 700);
  } catch (e) {
    keyStatus('err', '✕ ' + esc(e.message || 'Något gick fel'));
  } finally {
    $('key-save').disabled = false;
  }
});
$('key-skip').addEventListener('click', () => {
  store.keySkipped = true;
  nextOnboardingStep('key');
});

// ---------- Behörigheter ----------
function enterPerms() {
  $('perm-motion').closest('.perm-row').hidden = false;
  $('perm-hint').textContent = isIOS
    ? 'På iPhone måste sensorerna tillåtas med knappen ovan.'
    : 'På Android tillåts rörelsesensorer som standard (Webbplatsinställningar → Rörelsesensorer).';
  if (!needsMotionPermission()) markGranted($('perm-motion'), 'Tillåtet');
}
function markGranted(btn, text = 'Tillåtet ✓') {
  btn.textContent = text;
  btn.classList.add('granted');
}
$('perm-loc').addEventListener('click', async () => {
  try {
    await requestLocationOnce();
    markGranted($('perm-loc'));
  } catch (e) {
    toast(e.message + '. Tillåt plats i webbläsarens inställningar.', true);
  }
});
$('perm-motion').addEventListener('click', async () => {
  const r = await requestMotionPermission();
  if (r.motion === 'granted') markGranted($('perm-motion'));
  else toast('Sensorerna nekades. Kalibreringen blir mindre säker, men fungerar med GPS.', true);
});
$('perms-next').addEventListener('click', () => nextOnboardingStep('perms'));

// ---------- Kalibrering ----------
const calib = { runs: [], rec: null, stops: [], result: null, lastObs: null };

function enterCalib() {
  if (calib.rec && calib.rec.state === 'recording') return;
  $('calib-profile').textContent = trailerOn()
    ? 'Släpvagnsläget är på: provet görs med släpet kopplat och sparas för släpet.'
    : 'Provet görs utan släp. Slå på släpvagnsläget först om du ska kalibrera med släp.';
  calib.runs = [];
  calib.result = null;
  renderCalibIdle();
}

function renderCalibIdle() {
  const n = calib.runs.length + 1;
  $('calib-intro').hidden = calib.runs.length > 0;
  $('calib-live').hidden = true;
  $('calib-start').hidden = false;
  $('calib-start').textContent = `Starta prov ${n}`;
  $('calib-cancel').hidden = true;
  $('calib-later').hidden = false;
  $('calib-later').textContent = onboarding ? 'Kalibrera senare' : 'Tillbaka';
  if (!calib.runs.length) { $('calib-result').hidden = true; $('calib-save').hidden = true; }
}

function stopCalibration() {
  calib.stops.forEach(f => f());
  calib.stops = [];
  if (calib.rec && calib.rec.state !== 'done' && calib.rec.state !== 'failed') calib.rec.state = 'failed';
}

function calibState(text, cls = '') {
  const el = $('calib-state');
  el.textContent = text;
  el.className = 'calib-state ' + cls;
}

$('calib-start').addEventListener('click', async () => {
  unlockAudio();
  if (needsMotionPermission()) await requestMotionPermission();
  const n = calib.runs.length + 1;
  $('calib-intro').hidden = true;
  $('calib-result').hidden = true;
  $('calib-save').hidden = true;
  $('calib-live').hidden = false;
  $('calib-run').textContent = `Prov ${n} av 2${trailerOn() ? ' · med släpvagn' : ''}`;
  $('calib-speed').textContent = '–';
  $('calib-start').hidden = true;
  $('calib-later').hidden = true;
  $('calib-cancel').hidden = false;
  calibState('Väntar på GPS…');

  const rec = new CoastRecorder(ev => onCalibEvent(rec, ev));
  calib.rec = rec;
  calib.log = new DriveLog({ kind: 'calibration', run: n, trailer: trailerOn(), settings: { ...store.settings } });
  calib.stops.push(keepAwake());
  calib.stops.push(watchGps(obs => {
    calib.lastObs = obs;
    if (obs.speed != null) $('calib-speed').textContent = kmh(obs.speed);
    rec.addGps({ t: obs.t, v: obs.speed, lat: obs.lat, lon: obs.lon, alt: obs.alt, accuracy: obs.accuracy });
    calib.log?.sample(obs.t, { lat: obs.lat, lon: obs.lon, kmh: obs.speed != null ? obs.speed * 3.6 : null, acc: obs.accuracy, mode: rec.state, alt: obs.alt });
    if (rec.state === 'waiting') {
      if (obs.accuracy > 20) calibState('Svag GPS-signal – vänta…', 'bad');
      else if (obs.speed == null) calibState('GPS ger ingen fart ännu – kör iväg.');
      else if (obs.speed < CALIB.armSpeed) calibState('Kör upp i ca 80 km/h på rak, plan väg.');
      else calibState('Håll farten… provet startar strax.');
    } else if (rec.state === 'recording') {
      calibState('Rulla – rör inte gas eller broms.', 'cue');
    }
  }, err => calibState(err.message, 'bad')));
  calib.stops.push(watchMotion(m => { if (m.ax != null) rec.addMotion(m); }));
});

function calibLogEvent(type, data = {}) {
  if (!calib.log) return;
  calib.log.event(calib.lastObs?.t ?? Date.now() / 1000, type, data);
}

function saveCalibLog(result = {}) {
  if (!calib.log) return;
  calib.log.finish(result);
  logStore.save(calib.log);
}

async function onCalibEvent(rec, ev) {
  calibLogEvent(ev.type, ev.reason ? { reason: ev.reason } : {});
  if (ev.type === 'cue') {
    sounds.release();
    speak('Släpp gasen');
    calibState('Släpp gasen!', 'cue');
    return;
  }
  stopCalibration();
  $('calib-cancel').hidden = true;
  if (ev.type === 'failed') {
    sounds.warn();
    speak('Provet underkänt');
    showCalibResult(`<p class="result-line">Provet underkändes</p><p>${esc(ev.reason)}</p>`);
    saveCalibLog({ ok: false, reason: ev.reason });
    renderCalibIdle();
    $('calib-start').textContent = `Gör om prov ${calib.runs.length + 1}`;
    return;
  }
  // done
  sounds.done();
  speak('Klart');
  calibState('Klart! Räknar…');
  const gps = rec.result().gps;
  let elev = null;
  try { elev = await elevations(gps.map(p => [p.lat, p.lon])); } catch { elev = null; }
  const res = analyzeRun(gps, elev);
  const combinedNow = res.ok ? combineRuns([...calib.runs, res]) : null;
  saveCalibLog({
    ok: res.ok, reason: res.reason ?? null, gradePct: res.grade != null ? res.grade * 100 : null,
    distanceM: res.distance ?? null, points: res.points?.length ?? 0, elevationSource: elev ? 'open-meteo' : 'gps',
    A: combinedNow?.ok ? combinedNow.A : null, C: combinedNow?.ok ? combinedNow.C : null, r2: combinedNow?.ok ? combinedNow.r2 : null,
    runsCombined: combinedNow?.ok ? combinedNow.runs : null,
  });
  if (!res.ok) {
    showCalibResult(`<p class="result-line">Provet underkändes</p><p>${esc(res.reason)}</p>`);
    renderCalibIdle();
    $('calib-start').textContent = `Gör om prov ${calib.runs.length + 1}`;
    return;
  }
  calib.runs.push(res);
  const combined = combineRuns(calib.runs);
  calib.result = combined.ok ? combined : null;
  $('calib-live').hidden = true;
  if (calib.runs.length === 1) {
    showCalibResult(
      `<p class="result-line">Prov 1 godkänt ✓</p>` +
      (combined.ok ? `<p>${esc(describeModel(combined))} (preliminärt).</p>` : '') +
      `<p><strong>Vänd och kör samma sträcka åt andra hållet.</strong></p>`);
    renderCalibIdle();
    $('calib-save').hidden = !combined.ok;
    $('calib-save').textContent = 'Spara med bara ett prov';
  } else if (combined.ok) {
    showCalibResult(
      `<p class="result-line">${esc(describeModel(combined))}</p>` +
      `<p class="hint">A = ${combined.A.toFixed(3)} m/s², C = ${combined.C.toFixed(5)} 1/m, R² = ${combined.r2.toFixed(2)}, ${combined.runs} prov.</p>` +
      combined.warnings.map(w => `<p class="hint">⚠ ${esc(w)}</p>`).join('') +
      `<p>Verkar det rimligt för din bil? Spara, eller gör om provet.</p>`);
    $('calib-start').hidden = false;
    $('calib-start').textContent = 'Börja om';
    calib.runs = [];
    calib.pendingSave = combined;
    $('calib-save').hidden = false;
    $('calib-save').textContent = 'Spara';
    $('calib-later').hidden = false;
  } else {
    showCalibResult(`<p class="result-line">Kunde inte räkna fram bilens värden</p><p>${esc(combined.reason)}</p>`);
    calib.runs = [];
    renderCalibIdle();
  }
}

function showCalibResult(html) {
  const r = $('calib-result');
  r.innerHTML = `<div class="card">${html}</div>`;
  r.hidden = false;
}

$('calib-save').addEventListener('click', () => {
  const c = calib.pendingSave || calib.result;
  if (!c) return;
  const saved = { A: c.A, C: c.C, r2: c.r2, runs: c.runs, date: new Date().toISOString() };
  if (trailerOn()) store.calibrationTrailer = saved; else store.calibration = saved;
  calib.pendingSave = null;
  calib.runs = [];
  toast('Kalibreringen är sparad i telefonen.');
  nextOnboardingStep('calib');
});
$('calib-cancel').addEventListener('click', () => {
  stopCalibration();
  calib.rec = null;
  renderCalibIdle();
});
$('calib-later').addEventListener('click', () => {
  stopCalibration();
  nextOnboardingStep('calib');
});

// ---------- Hem ----------
const trailerOn = () => !!store.settings.trailer;
/** Kalibrering för aktuellt läge (bil eller bil med släp), eller null. */
function activeCalibration() { return trailerOn() ? store.calibrationTrailer : store.calibration; }
/** Modell från rullprovet (eller typvärden / uppskattning för släp). */
function baseModel() {
  if (trailerOn()) return store.calibrationTrailer || estimateTrailerModel(store.calibration || DEFAULT_MODEL);
  return store.calibration || DEFAULT_MODEL;
}
const coastKey = () => (trailerOn() ? 'trailer' : 'car');
function coastStats() { return new CoastStats((store.coastLearn || {})[coastKey()] || {}); }
/** Modellen som används: rullprovet förfinat av inlärda rullningar. */
function model() {
  const base = baseModel();
  if (!store.settings.learnCoast) return base;
  const fit = coastStats().fit(base);
  return fit ? { ...base, A: fit.A, C: fit.C, coastSegments: fit.segments } : base;
}
const isCalibrated = () => !!(trailerOn() ? store.calibrationTrailer : store.calibration);
/** Inställningar som påverkar fartmålen; med släp gäller släpets sidokraft och maxfart. */
function planSettings() {
  const s = store.settings;
  return s.trailer ? { ...s, aLat: s.trailerALat, maxKmh: s.trailerMaxKmh } : s;
}
/** Fartmål ur vägdata för aktuellt läge. Kan räknas om utan ny hämtning. */
function computeTargets(p) {
  const s = planSettings();
  const limits = s.maxKmh ? trailerLimits(p.rawLimits, s.maxKmh) : p.rawLimits;
  const targets = buildTargets(p.route, p.elements, limits, s);
  const curves = curveTargets(p.route, s.aLat, { limits });
  return { ...p, limits, targets, curves, trailer: !!s.trailer };
}

function enterHome() {
  const c = activeCalibration();
  const tr = trailerOn();
  $('home-calib').innerHTML =
    `<button class="chip ${tr ? 'on' : ''}" id="chip-trailer" aria-pressed="${tr}">${tr ? `Med släpvagn · max ${store.settings.trailerMaxKmh} km/h` : 'Utan släpvagn'}</button>` +
    (c
      ? `<button class="chip ok" id="chip-calib">✓ ${tr ? 'Släp kalibrerat' : 'Kalibrerad'} · ${esc(describeModel(model()))}</button>`
      : `<button class="chip todo" id="chip-calib">${tr ? 'Släpet är inte kalibrerat – gör ett rullprov' : 'Inte kalibrerad – gör ett rullprov'}</button>`);
  $('chip-calib').addEventListener('click', () => show('calib'));
  $('chip-trailer').addEventListener('click', () => { setTrailer(!trailerOn()); enterHome(); });
  if (store.key) locationGranted().then(ok => { if (ok) startPosition().catch(() => {}); });
  $('home-nokey').hidden = !!store.key;
  $('search-form').hidden = !store.key;
  renderFavorites();
}

function setTrailer(on) {
  store.settings = { ...store.settings, trailer: on };
  toast(on ? `Släpvagnsläge: max ${store.settings.trailerMaxKmh} km/h och mjukare kurvor.` : 'Släpvagnsläge av.');
}

$('home-addkey').addEventListener('click', () => show('key'));
$('open-settings').addEventListener('click', () => show('settings'));

let lastFocus = null;
$('search-form').addEventListener('submit', async e => {
  e.preventDefault();
  const q = $('search-input').value.trim();
  if (!q) return;
  const ul = $('search-results');
  ul.innerHTML = '<li><span class="pick"><span class="spinner"></span>Söker…</span></li>';
  try {
    if (!lastFocus) { try { lastFocus = await startPosition(); } catch { /* sök utan fokus */ } }
    const res = await geocode(store.key, q, lastFocus);
    ul.innerHTML = '';
    if (!res.length) { ul.innerHTML = '<li><span class="pick">Inga träffar.</span></li>'; return; }
    for (const r of res) {
      const li = document.createElement('li');
      li.innerHTML = `<button class="pick">${esc(r.name)}</button>`;
      li.querySelector('button').addEventListener('click', () => planRoute(r));
      ul.appendChild(li);
    }
  } catch (err) {
    ul.innerHTML = '';
    toast(err.message, true);
  }
});

function renderDemoRoutes() {
  const ul = $('demo-routes');
  ul.innerHTML = '';
  const saved = store.demoRoutes || {};
  for (const d of DEMO_ROUTES) {
    const have = !!saved[d.id] || !!d.bundled;
    const li = document.createElement('li');
    const status = d.bundled ? 'inbyggd' : saved[d.id] ? 'sparad' : (store.key ? 'hämtas första gången' : 'kräver nyckel första gången');
    li.innerHTML = `<button class="pick"><strong>${esc(d.name)}</strong><br><small class="hint">${esc(d.note)} · ${esc(status)}</small></button>`;
    const btn = li.querySelector('button');
    btn.disabled = !have && !store.key;
    btn.addEventListener('click', () => planDemoRoute(d));
    ul.appendChild(li);
  }
}

function renderFavorites() {
  renderRecents();
  const favs = store.favorites;
  $('fav-title').hidden = !favs.length || !store.key;
  const ul = $('favorites');
  ul.innerHTML = '';
  if (!store.key) return;
  favs.forEach((f, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<button class="pick">★ ${esc(f.name)}</button><button class="del" aria-label="Ta bort favorit">×</button>`;
    li.querySelector('.pick').addEventListener('click', () => planRoute(f));
    li.querySelector('.del').addEventListener('click', () => {
      const l = store.favorites; l.splice(i, 1); store.favorites = l; renderFavorites();
    });
    ul.appendChild(li);
  });
}

// ---------- Rutt ----------
let plan = null; // {dest, route, targets, limits, duration, demo, warnings}

async function prepare(coords, elements = null, onStep = () => {}) {
  let route = buildRoute(coords);
  const warnings = [];
  if (!route.hasEle) {
    onStep('Hämtar höjddata…');
    try {
      const pts = [];
      for (let i = 0; i < coords.length; i++) pts.push([coords[i][1], coords[i][0]]);
      const step = Math.max(1, Math.ceil(pts.length / 400));
      const sel = pts.filter((_, i) => i % step === 0);
      const el = await elevations(sel);
      const withEle = coords.map((c, i) => [c[0], c[1], el[Math.min(el.length - 1, Math.round(i / step))]]);
      route = buildRoute(withEle);
    } catch { warnings.push('Höjddata saknas – backar räknas inte in.'); }
  }
  let osmStats = null;
  if (!elements) {
    const t0 = performance.now();
    try {
      elements = await fetchOsmAlongRoute(route, {
        cache: osmCache,
        onProgress: (done, total) => {
          if (total) onStep(`Hämtar trafikljus och hastighetsgränser… ${done}/${total}`);
        },
      });
      osmStats = elements.stats;
      if (osmStats?.failed) {
        warnings.push(`Vägdata saknas för ${osmStats.failed} av ${osmStats.batches} delar av rutten (${osmStats.error}). Där saknas gränser och trafikljus.`);
      }
    } catch (e) {
      elements = [];
      osmStats = e.stats || { error: e.message };
      warnings.push(`Kunde inte hämta trafikljus och hastighetsgränser (${e.message}). Bara kurvor används.`);
    }
    console.info(`Vägdata: ${Math.round(performance.now() - t0)} ms`);
  }
  const rawLimits = assignLimits(route, elements);
  const coverage = rawLimits.coverage ?? 0;
  if (elements.length && coverage < 0.6) {
    warnings.push(coverage === 0
      ? 'Ingen hastighetsgräns hittades i OpenStreetMap längs rutten. Fartmål för gränser saknas, övriga fartmål gäller.'
      : `Hastighetsgräns finns i OpenStreetMap för bara ${Math.round(coverage * 100)} % av rutten; resten räknas med närmaste kända gräns.`);
  }
  return computeTargets({ route, elements, rawLimits, coverage, warnings, osmStats });
}

// ---------- Resmål som överlever omladdning ----------
const TRIP_MAX_AGE = 12 * 3600 * 1000;

function rememberTrip(dest, demo = false) {
  store.lastTrip = { dest: dest ? { name: dest.name, lat: dest.lat, lon: dest.lon } : null, demo, stage: 'overview', at: Date.now() };
  if (dest && !demo) {
    store.recents = [{ name: dest.name, lat: dest.lat, lon: dest.lon }, ...store.recents.filter(r => r.name !== dest.name)];
  }
}

function setTripStage(stage) {
  const t = store.lastTrip;
  if (t && t.stage !== stage) store.lastTrip = { ...t, stage, at: Date.now() };
}

function renderRecents() {
  const favNames = new Set(store.favorites.map(f => f.name));
  const list = store.key ? store.recents.filter(r => !favNames.has(r.name)) : [];
  $('recent-title').hidden = !list.length;
  const ul = $('recents');
  ul.innerHTML = '';
  for (const r of list) {
    const li = document.createElement('li');
    li.innerHTML = `<button class="pick">${esc(r.name)}</button>`;
    li.querySelector('.pick').addEventListener('click', () => planRoute(r));
    ul.appendChild(li);
  }
}

async function planRoute(dest) {
  rememberTrip(dest);
  show('overview');
  $('ov-title').textContent = dest.name;
  const step = text => { $('ov-summary').innerHTML = `<span><span class="spinner"></span>${esc(text)}</span>`; };
  step('Hämtar din position…');
  $('ov-counts').innerHTML = '';
  $('ov-warn').hidden = true;
  $('ov-start').disabled = true;
  $('ov-fav').hidden = true;
  const ctx = $('ov-map').getContext('2d'); ctx.clearRect(0, 0, 9999, 9999);
  try {
    const here = await startPosition();
    step('Hämtar rutt…');
    const r = await getRoute(store.key, here, dest);
    const p = await prepare(r.coords, null, step);
    plan = { dest, ...p, duration: r.duration, demo: false,
      apiRoute: { from: { lat: here.lat, lon: here.lon }, to: { lat: dest.lat, lon: dest.lon }, distance: r.distance, duration: r.duration, coords: r.coords } };
    renderOverview();
  } catch (e) {
    $('ov-summary').textContent = '';
    toast(e.message || 'Kunde inte hämta rutten', true, 6000);
    back();
  }
}

async function planDemo() {
  const d = demoData();
  rememberTrip(null, true);
  show('overview');
  const p = await prepare(d.coords, d.elements);
  plan = { dest: { name: d.name }, ...p, duration: null, demo: true };
  renderOverview();
}
$('demo-btn').addEventListener('click', planDemo);

/** Demorutt på riktig väg: hämtas en gång med nyckeln och sparas. */
async function planDemoRoute(d) {
  store.lastTrip = { dest: null, demo: true, demoId: d.id, stage: 'overview', at: Date.now() };
  show('overview');
  $('ov-title').textContent = d.name;
  const step = text => { $('ov-summary').innerHTML = `<span><span class="spinner"></span>${esc(text)}</span>`; };
  $('ov-counts').innerHTML = '';
  $('ov-warn').hidden = true;
  $('ov-start').disabled = true;
  $('ov-fav').hidden = true;
  try {
    let saved = (store.demoRoutes || {})[d.id];
    if (!saved && d.bundled) {
      // Inbyggd demorutt: rutt (och ev. vägdata) följer med appen
      step('Läser in demorutten…');
      const res = await fetch(d.bundled);
      if (!res.ok) throw new Error('Demorutten gick inte att läsa in.');
      saved = await res.json();
    }
    if (!saved) {
      if (!store.key) throw new Error('Lägg till en nyckel för att hämta demorutten första gången.');
      step('Hämtar rutt…');
      const r = await getRoute(store.key, d.from, d.to);
      saved = { coords: compactCoords(r.coords), distance: r.distance, duration: r.duration, fetched: new Date().toISOString() };
      store.demoRoutes = { ...(store.demoRoutes || {}), [d.id]: saved };
    }
    const p = await prepare(saved.coords, saved.osm || null, step);
    plan = { dest: { name: d.name }, ...p, duration: saved.duration, demo: true, demoReal: true, demoId: d.id };
    renderOverview();
  } catch (e) {
    $('ov-summary').textContent = '';
    toast(e.message || 'Kunde inte hämta demorutten', true, 6000);
    back();
  }
}

function renderOverview() {
  const { route, targets, dest, duration, warnings } = plan;
  $('ov-title').textContent = dest.name;
  const n = targets.filter(t => t.kind !== 'end').length;
  $('ov-summary').innerHTML =
    `<span><b>${fmtDist(route.length)}</b></span>` +
    (duration ? `<span><b>${Math.round(duration / 60)}</b> min</span>` : '') +
    `<span><b>${n}</b> fartmål</span>` +
    (plan.coverage != null && !plan.demo ? `<span><b>${Math.round(plan.coverage * 100)}</b> % med gräns</span>` : '');
  const c = countKinds(targets);
  const order = ['traffic_signals', 'roundabout', 'curve', 'limit', 'give_way', 'stop'];
  $('ov-counts').innerHTML = order.filter(k => c[k]).map(k =>
    `<li><i style="background:${KIND_COLOR[k]}"></i>${c[k]} ${esc(c[k] > 1 ? PLURAL[k] : kindLabel(k))}${esc(legendExtra(k))}</li>`).join('');
  const w = [...(warnings || [])];
  if (trailerOn()) {
    if (!store.calibrationTrailer) w.push('Släpet är inte kalibrerat – uppskattade värden utifrån bilen används. Gör ett rullprov med släpet för bättre precision.');
  } else if (!store.calibration) w.push('Bilen är inte kalibrerad – typvärden används. Gör ett rullprov för bättre precision.');
  if (plan.demo && !plan.demoReal) w.push('Demoläge: bilen simuleras i fyrdubbel fart. Ingen GPS används.');
  $('ov-warn').innerHTML = w.map(esc).join('<br>');
  $('ov-warn').hidden = !w.length;
  $('ov-start').disabled = false;
  $('ov-trailer').checked = trailerOn();
  $('ov-trailer-text').textContent = `Släpvagn (max ${store.settings.trailerMaxKmh} km/h, mjukare kurvor)`;
  $('ov-fav').hidden = plan.demo || store.favorites.some(f => f.name === dest.name);
  requestAnimationFrame(() => drawOverview($('ov-map'), route, targets));
}
function legendExtra(k) {
  if (k === 'curve' && plan.curves && plan.curves.length) {
    return ` (lägst ${kmh(Math.min(...plan.curves.map(c => c.v)))} km/h)`;
  }
  if (k === 'limit') {
    const known = plan.limits.filter(x => x != null);
    if (known.length) return ` (${Math.min(...known)}–${Math.max(...known)} km/h)`;
  }
  return '';
}

const PLURAL = {
  traffic_signals: 'trafikljus', roundabout: 'rondeller', curve: 'kurvor',
  limit: 'sänkta gränser', give_way: 'väjningsplikter', stop: 'stopplikter',
};

$('ov-trailer').addEventListener('change', e => {
  setTrailer(e.target.checked);
  if (plan) { plan = computeTargets(plan); renderOverview(); }
});

$('ov-fav').addEventListener('click', () => {
  if (!plan || plan.demo) return;
  const f = store.favorites;
  f.push({ name: plan.dest.name, lat: plan.dest.lat, lon: plan.dest.lon });
  store.favorites = f;
  $('ov-fav').hidden = true;
  toast('Sparad som favorit.');
});

// ---------- Körning ----------
const drive = {
  engine: null, stops: [], muted: false, compass: null, sim: null, simTimer: null,
  rerouting: false, lastReroute: 0, coastStart: null, flashUntil: 0, lastObs: null,
};

$('ov-start').addEventListener('click', () => startDrive());

function startDrive() {
  if (!plan) return;
  setTripStage('driving');
  unlockAudio();
  if (needsMotionPermission()) requestMotionPermission();
  const s = store.settings;
  drive.engine = new DriveEngine(plan.route, plan.targets, model(), { marginS: s.marginS });
  drive.coastStart = null;
  drive.rerouting = false;
  drive.meter = new LateralMeter();
  // Telefonen sitter oftast likadant: börja med förra körningens inlärda axel
  const ga = store.gyroAxis;
  if (ga && ga.method === 'interval' && Array.isArray(ga.axis) && !plan.demo) { drive.meter.axis = ga.axis; drive.meter.axisR2 = ga.r2; }
  drive.tracker = new CurveTracker(plan.route, plan.curves, planSettings().aLat);
  drive.curveLog = [];
  drive.askQueue = [];
  drive.coast = new CoastLearner(model());
  drive.coastFound = 0;
  drive.coastUsed = 0;
  drive.lastReleaseT = null;
  drive.accRatios = [];
  drive.accWarned = false;
  drive.log = new DriveLog({
    kind: 'drive',
    dest: plan.dest ? { name: plan.dest.name, lat: plan.dest.lat, lon: plan.dest.lon } : null,
    demo: !!plan.demo, trailer: trailerOn(),
    settings: { ...store.settings },
    model: { ...model(), source: modelSource() },
    route: routeMeta(plan),
  });
  drive.logSavedAt = Date.now();
  drive.raw = plan.demo ? null : new RawRecorder(drive.log.id);
  if (drive.raw) { persistStorage(); recordApi(); }
  hideAsk();
  show('drive');
  renderDrive(drive.engine.view('free', { next: plan.targets[0], distToNext: plan.targets[0]?.s }));
  drive.stops.push(keepAwake());
  $('d-simspeed').hidden = !plan.demo;
  if (plan.demo) {
    drive.meter.defaultSign = 1; // simulerat gyro har redan höger positiv
    if (plan.demoReal) {
      drive.sim = new RealCar(plan.route, plan.targets, plan.limits, plan.curves, model(), { rand: seededRandom() });
    } else {
      drive.sim = new SimCar(plan.route, plan.limits, model());
    }
    const tick = () => {
      if (!drive.sim) return;
      const obs = drive.sim instanceof RealCar ? drive.sim.step(1) : drive.sim.step(1, plan.targets);
      // Simulerat gyro: bilens vridhastighet ur ruttens form
      drive.meter.setSpeed(obs.speed);
      const yaw = drive.sim instanceof RealCar ? drive.sim.yaw(routeYaw) : routeYaw(plan.route, drive.sim.s, obs.speed, 10);
      drive.meter.addYaw(obs.t, yaw, 1);
      sampleCurve(obs.t);
      onDriveObs(obs);
    };
    // Demo på riktig väg går i verklig fart, som en vanlig körning
    drive.simSpeed = drive.simSpeed || (plan.demoReal ? 1 : 4);
    $('d-simspeed').textContent = `${drive.simSpeed}×`;
    drive.simTimer = setInterval(tick, 1000 / drive.simSpeed);
    drive.simTick = tick;
    drive.stops.push(() => clearInterval(drive.simTimer));
  } else {
    drive.stops.push(watchGps(onDriveObs, e => toast(e.message, true)));
    drive.stops.push(watchCompass(h => { drive.compass = h; drive.raw?.addCompass(Date.now() / 1000, h); }));
    drive.stops.push(watchMotion(onDriveMotion));
  }
  $('d-limit').classList.toggle('trailer', trailerOn());
  if (store.settings.voice && !drive.muted) speak(`${trailerOn() ? 'Släpvagnsläge. ' : ''}Kör försiktigt. Bromsen används alltid vid behov.`);
}

/** Ruttens fartmål och kurvor i loggen. */
function routeMeta(p) {
  const r1 = x => Math.round(x);
  return {
    lengthM: r1(p.route.length),
    limitCoverage: p.coverage != null ? Math.round(p.coverage * 100) / 100 : null,
    osm: p.osmStats ? { ...p.osmStats, elements: p.elements ? p.elements.length : null } : null,
    warnings: p.warnings || [],
    targets: p.targets.map(t => ({ s: r1(t.s), kmh: r1(t.v * 3.6), kind: t.kind })),
    curves: (p.curves || []).map(c => ({ s: r1(c.s), sEnd: r1(c.sEnd), kmh: r1(c.v * 3.6), radiusM: r1(c.radius), dir: c.dir })),
  };
}

function modelSource() {
  const base = trailerOn()
    ? (store.calibrationTrailer ? 'rullprov med släp' : 'uppskattad från bilen')
    : (store.calibration ? 'rullprov' : 'typvärden');
  const n = store.settings.learnCoast ? coastStats().segments : 0;
  return n ? `${base} + ${n} rullningar` : base;
}

function saveDriveLog(stats = null) {
  if (!drive.log) return;
  // Resan slutar: en pågående rullning räknas med innan loggen avslutas
  if (stats && drive.coast) {
    const seg = drive.coast.cut('slut');
    if (seg) handleCoastSegment(seg, drive.lastObs?.t ?? Date.now() / 1000);
  }
  const m = drive.meter;
  if (stats && m?.axis && !plan?.demo) store.gyroAxis = { axis: m.axis, r2: m.axisR2, method: 'interval', date: new Date().toISOString() };
  if (stats) drive.log.finish({
    ...stats, curves: (drive.curveLog || []).length,
    gyroAxis: m?.axis ? m.axis.map(x => Math.round(x * 1e5) / 1e5).join(',') : null,
    gyroAxisR2: m?.axisR2 ?? null, gyroSign: m?.sign ?? null,
    coastFound: drive.coastFound ?? 0, coastUsed: drive.coastUsed ?? 0,
    sim: drive.sim instanceof RealCar ? { ...drive.sim.stats, trueModel: drive.sim.trueModel, offsetKmh: drive.sim.offset * 3.6 } : null,
    modelAfter: (() => { const mm = model(); return { A: mm.A, C: mm.C, source: modelSource() }; })(),
  });
  logStore.save(drive.log);
  drive.logSavedAt = Date.now();
  if (stats && drive.raw) {
    const log = drive.log, raw = drive.raw;
    drive.raw = null;
    log.meta.raw = { ...raw.counts };
    raw.close().then(c => { log.meta.raw = c; logStore.save(log); });
  }
}

/** Svaren från API:erna (rutt och vägdata) till rådatan. */
function recordApi() {
  if (!drive.raw || !plan) return;
  if (plan.apiRoute) drive.raw.addApi('route', plan.apiRoute);
  if (plan.elements) drive.raw.addApi('osm', { stats: plan.osmStats || null, elements: plan.elements });
}

/** En rullning är klar: logga den, och lär av den om den är ren. */
function handleCoastSegment(seg, t) {
  if (seg.dur < 3) return; // inte värt att logga
  drive.coastFound++;
  let verdict = acceptSegment(seg, model(), { calibrated: isCalibrated() });
  // Bara rullningar som börjar vid en släpp-signal räknas: då vet appen att
  // gasen släpptes helt. Att bara lätta lite på gasen ser ut som en "lätt"
  // rullning och skulle annars få modellen att tro att bilen rullar längre.
  const r = drive.lastReleaseT;
  const fromSignal = r != null && seg.startT >= r - 3 && seg.startT <= r + 8;
  if (verdict.ok && !fromSignal) verdict = { ok: false, reason: 'började inte vid en släpp-signal', resid: verdict.resid };
  const meanA = seg.points.length ? seg.points.reduce((a, p) => a + p.a, 0) / seg.points.length : null;
  const learn = verdict.ok && store.settings.learnCoast && !plan.demo;
  drive.log?.event(t, 'coast', {
    s: seg.s, durS: seg.dur, fromKmh: seg.fromV * 3.6, toKmh: seg.toV * 3.6, end: seg.end,
    points: seg.points.length, meanA, resid: verdict.resid ?? null,
    accepted: verdict.ok, reason: verdict.reason ?? null, learned: learn, fromSignal,
  });
  if (!learn) return;
  const st = coastStats();
  st.add(seg.points);
  store.coastLearn = { ...(store.coastLearn || {}), [coastKey()]: st.toJSON() };
  drive.coastUsed++;
  const m = model();
  if (drive.engine) drive.engine.model = m;
  drive.coast.setModel(m);
}

function stopDrive() {
  drive.stops.forEach(f => f());
  drive.stops = [];
  drive.sim = null;
  hideAsk();
}

// ---------- Kurvkraft ----------
/**
 * Lär gyrots axel per GPS-intervall. Svängen sedan förra positionen tas ur
 * GPS-kursen (Doppler, noggrann i fart) eller, utan kurs, ur rutten.
 * Returnerar true första gången axeln blir inlärd.
 */
function learnGyroFromGps(meter, prev, cur, routeTurn = null) {
  if (!meter) return false;
  const had = !!meter.axis;
  const dt = prev ? cur.t - prev.t : Infinity;
  const v = cur.speed ?? 0;
  let turn = null;
  if (prev && dt > 0 && dt < 2.5 && v > 3) {
    if (cur.heading != null && prev.heading != null && (prev.speed ?? 0) > 3) {
      turn = (((cur.heading - prev.heading + 540) % 360) - 180) * Math.PI / 180;
    } else if (routeTurn != null) turn = routeTurn;
  }
  if (turn == null) { meter.resetInterval(); return false; }
  meter.learnInterval(turn);
  meter.setStraight(Math.abs(turn / dt) < 0.5 * Math.PI / 180);
  return !had && !!meter.axis;
}

/** Signerad kursändring längs rutten mellan s0 och s1 (rad, höger positiv). */
function routeTurnBetween(route, s0, s1) {
  const i0 = Math.max(0, Math.round(s0 / route.step)), i1 = Math.min(route.n - 1, Math.round(s1 / route.step));
  let d = 0;
  for (let i = i0 + 1; i <= i1; i++) d += ((route.H[i] - route.H[i - 1] + 540) % 360) - 180;
  return d * Math.PI / 180;
}

function onDriveMotion(m) {
  drive.raw?.addMotion(m);
  if (!drive.meter) return;
  drive.meter.addMotion(m);
  if (drive.coast && m.ax != null) drive.coast.addAccel(m.t, Math.hypot(m.ax, m.ay, m.az));
  sampleCurve(m.t);
}

let gmeterAt = 0;
function sampleCurve(t) {
  if (!drive.meter) return;
  if (drive.tracker && drive.tracker.inside()) {
    const c = drive.meter.current();
    drive.tracker.sample(t, c.a, drive.meter.v, c.yaw, c.accG);
  }
  const now = performance.now();
  if (now - gmeterAt > 150) { gmeterAt = now; renderGMeter(); }
}

/**
 * Sidokraftsbollen: i mitten rakt fram, åt höger i vänstersväng och tvärtom
 * (dit kraften trycker föraren). Det gröna bandet är planerad sidokraft.
 */
function renderGMeter() {
  const el = $('d-gmeter');
  if (!drive.meter) return;
  const tr = drive.tracker;
  const inCurve = tr && tr.inside();
  const planned = inCurve
    ? (tr.active.curve.v ** 2) / tr.active.curve.radius / 9.81
    : planSettings().aLat / 9.81;
  const { g, side } = drive.meter.current();
  // Skalan går till 200 % av planerat åt varje håll: grönt ≤ 100 %, gult ≤ 150 %, rött därefter
  const range = planned * 2;
  const pos = 50 + Math.max(-1, Math.min(1, side / range)) * 47;
  $('d-gball').style.left = `${pos}%`;
  const zone = g <= planned ? 'green' : g <= planned * 1.5 ? 'yellow' : 'red';
  const big = $('d-gnow');
  big.textContent = fmtG(g);
  big.className = 'gm-big ' + zone;
  $('d-gplan').textContent = inCurve
    ? `planerat ${fmtG(planned)}`
    : (g < 0.03 ? `rakt fram · komfort ${fmtG(planned)}` : `komfort ${fmtG(planned)}`);
}

const fmtG = g => `${g.toFixed(2).replace('.', ',')} g`;

function trackCurves(view, obs) {
  if (!drive.tracker || view.mode === 'paused') return;
  const s = view.s || 0, v = view.v || 0;
  drive.meter.setSpeed(v);
  drive.meter.setStraight(v < 0.5 || isStraightAt(plan.route, s));
  for (const ev of drive.tracker.update(s, obs.t, v, drive.meter)) {
    if (ev.type === 'exit') {
      const rec = { ...ev.record, answer: null, trailer: trailerOn() };
      drive.curveLog.push(rec);
      drive.log?.event(obs.t, 'curve', {
        s: rec.s, dir: rec.dir, radiusM: rec.radius, radiusMeasM: rec.radiusMeas, accPeakG: rec.accPeakG,
        plannedKmh: rec.plannedV * 3.6, maxKmh: rec.maxV * 3.6, plannedG: rec.plannedG, peakG: rec.peakG,
        gyroTurnDeg: rec.gyroTurn, routeTurnDeg: rec.routeTurn, valid: rec.valid, reason: rec.reason, ask: rec.ask,
      });
      if (rec.ask && store.settings.askCurvesInDrive) drive.askQueue.push(rec);
      checkGyroAgainstAccel(rec);
    }
  }
  renderGMeter();
  maybeAsk(view);
}

/**
 * Kontroll: i tydliga kurvor ska gyrot och accelerometern visa ungefär samma
 * sidokraft. Accelerometern visar normalt något mer (den får med gupp och
 * fartändringar). Skiljer de sig mycket i flera kurvor sitter telefonen
 * troligen löst, eller så är gyrots axel fel inlärd.
 */
function checkGyroAgainstAccel(rec) {
  if (!rec.valid || rec.accPeakG == null || rec.peakG < 0.1 || drive.accWarned) return;
  drive.accRatios = drive.accRatios || [];
  drive.accRatios.push(rec.accPeakG / rec.peakG);
  if (drive.accRatios.length < 5) return;
  const s = drive.accRatios.slice().sort((a, b) => a - b), med = s[Math.floor(s.length / 2)];
  if (med < 0.5 || med > 2.5) {
    drive.accWarned = true;
    drive.log?.event(drive.lastObs?.t ?? Date.now() / 1000, 'sensorMismatch', { accOverGyro: med });
    toast(med > 2.5
      ? 'Gyrot visar mycket mindre än accelerometern i kurvorna. Sitter telefonen fast i hållaren?'
      : 'Accelerometern visar mycket mindre än gyrot. Sitter telefonen fast i hållaren?', true, 7000);
  }
}

let askTimer = null;
/** Frågan visas bara på rak väg, inte nära en kurva eller en släpp-signal. */
function maybeAsk(view) {
  if (!$('d-ask').hidden || !drive.askQueue.length) return;
  const s = view.s || 0;
  if (drive.tracker.inside()) return;
  if ((plan.curves || []).some(c => c.s > s && c.s - s < 150)) return;
  if (view.distToRelease != null && view.distToRelease < 300) return;
  if (Date.now() < drive.flashUntil) return;
  showAsk(drive.askQueue.shift());
}

function showAsk(rec) {
  drive.asking = rec;
  $('d-ask-q').textContent = `Kurvan tog ${fmtG(rec.peakG)}. Var det okej?`;
  $('d-ask-m').textContent = `planerat ${fmtG(rec.plannedG)} · ${kmh(rec.maxV)} km/h i ${kmh(rec.plannedV)}-kurva`;
  $('d-ask').hidden = false;
  const bar = $('d-ask-timer');
  bar.style.transition = 'none';
  bar.style.width = '100%';
  requestAnimationFrame(() => requestAnimationFrame(() => {
    bar.style.transition = 'width 10s linear';
    bar.style.width = '0%';
  }));
  clearTimeout(askTimer);
  askTimer = setTimeout(hideAsk, 10000);
}

function hideAsk() {
  clearTimeout(askTimer);
  $('d-ask').hidden = true;
  drive.asking = null;
}

$('d-ask-ok').addEventListener('click', () => { if (drive.asking) answerCurve(drive.asking, 'ok'); hideAsk(); });
$('d-ask-no').addEventListener('click', () => { if (drive.asking) answerCurve(drive.asking, 'too_much'); hideAsk(); });

/** Sparar svaret och justerar sidokraften (om inlärning är på). */
function answerCurve(rec, answer) {
  rec.answer = answer;
  const st = store.settings;
  store.curveAnswers = [...store.curveAnswers, {
    date: new Date().toISOString(), answer, peakG: rec.peakG, plannedG: rec.plannedG,
    speed: rec.speedAtPeak, radius: rec.radius, trailer: rec.trailer,
  }];
  const logAnswer = extra => {
    if (!drive.log) return;
    drive.log.event(drive.lastObs?.t ?? Date.now() / 1000, 'answer', { curveS: rec.s, answer, peakG: rec.peakG, plannedG: rec.plannedG, ...extra });
    if (!drive.engine) saveDriveLog(); // efter resan: spara direkt
  };
  if (!st.learnCurves) { logAnswer({ learned: false }); return; }
  const key = rec.trailer ? 'trailerALat' : 'aLat';
  const bounds = rec.trailer ? { min: 0.10 * 9.81, max: 0.30 * 9.81 } : { min: 0.15 * 9.81, max: 0.35 * 9.81 };
  const before = st[key];
  const after = Math.round(learnALat(before, rec, answer, bounds) * 1000) / 1000;
  const counts = store.curveLearn;
  counts[rec.trailer ? 'trailer' : 'car'] = (counts[rec.trailer ? 'trailer' : 'car'] || 0) + 1;
  store.curveLearn = counts;
  logAnswer({ aLatBeforeG: before / 9.81, aLatAfterG: after / 9.81 });
  if (Math.abs(after - before) < 0.001) return;
  store.settings = { ...store.settings, [key]: after };
  toast(`Sidokraft i kurvor: ${fmtG(after / 9.81)} (var ${fmtG(before / 9.81)}).`);
  // Gäller resten av resan om den pågår och avser samma läge
  if (plan && drive.engine && rec.trailer === trailerOn()) applyNewCurveSpeeds();
}

function applyNewCurveSpeeds() {
  const eng = drive.engine;
  plan = computeTargets(plan);
  const passed = (eng.coast ? eng.coast.target.s : eng.s) + 1;
  eng.targets = plan.targets;
  eng.fired = new Set(plan.targets.filter(t => t.s <= passed).map(t => t.id));
  drive.tracker.setCurves(plan.curves, planSettings().aLat);
}

function onDriveObs(obs) {
  if (!drive.engine || drive.rerouting) return;
  const prevObs = drive.lastObs;
  const prevS = drive.engine.s;
  drive.lastObs = obs;
  if (!plan.demo) drive.raw?.addGps(obs);
  const { view, events } = drive.engine.update(obs);
  if (!plan.demo && drive.meter) {
    const onRoute = !view.paused && view.mode !== 'paused';
    const rt = onRoute && prevObs ? routeTurnBetween(plan.route, prevS, drive.engine.s) : null;
    if (learnGyroFromGps(drive.meter, prevObs, obs, rt)) {
      store.gyroAxis = { axis: drive.meter.axis, r2: drive.meter.axisR2, method: 'interval', date: new Date().toISOString() };
      drive.log?.event(obs.t, 'gyroAxis', { axis: drive.meter.axis.map(x => Math.round(x * 1e5) / 1e5).join(','), r2: drive.meter.axisR2 });
    }
  }
  const arrived = events.some(e => e.type === 'arrived');
  if (!arrived) trackCurves(view, obs);
  logDrive(view, obs, events);
  if (drive.coast && !arrived) {
    const seg = drive.coast.addGps({
      t: obs.t, v: obs.speed, s: view.s, acc: obs.accuracy,
      grade: gradeAt(plan.route, view.s || 0),
      // Utan höjddata går backen inte att räkna bort
      ok: view.mode !== 'paused' && !view.paused && plan.route.hasEle,
    });
    if (seg) handleCoastSegment(seg, obs.t);
  }
  for (const ev of events) handleDriveEvent(ev, obs);
  if (drive.engine) renderDrive(view, obs);
}

function logDrive(view, obs, events) {
  const L = drive.log;
  if (!L) return;
  const i = Math.min(plan.route.n - 1, Math.max(0, Math.round((view.s || 0) / plan.route.step)));
  const m = drive.meter ? drive.meter.current() : null;
  L.sample(obs.t, {
    s: view.s, lat: obs.lat, lon: obs.lon, kmh: (obs.speed ?? view.v ?? 0) * 3.6, acc: obs.accuracy,
    mode: view.mode, limit: plan.limits[i], g: m?.g, side: m?.side, rel: view.distToRelease, alt: obs.alt,
  });
  for (const ev of events) {
    const tg = ev.target;
    const at = { s: view.s, kmh: (view.v || 0) * 3.6 };
    if (ev.type === 'release') L.event(obs.t, 'release', { ...at, kind: tg.kind, targetS: tg.s, targetKmh: tg.v * 3.6, late: ev.late, brakeNeeded: ev.brakeNeeded });
    else if (ev.type === 'follow') L.event(obs.t, 'follow', { followed: ev.followed, kind: tg?.kind, targetS: tg?.s, afterS: ev.afterS ?? null });
    else if (ev.type === 'reached') L.event(obs.t, 'reached', { ...at, kind: tg.kind, targetS: tg.s, targetKmh: tg.v * 3.6 });
    else if (ev.type === 'pause') L.event(obs.t, 'pause', { ...at, reason: ev.reason, acc: obs.accuracy });
    else if (ev.type === 'resume' || ev.type === 'offroute') L.event(obs.t, ev.type, at);
  }
  if (Date.now() - drive.logSavedAt > 30000) saveDriveLog();
}

function say(text) {
  if (drive.muted) return;
  if (store.settings.voice) speak(text);
}

function handleDriveEvent(ev, obs) {
  switch (ev.type) {
    case 'release':
      hideAsk(); // signalen går före; frågan finns kvar i sammanfattningen
      if (!drive.muted) { ev.brakeNeeded ? sounds.warn() : sounds.release(); }
      setTimeout(() => say(releaseMessage(ev)), 550);
      drive.flashUntil = Date.now() + 2500;
      drive.coastStart = { id: ev.target.id, dist: ev.target.s - drive.engine.s };
      drive.lastReleaseT = obs.t;
      if (drive.sim) drive.sim.onRelease(ev.target);
      break;
    case 'pause':
      if (!drive.muted) sounds.pause();
      say(ev.reason === 'gps' ? 'Pausad, svag GPS' : 'Pausad');
      break;
    case 'resume':
      if (!drive.muted) sounds.resume();
      break;
    case 'offroute':
      reroute(obs);
      break;
    case 'arrived':
      if (!drive.muted) sounds.done();
      say('Framme');
      drive.log?.event(obs.t, 'arrived', { s: drive.engine.s });
      saveDriveLog(ev.stats);
      stopDrive();
      showSummary(ev.stats);
      drive.engine = null;
      break;
  }
}

async function reroute(obs) {
  if (plan.demo || !store.key || drive.rerouting) return;
  if (Date.now() - drive.lastReroute < 20000) return;
  drive.rerouting = true;
  drive.lastReroute = Date.now();
  setRing('paused', 'Ny rutt', 'beräknas…', 0);
  try {
    const r = await getRoute(store.key, obs, plan.dest);
    const p = await prepare(r.coords);
    const stats = drive.engine.stats;
    plan = { ...plan, ...p, duration: r.duration,
      apiRoute: { from: { lat: obs.lat, lon: obs.lon }, to: { lat: plan.dest.lat, lon: plan.dest.lon }, distance: r.distance, duration: r.duration, coords: r.coords } };
    recordApi();
    drive.engine = new DriveEngine(plan.route, plan.targets, model(), { marginS: store.settings.marginS });
    drive.engine.stats = stats;
    drive.tracker = new CurveTracker(plan.route, plan.curves, planSettings().aLat);
    drive.log?.event(obs.t, 'reroute', { lat: obs.lat, lon: obs.lon, route: routeMeta(plan) });
    if (!drive.muted) sounds.resume();
    say('Ny rutt');
  } catch (e) {
    toast(e.message, true);
  } finally {
    drive.rerouting = false;
  }
}

function setRing(mode, main, sub, progress) {
  const wrap = $('d-ringwrap');
  wrap.dataset.mode = mode;
  $('d-main').textContent = main;
  $('d-sub').textContent = sub;
  const p = Math.max(0, Math.min(1, progress)) * 100;
  $('d-ring').setAttribute('stroke-dasharray', `${p} ${100 - p}`);
  wrap.classList.toggle('flash', mode === 'coasting' && Date.now() < drive.flashUntil);
}

function renderDrive(view, obs = null) {
  $('d-speed').textContent = kmh(view.v || 0);
  $('d-remaining').textContent = view.remaining != null ? fmtDist(view.remaining) + ' kvar' : '';
  let target = '';
  switch (view.mode) {
    case 'free':
      setRing('free', 'Fri väg', view.next && view.distToNext != null ? `${kindLabel(view.next.kind)} om ${fmtDist(view.distToNext)}` : '', 0);
      break;
    case 'approach':
      setRing('approach', fmtDist(view.distToRelease), 'släpp gasen om', 1 - view.distToRelease / 800);
      target = describeTarget(view.target);
      if (view.brakeNeeded) target += ' · nedförsbacke';
      break;
    case 'coasting': {
      const fresh = Date.now() < drive.flashUntil;
      const total = drive.coastStart && drive.coastStart.id === view.target.id ? drive.coastStart.dist : view.distToTarget;
      setRing('coasting', fresh ? 'Släpp nu' : 'Rullar', `${fmtDist(view.distToTarget)} kvar`, 1 - view.distToTarget / Math.max(1, total));
      target = 'Mot ' + describeTarget(view.target, false);
      if (view.brakeNeeded) target += ' · broms kan behövas';
      break;
    }
    case 'paused':
      setRing('paused', 'Pausad', view.paused === 'gps' ? 'svag GPS' : 'utanför rutten', 0);
      break;
    case 'arrived':
      setRing('arrived', 'Framme', '', 1);
      break;
  }
  $('d-target').textContent = target;
  renderSigns(view);
  if (plan) {
    const s = view.s || 0;
    const moving = (view.v || 0) > 3;
    const heading = moving || drive.compass == null ? smoothHeading(plan.route, s) : drive.compass;
    drawDrive($('d-map'), plan.route, plan.targets, s, heading, { limits: plan.limits, curves: plan.curves });
  }
}

/** Hastighetsgräns och rekommenderad kurvfart vid bilens läge. */
function renderSigns(view) {
  if (!plan) return;
  const s = view.s || 0;
  const vk = (view.v || 0) * 3.6;
  const i = Math.min(plan.route.n - 1, Math.max(0, Math.round(s / plan.route.step)));
  const limit = plan.limits[i];
  const lim = $('d-limit');
  lim.hidden = limit == null;
  if (limit != null) lim.textContent = limit;

  // Kurva vi är i, eller nästa inom 300 m
  const cur = (plan.curves || []).find(c => s >= c.s - 300 && s <= c.sEnd + 10);
  const cs = $('d-curve');
  cs.hidden = !cur;
  let rec = limit;
  if (cur) {
    const ck = kmh(cur.v);
    const inside = s >= cur.s;
    cs.querySelector('b').textContent = ck;
    cs.classList.toggle('left', cur.dir === 'left');
    cs.querySelector('small').textContent = inside ? 'i kurvan' : `om ${fmtDist(cur.s - s)}`;
    if (inside) rec = rec == null ? ck : Math.min(rec, ck);
  }
  $('d-speed').parentElement.classList.toggle('over', rec != null && vk > rec + 3);
}

/** Kurs längs rutten över de närmaste ca 50 m – lugnare än enskilda segment. */
function smoothHeading(route, s) {
  const [x0, y0] = xyAt(route, Math.max(0, s - 10));
  const [x1, y1] = xyAt(route, Math.min(route.length, s + 40));
  if (Math.hypot(x1 - x0, y1 - y0) < 1) return headingAt(route, s);
  return (Math.atan2(x1 - x0, y1 - y0) * 180 / Math.PI + 360) % 360;
}

function describeTarget(t, capitalize = true) {
  if (!t) return '';
  const label = kindLabel(t.kind);
  const name = capitalize ? label.charAt(0).toUpperCase() + label.slice(1) : label;
  if (t.kind === 'traffic_signals' || t.kind === 'stop' || t.kind === 'end') return name;
  return `${name} · ${kmh(t.v)} km/h`;
}

// Simuleringens fart i demoläget: 1×, 4×, 8×, 16×
$('d-simspeed').addEventListener('click', () => {
  const speeds = [1, 4, 8, 16];
  drive.simSpeed = speeds[(speeds.indexOf(drive.simSpeed || 1) + 1) % speeds.length];
  $('d-simspeed').textContent = `${drive.simSpeed}×`;
  if (drive.simTimer && drive.simTick) {
    clearInterval(drive.simTimer);
    drive.simTimer = setInterval(drive.simTick, 1000 / drive.simSpeed);
  }
});

$('d-sound').addEventListener('click', () => {
  drive.muted = !drive.muted;
  $('d-sound').textContent = drive.muted ? '🔇' : '🔊';
  if (!drive.muted) unlockAudio();
});
$('d-stop').addEventListener('click', () => {
  const stats = drive.engine ? { ...drive.engine.stats, endT: drive.lastObs?.t ?? null } : null;
  if (stats) { drive.log?.event(drive.lastObs?.t ?? Date.now() / 1000, 'stopped', { s: drive.engine.s }); saveDriveLog(stats); }
  stopDrive();
  drive.engine = null;
  if (stats && (stats.signals > 0 || (drive.curveLog || []).length)) showSummary(stats);
  else back();
});
window.addEventListener('resize', () => {
  if (!$('overview').hidden && plan) drawOverview($('ov-map'), plan.route, plan.targets);
});

// ---------- Sammanfattning ----------
function showSummary(st) {
  const mins = st.endT != null && st.startT != null ? Math.round((st.endT - st.startT) / 60) : null;
  const pct = st.signals ? Math.round(100 * st.followed / st.signals) : 0;
  $('sum-stats').innerHTML = [
    [st.signals, 'släpp-signaler'],
    [`${st.followed}`, `följda (${pct} %)`],
    [fmtDist(st.distance), 'körd sträcka'],
    [mins != null ? `${mins} min` : '–', 'tid'],
    [st.late, 'sena signaler'],
    [st.brakeWarnings, 'backvarningar'],
    [`${drive.coastUsed ?? 0} / ${drive.coastFound ?? 0}`, 'rullningar använda / mätta'],
  ].map(([b, s]) => `<div class="stat"><b>${esc(b)}</b><span>${esc(s)}</span></div>`).join('');
  renderCurveSummary();
  stack.length = 0;
  stack.push('home');
  show('summary');
}
$('sum-copy').addEventListener('click', () => {
  if (drive.log) copyLog(drive.log);
});

function renderCurveSummary() {
  const log = drive.curveLog || [];
  $('sum-curves-title').hidden = !log.length;
  const ul = $('sum-curves');
  ul.innerHTML = '';
  for (const rec of log) {
    const li = document.createElement('li');
    const name = `Kurva vid ${fmtDist(rec.s)}, ${rec.dir === 'left' ? 'vänster' : 'höger'}`;
    const meta = rec.valid
      ? `${fmtG(rec.peakG)} · planerat ${fmtG(rec.plannedG)} · högst ${kmh(rec.maxV)} km/h`
      : `Inte mätt: ${rec.reason}`;
    let right;
    if (rec.answer === 'ok') right = '<span class="curve-chip ok">Okej</span>';
    else if (rec.answer === 'too_much') right = '<span class="curve-chip over">För mycket</span>';
    else if (rec.ask) right = '<span class="curve-answer"><button class="btn small" data-a="ok">Okej</button><button class="btn small danger-fill" data-a="too_much">För mycket</button></span>';
    else right = `<span class="curve-chip">${rec.valid ? 'inom planerat' : '–'}</span>`;
    li.innerHTML = `<span class="curve-name">${esc(name)}</span>${right}<span class="curve-meta">${esc(meta)}</span>`;
    li.querySelectorAll('button[data-a]').forEach(b => b.addEventListener('click', () => {
      answerCurve(rec, b.dataset.a);
      renderCurveSummary();
    }));
    ul.appendChild(li);
  }
}

$('sum-done').addEventListener('click', () => { stack.length = 0; show('home'); });

// ---------- Inställningar ----------
function enterSettings() {
  const k = store.key;
  $('set-key-show').textContent = k ? `Nyckel: ${maskKey(k)}` : 'Ingen nyckel – rutter fungerar inte.';
  $('set-share').hidden = !k;
  $('set-share-link').hidden = true;
  $('set-key-delete').hidden = !k;
  $('set-key-change').textContent = k ? 'Byt' : 'Lägg till';
  const c = store.calibration;
  $('set-calib-show').textContent = c
    ? `Rullprov ${new Date(c.date).toLocaleDateString('sv-SE')} (${c.runs} prov).`
    : 'Inte kalibrerad – typvärden används.';
  renderCoastShow();
  const s = store.settings;
  bindRange('set-margin', 'marginS', v => `${v.toFixed(1).replace('.', ',')} s`, s);
  bindGForce(s, 'set-alat', 'aLat');
  bindRange('set-giveway', 'giveWayKmh', v => `${v} km/h`, s);
  bindRange('set-rb', 'roundaboutKmh', v => `${v} km/h`, s);
  $('set-voice').checked = s.voice;
  $('set-trailer').checked = s.trailer;
  $('set-learn').checked = s.learnCurves;
  $('set-ask').checked = s.askCurvesInDrive;
  renderLearnShow();
  bindRange('set-tmax', 'trailerMaxKmh', v => `${v} km/h`, s);
  bindGForce(s, 'set-talat', 'trailerALat');
  const ct = store.calibrationTrailer;
  $('set-tcalib-show').textContent = ct
    ? `Släpet: ${describeModel(ct)}. Kalibrerat ${new Date(ct.date).toLocaleDateString('sv-SE')}.`
    : 'Släpet är inte kalibrerat – uppskattas från bilens värden.';
}
/** Komfort i kurvor visas i g men sparas som m/s². */
function bindGForce(s, id, key) {
  const input = $(id), out = $(id + '-out');
  const label = g => `${g.toFixed(2).replace('.', ',')} g · ${g < 0.2 ? 'mjukt' : g <= 0.28 ? 'lagom' : 'sportigt'}`;
  const g0 = s[key] / 9.81;
  input.value = g0.toFixed(2);
  out.textContent = label(g0);
  input.oninput = () => {
    const g = Number(input.value);
    out.textContent = label(g);
    store.settings = { ...store.settings, [key]: Math.round(g * 9.81 * 100) / 100 };
  };
}

function bindRange(id, key, fmt, s) {
  const input = $(id), out = $(id + '-out');
  input.value = s[key];
  out.textContent = fmt(Number(s[key]));
  input.oninput = () => {
    const v = Number(input.value);
    out.textContent = fmt(v);
    store.settings = { ...store.settings, [key]: v };
  };
}
$('set-voice').addEventListener('change', e => { store.settings = { ...store.settings, voice: e.target.checked }; });
function renderLearnShow() {
  const s = store.settings, n = store.curveLearn;
  const car = `Utan släp: ${fmtG(s.aLat / 9.81)}${n.car ? ` · inlärd från ${n.car} svar` : ''}`;
  const tr = `Med släp: ${fmtG(s.trailerALat / 9.81)}${n.trailer ? ` · inlärd från ${n.trailer} svar` : ''}`;
  $('set-learn-show').textContent = `${car}. ${tr}.`;
}
$('set-learn').addEventListener('change', e => { store.settings = { ...store.settings, learnCurves: e.target.checked }; });
$('set-ask').addEventListener('change', e => { store.settings = { ...store.settings, askCurvesInDrive: e.target.checked }; });
$('set-learn-reset').addEventListener('click', () => {
  store.settings = { ...store.settings, aLat: DEFAULT_SETTINGS.aLat, trailerALat: DEFAULT_SETTINGS.trailerALat };
  store.curveLearn = { car: 0, trailer: 0 };
  store.curveAnswers = [];
  enterSettings();
  toast('Sidokraften är återställd till 0,25 g (släp 0,18 g).');
});

$('set-logs').addEventListener('click', () => show('logs'));

// ---------- Inspelning utan rutt ----------
const rec = { log: null, raw: null, meter: null, stops: [], dist: 0, last: null, startT: null, courseRate: 0, savedAt: 0, timer: null };

$('rec-btn').addEventListener('click', startRecording);

async function startRecording() {
  unlockAudio();
  if (needsMotionPermission()) await requestMotionPermission();
  persistStorage();
  Object.assign(rec, { dist: 0, last: null, startT: Date.now() / 1000, courseRate: 0, lastGps: null });
  rec.log = new DriveLog({ kind: 'recording', settings: { ...store.settings }, model: { ...model(), source: modelSource() } });
  rec.raw = new RawRecorder(rec.log.id);
  rec.meter = new LateralMeter();
  const ga = store.gyroAxis;
  if (ga && ga.method === 'interval' && Array.isArray(ga.axis)) { rec.meter.axis = ga.axis; rec.meter.axisR2 = ga.r2; }
  rec.savedAt = Date.now();
  rec.stops.push(keepAwake());
  rec.stops.push(watchGps(onRecGps, e => toast(e.message, true)));
  rec.stops.push(watchMotion(onRecMotion));
  rec.stops.push(watchCompass(h => rec.raw?.addCompass(Date.now() / 1000, h)));
  rec.timer = setInterval(renderRecording, 1000);
  rec.stops.push(() => clearInterval(rec.timer));
  show('record');
  renderRecording();
}

function onRecGps(o) {
  rec.raw?.addGps(o);
  const v = o.speed ?? 0;
  rec.meter.setSpeed(v);
  // Sträcka och GPS-kursens ändring (för att lära gyrots axel utan rutt)
  if (rec.last && o.accuracy != null && o.accuracy < 30) {
    const d = haversine(rec.last.lat, rec.last.lon, o.lat, o.lon);
    if (d < 200) rec.dist += d;
  }
  if (learnGyroFromGps(rec.meter, rec.last, o)) {
    store.gyroAxis = { axis: rec.meter.axis, r2: rec.meter.axisR2, method: 'interval', date: new Date().toISOString() };
    rec.log.event(o.t, 'gyroAxis', { axis: rec.meter.axis.map(x => Math.round(x * 1e5) / 1e5).join(','), r2: rec.meter.axisR2 });
  }
  rec.last = o;
  const m = rec.meter.current();
  rec.log.sample(o.t, { s: rec.dist, lat: o.lat, lon: o.lon, kmh: v * 3.6, acc: o.accuracy, mode: 'rec', g: m.g, side: m.side, alt: o.alt });
  if (Date.now() - rec.savedAt > 30000) { logStore.save(rec.log); rec.savedAt = Date.now(); }
}

function onRecMotion(m) {
  rec.raw?.addMotion(m);
  if (!rec.meter) return;
  rec.meter.addMotion(m);
}

function renderRecording() {
  if (!rec.log) return;
  const o = rec.last;
  const secs = Math.round(Date.now() / 1000 - rec.startT);
  const c = rec.raw ? rec.raw.counts : { gps: 0, motion: 0 };
  const hz = secs > 0 ? Math.round(c.motion / secs) : 0;
  const m = rec.meter.current();
  $('rec-speed').textContent = o && o.speed != null ? Math.round(o.speed * 3.6) : '–';
  const mm = String(Math.floor(secs / 60)).padStart(2, '0'), ss = String(secs % 60).padStart(2, '0');
  $('rec-stats').innerHTML = [
    [`${mm}:${ss}`, 'tid'],
    [fmtDist(rec.dist) || '0 m', 'sträcka'],
    [o ? `±${Math.round(o.accuracy)} m` : '–', 'GPS-noggrannhet'],
    [`${c.gps}`, 'GPS-punkter'],
    [`${hz} /s`, 'sensorvärden'],
    [fmtG(m.g), rec.meter.axis ? 'sidokraft' : 'sidokraft (gyrot lär sig)'],
  ].map(([b, t]) => `<div class="stat"><b>${esc(b)}</b><span>${esc(t)}</span></div>`).join('');
}

$('rec-stop').addEventListener('click', async () => {
  if (!rec.log) return;
  rec.stops.forEach(f => f());
  rec.stops = [];
  const log = rec.log, raw = rec.raw, meter = rec.meter;
  rec.log = null; rec.raw = null;
  if (meter?.axis) store.gyroAxis = { axis: meter.axis, r2: meter.axisR2, method: 'interval', date: new Date().toISOString() };
  log.finish({
    distance: rec.dist, durationS: Date.now() / 1000 - rec.startT,
    gyroAxis: meter?.axis ? meter.axis.map(x => Math.round(x * 1e5) / 1e5).join(',') : null,
    gyroAxisR2: meter?.axisR2 ?? null,
  });
  log.meta.raw = await raw.close();
  logStore.save(log);
  toast(`Inspelningen är sparad: ${fmtDist(rec.dist) || '0 m'}, ${log.meta.raw.gps} GPS-punkter, ${log.meta.raw.motion} sensorvärden.`);
  stack.length = 0;
  stack.push('home');
  show('logs');
});

function enterLogs() {
  $('logs-text-card').hidden = true;
  const ul = $('logs-list');
  ul.innerHTML = '';
  const list = logStore.list();
  if (!list.length) { ul.innerHTML = '<li><span class="pick">Inga loggar ännu. De sparas när du kör eller gör ett rullprov.</span></li>'; return; }
  for (const e of list) {
    const li = document.createElement('li');
    const when = new Date(e.startedAt).toLocaleString('sv-SE', { dateStyle: 'short', timeStyle: 'short' });
    const dist = e.kind === 'calibration' ? '' : (e.distanceM ? ` · ${fmtDist(e.distanceM)}` : '');
    li.innerHTML = `<span class="log-title">${esc(e.title)}</span>
      <span class="log-meta">${esc(when)}${esc(dist)} · ${e.samples} mätpunkter · ${e.events} händelser${e.raw ? ` · rådata: ${e.raw.gps} GPS, ${e.raw.motion} sensorvärden${e.raw.api ? `, ${e.raw.api} API-svar` : ''}` : ''}</span>
      <span class="log-btns">
        <button class="btn small primary" data-a="copy">Kopiera för analys</button>
        <button class="btn small" data-a="file">Spara fil</button>
        ${navigator.canShare ? '<button class="btn small" data-a="share">Dela</button>' : ''}
        <button class="btn small ghost danger" data-a="del">Radera</button>
      </span>`;
    li.querySelectorAll('button[data-a]').forEach(b => b.addEventListener('click', async () => {
      const log = logStore.load(e.id);
      if (!log) { toast('Loggen gick inte att läsa.', true); return; }
      const a = b.dataset.a;
      if (a === 'copy') copyLog(log);
      if (a === 'file') downloadLog(log);
      if (a === 'share') shareLog(log);
      if (a === 'del') {
        if (b.dataset.sure) { logStore.remove(e.id); enterLogs(); }
        else { b.dataset.sure = '1'; b.textContent = 'Tryck igen för att radera'; }
      }
    }));
    ul.appendChild(li);
  }
}
screens.logs = enterLogs;

async function copyLog(log) {
  const text = JSON.stringify(log.toJSON());
  try {
    await navigator.clipboard.writeText(text);
    toast(`Kopierat (${Math.round(text.length / 1024)} kB). Klistra in i chatten.`);
  } catch {
    // Reserv: visa texten markerad så att den går att kopiera för hand
    if ($('logs').hidden) show('logs');
    $('logs-text-card').hidden = false;
    const ta = $('logs-text');
    ta.value = text;
    ta.focus();
    ta.select();
  }
}

/** Hela loggen med all rådata (GPS, gyro, accelerometer, kompass, API-svar). */
async function logFile(log) {
  const json = log.toJSON({ full: true });
  try { json.raw = await readRaw(log.id); } catch { json.raw = null; }
  const text = JSON.stringify(json);
  return new File([text], `${log.id}.json`, { type: 'application/json' });
}

async function downloadLog(log, file = null) {
  const f = file || await logFile(log);
  const url = URL.createObjectURL(f);
  const a = document.createElement('a');
  a.href = url; a.download = f.name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function shareLog(log) {
  const f = await logFile(log);
  try {
    if (navigator.canShare && navigator.canShare({ files: [f] })) await navigator.share({ files: [f], title: 'Körlogg' });
    else downloadLog(log, f);
  } catch (e) { if (e.name !== 'AbortError') downloadLog(log, f); }
}

$('set-trailer').addEventListener('change', e => { setTrailer(e.target.checked); });
$('set-tcalib-redo').addEventListener('click', () => {
  if (!trailerOn()) setTrailer(true);
  show('calib');
});
/** Länk till appen med nyckeln som parameter: ?key=… */
function shareLinkWithKey() {
  const url = new URL(location.href);
  url.hash = '';
  url.search = '';
  url.searchParams.set('key', store.key);
  return url.toString();
}
$('set-key-share').addEventListener('click', async () => {
  if (!store.key) return;
  const link = shareLinkWithKey();
  const field = $('set-share-link');
  field.value = link;
  field.hidden = false;
  try {
    if (navigator.share) {
      await navigator.share({ title: 'Bromsfri körning', text: 'Appen som säger när du ska släppa gasen. Öppna länken så följer min nyckel med:', url: link });
      return;
    }
    await navigator.clipboard.writeText(link);
    toast('Länken är kopierad.');
  } catch (e) {
    if (e && e.name === 'AbortError') return;
    field.focus();
    field.select();
    toast('Markera länken och kopiera den.');
  }
});

$('set-key-change').addEventListener('click', () => show('key'));
$('set-key-delete').addEventListener('click', () => {
  if (!confirm('Radera API-nyckeln från telefonen?')) return;
  store.key = null;
  enterSettings();
});
$('set-calib-redo').addEventListener('click', () => show('calib'));

function renderCoastShow() {
  const m = model(), st = coastStats();
  const fmt = x => x.toFixed(3).replace('.', ',');
  const learned = store.settings.learnCoast && st.segments
    ? ` Förfinad av ${st.segments} rullningar (${st.points} mätpunkter).`
    : ' Inga inlärda rullningar ännu.';
  $('set-coast-show').textContent = `${describeModel(m)}. A = ${fmt(m.A)} m/s², C = ${m.C.toFixed(5).replace('.', ',')} 1/m${trailerOn() ? ' (släp)' : ''}.${learned}`;
  $('set-coast').checked = store.settings.learnCoast;
}
$('set-coast').addEventListener('change', e => { store.settings = { ...store.settings, learnCoast: e.target.checked }; renderCoastShow(); });
$('set-coast-reset').addEventListener('click', e => {
  const b = e.currentTarget;
  if (!b.dataset.sure) { b.dataset.sure = '1'; b.textContent = 'Tryck igen för att glömma'; return; }
  delete b.dataset.sure;
  b.textContent = 'Glöm inlärda rullningar';
  const all = { ...(store.coastLearn || {}) };
  delete all[coastKey()];
  store.coastLearn = all;
  renderCoastShow();
  toast('De inlärda rullningarna är borttagna. Rullprovet gäller.');
});
$('set-test-sound').addEventListener('click', () => {
  unlockAudio();
  sounds.release();
  if (store.settings.voice) setTimeout(() => speak('Släpp gasen, rulla mot ljuset'), 550);
});
$('set-safety').addEventListener('click', () => show('welcome'));
$('set-reset').addEventListener('click', () => {
  if (!confirm('Radera nyckel, kalibrering, favoriter och inställningar från telefonen?')) return;
  try { Object.keys(localStorage).filter(k => k.startsWith('bromsfri.')).forEach(k => localStorage.removeItem(k)); } catch { /* blockerad lagring */ }
  store.settings = { ...DEFAULT_SETTINGS };
  location.reload();
});

// ---------- Start ----------
/**
 * Nyckel i länken (?key=… eller #key=…), t.ex. från en vän som delat appen.
 * Den sparas i telefonen och tas sedan bort ur adressfältet, så att den inte
 * ligger kvar i historiken eller syns om man delar skärmen.
 */
function takeKeyFromUrl() {
  let key = null;
  try {
    const url = new URL(location.href);
    const fromQuery = url.searchParams.get('key');
    const hash = new URLSearchParams(url.hash.replace(/^#/, ''));
    const fromHash = hash.get('key');
    key = (fromQuery || fromHash || '').trim() || null;
    if (!key) return;
    url.searchParams.delete('key');
    hash.delete('key');
    const rest = hash.toString();
    history.replaceState(null, '', url.pathname + url.search + (rest ? '#' + rest : ''));
  } catch { return; }
  if (key === store.key) return;
  const had = !!store.key;
  store.key = key;
  store.keySkipped = false;
  // Toasten visas när första vyn är på plats
  setTimeout(() => toast(had ? 'Nyckeln från länken har ersatt den tidigare.' : 'Nyckeln från länken är sparad i telefonen.'), 300);
}
takeKeyFromUrl();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

if (!store.safetyAck || !store.onboarded) {
  onboarding = true;
  show(store.safetyAck ? (store.key || store.keySkipped ? 'perms' : 'key') : 'welcome');
} else {
  // Resa som pågick när sidan laddades om: hämta samma rutt igen
  const trip = store.lastTrip;
  show('home');
  if (trip && trip.stage && Date.now() - trip.at < TRIP_MAX_AGE) {
    const wasDriving = trip.stage === 'driving';
    if (trip.demo && trip.demoId) { const d = DEMO_ROUTES.find(x => x.id === trip.demoId); if (d) planDemoRoute(d); }
    else if (trip.demo) planDemo();
    else if (trip.dest && store.key) planRoute(trip.dest);
    if (wasDriving) toast('Sidan laddades om. Rutten är hämtad igen – tryck Starta för att fortsätta.', false, 7000);
  }
}

// Gör det lättare att felsöka i konsolen.
window.__bromsfri = { store, plan: () => plan, ApiError };
