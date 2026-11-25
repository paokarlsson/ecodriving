import { test } from 'node:test';
import assert from 'node:assert/strict';
import { geocode } from '../js/api.js';

function stubFetch(features) {
  const urls = [];
  globalThis.fetch = async url => { urls.push(url); return { ok: true, json: async () => ({ features }) }; };
  return urls;
}

const F = (label, layer, lat, lon) => ({ geometry: { coordinates: [lon, lat] }, properties: { label, layer } });

test('sökningen begränsas till Sverige och ger typ och avstånd', async () => {
  const urls = stubFetch([F('Storgatan 12, Östersund, Sverige', 'address', 63.18, 14.64), F('Brunflo, JA, Sverige', 'locality', 63.08, 14.82)]);
  const res = await geocode('k', 'Storgatan 12', { lat: 63.1758, lon: 14.605 });
  assert.match(urls[0], /\/pelias\/v1\/search\?/);
  assert.match(urls[0], /boundary\.country=SE/);
  assert.match(urls[0], /size=10/);
  assert.equal(res[0].name, 'Storgatan 12, Östersund');
  assert.equal(res[0].kind, 'Adress');
  assert.ok(res[0].distance > 1000 && res[0].distance < 3000, `${res[0].distance}`);
  assert.equal(res[1].kind, 'Ort');
});

test('medan man skriver används autocomplete', async () => {
  const urls = stubFetch([F('Brunflo, JA, Sverige', 'locality', 63.08, 14.82)]);
  const res = await geocode('k', 'Brunf', null, { partial: true });
  assert.match(urls[0], /\/pelias\/v1\/autocomplete\?/);
  assert.match(urls[0], /boundary\.country=SE/);
  assert.equal(res[0].distance, null);
});
