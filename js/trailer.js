// Släpvagnsläge: högsta fart, mjukare kurvor och en egen rullmodell.

const G = 9.81;

export const TRAILER_DEFAULTS = Object.freeze({
  trailerMaxKmh: 80,              // personbil med släpvagn i Sverige
  trailerALat: Math.round(0.18 * G * 100) / 100, // 0,18 g – mer marginal mot slingring
});

/**
 * Uppskattad rullmodell med släp när bara bilen är kalibrerad.
 * Motorbromsen och rullmotståndet ska bromsa en tyngre ekipage (A minskar),
 * och släpets front och virvlar ger mer luftmotstånd per kg (C ökar).
 * Grovt antagande om ett släp på ungefär halva bilens vikt; ett rullprov
 * med släpet ger riktiga värden.
 */
export function estimateTrailerModel(car) {
  return { A: car.A * 0.75, C: car.C * 1.3, estimated: true };
}

/**
 * Hastighetsgränser med släp: skyltad gräns men aldrig över maxKmh.
 * Där gränsen är okänd gäller maxKmh.
 */
export function trailerLimits(limits, maxKmh) {
  return limits.map(l => (l == null ? maxKmh : Math.min(l, maxKmh)));
}
