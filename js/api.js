// Externa tjänster: OpenRouteService (HeiGIT) och Open-Meteo Elevation.
// Nyckeln skickas bara till api.heigit.org.

export const ORS_BASE = 'https://api.heigit.org';
const DIRECTIONS = '/openrouteservice/v2/directions/driving-car/geojson';
const GEOCODE = '/pelias/v1/search';
const AUTOCOMPLETE = '/pelias/v1/autocomplete';
import { haversine } from './geo.js';

export class ApiError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function mapError(status) {
  if (status === 401 || status === 403) return new ApiError('key', 'Ogiltig API-nyckel');
  if (status === 429) return new ApiError('quota', 'Kvoten är slut (2 000 rutter/dag eller 40/min)');
  if (status === 404) return new ApiError('route', 'Ingen rutt hittades');
  return new ApiError('server', `Tjänsten svarade med fel ${status}`);
}

async function call(url, opts) {
  let res;
  try {
    res = await fetch(url, opts);
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new ApiError('network', 'Ingen täckning eller tjänsten går inte att nå');
  }
  if (!res.ok) {
    let detail = '';
    try { const j = await res.json(); detail = j?.error?.message || j?.error || ''; } catch { /* tomt svar */ }
    const err = mapError(res.status);
    if (detail && err.code === 'route') err.message += `: ${detail}`;
    throw err;
  }
  return res.json();
}

/** Rutt med höjd. from/to = {lat, lon}. Returnerar GeoJSON-featurens koordinater [[lon, lat, ele]] och sammanfattning. */
export async function getRoute(key, from, to, { signal } = {}) {
  const json = await call(ORS_BASE + DIRECTIONS, {
    method: 'POST',
    signal,
    headers: {
      'Authorization': key,
      'Content-Type': 'application/json',
      'Accept': 'application/geo+json, application/json',
    },
    body: JSON.stringify({
      coordinates: [[from.lon, from.lat], [to.lon, to.lat]],
      elevation: true,
      instructions: false,
      units: 'm',
    }),
  });
  const f = json.features && json.features[0];
  if (!f) throw new ApiError('route', 'Ingen rutt hittades');
  return {
    coords: f.geometry.coordinates,
    distance: f.properties?.summary?.distance ?? null,
    duration: f.properties?.summary?.duration ?? null,
  };
}

/** Svensk benämning av Pelias-lagren. */
const LAYER = {
  address: 'Adress', street: 'Gata', venue: 'Plats', locality: 'Ort', localadmin: 'Ort',
  borough: 'Område', neighbourhood: 'Område', macrohood: 'Område', county: 'Kommun',
  region: 'Län', postalcode: 'Postnummer', country: 'Land', coarse: 'Område',
};

/**
 * Adressökning i Sverige. Med partial = true används Pelias autocomplete, som
 * klarar början av ord (för sök medan man skriver). Returnerar
 * [{name, lat, lon, kind, distance (m) | null}], närmast fokus först bland
 * lika bra träffar (Pelias egen ordning behålls annars).
 */
export async function geocode(key, text, focus = null, { signal, partial = false, size = 10 } = {}) {
  const p = new URLSearchParams({ text, 'boundary.country': 'SE' });
  if (!partial) p.set('size', String(size));   // autocomplete tar inte size
  if (focus) { p.set('focus.point.lat', focus.lat.toFixed(4)); p.set('focus.point.lon', focus.lon.toFixed(4)); }
  const json = await call(`${ORS_BASE}${partial ? AUTOCOMPLETE : GEOCODE}?${p}`, { signal, headers: { 'Authorization': key } });
  return (json.features || []).slice(0, size).map(f => {
    const lat = f.geometry.coordinates[1], lon = f.geometry.coordinates[0];
    const label = f.properties?.label || f.properties?.name || 'Okänd plats';
    return {
      name: label.replace(/, Sverige$/, ''),
      lat, lon,
      kind: LAYER[f.properties?.layer] || null,
      distance: focus ? haversine(focus.lat, focus.lon, lat, lon) : null,
    };
  });
}

/** Testanrop: en kort rutt i Stockholm. */
export async function testKey(key) {
  await getRoute(key, { lat: 59.3326, lon: 18.0649 }, { lat: 59.3340, lon: 18.0700 });
  return true;
}

/** Höjd för godtyckliga punkter (gratis, ingen nyckel). points = [[lat, lon]]. */
export async function elevations(points, { signal } = {}) {
  const out = [];
  for (let i = 0; i < points.length; i += 100) {
    const part = points.slice(i, i + 100);
    const lat = part.map(p => p[0].toFixed(5)).join(',');
    const lon = part.map(p => p[1].toFixed(5)).join(',');
    const json = await call(`https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lon}`, { signal });
    out.push(...json.elevation);
  }
  return out;
}
