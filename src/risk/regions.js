// Watchlist the risk matrix covers. Scores are only computed for these, so
// visitors can't make the Worker fan out to arbitrary coordinates.
//
// seismicMinMag: USGS's global catalogue is only complete from about M4
// outside the US (smaller quakes abroad are often missing), so non-US regions
// count M4+ and US regions count M2.5+. Baseline and live counts always use
// the same threshold.

import { REGION_LIST } from "../../public/js/regions.js";

export const REGION_DEFAULTS = Object.freeze({
  seismicRadiusKm: 300,
  fireBoxDeg: 1.0, // FIRMS box = centre ± this many degrees (~110 km)
  aqRadiusM: 25_000, // OpenAQ's maximum search radius
});

export const REGIONS = Object.freeze(REGION_LIST.map((r) => Object.freeze({ ...REGION_DEFAULTS, ...r })));

export function getRegion(id) {
  return REGIONS.find((r) => r.id === id) || null;
}

export function fireBox(r) {
  const d = r.fireBoxDeg;
  const f = (x) => Math.round(x * 1000) / 1000;
  return [f(r.lon - d), f(r.lat - d), f(r.lon + d), f(r.lat + d)]; // west,south,east,north
}
