// Builds the unified risk matrix: four pillars per watchlist region.
//
//   seismic   live   USGS
//   wildfire  live   NASA FIRMS (key) + Open-Meteo fire weather + OpenAQ PM2.5 (key)
//   heat      live   Open-Meteo forecast + 10-year archive baseline
//   glof      STUB   static reference data, no score (see glof.js)
//
// Caching (KV via store.js):
//   risk:v1:<region>      whole region result, fresh for 20 min
//   baseline:v1:<region>  history each score is compared against, per part, 7 days
// A cron refreshes the stalest regions every 10 minutes, so visitors almost
// always get cached data and upstream APIs see a steady, small load.

import { REGIONS, getRegion } from "./regions.js";
import { makeStore } from "./store.js";
import { levelFor } from "./math.js";
import { scoreSeismic, scoreWildfire, scoreHeat, heatBaselineFromArchive } from "./scoring.js";
import { glofPillar, GLOF_LABEL } from "./glof.js";
import { recentQuakes, historicalQuakeCount } from "./sources/usgs.js";
import { forecast, archiveDaily } from "./sources/openmeteo.js";
import { fireDetections } from "./sources/firms.js";
import { pm25Stations, pm25Latest } from "./sources/openaq.js";

export const SCHEMA = "zackscan.risk-matrix/v1";
export const LIVE_TTL_MS = 20 * 60_000;
const BASELINE_TTL_MS = 7 * 86_400_000;
const STALE_LIMIT_MS = 6 * 3_600_000; // after this, stale data is dropped, not shown
const riskKey = (id) => `risk:v1:${id}`;
const baselineKey = (id) => `baseline:v1:${id}`;

export const PILLARS = Object.freeze({
  seismic: { name: "Seismic & Geological", realtime: true, sources: ["USGS"] },
  wildfire: { name: "Thermal & Wildfire", realtime: true, sources: ["NASA FIRMS", "Open-Meteo", "OpenAQ"] },
  heat: { name: "Extreme Heat", realtime: true, sources: ["Open-Meteo"] },
  glof: { name: "Cryospheric & Hydrological (GLOF)", realtime: false, label: GLOF_LABEL, sources: [] },
});
export const SCORE_BANDS = { low: [0, 19], guarded: [20, 39], elevated: [40, 59], high: [60, 79], severe: [80, 100] };

// ------------------------------------------------------------- baseline

async function loadBaseline(region, env, store, deps, now) {
  const old = (await store.get(baselineKey(region.id))) || {};
  const fresh = (part) => old[part] && now - old[part].fetchedAt < BASELINE_TTL_MS;
  const year = new Date(now).getUTCFullYear();

  const jobs = {
    seismic: () => historicalQuakeCount(region, { now, fetch: deps.fetch }),
    heat: () =>
      archiveDaily(region, { startDate: `${year - 10}-01-01`, endDate: `${year - 1}-12-31`, fetch: deps.fetch }).then(heatBaselineFromArchive),
    ...(env.OPENAQ_API_KEY ? { aq: () => pm25Stations(region, { apiKey: env.OPENAQ_API_KEY, fetch: deps.fetch }) } : {}),
  };
  const due = Object.keys(jobs).filter((p) => !fresh(p));
  if (!due.length) return old;

  const results = await Promise.allSettled(due.map((p) => jobs[p]()));
  const next = { ...old };
  results.forEach((r, i) => {
    // A failed part keeps its old value and old timestamp, so it's retried next refresh.
    if (r.status === "fulfilled") next[due[i]] = { value: r.value, fetchedAt: now };
    else console.warn("baseline", region.id, due[i], r.reason?.message);
  });
  await store.put(baselineKey(region.id), next, 14 * 86_400);
  return next;
}

// ------------------------------------------------------------- pillars

function livePillar(result, { sources, asOf, status = "live", notes = [] }) {
  return {
    score: result.score,
    level: levelFor(result.score),
    status: result.score == null ? "error" : result.partial ? "partial" : status,
    realtime: true,
    asOf,
    sources,
    components: result.components,
    ...(result.detail ? { detail: result.detail } : {}),
    ...(result.method ? { method: result.method } : {}),
    notes: [...(result.notes || []), ...notes],
  };
}

