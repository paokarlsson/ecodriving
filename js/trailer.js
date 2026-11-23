// Släpvagnsläge: skyltad gräns men aldrig över 80 km/h. Allt annat som utan släp.

export const TRAILER_MAX_KMH = 80; // personbil med släpvagn i Sverige

/**
 * Hastighetsgränser med släp: skyltad gräns men aldrig över maxKmh.
 * Där gränsen är okänd gäller maxKmh.
 */
export function trailerLimits(limits, maxKmh = TRAILER_MAX_KMH) {
  return limits.map(l => (l == null ? maxKmh : Math.min(l, maxKmh)));
}
