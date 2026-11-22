// Färdiga demorutter mellan riktiga platser. Rutten hämtas en gång med
// användarens egen nyckel och sparas i telefonen; sedan kör en simulerad
// bil den, även utan täckning.

export const DEMO_ROUTES = [
  { id: 'ost-brunflo', name: 'Östersund → Brunflo', note: 'E14, landsväg 90 km/h, ca 20 km',
    from: { name: 'Stortorget, Östersund', lat: 63.1771, lon: 14.6378 },
    to: { name: 'Brunflo centrum', lat: 63.0757, lon: 14.8220 } },
  { id: 'are-duved', name: 'Åre → Duved', note: 'Fjällväg med backar, ca 9 km',
    from: { name: 'Åre torg', lat: 63.3986, lon: 13.0814 },
    to: { name: 'Duved', lat: 63.3913, lon: 12.9310 } },
  { id: 'sthlm-solna', name: 'Slussen → Solna centrum', note: 'Stadstrafik med trafikljus, ca 9 km',
    from: { name: 'Slussen, Stockholm', lat: 59.3197, lon: 18.0718 },
    to: { name: 'Solna centrum', lat: 59.3597, lon: 18.0003 } },
  { id: 'gbg-molndal', name: 'Lindholmen → Mölndal', note: 'Stad och led, ca 12 km',
    from: { name: 'Lindholmen, Göteborg', lat: 57.7066, lon: 11.9370 },
    to: { name: 'Mölndals centrum', lat: 57.6559, lon: 12.0139 } },
  { id: 'uppsala-sigtuna', name: 'Uppsala → Sigtuna', note: 'Kurvig landsväg, ca 40 km',
    from: { name: 'Uppsala centralstation', lat: 59.8586, lon: 17.6454 },
    to: { name: 'Sigtuna', lat: 59.6173, lon: 17.7236 } },
];

/** Avrundar koordinater så att en sparad rutt tar lite plats. */
export function compactCoords(coords) {
  return coords.map(c => [Math.round(c[0] * 1e6) / 1e6, Math.round(c[1] * 1e6) / 1e6, c[2] == null ? null : Math.round(c[2] * 10) / 10]);
}