/** Use the last good pillar, marked stale, if it's recent enough; otherwise an error. */
function fallback(prev, reason, now, sources) {
  if (prev && prev.score != null && prev.asOf && now - Date.parse(prev.asOf) < STALE_LIMIT_MS)
    return {
      ...prev,
      status: "stale",
      notes: [...(prev.notes || []).filter((n) => !n.startsWith("Refresh failed")), `Refresh failed (${reason}); showing data from ${prev.asOf}.`],
    };
  return { score: null, level: "unknown", status: "error", realtime: true, asOf: null, sources, components: null, notes: [`No data: ${reason}.`] };
}

const why = (r) => (r.status === "rejected" ? r.reason?.message || "failed" : null);

// ------------------------------------------------------------- region

export async function refreshRegion(region, env, deps = {}, { now = Date.now(), previous = null } = {}) {
  const store = deps.store || makeStore(env);
  const base = await loadBaseline(region, env, store, deps, now);
  const stations = base.aq?.value || [];

  const [quakes, wx, fires, pm] = await Promise.allSettled([
    recentQuakes(region, { days: 7, now, fetch: deps.fetch }),
    forecast(region, { fetch: deps.fetch }),
    env.FIRMS_MAP_KEY
      ? fireDetections(region, { mapKey: env.FIRMS_MAP_KEY, source: env.FIRMS_SOURCE || undefined, days: 1, fetch: deps.fetch })
      : Promise.resolve(null),
    env.OPENAQ_API_KEY ? pm25Latest(stations, { apiKey: env.OPENAQ_API_KEY, now, fetch: deps.fetch }) : Promise.resolve(null),
  ]);
  const asOf = new Date(now).toISOString();
  const prev = previous?.pillars || {};

  // Seismic
  let seismic;
  if (quakes.status === "fulfilled" && base.seismic)
    seismic = livePillar(scoreSeismic({ events: quakes.value, baseline: base.seismic.value, minMag: region.seismicMinMag, now }), {
      sources: ["USGS"],
      asOf,
    });
  else seismic = fallback(prev.seismic, why(quakes) || "no historical baseline yet", now, ["USGS"]);

  // Wildfire: score whatever inputs are available; say what's missing.
  const extra = [];
  if (fires.status === "rejected") extra.push(`FIRMS failed: ${why(fires)}.`);
  if (pm.status === "rejected") extra.push(`OpenAQ failed: ${why(pm)}.`);
  if (wx.status === "rejected") extra.push(`Open-Meteo failed: ${why(wx)}.`);
  const w = wx.status === "fulfilled" ? wx.value : null;
  const wf = scoreWildfire({
    detections: fires.status === "fulfilled" ? fires.value : null,
    weather: w ? { vpdKpa: w.current.vpdKpa, rh: w.current.rh, rh24hAgo: w.rh24hAgo, windKmh: w.current.windKmh } : null,
    pm25: pm.status === "fulfilled" ? pm.value : null,
  });
  const wildfire =
    wf.score == null
      ? fallback(prev.wildfire, extra.join(" ") || "no inputs", now, PILLARS.wildfire.sources)
      : livePillar({ ...wf, partial: wf.partial || extra.length > 0 }, { sources: PILLARS.wildfire.sources, asOf, notes: extra });
  if (!env.FIRMS_MAP_KEY || !env.OPENAQ_API_KEY) wildfire.configured = { firms: !!env.FIRMS_MAP_KEY, openaq: !!env.OPENAQ_API_KEY };

  // Heat
  let heat;
  if (w) {
    const h = scoreHeat({ hourlyAhead: w.hourlyAhead, daily: w.daily, baseline: base.heat?.value });
    const notes = base.heat ? [] : ["No 10-year baseline yet, so there's no anomaly score: severity only."];
    heat = h.score == null ? fallback(prev.heat, "no usable readings", now, ["Open-Meteo"]) : livePillar(h, { sources: ["Open-Meteo"], asOf, notes });
    if (!base.heat && heat.status === "live") heat.status = "partial";
  } else heat = fallback(prev.heat, why(wx), now, ["Open-Meteo"]);

  const pillars = { seismic, wildfire, heat, glof: glofPillar(region) };
  const scored = ["seismic", "wildfire", "heat"].filter((k) => pillars[k].score != null);
  const overallScore = scored.length ? Math.max(...scored.map((k) => pillars[k].score)) : null;

  const result = {
    id: region.id,
    name: region.name,
    lat: region.lat,
    lon: region.lon,
    updatedAt: asOf,
    overall: {
      score: overallScore,
      level: levelFor(overallScore),
      drivers: scored.filter((k) => pillars[k].score >= 40).sort((a, b) => pillars[b].score - pillars[a].score),
      note: "Overall is the highest live pillar score. GLOF is excluded (stub, no score).",
    },
    pillars,
  };
  await store.put(riskKey(region.id), result);
  return result;
}

