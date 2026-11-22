// Bromsfri körning – appens vyer och flöden.
import { store, maskKey, DEFAULT_SETTINGS, osmCache } from './store.js';
import { getRoute, geocode, testKey, elevations, ApiError } from './api.js';
import { buildRoute, headingAt, xyAt, curveTargets } from './route.js';
import { fetchOsmAlongRoute, assignLimits, buildTargets, countKinds, kindLabel } from './osm.js';
import { DEFAULT_MODEL } from './physics.js';
import { CoastRecorder, analyzeRun, combineRuns, describeModel, CALIB } from './calibration.js';
import { DriveEngine, releaseMessage } from './drive.js';
import { demoData } from './demo.js';
import { estimateTrailerModel, trailerLimits } from './trailer.js';
import { LateralMeter, CurveTracker, learnALat, isStraightAt, routeYaw } from './lateral.js';
import { SimCar } from './sim.js';
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
  const next = order[i + 1] || 'home';
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
  calib.stops.push(keepAwake());
  calib.stops.push(watchGps(obs => {
    calib.lastObs = obs;
    if (obs.speed != null) $('calib-speed').textContent = kmh(obs.speed);
    rec.addGps({ t: obs.t, v: obs.speed, lat: obs.lat, lon: obs.lon, alt: obs.alt, accuracy: obs.accuracy });
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

async function onCalibEvent(rec, ev) {
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
function model() {
  if (trailerOn()) return store.calibrationTrailer || estimateTrailerModel(store.calibration || DEFAULT_MODEL);
  return store.calibration || DEFAULT_MODEL;
}
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
      ? `<button class="chip ok" id="chip-calib">✓ ${tr ? 'Släp kalibrerat' : 'Kalibrerad'} · ${esc(describeModel(c))}</button>`
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
  if (!elements) {
    const t0 = performance.now();
    try {
      elements = await fetchOsmAlongRoute(route, {
        cache: osmCache,
        onProgress: (done, total) => {
          if (total) onStep(`Hämtar trafikljus och hastighetsgränser… ${done}/${total}`);
        },
      });
    } catch (e) {
      elements = [];
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
  return computeTargets({ route, elements, rawLimits, coverage, warnings });
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
    plan = { dest, ...p, duration: r.duration, demo: false };
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
  if (plan.demo) w.push('Demoläge: bilen simuleras i fyrdubbel fart. Ingen GPS används.');
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
  drive.tracker = new CurveTracker(plan.route, plan.curves, planSettings().aLat);
  drive.curveLog = [];
  drive.askQueue = [];
  hideAsk();
  show('drive');
  renderDrive(drive.engine.view('free', { next: plan.targets[0], distToNext: plan.targets[0]?.s }));
  drive.stops.push(keepAwake());
  if (plan.demo) {
    drive.sim = new SimCar(plan.route, plan.limits, model());
    drive.meter.defaultSign = 1; // simulerat gyro har redan höger positiv
    drive.simTimer = setInterval(() => {
      const obs = drive.sim.step(1, plan.targets);
      // Simulerat gyro: bilens vridhastighet ur ruttens form
      drive.meter.setSpeed(obs.speed);
      drive.meter.addYaw(obs.t, routeYaw(plan.route, drive.sim.s, obs.speed), 1);
      sampleCurve(obs.t);
      onDriveObs(obs);
    }, 250);
    drive.stops.push(() => clearInterval(drive.simTimer));
  } else {
    drive.stops.push(watchGps(onDriveObs, e => toast(e.message, true)));
    drive.stops.push(watchCompass(h => { drive.compass = h; }));
    drive.stops.push(watchMotion(onDriveMotion));
  }
  $('d-limit').classList.toggle('trailer', trailerOn());
  if (store.settings.voice && !drive.muted) speak(`${trailerOn() ? 'Släpvagnsläge. ' : ''}Kör försiktigt. Bromsen används alltid vid behov.`);
}

function stopDrive() {
  drive.stops.forEach(f => f());
  drive.stops = [];
  drive.sim = null;
  hideAsk();
}

// ---------- Kurvkraft ----------
function onDriveMotion(m) {
  if (!drive.meter) return;
  drive.meter.addMotion(m);
  sampleCurve(m.t);
}

let gmeterAt = 0;
function sampleCurve(t) {
  if (!drive.meter) return;
  // Lär gyrots tecken av rutten (vilket håll som är höger på just den här telefonen)
  if (drive.engine && plan) drive.meter.learnSign(routeYaw(plan.route, drive.engine.s, drive.meter.v));
  if (drive.tracker && drive.tracker.inside()) {
    const c = drive.meter.current();
    drive.tracker.sample(t, c.a, drive.meter.v, c.yaw);
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
  const range = Math.max(0.5, planned * 1.4);            // ± fullt utslag i g
  const pos = 50 + Math.max(-1, Math.min(1, side / range)) * 46;
  $('d-gball').style.left = `${pos}%`;
  $('d-gzone').style.width = `${Math.min(100, (planned / range) * 100)}%`;
  $('d-gnow').textContent = fmtG(g);
  $('d-gplan').textContent = inCurve
    ? `planerat ${fmtG(planned)}`
    : (g < 0.03 ? 'rakt fram' : `komfort ${fmtG(planned)}`);
  el.classList.toggle('over', g > planned * 1.15);
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
      if (rec.ask && store.settings.askCurvesInDrive) drive.askQueue.push(rec);
    }
  }
  renderGMeter();
  maybeAsk(view);
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
  if (!st.learnCurves) return;
  const key = rec.trailer ? 'trailerALat' : 'aLat';
  const bounds = rec.trailer ? { min: 0.10 * 9.81, max: 0.30 * 9.81 } : { min: 0.15 * 9.81, max: 0.35 * 9.81 };
  const before = st[key];
  const after = Math.round(learnALat(before, rec, answer, bounds) * 1000) / 1000;
  const counts = store.curveLearn;
  counts[rec.trailer ? 'trailer' : 'car'] = (counts[rec.trailer ? 'trailer' : 'car'] || 0) + 1;
  store.curveLearn = counts;
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
  drive.lastObs = obs;
  const { view, events } = drive.engine.update(obs);
  const arrived = events.some(e => e.type === 'arrived');
  if (!arrived) trackCurves(view, obs);
  for (const ev of events) handleDriveEvent(ev, obs);
  if (drive.engine) renderDrive(view, obs);
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
    plan = { ...plan, ...p, duration: r.duration };
    drive.engine = new DriveEngine(plan.route, plan.targets, model(), { marginS: store.settings.marginS });
    drive.engine.stats = stats;
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

$('d-sound').addEventListener('click', () => {
  drive.muted = !drive.muted;
  $('d-sound').textContent = drive.muted ? '🔇' : '🔊';
  if (!drive.muted) unlockAudio();
});
$('d-stop').addEventListener('click', () => {
  const stats = drive.engine ? { ...drive.engine.stats, endT: drive.lastObs?.t ?? null } : null;
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
  ].map(([b, s]) => `<div class="stat"><b>${esc(b)}</b><span>${esc(s)}</span></div>`).join('');
  renderCurveSummary();
  stack.length = 0;
  stack.push('home');
  show('summary');
}
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
  $('set-key-delete').hidden = !k;
  $('set-key-change').textContent = k ? 'Byt' : 'Lägg till';
  const c = store.calibration;
  $('set-calib-show').textContent = c
    ? `${describeModel(c)}. Kalibrerad ${new Date(c.date).toLocaleDateString('sv-SE')} (${c.runs} prov).`
    : 'Inte kalibrerad – typvärden används.';
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

$('set-trailer').addEventListener('change', e => { setTrailer(e.target.checked); });
$('set-tcalib-redo').addEventListener('click', () => {
  if (!trailerOn()) setTrailer(true);
  show('calib');
});
$('set-key-change').addEventListener('click', () => show('key'));
$('set-key-delete').addEventListener('click', () => {
  if (!confirm('Radera API-nyckeln från telefonen?')) return;
  store.key = null;
  enterSettings();
});
$('set-calib-redo').addEventListener('click', () => show('calib'));
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
    if (trip.demo) planDemo();
    else if (trip.dest && store.key) planRoute(trip.dest);
    if (wasDriving) toast('Sidan laddades om. Rutten är hämtad igen – tryck Starta för att fortsätta.', false, 7000);
  }
}

// Gör det lättare att felsöka i konsolen.
window.__bromsfri = { store, plan: () => plan, ApiError };
