// USGS FDSN Event web service. Free, no key.
// https://earthquake.usgs.gov/fdsnws/event/1/

import { getJson } from "./http.js";

const BASE = "https://earthquake.usgs.gov/fdsnws/event/1/";
const DAY_MS = 86_400_000;

function areaParams(region) {
  return new URLSearchParams({
    format: "geojson",
    latitude: String(region.lat),
    longitude: String(region.lon),
    maxradiuskm: String(region.seismicRadiusKm),
    minmagnitude: String(region.seismicMinMag),
  });
}

/** Events in the region over the last `days` days, newest first. */
export async function recentQuakes(region, { days, now = Date.now(), fetch } = {}) {
  const q = areaParams(region);
  q.set("starttime", new Date(now - days * DAY_MS).toISOString());
  q.set("orderby", "time");
  q.set("limit", "2000");
  const data = await getJson("USGS", BASE + "query?" + q, { fetch });
  return (data.features || [])
    .map((f) => ({
      id: f.id,
      mag: f.properties?.mag,
      time: f.properties?.time,
      place: f.properties?.place || "",
      depthKm: f.geometry?.coordinates?.[2] ?? null,
    }))
    .filter((e) => Number.isFinite(e.mag) && Number.isFinite(e.time));
}

/**
 * Historical event count for the baseline rate: `years` years ending
 * `gapDays` ago. The gap keeps a current swarm from inflating its own baseline.
 */
export async function historicalQuakeCount(region, { years = 10, gapDays = 30, now = Date.now(), fetch } = {}) {
  const end = now - gapDays * DAY_MS;
  const start = end - years * 365.25 * DAY_MS;
  const q = areaParams(region);
  q.set("starttime", new Date(start).toISOString());
  q.set("endtime", new Date(end).toISOString());
  const data = await getJson("USGS", BASE + "count?" + q, { fetch });
  if (!Number.isFinite(data.count)) throw new Error("USGS: count missing from response");
  return { count: data.count, days: (end - start) / DAY_MS, years };
}
