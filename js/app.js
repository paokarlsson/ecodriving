// Bromsfri körning – appens vyer och flöden.
import { haversine, angleDiff, headingXY } from './geo.js';
import { store, maskKey, DEFAULT_SETTINGS, osmCache, netCache } from './store.js';
import { getRoute, geocode, testKey, elevations, ApiError } from './api.js';
import { buildRoute, headingAt, xyAt, curveTargets, gradeAt, matchToRoute, latLonAt } from './route.js';
import { fetchOsmAlongRoute, fetchOsmNetwork, cellsAround, assignLimits, buildTargets, countKinds, kindLabel } from './osm.js';
import { buildNetwork, buildHorizon, HORIZON } from './horizon.js';
import { PedalModel, recommendGas, gasWithin, gasHint } from './gasadvice.js';
import { DEFAULT_MODEL, decel } from './physics.js';
import { CoastRecorder, analyzeRun, combineRuns, describeModel, CALIB } from './calibration.js';
import { DriveEngine, releaseMessage, travelHeading } from './drive.js';
import { demoData } from './demo.js';
import { LateralMeter, CurveTracker, isStraightAt, routeYaw, curveRadiusText } from './lateral.js';
import { DriveLog, makeLogStore } from './logbook.js';
import { RawRecorder, readRaw, deleteRaw, persistStorage } from './rawstore.js';
import { CoastLearner, CoastStats, acceptSegment } from './coastlearn.js';
import { ObdLink, chooseDevice, knownDevice, bleSupported, engineBraking } from './obd.js';

// Körloggar i telefonens lagring
const safeStorage = {
  getItem: k => { try { return localStorage.getItem(k); } catch { return null; } },
  setItem: (k, v) => localStorage.setItem(k, v),
  removeItem: k => { try { localStorage.removeItem(k); } catch { /* blockerad */ } },
};
const logStore = makeLogStore(safeStorage, { onRemove: id => deleteRaw(id) });
import { SimCar } from './sim.js';
import { drawOverview, drawDrive, KIND_COLOR } from './mapview.js';
import { GRAPH, coastProfile, releaseOnProfile, drawSpeedGraph } from './speedgraph.js';
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
  $('calib-run').textContent = `Prov ${n} av 2`;
  $('calib-speed').textContent = '–';
  $('calib-start').hidden = true;
  $('calib-later').hidden = true;
  $('calib-cancel').hidden = false;
  calibState('Väntar på GPS…');

  const rec = new CoastRecorder(ev => onCalibEvent(rec, ev));
  calib.rec = rec;
  calib.log = new DriveLog({ kind: 'calibration', run: n, settings: { ...store.settings } });
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
  store.calibration = saved;
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
/** Modell från rullprovet (eller typvärden). */
function baseModel() { return store.calibration || DEFAULT_MODEL; }
const coastKey = () => 'car';
function coastStats() { return new CoastStats((store.coastLearn || {})[coastKey()] || {}); }
/** Modellen som används: rullprovet förfinat av inlärda rullningar. */
function model() {
  const base = baseModel();
  if (!store.settings.learnCoast) return base;
  const fit = coastStats().fit(base);
  return fit ? { ...base, A: fit.A, C: fit.C, coastSegments: fit.segments } : base;
}
/** Inställningar som påverkar fartmålen. */
function planSettings() { return store.settings; }
/** Fartmål ur vägdata för aktuellt läge. Kan räknas om utan ny hämtning. */
function computeTargets(p) {
  const s = planSettings();
  const limits = p.rawLimits;
  const targets = buildTargets(p.route, p.elements, limits, s);
  const curves = curveTargets(p.route, s.aLat, { limits });
  return { ...p, limits, targets, curves };
}

// ---------- Installera som app ----------
// Chrome/Edge (Android och dator) ger ett installationsanrop via
// beforeinstallprompt; Safari på iPhone har inget sådant, där visas hur man
// lägger till appen på hemskärmen. Inget visas när appen redan körs installerad.
const isStandalone = () => window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
let installPrompt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installPrompt = e; renderInstall(); });
window.addEventListener('appinstalled', () => {
  installPrompt = null;
  renderInstall();
  toast('Appen är installerad. Öppna den från hemskärmen.');
});

const INSTALL_TEXT = {
  prompt: 'Installera appen på hemskärmen.',
  ios: 'Installera: Dela → Lägg till på hemskärmen.',
};
function installState() {
  if (isStandalone()) return null;
  if (installPrompt) return 'prompt';
  if (isIOS) return 'ios';
  return null;
}
function renderInstall() {
  const st = installState();
  const snoozed = Date.now() - (store.installDismissed || 0) < 14 * 86400 * 1000;
  $('install-card').hidden = !st || snoozed;
  $('set-install').hidden = !st;
  for (const [text, btn] of [['install-text', 'install-btn'], ['set-install-text', 'set-install-btn']]) {
    if (st) $(text).textContent = INSTALL_TEXT[st];
    $(btn).hidden = st !== 'prompt';
  }
}
async function doInstall() {
  const p = installPrompt;
  if (!p) return;
  installPrompt = null;   // ett anrop kan bara visas en gång
  p.prompt();
  try { await p.userChoice; } catch { /* avbrutet */ }
  renderInstall();
}
$('install-btn').addEventListener('click', doInstall);
$('set-install-btn').addEventListener('click', doInstall);
$('install-later').addEventListener('click', () => { store.installDismissed = Date.now(); renderInstall(); });

function enterHome() {
  const c = store.calibration;
  $('home-calib').innerHTML =
    (c
      ? `<button class="chip ok" id="chip-calib">✓ Kalibrerad · ${esc(describeModel(model()))}</button>`
      : `<button class="chip todo" id="chip-calib">Inte kalibrerad – gör ett rullprov</button>`);
  $('chip-calib').addEventListener('click', () => show('calib'));
  if (store.key) locationGranted().then(ok => { if (ok) startPosition().catch(() => {}); });
  $('home-nokey').hidden = !!store.key;
  $('search-form').hidden = !store.key;
  renderFavorites();
  renderInstall();
}

$('home-addkey').addEventListener('click', () => show('key'));
$('open-settings').addEventListener('click', () => show('settings'));

let lastFocus = null;
let searchCtrl = null, searchTimer = null, searchSeq = 0, noAutocomplete = false;

/**
 * Sök: medan man skriver (efter 3 tecken och en kort paus) används
 * autocomplete, som klarar början av ord; Sök-knappen gör en vanlig sökning.
 */
async function runSearch(q, partial) {
  const seq = ++searchSeq;
  searchCtrl?.abort();
  searchCtrl = new AbortController();
  const ul = $('search-results');
  if (!partial || !ul.children.length) ul.innerHTML = '<li><span class="pick"><span class="spinner"></span>Söker…</span></li>';
  try {
    if (!lastFocus) { try { lastFocus = await startPosition(); } catch { /* sök utan fokus */ } }
    const signal = searchCtrl.signal;
    let res;
    try {
      res = await geocode(store.key, q, lastFocus, { partial: partial && !noAutocomplete, signal });
    } catch (e) {
      // Finns inte autocomplete hos tjänsten: sök vanligt även medan man skriver
      if (!(partial && !noAutocomplete && e.code === 'route')) throw e;
      noAutocomplete = true;
      res = await geocode(store.key, q, lastFocus, { signal });
    }
    if (seq !== searchSeq) return;   // en nyare sökning har startat
    renderSearchResults(res);
  } catch (err) {
    if (err.name === 'AbortError' || seq !== searchSeq) return;
    ul.innerHTML = '';
    // Medan man skriver visas bara fel som gäller nyckel och kvot
    if (!partial || err.code === 'key' || err.code === 'quota') toast(err.message, true);
  }
}

function renderSearchResults(res) {
  const ul = $('search-results');
  ul.innerHTML = '';
  if (!res.length) { ul.innerHTML = '<li><span class="pick">Inga träffar i Sverige.</span></li>'; return; }
  for (const r of res) {
    const li = document.createElement('li');
    const meta = [r.kind, r.distance != null ? fmtDist(r.distance) : null].filter(Boolean).join(' · ');
    li.innerHTML = `<button class="pick">${esc(r.name)}${meta ? `<span class="meta">${esc(meta)}</span>` : ''}</button>`;
    li.querySelector('button').addEventListener('click', () => planRoute(r));
    ul.appendChild(li);
  }
}

$('search-form').addEventListener('submit', e => {
  e.preventDefault();
  clearTimeout(searchTimer);
  const q = $('search-input').value.trim();
  if (q) runSearch(q, false);
});

$('search-input').addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = $('search-input').value.trim();
  if (q.length < 3) {
    searchSeq++; searchCtrl?.abort();
    if (!q) $('search-results').innerHTML = '';
    return;
  }
  searchTimer = setTimeout(() => runSearch(q, true), 350);
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

/**
 * Bygger rutt och fartmål. Utan färdiga element hämtas vägdata längs rutten.
 * Med onComplete returneras planen så snart början av rutten har vägdata
 * (plan.partial = true); onComplete(plan) anropas sedan med hela rutten.
 * Utan onComplete väntar funktionen tills allt är hämtat.
 */
