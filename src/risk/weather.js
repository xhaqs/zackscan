// Daily weather vs the seasonal normal, for the weather widget.
//
// Shares the heat pillar's data rather than fetching its own:
//   - today's values come from the same Open-Meteo forecast call
//   - the normal comes from the same 10-year archive call, kept in the
//     region's weekly baseline as compact [dayOfYear, Tmax, RHmean, windMax] rows
// Today's daily values are compared with the same daily measures on the same
// calendar days (±7) over 10 years, so like is compared with like. The
// "now" readings are shown for context but have no σ (there's no hourly baseline).

import { meanStd } from "./math.js";

const DAY_MS = 86_400_000;
const r1 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10) / 10);
const doy = (date) => {
  const d = new Date(date + "T00:00:00Z");
  return Math.floor((d - Date.UTC(d.getUTCFullYear(), 0, 1)) / DAY_MS);
};
const doyGap = (a, b) => Math.min(Math.abs(a - b), 365 - Math.abs(a - b));

/** Archive rows -> compact climate rows kept in the weekly baseline. */
export function climateFromArchive(rows) {
  return rows.map((r) => [doy(r.date), r1(r.tmaxC), r1(r.rhMeanPct), r1(r.windMaxKmh)]);
}

/**
 * @param current  {time, tempC, rh, windKmh} from the forecast
 * @param today    {date, tmaxC, rhMeanPct, windMaxKmh} today's forecast daily values
 * @param climate  compact rows from climateFromArchive, or null
 */
export function weatherSummary({ current, today, climate, windowDays = 7, asOf }) {
  const measures = [
    ["tmax", "tmaxC", 1],
    ["rhMean", "rhMeanPct", 2],
    ["windMax", "windMaxKmh", 3],
  ];
  const normals = {};
  if (climate?.length && today) {
    const target = doy(today.date);
    const inWindow = climate.filter((row) => doyGap(row[0], target) <= windowDays);
    for (const [name, field, col] of measures) {
      const { mean, std, n } = meanStd(inWindow.map((row) => row[col]).filter(Number.isFinite));
      const v = today[field];
      normals[name] =
        n >= 20 && std > 0 && Number.isFinite(v) ? { mean: r1(mean), std: r1(std), n, z: r1((v - mean) / std) } : { mean: n ? r1(mean) : null, std: null, n, z: null };
    }
  }
  return {
    asOf,
    current: current ? { time: current.time, tempC: r1(current.tempC), rh: current.rh ?? null, windKmh: r1(current.windKmh) } : null,
    today: today ? { date: today.date, tmaxC: r1(today.tmaxC), rhMeanPct: r1(today.rhMeanPct), windMaxKmh: r1(today.windMaxKmh) } : null,
    normals,
    window: `±${windowDays} days`,
    baselineYears: climate?.length ? 10 : 0,
  };
}
