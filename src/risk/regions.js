// Watchlist the risk matrix covers. Scores are only computed for these, so
// visitors can't make the Worker fan out to arbitrary coordinates.
//
// seismicMinMag: USGS's global catalogue is only complete from about M4
// outside the US (smaller quakes abroad are often missing), so non-US regions
// count M4+ and US regions count M2.5+. Baseline and live counts always use
// the same threshold.

export const REGION_DEFAULTS = Object.freeze({
  seismicRadiusKm: 300,
  fireBoxDeg: 1.0, // FIRMS box = centre ± this many degrees (~110 km)
  aqRadiusM: 25_000, // OpenAQ's maximum search radius
});

export const REGIONS = Object.freeze([
  { id: "nairobi", name: "Nairobi, Kenya", lat: -1.2921, lon: 36.8219, seismicMinMag: 4.0 },
  { id: "dubai", name: "Dubai, UAE", lat: 25.2048, lon: 55.2708, seismicMinMag: 4.0 },
  { id: "los-angeles", name: "Los Angeles, USA", lat: 34.0522, lon: -118.2437, seismicMinMag: 2.5 },
  { id: "tokyo", name: "Tokyo, Japan", lat: 35.6762, lon: 139.6503, seismicMinMag: 4.0 },
  { id: "delhi", name: "Delhi, India", lat: 28.6139, lon: 77.209, seismicMinMag: 4.0 },
  { id: "kathmandu", name: "Kathmandu, Nepal", lat: 27.7172, lon: 85.324, seismicMinMag: 4.0 },
].map((r) => Object.freeze({ ...REGION_DEFAULTS, ...r })));

export function getRegion(id) {
  return REGIONS.find((r) => r.id === id) || null;
}

export function fireBox(r) {
  const d = r.fireBoxDeg;
  const f = (x) => Math.round(x * 1000) / 1000;
  return [f(r.lon - d), f(r.lat - d), f(r.lon + d), f(r.lat + d)]; // west,south,east,north
}