async function prepare(coords, elements = null, onStep = () => {}, onComplete = null) {
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
  if (elements) return planFromElements(route, elements, warnings, null);

  const t0 = performance.now();
  return new Promise(resolve => {
    let early = false;
    const done = p => {
      console.info(`Vägdata: ${Math.round(performance.now() - t0)} ms${early ? ' (körbar tidigare)' : ''}`);
      if (early) onComplete(p); else resolve(p);
    };
    fetchOsmAlongRoute(route, {
      cache: osmCache,
      onProgress: (n, total) => {
        if (total && !early) onStep(`Hämtar trafikljus och hastighetsgränser… ${n}/${total}`);
        if (early) onBackgroundProgress(route, n, total);
      },
      onReady: onComplete ? part => {
        early = true;
        console.info(`Vägdata för början: ${Math.round(performance.now() - t0)} ms`);
        resolve(planFromElements(route, part, warnings, part.stats));
      } : null,
    }).then(els => {
      const w = [...warnings];
      const st = els.stats;
      if (st?.failed) {
        w.push(`Vägdata saknas för ${st.failed} av ${st.batches} delar av rutten (${st.error}). Där saknas gränser och trafikljus.`);
      }
      done(planFromElements(route, els, w, st));
    }, e => {
      done(planFromElements(route, [], [...warnings, `Kunde inte hämta trafikljus och hastighetsgränser (${e.message}). Bara kurvor används.`], e.stats || { error: e.message }));
    });
  });
}

function planFromElements(route, elements, warnings, osmStats) {
  const partial = !!osmStats?.partial;
  const rawLimits = assignLimits(route, elements);
  const coverage = rawLimits.coverage ?? 0;
  const w = [...warnings];
  // Med bara början hämtad är täckningen missvisande låg: vänta på resten.
  if (!partial && elements.length && coverage < 0.6) {
    w.push(coverage === 0
      ? 'Ingen hastighetsgräns hittades i OpenStreetMap längs rutten. Fartmål för gränser saknas, övriga fartmål gäller.'
      : `Hastighetsgräns finns i OpenStreetMap för bara ${Math.round(coverage * 100)} % av rutten; resten räknas med närmaste kända gräns.`);
  }
  return computeTargets({ route, elements, rawLimits, coverage, warnings: w, osmStats, partial });
}

/** Status för vägdata som hämtas i bakgrunden, i ruttöversikten och körvyn. */
let bgProgress = null;
function onBackgroundProgress(route, n, total) {
  if (!plan || plan.route !== route || !plan.partial) return;
  bgProgress = { n, total };
  renderBackgroundStatus();
}
function renderBackgroundStatus() {
  const el = $('ov-bg');
  if (!el) return;
  const on = !!(plan && plan.partial && !plan.demo);
  el.hidden = !on;
  if (on) {
    const p = bgProgress && bgProgress.total ? ` ${bgProgress.n}/${bgProgress.total}` : '';
    const slow = plan.osmStats?.readyTimeout;
    el.innerHTML = `<span class="spinner"></span>` + (slow
      ? `Vägdata från OpenStreetMap dröjer${esc(p)}. Du kan starta nu med bara kurvor; trafikljus och gränser läggs till när de kommer.`
      : `Vägdata för resten av rutten hämtas${esc(p)}. Du kan starta nu; trafikljus och gränser längre fram läggs till under körningen.`);
  }
}

