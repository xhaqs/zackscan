import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { poissonUpperTail, surpriseScore, wetBulbStull, aqiFromPm25, levelFor } from "../src/risk/math.js";
import { scoreSeismic, scoreWildfire, scoreHeat, heatBaselineFromArchive } from "../src/risk/scoring.js";
import { parseFirmsCsv } from "../src/risk/sources/firms.js";
import { glofPillar } from "../src/risk/glof.js";
import { getMatrix, refreshStalest, LIVE_TTL_MS } from "../src/risk/matrix.js";
import { getRegion, REGIONS } from "../src/risk/regions.js";
import { makeStore, _resetMemoryStore } from "../src/risk/store.js";
import worker from "../src/worker.js";

const NOW = Date.parse("2026-09-25T12:00:00Z");
const DAY = 86_400_000;
beforeEach(() => _resetMemoryStore());

// ---------------------------------------------------------------- math

test("Poisson tail and surprise score match known values", () => {
  assert.equal(poissonUpperTail(0, 3), 1);
  assert.ok(Math.abs(poissonUpperTail(1, 1) - (1 - Math.exp(-1))) < 1e-12);
  assert.ok(Math.abs(poissonUpperTail(10, 1) / 1.1142547e-7 - 1) < 1e-4); // P(N>=10 | 1)
  const tiny = poissonUpperTail(600, 50); // true value ~1e-410: below double range
  assert.ok(tiny >= 0 && tiny < 1e-300 && surpriseScore(tiny) === 100);
  assert.equal(surpriseScore(1), 0);
  assert.equal(Math.round(surpriseScore(0.01)), 40);
  assert.equal(surpriseScore(1e-9), 100);
});

test("Stull wet-bulb matches the paper's worked example (20 °C, 50% -> 13.7 °C)", () => {
  assert.equal(Math.round(wetBulbStull(20, 50) * 10) / 10, 13.7);
  assert.ok(wetBulbStull(40, 60) > 32, "hot and humid is dangerous");
});

test("PM2.5 AQI uses the 2024 EPA breakpoints", () => {
  assert.deepEqual([9.0, 9.1, 35.4, 35.5, 55.5, 500].map(aqiFromPm25), [50, 51, 100, 101, 151, 500]);
  assert.deepEqual([0, 20, 40, 60, 80, null].map(levelFor), ["low", "guarded", "elevated", "high", "severe", "unknown"]);
});

// ---------------------------------------------------------------- pillars

const quake = (mag, hoursAgo) => ({ id: "q" + Math.random(), mag, time: NOW - hoursAgo * 3_600_000, place: "x", depthKm: 10 });

test("seismic: quiet week scores 0; a swarm in a quiet region scores high", () => {
  const baseline = { count: 20, days: 3652, years: 10 }; // ~2 M4+ a year
  assert.equal(scoreSeismic({ events: [], baseline, minMag: 4, now: NOW }).score, 0);
  const swarm = scoreSeismic({ events: [4.1, 4.3, 4.0, 4.6, 4.2].map((m, i) => quake(m, i)), baseline, minMag: 4, now: NOW });
  assert.ok(swarm.score >= 80, `swarm score ${swarm.score}`);
  assert.equal(swarm.components.clustering.windowDays, 1, "a one-day swarm is caught by the 1-day window");
});

test("seismic: a big quake is severe even where quakes are common", () => {
  const busy = { count: 2300, days: 3652, years: 10 };
  const r = scoreSeismic({ events: [quake(7.2, 5)], baseline: busy, minMag: 4, now: NOW });
  assert.ok(r.components.severity.score >= 85 && r.score >= 85);
  assert.equal(r.detail.largest.mag, 7.2);
});

test("wildfire: nothing configured and no weather means no score, not zero", () => {
  const r = scoreWildfire({ detections: null, weather: null, pm25: null });
  assert.equal(r.score, null);
});

