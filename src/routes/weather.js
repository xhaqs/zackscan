// GET /api/weather?lat=X&lon=Y
// On-demand weather + 10-year seasonal baseline for any coordinates.
// Reuses the exact forecast + archive pipeline that runs for the 6 watchlist
// cities, so the numbers are directly comparable.
//
// Two-layer KV cache:
//   wx-base:v1:{lat4}:{lon4}   climate normals   14 days (archive rarely changes)
//   wx-cur:v1:{lat4}:{lon4}    current weather    1 hour

import { forecast, archiveDaily } from "../risk/sources/openmeteo.js";
import { climateFromArchive, weatherSummary } from "../risk/weather.js";
import { makeStore } from "../risk/store.js";
import { json } from "../http.js";

const WEATHER_TTL = 3_600;
const BASELINE_TTL = 14 * 86_400;

const r4 = (n) => Math.round(n * 1e4) / 1e4;
const baseKey = (lat, lon) => `wx-base:v1:${lat}:${lon}`;
const curKey = (lat, lon) => `wx-cur:v1:${lat}:${lon}`;

export async function handleWeather(request, env, deps = {}) {
  const url = new URL(request.url);
  const lat = parseFloat(url.searchParams.get("lat"));
  const lon = parseFloat(url.searchParams.get("lon"));
  if (
    !isFinite(lat) ||
    !isFinite(lon) ||
    lat < -90 ||
    lat > 90 ||
    lon < -180 ||
    lon > 180
  )
    return json(
      {
        error: "lat and lon must be valid coordinates.",
        code: "coords_invalid",
      },
      400,
    );

  const rlat = r4(lat);
  const rlon = r4(lon);
  const store = deps.store || makeStore(env);

  const cached = await store.get(curKey(rlat, rlon));
  if (cached) return json({ ...cached, cached: true });

  const region = { id: `geo_${rlat}_${rlon}`, lat: rlat, lon: rlon };
  const year = new Date().getUTCFullYear();
  const fetchImpl = deps.fetch || fetch;

  const [wxResult, baseResult] = await Promise.allSettled([
    forecast(region, { fetch: fetchImpl }),
    store.get(baseKey(rlat, rlon)).then(async (hit) => {
      if (hit) return hit;
      const rows = await archiveDaily(region, {
        startDate: `${year - 10}-01-01`,
        endDate: `${year - 1}-12-31`,
        fetch: fetchImpl,
      });
      const climate = climateFromArchive(rows);
      const result = { climate, years: 10 };
      await store.put(baseKey(rlat, rlon), result, BASELINE_TTL);
      return result;
    }),
  ]);

  if (wxResult.status === "rejected")
    return json(
      {
        error: "Weather data couldn't be loaded right now. Try again.",
        code: "weather_unavailable",
      },
      502,
    );

  const wx = wxResult.value;
  const base = baseResult.status === "fulfilled" ? baseResult.value : null;
  const weather = weatherSummary({
    current: wx.current,
    today: wx.daily[0],
    climate: base?.climate,
    asOf: new Date().toISOString(),
  });

  const result = { weather };
  await store.put(curKey(rlat, rlon), result, WEATHER_TTL);
  return json(result);
}