async function readCached(region, store) {
  return store.get(riskKey(region.id));
}

const ageMs = (r, now) => (r?.updatedAt ? now - Date.parse(r.updatedAt) : Infinity);
const withAge = (r, now) => (r ? { ...r, ageSeconds: Math.round(ageMs(r, now) / 1000) } : r);

// ------------------------------------------------------------- public API

/**
 * Full matrix, or one region. Cached regions are served as-is while fresh.
 * Missing or old regions are computed live, at most `computeBudget` per
 * request (each costs ~6 upstream calls); the rest are served old or pending.
 */
export async function getMatrix(env, deps = {}, { regionId = null, now = Date.now(), computeBudget = 2 } = {}) {
  const store = deps.store || makeStore(env);
  const regions = regionId ? [getRegion(regionId)].filter(Boolean) : REGIONS;
  const cached = await Promise.all(regions.map((r) => readCached(r, store)));

  let budget = computeBudget;
  const out = [];
  // Missing regions first, then the oldest.
  const order = regions.map((r, i) => i).sort((a, b) => ageMs(cached[b], now) - ageMs(cached[a], now));
  const results = new Array(regions.length);
  for (const i of order) {
    const c = cached[i];
    if (ageMs(c, now) < LIVE_TTL_MS) results[i] = c;
    else if (budget > 0) {
      budget--;
      results[i] = await refreshRegion(regions[i], env, { ...deps, store }, { now, previous: c });
    } else results[i] = c ? { ...c, outdated: true } : { id: regions[i].id, name: regions[i].name, pending: true };
  }
  for (const r of results) out.push(withAge(r, now));

  return {
    schema: SCHEMA,
    generatedAt: new Date(now).toISOString(),
    pillars: PILLARS,
    scoreBands: SCORE_BANDS,
    regions: out,
  };
}

/**
 * Data-saver version: scores, levels, status and timestamps only, with no
 * components, notes or method text. About a quarter of the size, for poor
 * links and background sync.
 */
export function summarizeMatrix(m) {
  const slim = (p) => ({
    score: p.score,
    level: p.level,
    status: p.status,
    asOf: p.asOf,
    realtime: p.realtime,
    ...(p.label ? { label: p.label } : {}),
  });
  return {
    schema: m.schema,
    fields: "summary",
    generatedAt: m.generatedAt,
    scoreBands: m.scoreBands,
    regions: m.regions.map((r) =>
      r.pillars
        ? { id: r.id, name: r.name, updatedAt: r.updatedAt, overall: { score: r.overall.score, level: r.overall.level }, pillars: Object.fromEntries(Object.entries(r.pillars).map(([k, p]) => [k, slim(p)])), ...(r.outdated ? { outdated: true } : {}) }
        : r,
    ),
  };
}

/** What changing means for caching: which regions changed, and when. */
export const matrixVersion = (m, fields) => [fields, m.regions.map((r) => [r.id, r.updatedAt || null, !!r.pending, !!r.outdated])];

/** Cron: refresh the `count` stalest regions that are older than `minAgeMs`. */
export async function refreshStalest(env, deps = {}, { count = 3, now = Date.now(), minAgeMs = 15 * 60_000 } = {}) {
  const store = deps.store || makeStore(env);
  const cached = await Promise.all(REGIONS.map((r) => readCached(r, store)));
  const due = REGIONS.map((r, i) => ({ r, c: cached[i], age: ageMs(cached[i], now) }))
    .filter((x) => x.age >= minAgeMs)
    .sort((a, b) => b.age - a.age)
    .slice(0, count);
  const done = [];
  for (const { r, c } of due) {
    try {
      await refreshRegion(r, env, { ...deps, store }, { now, previous: c });
      done.push(r.id);
    } catch (e) {
      console.error("refresh failed", r.id, e?.message);
    }
  }
  return done;
}
