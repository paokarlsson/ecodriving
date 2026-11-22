// Bromsfri körning – appens vyer och flöden.
import { store, maskKey, DEFAULT_SETTINGS, osmCache } from './store.js';
import { getRoute, geocode, testKey, elevations, ApiError } from './api.js';
import { buildRoute, headingAt, xyAt } from './route.js';
import { fetchOsmAlongRoute, assignLimits, buildTargets, countKinds, kindLabel } from './osm.js';
import { DEFAULT_MODEL } from './physics.js';
import { CoastRecorder, analyzeRun, combineRuns, describeModel, CALIB } from './calibration.js';
import { DriveEngine, releaseMessage } from './drive.js';
import { demoData } from './demo.js';
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
  calib.stops.push(watchMotion(m => rec.addMotion(m)));
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
  store.calibration = { A: c.A, C: c.C, r2: c.r2, runs: c.runs, date: new Date().toISOString() };
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
function model() { return store.calibration || DEFAULT_MODEL; }

function enterHome() {
  const c = store.calibration;
  $('home-calib').innerHTML = c
    ? `<button class="chip ok" id="chip-calib">✓ Kalibrerad · ${esc(describeModel(c))}</button>`
    : `<button class="chip todo" id="chip-calib">Inte kalibrerad – gör ett rullprov</button>`;
  $('chip-calib').addEventListener('click', () => show('calib'));
  if (store.key) locationGranted().then(ok => { if (ok) startPosition().catch(() => {}); });
  $('home-nokey').hidden = !!store.key;
  $('search-form').hidden = !store.key;
  renderFavorites();
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
  const s = store.settings;
  const limits = assignLimits(route, elements);
  const targets = buildTargets(route, elements, limits, s);
  return { route, limits, targets, warnings };
}

async function planRoute(dest) {
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
    `<span><b>${n}</b> fartmål</span>`;
  const c = countKinds(targets);
  const order = ['traffic_signals', 'roundabout', 'curve', 'limit', 'give_way', 'stop'];
  $('ov-counts').innerHTML = order.filter(k => c[k]).map(k =>
    `<li><i style="background:${KIND_COLOR[k]}"></i>${c[k]} ${esc(c[k] > 1 ? PLURAL[k] : kindLabel(k))}</li>`).join('');
  const w = [...(warnings || [])];
  if (!store.calibration) w.push('Bilen är inte kalibrerad – typvärden används. Gör ett rullprov för bättre precision.');
  if (plan.demo) w.push('Demoläge: bilen simuleras i fyrdubbel fart. Ingen GPS används.');
  $('ov-warn').innerHTML = w.map(esc).join('<br>');
  $('ov-warn').hidden = !w.length;
  $('ov-start').disabled = false;
  $('ov-fav').hidden = plan.demo || store.favorites.some(f => f.name === dest.name);
  requestAnimationFrame(() => drawOverview($('ov-map'), route, targets));
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
  rerouting: false, lastReroute: 0, coastStart: null, flashUntil: 0, lastObs: null,
};

$('ov-start').addEventListener('click', () => startDrive());

function startDrive() {
  if (!plan) return;
  unlockAudio();
  if (needsMotionPermission()) requestMotionPermission();
  const s = store.settings;
  drive.engine = new DriveEngine(plan.route, plan.targets, model(), { marginS: s.marginS });
  drive.coastStart = null;
  drive.rerouting = false;
  show('drive');
  renderDrive(drive.engine.view('free', { next: plan.targets[0], distToNext: plan.targets[0]?.s }));
  drive.stops.push(keepAwake());
  if (plan.demo) {
    drive.sim = new SimCar(plan.route, plan.limits, model());
    drive.simTimer = setInterval(() => {
      const obs = drive.sim.step(1, plan.targets);
      onDriveObs(obs);
    }, 250);
    drive.stops.push(() => clearInterval(drive.simTimer));
  } else {
    drive.stops.push(watchGps(onDriveObs, e => toast(e.message, true)));
    drive.stops.push(watchCompass(h => { drive.compass = h; }));
  }
  if (store.settings.voice && !drive.muted) speak('Kör försiktigt. Bromsen används alltid vid behov.');
}

function stopDrive() {
  drive.stops.forEach(f => f());
  drive.stops = [];
  drive.sim = null;
}

function onDriveObs(obs) {
  if (!drive.engine || drive.rerouting) return;
  drive.lastObs = obs;
  const { view, events } = drive.engine.update(obs);
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
  if (plan) {
    const s = view.s || 0;
    const moving = (view.v || 0) > 3;
    const heading = moving || drive.compass == null ? smoothHeading(plan.route, s) : drive.compass;
    drawDrive($('d-map'), plan.route, plan.targets, s, heading);
  }
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
  if (stats && stats.signals > 0) showSummary(stats);
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
  stack.length = 0;
  stack.push('home');
  show('summary');
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
  bindRange('set-alat', 'aLat', v => `${v.toFixed(1).replace('.', ',')} m/s²`, s);
  bindRange('set-giveway', 'giveWayKmh', v => `${v} km/h`, s);
  bindRange('set-rb', 'roundaboutKmh', v => `${v} km/h`, s);
  $('set-voice').checked = s.voice;
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
  show('home');
}

// Gör det lättare att felsöka i konsolen.
window.__bromsfri = { store, plan: () => plan, ApiError };
