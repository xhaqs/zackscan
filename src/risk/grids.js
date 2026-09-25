// Gridded views around a watchlist region, built on demand and cached.
//
//   dispersion  Copernicus CAMS forecast (via Open-Meteo Air Quality API):
//               PM2.5 and dust on a 7×7 grid at 0.4°, the model's own
//               resolution outside Europe, every 3 h for the next 48 h,
//               plus 10 m wind for the arrows. Model output, not measurements.
//   heatgrid    Heat anomaly on a 5×5 grid at 0.6°: today's daily wet-bulb
//               (Stull of Tmax, min RH) at each point vs the same ±6-day
//               window over the last 10 years at that point, as a z-score.
//
// Cost control: Open-Meteo counts every grid point as one call. Both views
// are fetched only when someone opens them, and cached per region (3 h for
// data; the heat baseline is kept for weeks and only rebuilt when the date
// has moved on), so a busy day costs a few hundred calls, not thousands.

import { getJson, SourceError } from "./sources/http.js";
import { wetBulbStull, meanStd } from "./math.js";
import { makeStore } from "./store.js";

const AQ = "https://air-quality-api.open-meteo.com/v1/air-quality?";
const FORECAST = "https://api.open-meteo.com/v1/forecast?";
const ARCHIVE = "https://archive-api.open-meteo.com/v1/archive?";
const DATA_TTL_MS = 3 * 3_600_000;
const DAY_MS = 86_400_000;
// Many-point requests are slower; Open-Meteo sometimes takes 5-15 s for 49 points.
const GRID_TIMEOUT_MS = 30_000;
const r1 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10) / 10);

/** n×n points centred on the region, row by row from north to south. */
export function gridAround(region, n, spacingDeg) {
  const half = (n - 1) / 2;
  const r3 = (v) => Math.round(v * 1000) / 1000;
  const points = [];
  for (let row = 0; row < n; row++)
    for (let col = 0; col < n; col++) points.push([r3(region.lat + (half - row) * spacingDeg), r3(region.lon + (col - half) * spacingDeg)]);
  return { n, spacingDeg, points };
}

function coords(points) {
  return { latitude: points.map((p) => p[0]).join(","), longitude: points.map((p) => p[1]).join(",") };
}

/** Open-Meteo returns an array for several locations (a single object for one). */
const asList = (d) => (Array.isArray(d) ? d : [d]);

// ---------------------------------------------------------------- dispersion

const FRAME_STEP_H = 3;
const FRAMES = 16; // 48 h

export async function buildDispersion(region, { fetch, now = Date.now(), fires = [] } = {}) {
  const grid = gridAround(region, 7, 0.4);
  const q = (extra) => new URLSearchParams({ ...coords(grid.points), forecast_days: "3", timezone: "auto", ...extra });
  const [aq, wx] = await Promise.all([
    getJson("CAMS (Open-Meteo)", AQ + q({ hourly: "pm2_5,dust" }), { fetch, timeoutMs: GRID_TIMEOUT_MS }),
    getJson("Open-Meteo", FORECAST + q({ hourly: "wind_speed_10m,wind_direction_10m" }), { fetch, timeoutMs: GRID_TIMEOUT_MS }),
  ]);
  const A = asList(aq);
  const Wx = asList(wx);
  if (A.length !== grid.points.length || Wx.length !== grid.points.length || !A[0]?.hourly?.time)
    throw new SourceError("CAMS (Open-Meteo)", "unexpected grid response", { code: "bad_response" });

  // Start at the current local hour.
  const offset = (A[0].utc_offset_seconds || 0) * 1000;
  const nowHour = new Date(now + offset).toISOString().slice(0, 13) + ":00";
  const t0 = Math.max(0, A[0].hourly.time.indexOf(nowHour));
  const idx = Array.from({ length: FRAMES }, (_, k) => t0 + k * FRAME_STEP_H).filter((i) => i < A[0].hourly.time.length);
  const frame = (list, v) => idx.map((i) => list.map((loc) => r1(loc.hourly[v]?.[i])));

  return {
    kind: "dispersion",
    region: { id: region.id, name: region.name, lat: region.lat, lon: region.lon },
    grid,
    times: idx.map((i) => A[0].hourly.time[i]),
    pm2_5: frame(A, "pm2_5"),
    dust: frame(A, "dust"),
    windSpeed: frame(Wx, "wind_speed_10m"),
    windDir: frame(Wx, "wind_direction_10m"),
    fires: fires.slice(0, 200),
    source: "Copernicus CAMS global forecast (0.4° grid) via Open-Meteo. Model forecast, not measurements.",
    fetchedAt: now,
  };
}

// ---------------------------------------------------------------- heat anomaly grid

const WINDOW_DAYS = 6; // ±6 days = 13 days per year, which counts as one call per point
const BASELINE_YEARS = 10;

const ymd = (d) => d.toISOString().slice(0, 10);
const doy = (d) => Math.floor((d - Date.UTC(d.getUTCFullYear(), 0, 1)) / DAY_MS);