test("wildfire: dry weather alone is capped as potential; real fires drive the score", () => {
  const dry = { vpdKpa: 4.5, rh: 8, rh24hAgo: 40, windKmh: 40 };
  const potential = scoreWildfire({ detections: [], weather: dry, pm25: null });
  assert.ok(potential.score <= 40, `potential ${potential.score}`);
  const fires = Array.from({ length: 300 }, () => ({ confidence: "n", frpMw: 50 }));
  const burning = scoreWildfire({ detections: [...fires, { confidence: "l", frpMw: 999 }], weather: dry, pm25: null });
  assert.ok(burning.score > potential.score && burning.score >= 60, `burning ${burning.score}`);
  assert.equal(burning.components.activity.detections, 300);
  assert.equal(burning.components.activity.lowConfidenceDropped, 1);
});

test("wildfire: PM2.5 without a nearby fire counts at half weight", () => {
  const pm = [{ value: 150 }, { value: 170 }, { value: 160 }]; // AQI ~ 211
  const noFire = scoreWildfire({ detections: [], weather: null, pm25: pm });
  const withFire = scoreWildfire({ detections: [{ confidence: "h", frpMw: 5 }], weather: null, pm25: pm });
  assert.equal(noFire.components.smoke.likelySmoke, false);
  assert.ok(withFire.score > noFire.score);
});

test("heat: dangerous wet-bulb is severe; anomaly needs enough baseline days", () => {
  const hourlyAhead = [{ time: "t", tempC: 38, rh: 70 }]; // Tw ~ 33
  const daily = [{ date: "2026-09-25", tmaxC: 38, rhMinPct: 60 }];
  const archive = [];
  for (let y = 2016; y <= 2025; y++)
    for (let d = 18; d <= 30; d++) archive.push({ date: `${y}-09-${String(d).padStart(2, "0")}`, tmaxC: 33 + (d % 3), rhMinPct: 40 });
  const r = scoreHeat({ hourlyAhead, daily, baseline: heatBaselineFromArchive(archive) });
  assert.ok(r.components.severity.score >= 85, `severity ${r.components.severity.score}`);
  assert.ok(r.components.anomaly.zScore > 3 && r.components.anomaly.baselineDays >= 100);
  const thin = scoreHeat({ hourlyAhead, daily, baseline: heatBaselineFromArchive(archive.slice(0, 5)) });
  assert.equal(thin.components.anomaly, null);
});

test("FIRMS: CSV parsed by header name; a key error is reported, not parsed as data", () => {
  const rows = parseFirmsCsv("latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight\n1.5,36.1,330,0.4,0.4,2026-09-25,1030,N20,VIIRS,n,2.0NRT,290,12.5,D\n");
  assert.deepEqual(rows[0], { lat: 1.5, lon: 36.1, frpMw: 12.5, confidence: "n", acq: "2026-09-25 1030" });
  assert.throws(() => parseFirmsCsv("Invalid MAP_KEY."), (e) => e.code === "unauthorized");
});

test("GLOF is a labelled stub: never a score, lakes are reference only", () => {
  const k = glofPillar(getRegion("kathmandu"));
  assert.equal(k.score, null);
  assert.equal(k.realtime, false);
  assert.equal(k.status, "stub");
  assert.equal(k.label, "Preliminary / Non-Real-Time");
  assert.deepEqual(k.referenceLakes.map((l) => l.id), ["tsho-rolpa", "imja-tsho", "south-lhonak"]);
  assert.deepEqual(glofPillar(getRegion("dubai")).referenceLakes, []);
});

// ---------------------------------------------------------------- matrix

