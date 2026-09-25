// OpenAQ v3 air quality. Free, but v3 REQUIRES an API key (X-API-Key header),
// from https://explore.openaq.org/register. Limits: 60 requests/minute and
// 2,000/hour.
// https://docs.openaq.org/

import { getJson } from "./http.js";

const BASE = "https://api.openaq.org/v3/";
const PM25_PARAMETER_ID = 2; // PM2.5, µg/m³
const MAX_STATIONS = 3;
const MAX_AGE_MS = 3 * 3_600_000; // ignore readings older than 3 h

/**
 * Nearest stations measuring PM2.5 (up to 25 km). This changes rarely, so
 * it's fetched with the weekly baseline, not on every refresh.
 */
export async function pm25Stations(region, { apiKey, fetch } = {}) {
  const q = new URLSearchParams({
    coordinates: `${region.lat},${region.lon}`,
    radius: String(region.aqRadiusM),
    parameters_id: String(PM25_PARAMETER_ID),
    limit: "20",
  });
  const d = await getJson("OpenAQ", BASE + "locations?" + q, { fetch, headers: { "X-API-Key": apiKey } });
  return (d.results || [])
    .map((loc) => ({
      id: loc.id,
      name: loc.name || "",
      distanceM: loc.distance ?? null,
      // Filter by parameter name too, not just the id in the query.
      sensorIds: (loc.sensors || []).filter((s) => s.parameter?.name === "pm25").map((s) => s.id),
    }))
    .filter((s) => s.sensorIds.length)
    .sort((a, b) => (a.distanceM ?? Infinity) - (b.distanceM ?? Infinity))
    .slice(0, MAX_STATIONS);
}

/** Latest PM2.5 reading from each station, keeping only recent, plausible values. */
export async function pm25Latest(stations, { apiKey, now = Date.now(), fetch } = {}) {
  const results = await Promise.allSettled(
    stations.map((s) => getJson("OpenAQ", `${BASE}locations/${encodeURIComponent(s.id)}/latest`, { fetch, headers: { "X-API-Key": apiKey } })),
  );
  const readings = [];
  results.forEach((r, i) => {
    if (r.status !== "fulfilled") return;
    const wanted = new Set(stations[i].sensorIds);
    for (const m of r.value.results || []) {
      const t = Date.parse(m.datetime?.utc);
      if (wanted.has(m.sensorsId) && Number.isFinite(m.value) && m.value >= 0 && m.value < 1000 && now - t < MAX_AGE_MS)
        readings.push({ station: stations[i].name, value: m.value, at: m.datetime.utc });
    }
  });
  // All stations failing is an error; no recent readings is just "no data".
  if (stations.length && results.every((r) => r.status === "rejected")) throw results[0].reason;
  return readings;
}