/** Per-point daily wet-bulb mean/std for this calendar window over the last 10 years. */
export async function buildHeatBaseline(region, grid, { fetch, now = Date.now(), retryWaitMs = 15_000 } = {}) {
  const today = new Date(now);
  const year = today.getUTCFullYear();
  const perPoint = grid.points.map(() => []);
  const years = Array.from({ length: BASELINE_YEARS }, (_, i) => year - 1 - i);
  // One year at a time: 10 parallel requests x 25 points tripped Open-Meteo's
  // per-minute limit. On a 429, wait and retry once.
  const results = [];
  for (const y of years) {
    const centre = new Date(Date.UTC(y, today.getUTCMonth(), today.getUTCDate()));
    const q = new URLSearchParams({
      ...coords(grid.points),
      start_date: ymd(new Date(centre - WINDOW_DAYS * DAY_MS)),
      end_date: ymd(new Date(+centre + WINDOW_DAYS * DAY_MS)),
      daily: "temperature_2m_max,relative_humidity_2m_min",
      timezone: "auto",
    });
    try {
      results.push(await getJson("Open-Meteo archive", ARCHIVE + q, { fetch, timeoutMs: GRID_TIMEOUT_MS }));
    } catch (e) {
      if (e.code !== "rate_limited") throw e;
      await new Promise((r) => setTimeout(r, retryWaitMs));
      results.push(await getJson("Open-Meteo archive", ARCHIVE + q, { fetch, timeoutMs: GRID_TIMEOUT_MS }));
    }
  }
  for (const res of results)
    asList(res).forEach((loc, i) => {
      const d = loc.daily || {};
      (d.time || []).forEach((_, k) => {
        const t = d.temperature_2m_max?.[k], rh = d.relative_humidity_2m_min?.[k];
        if (Number.isFinite(t) && Number.isFinite(rh)) perPoint[i]?.push(wetBulbStull(t, rh));
      });
    });
  return {
    centreDoy: doy(today),
    builtAt: now,
    points: perPoint.map((vals) => {
      const { mean, std, n } = meanStd(vals);
      return { mean: r1(mean), std: Math.round(std * 100) / 100, n };
    }),
  };
}

export async function buildHeatGrid(region, { fetch, now = Date.now(), baseline, retryWaitMs } = {}) {
  const grid = gridAround(region, 5, 0.6);
  const q = new URLSearchParams({ ...coords(grid.points), daily: "temperature_2m_max,relative_humidity_2m_min", forecast_days: "1", timezone: "auto" });
  const today = asList(await getJson("Open-Meteo", FORECAST + q, { fetch, timeoutMs: GRID_TIMEOUT_MS }));
  if (today.length !== grid.points.length) throw new SourceError("Open-Meteo", "unexpected grid response", { code: "bad_response" });
  // Without a baseline the map still shows today's values, just not the anomaly.
  let base = baseline;
  let baselineError = null;
  if (!base)
    try {
      base = await buildHeatBaseline(region, grid, { fetch, now, retryWaitMs });
    } catch (e) {
      baselineError = e.code === "rate_limited" ? "The weather archive is busy, so the comparison with normal isn't available yet. Try again in a few minutes." : "The comparison with normal couldn't be built right now.";
      base = null;
    }
  const cells = grid.points.map(([lat, lon], i) => {
    const d = today[i].daily || {};
    const tmax = d.temperature_2m_max?.[0];
    const rh = d.relative_humidity_2m_min?.[0];
    const tw = Number.isFinite(tmax) && Number.isFinite(rh) ? wetBulbStull(tmax, rh) : null;
    const b = base?.points[i] || {};
    const z = tw != null && b.n >= 20 && b.std > 0 ? (tw - b.mean) / b.std : null;
    return { lat, lon, tw: r1(tw), mean: b.mean ?? null, std: b.std ?? null, n: b.n ?? 0, z: r1(z) };
  });
  return {
    kind: "heatgrid",
    region: { id: region.id, name: region.name, lat: region.lat, lon: region.lon },
    grid,
    date: today[0]?.daily?.time?.[0] || ymd(new Date(now)),
    cells,
    source: `Open-Meteo forecast (today) vs ERA5 archive (±${WINDOW_DAYS} days, ${BASELINE_YEARS} years) at each point. Daily wet-bulb = Stull (2011) of Tmax and min RH.`,
    fetchedAt: now,
    baselineBuiltAt: base?.builtAt ?? null,
    ...(baselineError ? { baselineError } : {}),
    _baseline: base, // stripped before sending
  };
}

// ---------------------------------------------------------------- cached access

const doyGap = (a, b) => Math.min(Math.abs(a - b), 365 - Math.abs(a - b));

export async function getDispersion(region, env, deps = {}, { now = Date.now(), fires = [] } = {}) {
  const store = deps.store || makeStore(env);
  const key = `disp:v1:${region.id}`;
  const cached = await store.get(key);
  if (cached && now - cached.fetchedAt < DATA_TTL_MS) return cached;
  const fresh = await buildDispersion(region, { fetch: deps.fetch, now, fires });
  await store.put(key, fresh, 6 * 3600);
  return fresh;
}

export async function getHeatGrid(region, env, deps = {}, { now = Date.now() } = {}) {
  const store = deps.store || makeStore(env);
  const key = `heatgrid:v1:${region.id}`;
  const cached = await store.get(key);
  if (cached && now - cached.fetchedAt < DATA_TTL_MS) return cached;
  // The baseline is expensive (10 archive requests × 25 points): reuse it
  // while the calendar window still fits (within 3 days) and it's under 30 days old.
  const bkey = `heatgrid-base:v1:${region.id}`;
  let baseline = await store.get(bkey);
  if (!baseline || doyGap(baseline.centreDoy, doy(new Date(now))) > 3 || now - baseline.builtAt > 30 * DAY_MS) baseline = null;
  const fresh = await buildHeatGrid(region, { fetch: deps.fetch, now, baseline, retryWaitMs: deps.retryWaitMs });
  if (!baseline && fresh._baseline) await store.put(bkey, fresh._baseline, 40 * 86_400);
  delete fresh._baseline;
  // Without the anomaly, cache only briefly so the next open retries the baseline.
  await store.put(key, fresh, fresh.baselineError ? 60 : 6 * 3600);
  return fresh;
}