function fakeApis({ failForecast = false, failUsgs = false } = {}) {
  const calls = [];
  const hourlyTimes = Array.from({ length: 72 }, (_, i) => new Date(Date.UTC(2026, 8, 24, i)).toISOString().slice(0, 13) + ":00");
  const fetch = async (url) => {
    const u = new URL(String(url));
    calls.push(u.host + u.pathname);
    if (u.host === "earthquake.usgs.gov") {
      if (failUsgs) return new Response("down", { status: 503 });
      if (u.pathname.endsWith("/count")) return Response.json({ count: 50, maxAllowed: 20000 });
      return Response.json({ features: [{ id: "a", properties: { mag: 4.4, time: NOW - 3_600_000, place: "near" }, geometry: { coordinates: [0, 0, 10] } }] });
    }
    if (u.host === "api.open-meteo.com") {
      if (failForecast) return new Response("down", { status: 500 });
      return Response.json({
        timezone: "UTC",
        current: { time: "2026-09-25T12:00", temperature_2m: 30, relative_humidity_2m: 30, vapour_pressure_deficit: 3.0, wind_speed_10m: 20 },
        hourly: { time: hourlyTimes, temperature_2m: hourlyTimes.map(() => 30), relative_humidity_2m: hourlyTimes.map((_, i) => (i < 36 ? 60 : 30)) },
        daily: { time: ["2026-09-24", "2026-09-25", "2026-09-26"], temperature_2m_max: [31, 32, 31], relative_humidity_2m_min: [30, 30, 30] },
      });
    }
    if (u.host === "archive-api.open-meteo.com") {
      const time = [], tmax = [], rh = [];
      for (let y = 2016; y <= 2025; y++)
        for (let d = 15; d <= 30; d++) (time.push(`${y}-09-${d}`), tmax.push(29 + (d % 4)), rh.push(30));
      return Response.json({ daily: { time, temperature_2m_max: tmax, relative_humidity_2m_min: rh } });
    }
    if (u.host === "firms.modaps.eosdis.nasa.gov")
      return new Response("latitude,longitude,frp,confidence,acq_date,acq_time\n1,1,40,h,2026-09-25,0900\n1,1,20,n,2026-09-25,0910\n");
    if (u.host === "api.openaq.org") {
      if (u.pathname === "/v3/locations")
        return Response.json({ results: [{ id: 7, name: "Station", distance: 900, sensors: [{ id: 70, parameter: { name: "pm25" } }, { id: 71, parameter: { name: "pm10" } }] }] });
      return Response.json({ results: [{ sensorsId: 70, value: 40, datetime: { utc: new Date(NOW - 600_000).toISOString() } }, { sensorsId: 71, value: 999, datetime: { utc: new Date(NOW).toISOString() } }] });
    }
    throw new Error("unexpected host " + u.host);
  };
  return { fetch, calls };
}

test("matrix: unified schema, four pillars, cached on the second call", async () => {
  const api = fakeApis();
  const env = {};
  const m = await getMatrix(env, { fetch: api.fetch }, { regionId: "nairobi", now: NOW });
  assert.equal(m.schema, "zackscan.risk-matrix/v1");
  assert.deepEqual(Object.keys(m.pillars), ["seismic", "wildfire", "heat", "glof"]);
  const r = m.regions[0];
  assert.deepEqual(Object.keys(r.pillars), ["seismic", "wildfire", "heat", "glof"]);
  assert.equal(r.pillars.seismic.status, "live");
  assert.equal(r.pillars.heat.status, "live");
  assert.ok(r.pillars.heat.components.anomaly, "10-year baseline used");
  assert.equal(r.pillars.wildfire.status, "partial", "no FIRMS/OpenAQ keys");
  assert.deepEqual(r.pillars.wildfire.configured, { firms: false, openaq: false });
  assert.equal(r.pillars.wildfire.components.fireWeather.humidityDrop24hPts, 30);
  assert.equal(r.pillars.glof.score, null);
  assert.equal(r.overall.score, Math.max(r.pillars.seismic.score, r.pillars.wildfire.score, r.pillars.heat.score));
  assert.ok(!api.calls.some((c) => c.includes("firms") || c.includes("openaq")), "no calls to unconfigured sources");

  const before = api.calls.length;
  const again = await getMatrix(env, { fetch: api.fetch }, { regionId: "nairobi", now: NOW + 5 * 60_000 });
  assert.equal(api.calls.length, before, "served from cache");
  assert.equal(again.regions[0].ageSeconds, 300);
});

