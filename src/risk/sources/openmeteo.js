// Open-Meteo forecast + historical archive. Free, no key, for NON-COMMERCIAL
// use. Commercial use needs Open-Meteo's paid API (customer URL + key).
// https://open-meteo.com/en/docs  https://open-meteo.com/en/docs/historical-weather-api

import { getJson, SourceError } from "./http.js";

const FORECAST = "https://api.open-meteo.com/v1/forecast?";
const ARCHIVE = "https://archive-api.open-meteo.com/v1/archive?";

/**
 * One call gives everything the fire-weather and heat pillars need:
 * current conditions, the last 24 h of humidity (to measure a drop), hourly
 * temperature/humidity for the next 48 h, and daily max temperature / min
 * humidity for today and tomorrow.
 */
export async function forecast(region, { fetch } = {}) {
  const q = new URLSearchParams({
    latitude: String(region.lat),
    longitude: String(region.lon),
    current: "temperature_2m,relative_humidity_2m,vapour_pressure_deficit,wind_speed_10m",
    hourly: "temperature_2m,relative_humidity_2m",
    daily: "temperature_2m_max,relative_humidity_2m_min,relative_humidity_2m_mean,wind_speed_10m_max",
    past_days: "1",
    // 3 days so a full 48 h is always ahead, whatever the time of day.
    forecast_days: "3",
    timezone: "auto",
  });
  const d = await getJson("Open-Meteo", FORECAST + q, { fetch });
  const c = d.current;
  if (!c || !d.hourly?.time || !d.daily?.time) throw new SourceError("Open-Meteo", "unexpected response shape", { code: "bad_response" });

  const hourly = d.hourly.time.map((t, i) => ({ time: t, tempC: d.hourly.temperature_2m[i], rh: d.hourly.relative_humidity_2m[i] }));
  // Humidity 24 h before the current reading (hourly times are local, "YYYY-MM-DDTHH:00").
  const nowHour = c.time.slice(0, 13) + ":00";
  const idx = hourly.findIndex((h) => h.time === nowHour);
  const rh24hAgo = idx >= 24 ? hourly[idx - 24].rh : null;

  return {
    timezone: d.timezone,
    current: { time: c.time, tempC: c.temperature_2m, rh: c.relative_humidity_2m, vpdKpa: c.vapour_pressure_deficit, windKmh: c.wind_speed_10m },
    rh24hAgo,
    // Past day included by past_days=1; keep only now onwards for "next 48 h".
    hourlyAhead: (idx >= 0 ? hourly.slice(idx) : hourly).slice(0, 48), // exactly the next 48 h
    // Today and tomorrow only (past_days=1 also returns yesterday, which must not count).
    daily: d.daily.time
      .map((date, i) => ({
        date,
        tmaxC: d.daily.temperature_2m_max[i],
        rhMinPct: d.daily.relative_humidity_2m_min[i],
        rhMeanPct: d.daily.relative_humidity_2m_mean?.[i] ?? null,
        windMaxKmh: d.daily.wind_speed_10m_max?.[i] ?? null,
      }))
      .filter((r) => r.date >= c.time.slice(0, 10))
      .slice(0, 2),
  };
}

/** Daily max temperature and min humidity between two dates (YYYY-MM-DD). */
export async function archiveDaily(region, { startDate, endDate, fetch } = {}) {
  const q = new URLSearchParams({
    latitude: String(region.lat),
    longitude: String(region.lon),
    start_date: startDate,
    end_date: endDate,
    daily: "temperature_2m_max,relative_humidity_2m_min,relative_humidity_2m_mean,wind_speed_10m_max",
    timezone: "auto",
  });
  const d = await getJson("Open-Meteo archive", ARCHIVE + q, { fetch });
  if (!d.daily?.time) throw new SourceError("Open-Meteo archive", "unexpected response shape", { code: "bad_response" });
  return d.daily.time
    .map((date, i) => ({
      date,
      tmaxC: d.daily.temperature_2m_max[i],
      rhMinPct: d.daily.relative_humidity_2m_min[i],
      rhMeanPct: d.daily.relative_humidity_2m_mean?.[i] ?? null,
      windMaxKmh: d.daily.wind_speed_10m_max?.[i] ?? null,
    }))
    .filter((r) => Number.isFinite(r.tmaxC) && Number.isFinite(r.rhMinPct));
}