/** Hela rutans vägdata har kommit: byt in den i planen och i en pågående körning. */
function applyFullPlan(route, p) {
  if (!plan || plan.route !== route) return;   // ny rutt sedan dess
  plan = { ...plan, ...p };
  bgProgress = null;
  if (drive.engine && drive.engine.route === route) {
    drive.engine.setTargets(plan.targets);
    drive.tracker?.setCurves(plan.curves, planSettings().aLat);
    drive.log?.event(Date.now() / 1000, 'osm-complete', { route: routeMeta(plan) });
  }
  if (!$('overview').hidden) renderOverview();
  else renderBackgroundStatus();
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
    bgProgress = null;
    const p = await prepare(r.coords, null, step, full => applyFullPlan(full.route, full));
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

function renderOverview() {
  const { route, targets, dest, duration, warnings } = plan;
  $('ov-title').textContent = dest.name;
  const n = targets.filter(t => t.kind !== 'end').length;
  $('ov-summary').innerHTML =
    `<span><b>${fmtDist(route.length)}</b></span>` +
    (duration ? `<span><b>${Math.round(duration / 60)}</b> min</span>` : '') +
    `<span><b>${n}</b> fartmål</span>` +
    (plan.coverage != null && !plan.demo && !plan.partial ? `<span><b>${Math.round(plan.coverage * 100)}</b> % med gräns</span>` : '');
  const c = countKinds(targets);
  const order = ['traffic_signals', 'roundabout', 'curve', 'limit', 'give_way', 'stop'];
  $('ov-counts').innerHTML = order.filter(k => c[k]).map(k =>
    `<li><i style="background:${KIND_COLOR[k]}"></i>${c[k]} ${esc(c[k] > 1 ? PLURAL[k] : kindLabel(k))}${esc(legendExtra(k))}</li>`).join('');
  const w = [...(warnings || [])];
  if (!store.calibration) w.push('Bilen är inte kalibrerad – typvärden används. Gör ett rullprov för bättre precision.');
  if (plan.demo) w.push('Demoläge: bilen simuleras i fyrdubbel fart. Ingen GPS används.');
  $('ov-warn').innerHTML = w.map(esc).join('<br>');
  $('ov-warn').hidden = !w.length;
  $('ov-start').disabled = false;
  $('ov-fav').hidden = plan.demo || store.favorites.some(f => f.name === dest.name);
  renderBackgroundStatus();
  requestAnimationFrame(() => drawOverview($('ov-map'), route, targets, plan.curves));
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
  rerouting: false, lastReroute: 0, rerouteTries: 0, trail: [], coastStart: null, flashUntil: 0, lastObs: null,
};

$('ov-start').addEventListener('click', () => startDrive());

function startDrive() {
  if (!plan) return;
  if (!plan.free) setTripStage('driving');
  unlockAudio();
  if (needsMotionPermission()) requestMotionPermission();
  const s = store.settings;
  drive.baseModel = model();
  drive.liveAdj = null;
  drive.engine = new DriveEngine(plan.route, plan.targets, drive.baseModel, { marginS: s.marginS, endless: !!plan.free });
  resetFree();
  drive.pedalModel = new PedalModel(store.pedalModel);
  drive.gasRec = null; drive.gasIn = 0; drive.gasTotal = 0; drive.gasPrev = null; drive.gasLastT = null;
  resetSpeedGraph();
  drive.coastStart = null;
  drive.rerouting = false;
  drive.lastReroute = 0;
  drive.rerouteTries = 0;
  drive.trail = [];
  drive.meter = new LateralMeter();
  // Telefonen sitter oftast likadant: börja med förra körningens inlärda axel
  const ga = store.gyroAxis;
  if (ga && ga.method === 'interval' && Array.isArray(ga.axis) && !plan.demo) { drive.meter.axis = ga.axis; drive.meter.axisR2 = ga.r2; }
  if (!plan.demo) useAccAxis(drive.meter);
  drive.gtrail = [];
  drive.gfieldKey = null;
  drive.tracker = new CurveTracker(plan.route, plan.curves, planSettings().aLat);
  drive.curveLog = [];
  drive.coast = new CoastLearner(model());
  drive.coastFound = 0;
  drive.coastUsed = 0;
  drive.lastReleaseT = null;
  drive.accRatios = [];
  drive.accWarned = false;
  resetDriveObd();
  drive.log = new DriveLog({
    kind: plan.free ? 'free' : 'drive',
    dest: plan.dest ? { name: plan.dest.name, lat: plan.dest.lat, lon: plan.dest.lon } : null,
    demo: !!plan.demo,
    settings: { ...store.settings },
    model: { ...model(), source: modelSource() },
    route: routeMeta(plan),
  });
  drive.logSavedAt = Date.now();
  drive.raw = plan.demo ? null : new RawRecorder(drive.log.id);
  if (drive.raw) { persistStorage(); recordApi(); }
  show('drive');
  renderDrive(drive.engine.view('free', { next: plan.targets[0], distToNext: plan.targets[0]?.s }));
  drive.stops.push(keepAwake());
  $('d-simspeed').hidden = !plan.demo;
  renderObdChip();
  if (!plan.demo) autoConnectObd();
  if (plan.demo) {
    drive.meter.defaultSign = 1; // simulerat gyro har redan höger positiv
    drive.sim = new SimCar(plan.route, plan.limits, model());
    const tick = () => {
      if (!drive.sim) return;
      const obs = drive.sim.step(1, plan.targets);
      // Simulerat gyro: bilens vridhastighet ur ruttens form
      drive.meter.setSpeed(obs.speed);
      drive.meter.addYaw(obs.t, routeYaw(plan.route, drive.sim.s, obs.speed, 10), 1);
      sampleCurve(obs.t);
      onDriveObs(obs);
    };
    drive.simSpeed = drive.simSpeed || 4;
    $('d-simspeed').textContent = `${drive.simSpeed}×`;
    drive.simTimer = setInterval(tick, 1000 / drive.simSpeed);
    drive.simTick = tick;
    drive.stops.push(() => clearInterval(drive.simTimer));
  } else {
    drive.stops.push(watchGps(onDriveObs, e => toast(e.message, true)));
    drive.stops.push(watchCompass(h => { drive.compass = h; drive.raw?.addCompass(Date.now() / 1000, h); }));
    drive.stops.push(watchMotion(onDriveMotion));
  }
  if (store.settings.voice && !drive.muted) speak(`Kör försiktigt. Bromsen används alltid vid behov.`);
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
  const base = store.calibration ? 'rullprov' : 'typvärden';
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
  if (stats && drive.pedalModel && !plan?.demo) store.pedalModel = drive.pedalModel.toJSON();
  if (stats && m?.fwd && !plan?.demo) store.accAxis = { axis: m.fwd, r2: m.fwdR2, date: new Date().toISOString() };
  if (stats) drive.log.finish({
    ...stats, curves: (drive.curveLog || []).length,
    gyroAxis: m?.axis ? m.axis.map(x => Math.round(x * 1e5) / 1e5).join(',') : null,
    gyroAxisR2: m?.axisR2 ?? null, gyroSign: m?.sign ?? null,
    accAxis: m?.fwd ? m.fwd.map(x => Math.round(x * 1e5) / 1e5).join(',') : null, accAxisR2: m?.fwdR2 ?? null,
    coastFound: drive.coastFound ?? 0, coastUsed: drive.coastUsed ?? 0,
    obd: drive.obdUsed ? obdSummary() : null,
    gasWithinPct: drive.gasTotal > 10 ? Math.round(100 * drive.gasIn / drive.gasTotal) : null,
    horizons: plan?.free ? drive.free.builds : undefined,
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
  let verdict = acceptSegment(seg, model());
  // Bara rullningar som börjar vid en släpp-signal räknas: då vet appen att
  // gasen släpptes helt. Att bara lätta lite på gasen ser ut som en "lätt"
  // rullning och skulle annars få modellen att tro att bilen rullar längre.
  const r = drive.lastReleaseT;
  const fromSignal = r != null && seg.startT >= r - 3 && seg.startT <= r + 8;
  // Med gaspedalen från OBD vet appen att gasen var helt släppt hela rullningen
  const pedalOk = pedalReleasedBetween(seg.startT, seg.endT);
  if (verdict.ok && !fromSignal && !pedalOk) verdict = { ok: false, reason: 'började inte vid en släpp-signal', resid: verdict.resid };
  const meanA = seg.points.length ? seg.points.reduce((a, p) => a + p.a, 0) / seg.points.length : null;
  const learn = verdict.ok && store.settings.learnCoast && !plan.demo;
  drive.log?.event(t, 'coast', {
    s: seg.s, durS: seg.dur, fromKmh: seg.fromV * 3.6, toKmh: seg.toV * 3.6, end: seg.end,
    points: seg.points.length, meanA, resid: verdict.resid ?? null,
    accepted: verdict.ok, reason: verdict.reason ?? null, learned: learn, fromSignal, pedalOk,
  });
  if (!learn) return;
  const st = coastStats();
  st.add(seg.points);
  store.coastLearn = { ...(store.coastLearn || {}), [coastKey()]: st.toJSON() };
  drive.coastUsed++;
  const m = model();
  drive.baseModel = m;
  if (drive.engine) drive.engine.model = m;
  drive.coast.setModel(m);
}

function stopDrive() {
  drive.stops.forEach(f => f());
  drive.stops = [];
  drive.sim = null;
}

// ---------- Körning utan rutt ----------
// Vägen framåt räknas fram ur OSM:s vägnät runt bilen (horizon.js) och blir
// en vanlig rutt för körmotorn, så att släpp-signaler, kurvor, gränser och
// rullmodellen fungerar som med rutt. När bilen svänger av, eller närmar sig
// slutet av vägen framåt, räknas en ny fram.
const FREE = {
  netRadius: 1300,    // m: vägnät som ska finnas runt bilen
  keepRadius: 2600,   // m: vägnät längre bort släpps
  retryMs: 30000,     // ms innan celler som inte gick att hämta försöks igen
  rebuildMs: 1500,    // ms mellan omräkningar
  nearEnd: 700,       // m kvar av vägen framåt då den förlängs
  offDist: 20,        // m från vägen framåt (plus GPS-noggrannheten, högst 20 m)
  offAngle: 50,       // grader mellan färdriktning och väg
  trailStep: 10,      // m mellan punkter i spåret på kartan
  trailKeep: 3000,    // m spår
};

function resetFree() {
  drive.free = {
    cells: new Map(), failed: new Map(), loading: false, net: null, roads: [],
    builtAt: 0, builds: 0, dist: 0, trail: [], trailLen: 0, startWall: Date.now() / 1000, lastKey: null,
  };
}

$('free-btn').addEventListener('click', startFreeDrive);

/** Plan utan resmål: en rak bit väg tills vägnätet och färdriktningen är kända. */
function startFreeDrive() {
  plan = { free: true, dest: null, demo: false, warnings: [], elements: [], horizon: null, coverage: null, osmStats: null };
  Object.assign(plan, freeRouteParts(null, drive.lastObs || { lat: 0, lon: 0 }, 0));
  startDrive();
}

/** Rak väg längs kursen när vägen framåt inte är känd. */
function straightCoords(lat, lon, heading, len = 300) {
  const r = heading * Math.PI / 180;
  const dLat = Math.cos(r) * len / 111320;
  const dLon = Math.sin(r) * len / (111320 * Math.max(0.2, Math.cos(lat * Math.PI / 180)));
  return [[lon, lat], [lon + dLon, lat + dLat]];
}

/** Rutt, gränser, mål och kurvor för vägen framåt (h = null: rak väg utan mål). */
function freeRouteParts(h, obs, heading) {
  const route = buildRoute(h ? h.coords : straightCoords(obs.lat, obs.lon, heading ?? 0));
  const els = drive.free?.elements || [];
  const set = planSettings();
  const rawLimits = els.length ? assignLimits(route, els) : new Array(route.n).fill(null);
  const limits = rawLimits;
  let targets = [], curves = [];
  if (h) {
    targets = buildTargets(route, els, limits, { ...set, noEnd: true, minTargetS: 5, skipStart: 0 });
    curves = curveTargets(route, set.aLat, { limits, skipStart: 0 });
    for (const t of targets) [t.lat, t.lon] = latLonAt(route, t.s);
  }
  return { route, rawLimits, limits, targets, curves, horizon: h };
}

/** Vägnätet runt bilen: hämtas i bakgrunden, cellerna sparas i telefonen. */
function ensureNetwork(obs) {
  const f = drive.free;
  if (f.loading || obs.accuracy > 60) return;
  const now = Date.now();
  const want = cellsAround(obs.lat, obs.lon, FREE.netRadius);
  // Närmast först: de första fyra cellerna i ett eget anrop, sedan tolv i taget
  const missing = want.filter(k => !f.cells.has(k) && !(f.failed.get(k) > now - FREE.retryMs))
    .slice(0, f.cells.size ? 12 : 4);
  if (!missing.length) return;
  f.loading = true;
  const engine = drive.engine;
  fetchOsmNetwork(missing, { cache: netCache }).then(res => {
    if (drive.engine !== engine) return;
    for (const k of missing) {
      if (res.failed.includes(k)) f.failed.set(k, Date.now());
      else f.cells.set(k, true);
    }
    const keep = new Set(cellsAround(obs.lat, obs.lon, FREE.keepRadius));
    for (const k of [...f.cells.keys()]) if (!keep.has(k)) f.cells.delete(k);
    const all = new Map((f.elements || []).map(e => [e.type + e.id, e]));
    for (const e of res.elements) all.set(e.type + e.id, e);
    // Släpp element som ligger helt utanför de celler som finns kvar
    const near = e => {
      const p = e.type === 'node' ? e : (e.geometry || [])[0];
      return p && haversine(p.lat, p.lon, obs.lat, obs.lon) < FREE.keepRadius + 1500;
    };
    f.elements = [...all.values()].filter(near);
    f.net = buildNetwork(f.elements, obs.lat, obs.lon);
    f.roads = f.net.ways.map(w => w.g);
    f.builtAt = 0;   // räkna om vägen framåt med det nya vägnätet
    drive.log?.event(drive.lastObs?.t ?? Date.now() / 1000, 'network', {
      cells: f.cells.size, fetched: res.fetched.length, failed: res.failed.length, error: res.error, ways: f.net.ways.length,
    });
    if (res.failed.length && !f.netToast) { f.netToast = true; toast(`Vägdata gick inte att hämta (${res.error}). Försöker igen.`, true); }
  }).catch(e => {
    for (const k of missing) f.failed.set(k, Date.now());
    drive.log?.event(drive.lastObs?.t ?? Date.now() / 1000, 'network', { error: e.message });
  }).finally(() => { f.loading = false; });
}

/**
 * Före varje position: behövs en ny väg framåt? Bilen har lämnat den, är
 * nära slutet, eller vägnätet har kommit. force = körmotorn har sett att
 * bilen är utanför.
 */
function updateFree(obs, prevObs, force = false) {
  const f = drive.free;
  if (!f) return;
  if (prevObs && (obs.accuracy ?? 0) < 30) {
    const d = haversine(prevObs.lat, prevObs.lon, obs.lat, obs.lon);
    if (d < 200) f.dist += d;
  }
  const last = f.trail[f.trail.length - 1];
  const step = last ? haversine(last.lat, last.lon, obs.lat, obs.lon) : Infinity;
  if (step >= FREE.trailStep && (obs.accuracy ?? 0) < 30) {
    f.trail.push({ lat: obs.lat, lon: obs.lon, d: step === Infinity ? 0 : step });
    f.trailLen += step === Infinity ? 0 : step;
    while (f.trail.length > 2 && f.trailLen > FREE.trailKeep) f.trailLen -= f.trail.shift().d || 0;
  }
  ensureNetwork(obs);
  const heading = travelHeading(drive.trail, obs);
  const moving = (obs.speed ?? 0) >= HORIZON.minSpeed;
  let need = force || f.builtAt === 0 || !plan.horizon;
  let urgent = need;
  if (!need) {
    const m = matchToRoute(plan.route, obs.lat, obs.lon, drive.engine.sHint);
    const tol = FREE.offDist + Math.min(20, obs.accuracy ?? 0);
    const off = !m || m.dist > tol || (heading != null && moving && angleDiff(heading, headingAt(plan.route, m.s)) > FREE.offAngle);
    const left = m ? plan.route.length - m.s : 0;
    need = off || left < (plan.horizon.reason === 'length' ? FREE.nearEnd : 15);
    urgent = off;
  }
  if (!need) return;
  if (heading == null || (!moving && plan.horizon)) {
    // Ingen färdriktning än: behåll det som finns, men flytta den raka biten till bilen
    if (!plan.horizon && (f.builtAt === 0 || haversine(plan.route.pts[0].lat, plan.route.pts[0].lon, obs.lat, obs.lon) > 50)) setFreeRoute(null, obs, heading ?? 0);
    return;
  }
  // Avsvängd: räkna om direkt. Förlängning och försök utan känd väg högst var 1,5 s.
  if (!urgent && Date.now() - f.builtAt < FREE.rebuildMs) return;
  const h = f.net ? buildHorizon(f.net, obs.lat, obs.lon, heading) : null;
  setFreeRoute(h, obs, heading);
}

function setFreeRoute(h, obs, heading) {
  const f = drive.free;
  f.builtAt = Date.now();
  f.builds++;
  const parts = freeRouteParts(h, obs, heading);
  plan = { ...plan, ...parts, elements: f.elements || [] };
  if (drive.engine) {
    drive.engine.setRoute(plan.route, plan.targets);
    drive.tracker = new CurveTracker(plan.route, plan.curves, planSettings().aLat);
  }
  // Logga när vägen framåt blir en annan (inte varje förlängning)
  const key = h ? `${h.wayId}|${h.reason}` : 'none';
  if (key !== f.lastKey) {
    f.lastKey = key;
    drive.log?.event(obs.t, 'horizon', {
      lat: obs.lat, lon: obs.lon, heading, found: !!h, name: h?.name ?? null, reason: h?.reason ?? null,
      lengthM: h ? Math.round(h.length) : null, targets: plan.targets.map(t => `${t.kind}@${Math.round(t.s)}:${Math.round(t.v * 3.6)}`).join(' '),
    });
  }
}

/** Raden under ringen utan rutt: vägens namn och gräns, eller vad som saknas. */
function freeRoadText(view) {
  const f = drive.free;
  if (!f.net) return f.loading ? 'Hämtar vägnätet…' : '';
  if (!plan.horizon) return (view.v || 0) < HORIZON.minSpeed ? 'Vägen framåt visas när du kör' : 'Ingen känd väg här';
  const i = Math.min(plan.route.n - 1, Math.max(0, Math.round((view.s || 0) / plan.route.step)));
  const lim = plan.limits[i];
  return [plan.horizon.name, lim != null ? `${lim} km/h` : null].filter(Boolean).join(' · ');
}

// ---------- Rekommenderat gaspådrag ----------
/** Räknar rekommendationen för läget; gasraden ritas av renderGas. */
function updateGasRec(view) {
  if (!plan || !drive.pedalModel) return;
  const s = view.s || 0;
  const i = Math.min(plan.route.n - 1, Math.max(0, Math.round(s / plan.route.step)));
  const cur = (plan.curves || []).find(c => s >= c.s - 10 && s <= c.sEnd);
  const paused = view.mode === 'paused' || view.paused;
  drive.gasRec = paused ? { kind: 'none' } : recommendGas(drive.pedalModel, {
    kmh: (view.v || 0) * 3.6, mode: view.mode, distToRelease: view.distToRelease ?? null,
    limitKmh: plan.limits[i] ?? null, curveKmh: cur ? cur.v * 3.6 : null,
    grade: plan.route.hasEle ? gradeAt(plan.route, s) : 0,
  });
  renderGas();
}

function renderGas() {
  const on = obdActive() && !!drive.engine;
  const rec = drive.gasRec;
  const show = on && rec && rec.kind !== 'none';
  $('d-gas').hidden = !show;
  $('d-gashint').hidden = !show;
  if (!show) return;
  const o = obd.last;
  const p = Math.max(0, Math.min(100, o.pedal ?? 0));
  const ok = gasWithin(rec, p, o.released);
  $('d-gas').classList.toggle('ok', !!ok);
  $('d-gascur').style.width = `${p}%`;
  $('d-gasrec').style.left = `${rec.lo}%`;
  $('d-gasrec').style.width = `${Math.max(0, rec.hi - rec.lo)}%`;
  $('d-gasmark').style.left = `${rec.mid}%`;
  $('d-gastext').textContent = `${Math.round(p)} % · rek. ${Math.round(rec.mid)} %`;
  $('d-gashint').textContent = gasHint(rec, p, o.released) + (rec.learned === false && rec.kind !== 'release' ? ' (typvärde)' : '');
}

/** Varje OBD-värde: lär pedalmodellen och räkna tiden inom rekommendationen. */
function gasObd(s) {
  if (!drive.engine || !drive.pedalModel) return;
  const prev = drive.gasPrev;
  if (s.kmh != null && (!prev || s.t - prev.t >= 1)) {
    if (prev && s.t - prev.t <= 3 && prev.kmh != null && !s.released) {
      const a = (s.kmh - prev.kmh) / 3.6 / (s.t - prev.t);
      const sNow = drive.engine.s || 0;
      const grade = plan?.route?.hasEle ? gradeAt(plan.route, sNow) : 0;
      if (!plan?.demo) drive.pedalModel.learn((s.kmh + prev.kmh) / 2, a, s.pedal, grade);
    }
    drive.gasPrev = { t: s.t, kmh: s.kmh };
  }
  const within = gasWithin(drive.gasRec, s.pedal, s.released);
  const dt = drive.gasLastT != null ? Math.min(2, s.t - drive.gasLastT) : 0;
  drive.gasLastT = s.t;
  if (within != null && dt > 0) {
    drive.gasTotal += dt;
    if (within) drive.gasIn += dt;
  }
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

/**
 * Gas och broms: GPS-fartens ändring sedan förra positionen, som reserv och
 * för att lära telefonens framåtaxel. Sparar axeln och loggar första gången.
 */
function learnAccFromGps(meter, prev, cur, log, learn = true) {
  if (!meter) return;
  const dt = prev ? cur.t - prev.t : Infinity;
  const ok = prev && dt > 0.3 && dt < 2.5 && cur.speed != null && prev.speed != null
    && (cur.accuracy == null || cur.accuracy < 30);
  const dvdt = ok ? (cur.speed - prev.speed) / dt : null;
  // Under ca 7 km/h är GPS-farten för osäker för att lära av
  if (meter.learnLon(dvdt, learn && ok && Math.max(cur.speed, prev.speed) > 2)) {
    store.accAxis = { axis: meter.fwd, r2: meter.fwdR2, date: new Date().toISOString() };
    log?.event(cur.t, 'accAxis', { axis: meter.fwd.map(x => Math.round(x * 1e5) / 1e5).join(','), r2: meter.fwdR2 });
  }
}

/** Telefonen sitter oftast likadant: börja med förra körningens framåtaxel. */
function useAccAxis(meter) {
  const a = store.accAxis;
  if (a && Array.isArray(a.axis) && a.axis.length === 3) { meter.fwd = a.axis; meter.fwdR2 = a.r2; }
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
 * G-plattan: bollen rör sig dit kraften trycker föraren. Åt höger i
 * vänstersväng och tvärtom, uppåt vid broms och nedåt vid gas. Fältet är
 * symmetriskt: total kraft upp till planerad sidokraft är grönt, 150 % gult
 * och 200 % (plattans kant) rött. Det blå stråket visar hur mycket bilen
 * bromsar av sig själv när den rullar med släppt gas, i nuvarande fart och backe.
 */
const GPAD = { R: 88, trail: 12, gMin: 0.02, coastBand: 0.035, still: 2 };

function renderGMeter() {
  if (!drive.meter) return;
  const tr = drive.tracker;
  const inCurve = tr && tr.inside();
  const planned = inCurve
    ? (tr.active.curve.v ** 2) / tr.active.curve.radius / 9.81
    : planSettings().aLat / 9.81;
  const c = drive.meter.current();
  const v = drive.meter.v;
  const lat = c.side, lon = c.lonSrc ? c.lonG : 0;
  const range = planned * 2;
  const clamp = x => Math.max(-1, Math.min(1, x));
  const toX = g => 100 + clamp(g / range) * GPAD.R;
  const toY = g => 100 - clamp(-g / range) * GPAD.R; // broms (negativ) uppåt

  // Rullningens inbromsning (g) i nuvarande fart och backe
  const moving = v > GPAD.still;
  let coastG = null;
  if (moving) {
    const grade = plan?.route?.hasEle ? gradeAt(plan.route, drive.engine?.s || 0) : 0;
    coastG = -decel(v, grade, drive.engine?.model || model()) / 9.81;
  }
  drawGField(coastG == null ? null : coastG / range);

  const tick = $('d-gcoast');
  tick.style.display = coastG == null ? 'none' : '';
  if (coastG != null) { const y = toY(coastG).toFixed(1); tick.setAttribute('y1', y); tick.setAttribute('y2', y); }

  const x = toX(lat), y = toY(lon);
  const ball = $('d-gball');
  ball.setAttribute('cx', x.toFixed(1));
  ball.setAttribute('cy', y.toFixed(1));
  const trail = drive.gtrail || (drive.gtrail = []);
  trail.push([x, y]);
  while (trail.length > GPAD.trail) trail.shift();
  $('d-gtrail').innerHTML = trail.slice(0, -1).map(([px, py], i, a) =>
    `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="${(2 + i * 0.25).toFixed(2)}" fill="#fff" opacity="${((i + 1) / (a.length + 1) * 0.55).toFixed(2)}"/>`).join('');

  const total = Math.hypot(lat, lon);
  const score = total / planned;
  const big = $('d-gnow');
  big.textContent = fmtG(total);
  big.className = 'gm-big ' + (score <= 1 ? 'green' : score <= 1.5 ? 'yellow' : 'red');

  const chip = $('d-gchip');
  const [cls, label] = !moving ? ['', 'Står still']
    : !c.lonSrc ? ['', 'Väntar på GPS']
    : lonState(lon, coastG ?? 0, planned);
  chip.className = 'gm-chip ' + cls;
  chip.textContent = label;

  $('d-glat').textContent = fmtG(Math.abs(lat));
  $('d-glon').textContent = c.lonSrc ? fmtSignedG(lon) : '–';
  $('d-gplan').textContent = inCurve ? `planerat ${fmtG(planned)}` : `komfort ${fmtG(planned)}`;
}

/** Gas, rullning eller broms ur längskraften (g) och rullningens inbromsning (g, negativ). */
function lonState(lon, coastG, planned) {
  if (lon > planned * 1.5) return ['red', 'Hård gas'];
  if (lon > planned) return ['yellow', 'Rask gas'];
  if (lon > Math.max(GPAD.gMin, coastG + GPAD.coastBand)) return ['green', 'Gasar'];
  if (lon > coastG - GPAD.coastBand) return ['blue', 'Rullar'];
  if (lon > -planned) return ['yellow', 'Bromsar'];
  return ['red', 'Hård broms'];
}

const smoothstep = t => { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); };
const GCOL = { green: [47, 179, 109], yellow: [242, 194, 48], red: [229, 72, 77], blue: [47, 128, 216] };

/**
 * Ritar fältets färger. Plattans koordinater är normerade (kanten = 200 %
 * av planerat), så fältet ser likadant ut för alla nivåer; bara rullningens
 * stråk flyttar sig. Ritas om när stråket flyttat sig märkbart eller storleken ändrats.
 */
function drawGField(coastN) {
  const cv = $('d-gfield');
  const n = Math.round(cv.clientWidth * Math.min(2, window.devicePixelRatio || 1));
  if (!n) return;
  const key = `${n}|${coastN == null ? '-' : Math.round(coastN * 200)}`;
  if (drive.gfieldKey === key) return;
  drive.gfieldKey = key;
  cv.width = cv.height = n;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(n, n);
  const d = img.data;
  const { green: Gc, yellow: Y, red: R, blue: B } = GCOL;
  const scale = 100 / GPAD.R; // pixlar utanför R är rött
  const bandW = 0.07;
  for (let py = 0; py < n; py++) {
    const v = -(((py + 0.5) / n) * 2 - 1) * scale; // +1 = 200 % gas … −1 = 200 % broms (normerat)
    for (let px = 0; px < n; px++) {
      const u = (((px + 0.5) / n) * 2 - 1) * scale;
      const sc = 2 * Math.hypot(u, v);
      const t1 = smoothstep((sc - 0.85) / 0.55), t2 = smoothstep((sc - 1.45) / 0.5);
      let r = Gc[0] + (Y[0] - Gc[0]) * t1, g = Gc[1] + (Y[1] - Gc[1]) * t1, b = Gc[2] + (Y[2] - Gc[2]) * t1;
      r += (R[0] - r) * t2; g += (R[1] - g) * t2; b += (R[2] - b) * t2;
      if (coastN != null) {
        const w = 0.9 * Math.exp(-(((v - coastN) / bandW) ** 2)) * (1 - smoothstep(Math.abs(u) * 2 * 0.9));
        r += (B[0] - r) * w; g += (B[1] - g) * w; b += (B[2] - b) * w;
      }
      const k = (py * n + px) * 4;
      d[k] = r; d[k + 1] = g; d[k + 2] = b; d[k + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

const fmtG = g => `${g.toFixed(2).replace('.', ',')} g`;
const fmtSignedG = g => `${g < -0.005 ? '−' : g > 0.005 ? '+' : ''}${Math.abs(g).toFixed(2).replace('.', ',')} g`;

function trackCurves(view, obs) {
  if (!drive.tracker || view.mode === 'paused') return;
  const s = view.s || 0, v = view.v || 0;
  drive.meter.setSpeed(v);
  drive.meter.setStraight(v < 0.5 || isStraightAt(plan.route, s));
  for (const ev of drive.tracker.update(s, obs.t, v, drive.meter)) {
    if (ev.type === 'exit') {
      const rec = { ...ev.record };
      drive.curveLog.push(rec);
      drive.log?.event(obs.t, 'curve', {
        s: rec.s, dir: rec.dir, radiusM: rec.radius, radiusMeasM: rec.radiusMeas, accPeakG: rec.accPeakG,
        plannedKmh: rec.plannedV * 3.6, maxKmh: rec.maxV * 3.6, plannedG: rec.plannedG, peakG: rec.peakG,
        gyroTurnDeg: rec.gyroTurn, routeTurnDeg: rec.routeTurn, valid: rec.valid, reason: rec.reason, ask: rec.ask,
      });
      checkGyroAgainstAccel(rec);
    }
  }
  renderGMeter();
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

function onDriveObs(obs) {
  if (!drive.engine || drive.rerouting) return;
  const prevObs = drive.lastObs;
  const prevS = drive.engine.s;
  drive.lastObs = obs;
  drive.obsWall = Date.now() / 1000;
  if (!plan.demo) drive.raw?.addGps(obs);
  if (plan.free) updateFree(obs, prevObs);
  const { view, events } = drive.engine.update(obs);
  if (plan.free) drive.engine.stats.distance = drive.free.dist;
  recordSpeed(view, obs);
  if (!plan.demo && drive.meter) {
    const onRoute = !view.paused && view.mode !== 'paused';
    const rt = onRoute && prevObs ? routeTurnBetween(plan.route, prevS, drive.engine.s) : null;
    if (learnGyroFromGps(drive.meter, prevObs, obs, rt)) {
      store.gyroAxis = { axis: drive.meter.axis, r2: drive.meter.axisR2, method: 'interval', date: new Date().toISOString() };
      drive.log?.event(obs.t, 'gyroAxis', { axis: drive.meter.axis.map(x => Math.round(x * 1e5) / 1e5).join(','), r2: drive.meter.axisR2 });
    }
  }
  if (drive.meter) learnAccFromGps(drive.meter, prevObs, obs, drive.log, !plan.demo);
  const arrived = events.some(e => e.type === 'arrived');
  if (!arrived) trackCurves(view, obs);
  logDrive(view, obs, events);
  if (drive.coast && !arrived) {
    const seg = drive.coast.addGps({
      t: obs.t, v: obs.speed, s: view.s, acc: obs.accuracy,
      grade: gradeAt(plan.route, view.s || 0),
      // Utan höjddata går backen inte att räkna bort
      ok: view.mode !== 'paused' && !view.paused && plan.route.hasEle,
      gas: obdActive() && obd.last.released === false,
    });
    if (seg) handleCoastSegment(seg, obs.t);
  }
  applyLiveCoast(view);
  for (const ev of events) handleDriveEvent(ev, obs);
  if (drive.engine) {
    // Fortfarande utanför rutten: försök igen om förra försöket misslyckades.
    if (drive.engine.paused === 'offroute' && !plan.free) {
      if (!events.some(e => e.type === 'offroute')) reroute(obs);
    } else drive.rerouteTries = 0;
    renderDrive(view, obs);
  }
  drive.trail.push({ t: obs.t, lat: obs.lat, lon: obs.lon, accuracy: obs.accuracy });
  while (drive.trail.length && obs.t - drive.trail[0].t > 30) drive.trail.shift();
}

/** OBD-värden för en mätpunkt i körloggen (tomt utan aktiv dosa). */
function obdFields() {
  if (!obdActive()) return {};
  const o = obd.last;
  return {
    pedal: o.pedal, rpm: o.rpm, obdKmh: o.kmh, pedalRaw: o.pedalRaw,
    gas: o.released == null ? null : !o.released,
    fuelLh: o.fuelRate, maf: o.maf, fuelCut: o.fuelCut,
  };
}

function logDrive(view, obs, events) {
  const L = drive.log;
  if (!L) return;
  const i = Math.min(plan.route.n - 1, Math.max(0, Math.round((view.s || 0) / plan.route.step)));
  const m = drive.meter ? drive.meter.current() : null;
  L.sample(obs.t, {
    s: view.s, lat: obs.lat, lon: obs.lon, kmh: (obs.speed ?? view.v ?? 0) * 3.6, acc: obs.accuracy,
    mode: view.mode, limit: plan.limits[i], g: m?.g, side: m?.side, lonG: m?.lonG, rel: view.distToRelease, alt: obs.alt,
    coastAdj: drive.liveAdj ? Math.round(drive.liveAdj.dA * 1000) / 1000 : undefined,
    heading: obs.heading,
    ...obdFields(),
    gasRec: obdActive() && drive.gasRec ? (drive.gasRec.kind === 'none' ? null : drive.gasRec.mid) : null,
  });
  for (const ev of events) {
    const tg = ev.target;
    const at = { s: view.s, kmh: (view.v || 0) * 3.6 };
    if (ev.type === 'release') L.event(obs.t, 'release', { ...at, kind: tg.kind, targetS: tg.s, targetKmh: tg.v * 3.6, late: ev.late, brakeNeeded: ev.brakeNeeded });
    else if (ev.type === 'follow') L.event(obs.t, 'follow', { followed: ev.followed, kind: tg?.kind, targetS: tg?.s, afterS: ev.afterS ?? null, byPedal: !!ev.byPedal });
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
      if (!drive.muted) { ev.brakeNeeded ? sounds.warn() : sounds.release(); }
      setTimeout(() => say(releaseMessage(ev)), 550);
      drive.flashUntil = Date.now() + 2500;
      drive.coastStart = { id: ev.target.id, dist: ev.target.s - drive.engine.s };
      drive.lastReleaseT = obs.t;
      if (drive.sim) drive.sim.onRelease(ev.target);
      break;
    case 'pause':
      if (plan?.free && ev.reason === 'offroute') break;
      if (!drive.muted) sounds.pause();
      say(ev.reason === 'gps' ? 'Pausad, svag GPS' : 'Pausad');
      break;
    case 'resume':
      if (!drive.muted) sounds.resume();
      break;
    case 'offroute':
      if (plan?.free) updateFree(obs, null, true);
      else reroute(obs);
      break;
    case 'follow':
      drive.reactions.push({ afterS: ev.afterS ?? null, followed: ev.followed, byPedal: !!ev.byPedal });
      if (ev.byPedal) {
        const late = ev.afterS > 2;
        drive.badge = { text: `${late ? '' : '✓ '}Gas släppt efter ${ev.afterS.toFixed(1).replace('.', ',')} s`, late, until: Date.now() + 6000 };
        renderObdDrive();
      }
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

/** Väntetid (ms) före nästa försök att räkna om rutten: 5, 10, 20, 40, 60 s. */
function rerouteWait(tries) {
  return tries === 0 ? 0 : Math.min(60000, 5000 * 2 ** (tries - 1));
}

async function reroute(obs) {
  if (plan.demo || plan.free || !store.key || drive.rerouting) return;
  if (Date.now() - drive.lastReroute < rerouteWait(drive.rerouteTries)) return;
  drive.rerouting = true;
  drive.lastReroute = Date.now();
  const engine = drive.engine;
  setRing('paused', 'Ny rutt', 'beräknas…', 0);
  try {
    const heading = travelHeading(drive.trail, obs);
    const r = await getRoute(store.key, { lat: obs.lat, lon: obs.lon, heading }, plan.dest);
    if (drive.engine !== engine) return;   // körningen avslutades under tiden
    bgProgress = null;
    const p = await prepare(r.coords, null, () => {}, full => applyFullPlan(full.route, full));
    if (drive.engine !== engine) return;
    const stats = drive.engine.stats;
    plan = { ...plan, ...p, duration: r.duration,
      apiRoute: { from: { lat: obs.lat, lon: obs.lon }, to: { lat: plan.dest.lat, lon: plan.dest.lon }, distance: r.distance, duration: r.duration, coords: r.coords } };
    recordApi();
    drive.engine = new DriveEngine(plan.route, plan.targets, model(), { marginS: store.settings.marginS });
    resetSpeedGraph();
    drive.engine.stats = stats;
    drive.tracker = new CurveTracker(plan.route, plan.curves, planSettings().aLat);
    drive.log?.event(obs.t, 'reroute', { lat: obs.lat, lon: obs.lon, heading, tries: drive.rerouteTries + 1, route: routeMeta(plan) });
    drive.rerouteTries = 0;
    if (!drive.muted) sounds.resume();
    say('Ny rutt');
  } catch (e) {
    if (drive.engine !== engine) return;
    drive.rerouteTries++;
    drive.log?.event(obs.t, 'rerouteFailed', { tries: drive.rerouteTries, error: e.message });
    // Visa felet en gång; därefter försöker appen tyst igen.
    if (drive.rerouteTries === 1) toast(`${e.message}. Försöker igen.`, true);
    setRing('paused', 'Ny rutt', 'försöker igen…', 0);
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
  drive.lastView = view;
  $('d-speed').textContent = kmh(view.v || 0);
  if (plan?.free) {
    const secs = Math.max(0, Math.round(Date.now() / 1000 - drive.free.startWall));
    const mm = String(Math.floor(secs / 60)).padStart(2, '0'), ss = String(secs % 60).padStart(2, '0');
    $('d-remaining').innerHTML = `<span class="rec-dot small" aria-hidden="true"></span>${mm}:${ss} · ${esc(fmtDist(drive.free.dist) || '0 m')}`;
  } else $('d-remaining').textContent = view.remaining != null ? fmtDist(view.remaining) + ' kvar' : '';
  let target = '';
  switch (view.mode) {
    case 'free':
      setRing('free', plan?.free ? 'Utan rutt' : 'Fri väg', view.next && view.distToNext != null ? `${kindLabel(view.next.kind)} om ${fmtDist(view.distToNext)}` : '', 0);
      if (plan?.free) target = freeRoadText(view);
      break;
    case 'approach':
      setRing('approach', 'Släpp om', fmtDist(view.distToRelease), 1 - view.distToRelease / 800);
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
  updateGasRec(view);
  renderObdDrive();
  if (plan) {
    const s = view.s || 0;
    const graph = speedGraphData(view);
    $('d-graph').hidden = !graph;
    $('d-map').hidden = !!graph;
    if (graph) drawSpeedGraph($('d-graph'), graph);
    else {
      const moving = (view.v || 0) > 3;
      const heading = moving || drive.compass == null ? smoothHeading(plan.route, s) : drive.compass;
      const free = plan.free ? { roads: drive.free.roads, trail: drive.free.trail, horizon: !!plan.horizon } : null;
      const hd = plan.free && drive.lastObs ? (travelHeading(drive.trail, drive.lastObs) ?? heading) : heading;
      drawDrive($('d-map'), plan.route, plan.targets, s, hd, { limits: plan.limits, curves: plan.curves, free });
    }
  }
}

/**
 * Under en rullning mot ett mål justeras modellen efter hur bilen faktiskt
 * rullar just nu (vind, väglag, last). Gäller släppsignal, bromsvarning och
 * fartkurva tills rullningen tar slut; den sparade modellen ändras inte här.
 */
function applyLiveCoast(view) {
  if (!drive.engine || !drive.coast) return;
  const base = drive.baseModel || model();
  const live = view.mode === 'coasting' ? drive.coast.live(base) : null;
  const was = drive.liveAdj;
  drive.liveAdj = live;
  drive.engine.model = live ? { ...base, A: base.A + live.dA } : base;
  if (live && !was) drive.log?.event(drive.lastObs?.t, 'liveCoast', { dA: Math.round(live.dA * 1000) / 1000, measured: Math.round(live.meas * 1000) / 1000, predicted: Math.round(live.pred * 1000) / 1000 });
}

// ---------- Fartkurva ----------
function resetSpeedGraph() {
  drive.speedHist = [];
  drive.graph = { key: null, profile: null, release: null };
}

/** Förarens fart längs rutten, för den svarta linjen i grafen. */
function recordSpeed(view, obs) {
  const h = drive.speedHist || (drive.speedHist = []);
  if (view.mode === 'paused' || view.paused || view.s == null) return;
  const v = obs.speed ?? view.v;
  if (v == null || !Number.isFinite(v)) return;
  const last = h[h.length - 1];
  if (last && view.s < last[0] - 30) h.length = 0; // ny rutt eller hopp bakåt
  if (last && Math.abs(view.s - last[0]) < 0.5) last[1] = v;
  else h.push([view.s, v]);
  while (h.length && h[0][0] < view.s - GRAPH.histKeep) h.shift();
}

/**
 * Grafens data när den ska visas: ett mål närmar sig (släpp om … eller
 * rullar), inom GRAPH.maxAhead, och föraren har inte valt kartan.
 */
function speedGraphData(view) {
  if (store.driveGraph === false) return null;
  if (view.mode !== 'approach' && view.mode !== 'coasting') return null;
  const target = view.target;
  const s = view.s || 0, v = view.v || 0;
  if (!target || target.s - s > GRAPH.maxAhead || target.s < s) return null;
  const m = drive.engine?.model || model();
  const gr = drive.graph || (drive.graph = { key: null, profile: null, release: null });
  const key = `${target.id ?? target.s}|${target.v}|${m.A.toFixed(3)}|${m.C}`;
  if (gr.key !== key) {
    const grade = plan.route.hasEle ? x => gradeAt(plan.route, x) : () => 0;
    gr.profile = coastProfile(target, Math.max(0, target.s - GRAPH.maxAhead - GRAPH.behind - 100), grade, m);
    gr.key = key;
  }
  // Släpp-punkten följer farten fram till släppet och ligger sedan still
  const id = target.id ?? target.s;
  if (view.mode === 'approach') {
    const r = releaseOnProfile(gr.profile, v);
    gr.release = { id, s: r };
  } else if (!gr.release || gr.release.id !== id || gr.release.s == null) {
    gr.release = { id, s };
  }
  return { s, v, hist: drive.speedHist || [], target, profile: gr.profile, releaseS: gr.release.s, adjusted: !!drive.liveAdj };
}

/** Ett tryck växlar mellan fartkurva och karta; valet sparas. */
function toggleDriveGraph() {
  store.driveGraph = store.driveGraph === false;
  toast(store.driveGraph ? 'Fartkurvan visas när ett mål närmar sig.' : 'Kartan visas hela tiden. Tryck på kartan för fartkurvan.');
  if (drive.engine && drive.lastView) renderDrive(drive.lastView, drive.lastObs);
}
$('d-graph').addEventListener('click', toggleDriveGraph);
$('d-map').addEventListener('click', toggleDriveGraph);

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
  if (stats && (plan?.free || stats.signals > 0 || (drive.curveLog || []).length)) showSummary(stats);
  else back();
});
window.addEventListener('resize', () => {
  if (!$('overview').hidden && plan) drawOverview($('ov-map'), plan.route, plan.targets, plan.curves);
});

// ---------- Sammanfattning ----------
function showSummary(st) {
  const secs = st.endT != null && st.startT != null ? st.endT - st.startT : null;
  const mins = secs != null ? Math.round(secs / 60) : null;
  const pct = st.signals ? Math.round(100 * st.followed / st.signals) : 0;
  const free = !!plan?.free;
  $('sum-title').textContent = free ? 'Körning utan rutt' : 'Framme';
  const avg = secs > 30 && st.distance > 100 ? `${Math.round(st.distance / secs * 3.6)} km/h` : null;
  const gasPct = drive.gasTotal > 10 ? Math.round(100 * drive.gasIn / drive.gasTotal) : null;
  $('sum-stats').innerHTML = [
    ...(free ? [[fmtDist(st.distance) || '0 m', 'körd sträcka'], [mins != null ? `${mins} min` : '–', 'tid'], ...(avg ? [[avg, 'snittfart']] : [])] : []),
    ...(gasPct != null ? [[`${gasPct} %`, 'av tiden inom rekommenderat gaspådrag']] : []),
    [st.signals, 'släpp-signaler'],
    [`${st.followed}`, `följda (${pct} %)`],
    ...(free ? [] : [[fmtDist(st.distance), 'körd sträcka'], [mins != null ? `${mins} min` : '–', 'tid']]),
    [st.late, 'sena signaler'],
    [st.brakeWarnings, 'backvarningar'],
    [`${drive.coastUsed ?? 0} / ${drive.coastFound ?? 0}`, 'rullningar använda / mätta'],
    ...obdStatRows(),
  ].map(([b, s]) => `<div class="stat"><b>${esc(b)}</b><span>${esc(s)}</span></div>`).join('');
  renderReactionChart();
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
    const radius = curveRadiusText(rec);
    const meta = (radius ? `${radius} · ` : '') + (rec.valid
      ? `${fmtG(rec.peakG)} · planerat ${fmtG(rec.plannedG)} · högst ${kmh(rec.maxV)} km/h`
      : `Inte mätt: ${rec.reason}`);
    const right = rec.ask
      ? '<span class="curve-chip over">över planerat</span>'
      : `<span class="curve-chip">${rec.valid ? 'inom planerat' : '–'}</span>`;
    li.innerHTML = `<span class="curve-name">${esc(name)}</span>${right}<span class="curve-meta">${esc(meta)}</span>`;
    ul.appendChild(li);
  }
}

$('sum-done').addEventListener('click', () => { stack.length = 0; show('home'); });

// ---------- Inställningar ----------
function enterSettings() {
  renderInstall();
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
  renderObdCard();
  const s = store.settings;
  bindRange('set-margin', 'marginS', v => `${v.toFixed(1).replace('.', ',')} s`, s);
  bindGForce(s, 'set-alat', 'aLat');
  bindRange('set-giveway', 'giveWayKmh', v => `${v} km/h`, s);
  bindRange('set-rb', 'roundaboutKmh', v => `${v} km/h`, s);
  $('set-voice').checked = s.voice;
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

$('set-logs').addEventListener('click', () => show('logs'));

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
  $('set-coast-show').textContent = `${describeModel(m)}. A = ${fmt(m.A)} m/s², C = ${m.C.toFixed(5).replace('.', ',')} 1/m.${learned}`;
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

// ---------- OBD-dosa ----------
const obd = { last: null, step: null, lostToast: false };
const obdLink = new ObdLink({ onState: onObdState, onSample: onObdSample, onStep: step => { obd.step = step; renderObdCard(); } });

/** Ger dosan färska värden just nu? */
function obdActive() {
  return obdLink.state === 'connected' && !!obd.last && Date.now() / 1000 - obd.last.t < 3;
}

function resetDriveObd() {
  drive.reactions = [];
  drive.badge = null;
  drive.obdUsed = false;
  drive.pedalHist = [];
  drive.fuelL = 0; drive.fuelKnown = false;
  drive.ebrakeM = 0; drive.fuelCutKnown = false;
  drive.obdPrevT = null;
  drive.obsWall = null;
  obd.lostToast = false;
}

/** Väggklockans tid (s) i GPS-tidens skala; i demon går tiden snabbare. */
function obsTime(wallT) {
  if (!drive.lastObs || drive.obsWall == null) return null;
  return drive.lastObs.t + (wallT - drive.obsWall) * (drive.sim ? drive.simSpeed || 1 : 1);
}

/** Var gasen helt släppt (enligt OBD) hela tiden mellan t0 och t1? */
function pedalReleasedBetween(t0, t1) {
  const h = (drive.pedalHist || []).filter(p => p.t >= t0 && p.t <= t1);
  if (h.length < Math.max(2, (t1 - t0) * 0.5)) return false;
  return h.every(p => p.released);
}

function onObdSample(s) {
  obd.last = s;
  if (!$('settings').hidden) renderObdLive();
  if (!drive.engine) return;
  drive.obdUsed = true;
  drive.raw?.addObd(s);
  gasObd(s);
  // Dosans tid räknas om till GPS-tidens skala (positionernas tidsstämplar)
  const t = obsTime(s.t);
  const dt = drive.obdPrevT != null ? Math.min(2, s.t - drive.obdPrevT) : 0;
  drive.obdPrevT = s.t;
  if (s.fuelRate != null) { drive.fuelL += s.fuelRate * dt / 3600; drive.fuelKnown = true; }
  if (s.fuelCut != null) drive.fuelCutKnown = true;
  if (drive.fuelCutKnown ? s.fuelCut : engineBraking(s)) drive.ebrakeM += (s.kmh || 0) / 3.6 * dt;
  if (t == null) return;
  drive.pedalHist.push({ t, released: s.released });
  while (drive.pedalHist.length && t - drive.pedalHist[0].t > 180) drive.pedalHist.shift();
  if (drive.rerouting) return;
  const events = drive.engine.pedal(t, s.released);
  for (const ev of events) {
    const tg = ev.target;
    drive.log?.event(t, 'follow', { followed: ev.followed, kind: tg?.kind, targetS: tg?.s, afterS: ev.afterS ?? null, byPedal: true });
    handleDriveEvent(ev, drive.lastObs);
  }
  renderObdDrive();
}

function onObdState(state, link) {
  renderObdChip();
  renderObdCard();
  if (!drive.engine) return;
  const t = Date.now() / 1000;
  if (state === 'lost') {
    drive.log?.event(t, 'obd', { state, error: link.error });
    if (!obd.lostToast) toast('OBD-dosan tappade anslutningen. Fortsätter med GPS.', true);
    obd.lostToast = true;
  } else if (state === 'connected') {
    const info = link.session?.info;
    drive.log?.event(t, 'obd', {
      state, protocol: info?.protocol, pedalPid: info?.pedalPid, version: info?.version, fuelType: info?.fuelType,
      pids: info ? [...info.supported].sort((a, b) => a - b).map(p => p.toString(16).padStart(2, '0')).join(',') : null,
    });
    if (obd.lostToast) toast('OBD-dosan är ansluten igen.');
    obd.lostToast = false;
  }
  renderObdDrive();
}

/** Ansluter till den sparade dosan vid körstart, om webbläsaren minns den. */
async function autoConnectObd() {
  const saved = store.obd;
  if (!saved || !saved.auto || obdLink.state !== 'off') return;
  const dev = obdLink.device && obdLink.device.id === saved.id ? obdLink.device : await knownDevice(saved.id);
  if (dev) obdLink.connect(dev).catch(() => {});
}

/** Väljer dosa i Chromes lista (måste ske i en tryckning) och ansluter. */
async function pickAndConnectObd() {
  try {
    const dev = await chooseDevice();
    store.obd = { id: dev.id, name: dev.name || 'OBD-dosa', auto: store.obd?.auto ?? true };
    obd.step = null;
    await obdLink.connect(dev);
  } catch (e) {
    if (e.message !== 'Ingen dosa valdes.') toast(e.message, true);
    renderObdCard();
  }
}

function renderObdChip() {
  const chip = $('d-obd');
  if (!chip) return;
  const st = obdLink.state;
  chip.hidden = !store.obd || !!plan?.demo;
  chip.className = 'obd-chip ' + ({ connected: 'on', lost: 'lost', connecting: 'busy', testing: 'busy' }[st] || '');
  chip.setAttribute('aria-label', { connected: 'OBD-dosa ansluten', lost: 'OBD-dosan tappad, ansluter igen', connecting: 'Ansluter OBD-dosa', testing: 'Ansluter OBD-dosa' }[st] || 'Anslut OBD-dosa');
}
$('d-obd').addEventListener('click', () => {
  const st = obdLink.state;
  if (st === 'connected' || st === 'connecting' || st === 'testing') return;
  if (obdLink.device) obdLink.connect(obdLink.device).catch(e => toast(e.message, true));
  else pickAndConnectObd();
});

/** Pedalbågen, brickan och raden med varvtal i körvyn. */
function renderObdDrive() {
  if (!drive.engine) return;
  const on = obdActive();
  const s = obd.last;
  $('d-ringwrap').classList.toggle('obd', on);
  const arc = $('d-pedalarc');
  arc.toggleAttribute('hidden', !on);
  $('d-ebrake').hidden = !on || !(s.fuelCut ?? engineBraking(s));
  $('d-ebrake').textContent = s?.fuelCut ? 'Bränsle av' : 'Motorbroms';
  $('d-obdline').hidden = !on;
  if (on) {
    arc.classList.toggle('released', !!s.released);
    const p = s.pedal ?? 0;
    $('d-pedalfg').setAttribute('stroke-dasharray', `${p.toFixed(1)} 100`);
    const parts = [];
    if (s.rpm != null) parts.push(`<b>${Math.round(s.rpm).toLocaleString('sv-SE')}</b> rpm`);
    if (s.pedal != null) parts.push(`gas <b>${Math.round(s.pedal)} %</b>`);
    $('d-obdline').innerHTML = parts.join(' · ');
  }
  renderGas();
  const b = drive.badge;
  const badge = $('d-badge');
  badge.hidden = !b || Date.now() > b.until;
  if (b && !badge.hidden) { badge.textContent = b.text; badge.className = 'ring-badge' + (b.late ? ' late' : ''); }
}

const PROTOCOLS = {
  1: 'SAE J1850 PWM', 2: 'SAE J1850 VPW', 3: 'ISO 9141-2', 4: 'ISO 14230-4 (KWP)', 5: 'ISO 14230-4 (KWP, snabb)',
  6: 'CAN 11 bit, 500 kbit/s', 7: 'CAN 29 bit, 500 kbit/s', 8: 'CAN 11 bit, 250 kbit/s', 9: 'CAN 29 bit, 250 kbit/s', A: 'SAE J1939',
};
const protocolName = p => (p ? PROTOCOLS[p.replace(/^A(?=.)/, '').toUpperCase()] || p : '–');
const PEDAL_NAME = { 0x5a: 'gaspedal (relativ)', 0x49: 'gaspedal', 0x45: 'gasspjäll (relativt)', 0x11: 'gasspjäll' };

/** OBD-kortet under Inställningar. */
function renderObdCard() {
  if (!$('obd-card')) return;
  const saved = store.obd;
  const st = obdLink.state;
  const info = obdLink.session?.info;
  const busy = st === 'connecting' || st === 'testing';
  const on = st === 'connected';
  $('obd-card').classList.toggle('off', !saved && !busy && !on);
  $('obd-dot').className = 'obd-dot ' + (on ? 'on' : busy || st === 'lost' ? 'busy' : '');
  const name = saved?.name || obdLink.device?.name || 'OBD-dosa';
  $('obd-title').textContent = on ? `${name} · ansluten`
    : busy ? `${name} · ${st === 'testing' ? 'testar vad bilen redovisar…' : 'ansluter…'}`
    : st === 'lost' ? `${name} · tappad, försöker igen`
    : saved ? `${name} · inte ansluten` : 'Ingen dosa ansluten';
  $('obd-sub').textContent = on ? obdRateText()
    : obdLink.error && !busy ? obdLink.error
    : saved ? 'Slå på tändningen och tryck på Anslut.'
    : 'Med en OBD-dosa (Bluetooth 4.0/BLE) läser appen gaspedalen, farten och varvtalet direkt från bilen. Utan dosa används GPS som förut.';
  $('obd-steps').hidden = !!saved || on || busy;

  const test = $('obd-test');
  test.hidden = !info && !busy;
  if (!test.hidden) {
    const sup = info?.supported || new Set();
    const has = pid => sup.has(pid);
    const rows = busy && !info?.supported?.size ? [['…', obd.step === 'protokoll' ? 'Letar bilens protokoll' : 'Startar dosan', '']] : [
      ['yes', 'Dosa', info?.version || '–'],
      ['yes', 'Protokoll', protocolName(info?.protocol)],
      [has(0x0d) ? 'yes' : 'no', 'Fart', has(0x0d) ? 'finns' : 'saknas, GPS används'],
      [has(0x0c) ? 'yes' : 'no', 'Varvtal', has(0x0c) ? 'finns' : 'saknas'],
      [info?.pedalPid != null ? 'yes' : 'no', 'Gaspedal', info?.pedalPid != null ? PEDAL_NAME[info.pedalPid] : 'saknas, GPS används'],
      [has(0x5e) || has(0x10) ? 'yes' : 'no', 'Bränsle', has(0x5e) ? 'bränsleflöde' : has(0x10) ? 'räknas ur luftflödet' : 'saknas'],
      [has(0x03) ? 'yes' : 'no', 'Avstängt bränsle', has(0x03) ? 'syns' : 'syns inte, motorbroms uppskattas'],
    ];
    test.innerHTML = rows.map(([m, k, v]) => `<li><span class="mark ${m}">${m === 'yes' ? '✓' : m === 'no' ? '–' : '…'}</span><span>${esc(k)}</span><span class="v">${esc(v)}</span></li>`).join('');
  }
  $('obd-live').hidden = !on;
  $('obd-auto-row').hidden = !saved;
  $('obd-auto').checked = !!saved?.auto;
  $('obd-connect').hidden = on || busy;
  $('obd-connect').textContent = saved ? 'Anslut' : 'Anslut OBD-dosa';
  $('obd-retest').hidden = !on;
  $('obd-disconnect').hidden = !on && st !== 'lost';
  $('obd-forget').hidden = !saved;
  $('obd-hint').textContent = bleSupported()
    ? 'Fungerar i Chrome på Android. Dosan ska inte parkopplas i telefonens Bluetooth-inställningar.'
    : 'Den här webbläsaren saknar Bluetooth. Använd Chrome på Android.';
  if (on) renderObdLive();
}

function obdRateText() {
  const rate = obd.last?.rate;
  return rate ? `${rate.toFixed(1).replace('.', ',')} avläsningar per sekund` : 'Läser…';
}

function renderObdLive() {
  const s = obd.last;
  if (!s || $('obd-live').hidden) return;
  $('obd-sub').textContent = obdRateText();
  $('obd-kmh').textContent = s.kmh != null ? `${Math.round(s.kmh)} km/h` : '–';
  $('obd-rpm').textContent = s.rpm != null ? `${Math.round(s.rpm).toLocaleString('sv-SE')} rpm` : '–';
  $('obd-pedal').textContent = s.pedal != null ? `${Math.round(s.pedal)} %` : '–';
  const bar = $('obd-pedalbar');
  bar.style.width = `${s.pedal ?? 0}%`;
  bar.className = s.released ? 'released' : '';
}

$('obd-connect').addEventListener('click', () => {
  if (obdLink.device && store.obd && obdLink.device.id === store.obd.id) {
    obd.step = null;
    obdLink.connect(obdLink.device).catch(() => renderObdCard());
  } else pickAndConnectObd();
});
$('obd-retest').addEventListener('click', () => {
  const dev = obdLink.device;
  obdLink.disconnect();
  obd.step = null;
  if (dev) obdLink.connect(dev).catch(() => renderObdCard());
});
$('obd-disconnect').addEventListener('click', () => obdLink.disconnect());
$('obd-forget').addEventListener('click', async () => {
  const dev = obdLink.device;
  obdLink.disconnect();
  try { await dev?.forget?.(); } catch { /* stöds inte */ }
  store.obd = null;
  obd.last = null;
  obdLink.session = null;
  obdLink.error = null;
  renderObdCard();
});
$('obd-auto').addEventListener('change', e => {
  if (store.obd) store.obd = { ...store.obd, auto: e.target.checked };
});

/** Median av talen, eller null. */
function median(xs) {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function obdSummary() {
  const r = (drive.reactions || []).filter(x => x.byPedal && x.afterS != null).map(x => x.afterS);
  const km = (drive.engine?.stats.distance ?? 0) / 1000;
  return {
    reactMedianS: median(r),
    fuelL: drive.fuelKnown ? drive.fuelL : null,
    fuelPer100: drive.fuelKnown && km > 1 ? drive.fuelL / km * 100 : null,
    ebrakeKm: drive.ebrakeM / 1000,
    fuelCutKnown: drive.fuelCutKnown,
  };
}

function obdStatRows() {
  if (!drive.obdUsed) return [];
  const o = obdSummary();
  const n1 = x => x.toFixed(1).replace('.', ',');
  const rows = [];
  if (o.reactMedianS != null) rows.push([`${n1(o.reactMedianS)} s`, 'reaktionstid, median (gaspedal)']);
  if (o.fuelL != null) rows.push([`${o.fuelL.toFixed(2).replace('.', ',')} l`, o.fuelPer100 != null ? `bränsle · ${n1(o.fuelPer100)} l/100 km` : 'bränsle']);
  rows.push([`${n1(o.ebrakeKm)} km`, o.fuelCutKnown ? 'utan bränsle (motorbroms)' : 'med motorbroms']);
  return rows;
}

/** Stapel per signal: tid till släppt gas, orange om sen eller inte släppt. */
function renderReactionChart() {
  const r = drive.reactions || [];
  const show = drive.obdUsed && r.length > 0;
  $('sum-obd').hidden = !show;
  if (!show) return;
  const max = Math.max(3, ...r.map(x => x.afterS ?? 0));
  $('sum-react').innerHTML = r.map(x => {
    const late = !x.followed || x.afterS == null || x.afterS > 2;
    const h = x.followed && x.afterS != null ? Math.max(4, x.afterS / max * 100) : 100;
    return `<i class="${late ? 'late' : ''}" style="height:${h.toFixed(0)}%"></i>`;
  }).join('');
  const ok = r.filter(x => x.followed && x.afterS != null && x.afterS <= 2).length;
  $('sum-react').setAttribute('aria-label', `Gasen släppt inom 2 sekunder vid ${ok} av ${r.length} signaler`);
}

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
    if (trip.demo) planDemo();
    else if (trip.dest && store.key) planRoute(trip.dest);
    if (wasDriving) toast('Sidan laddades om. Rutten är hämtad igen – tryck Starta för att fortsätta.', false, 7000);
  }
}

// Gör det lättare att felsöka i konsolen.
window.__bromsfri = { store, plan: () => plan, ApiError };