test("matrix: with keys, FIRMS and OpenAQ feed the wildfire pillar", async () => {
  const api = fakeApis();
  const m = await getMatrix({ FIRMS_MAP_KEY: "k", OPENAQ_API_KEY: "k" }, { fetch: api.fetch }, { regionId: "delhi", now: NOW });
  const w = m.regions[0].pillars.wildfire;
  assert.equal(w.status, "live");
  assert.equal(w.components.activity.detections, 2);
  assert.equal(w.components.smoke.pm25, 40, "only the PM2.5 sensor is used, not PM10");
  assert.equal(w.configured, undefined);
});

test("matrix: the baseline is fetched once a week, not every refresh", async () => {
  const api = fakeApis();
  await getMatrix({}, { fetch: api.fetch }, { regionId: "tokyo", now: NOW });
  await getMatrix({}, { fetch: api.fetch }, { regionId: "tokyo", now: NOW + LIVE_TTL_MS + 1000 });
  const count = (s) => api.calls.filter((c) => c.includes(s)).length;
  assert.equal(count("/count"), 1);
  assert.equal(count("archive-api"), 1);
  assert.equal(count("/query"), 2);
});

test("matrix: a failed refresh shows the last good data as stale, then gives up after 6 h", async () => {
  await getMatrix({}, { fetch: fakeApis().fetch }, { regionId: "dubai", now: NOW });
  const later = NOW + LIVE_TTL_MS + 1000;
  const stale = (await getMatrix({}, { fetch: fakeApis({ failUsgs: true, failForecast: true }).fetch }, { regionId: "dubai", now: later })).regions[0];
  assert.equal(stale.pillars.seismic.status, "stale");
  assert.ok(stale.pillars.seismic.score != null);
  assert.equal(stale.pillars.heat.status, "stale");
  assert.match(stale.pillars.heat.notes.at(-1), /Refresh failed/);

  const muchLater = NOW + 7 * 3_600_000;
  const gone = (await getMatrix({}, { fetch: fakeApis({ failUsgs: true, failForecast: true }).fetch }, { regionId: "dubai", now: muchLater })).regions[0];
  assert.equal(gone.pillars.seismic.status, "error");
  assert.equal(gone.pillars.seismic.score, null);
  assert.equal(gone.overall.score, null);
});

test("matrix: at most `computeBudget` regions are computed per request", async () => {
  const api = fakeApis();
  const m = await getMatrix({}, { fetch: api.fetch }, { now: NOW, computeBudget: 2 });
  assert.equal(m.regions.length, REGIONS.length);
  assert.equal(m.regions.filter((r) => r.pillars).length, 2);
  assert.equal(m.regions.filter((r) => r.pending).length, REGIONS.length - 2);
});

test("cron refreshes the stalest regions first", async () => {
  const api = fakeApis();
  const store = makeStore({});
  let done = await refreshStalest({}, { fetch: api.fetch, store }, { now: NOW, count: 3 });
  assert.equal(done.length, 3);
  const second = await refreshStalest({}, { fetch: api.fetch, store }, { now: NOW + 60_000, count: 3 });
  assert.deepEqual(new Set([...done, ...second]).size, 6, "the other three come next");
  done = await refreshStalest({}, { fetch: api.fetch, store }, { now: NOW + 120_000, count: 3 });
  assert.deepEqual(done, [], "nothing is due yet");
});

test("worker: /api/risk rejects unknown regions", async () => {
  const res = await worker.fetch(new Request("https://z.test/api/risk?region=atlantis"), {}, {});
  assert.equal(res.status, 400);
});
