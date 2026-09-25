import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { gridAround, buildDispersion, getHeatGrid } from "../src/risk/grids.js";
import { getRegion } from "../src/risk/regions.js";
import { makeStore, _resetMemoryStore } from "../src/risk/store.js";
import { wetBulbStull } from "../src/risk/math.js";
import worker from "../src/worker.js";

const dubai = getRegion("dubai");
beforeEach(() => _resetMemoryStore());

test("grid: n×n points centred on the region, north-west first, exact spacing", () => {
  const g = gridAround(dubai, 7, 0.4);
  assert.equal(g.points.length, 49);
  assert.deepEqual(g.points[24], [Math.round(dubai.lat * 1000) / 1000, Math.round(dubai.lon * 1000) / 1000], "centre point is the region");
  assert.ok(g.points[0][0] > dubai.lat && g.points[0][1] < dubai.lon, "first point is north-west");
  assert.ok(Math.abs(g.points[1][1] - g.points[0][1] - 0.4) < 1e-9);
  assert.ok(Math.abs(g.points[0][0] - g.points[7][0] - 0.4) < 1e-9);
});

/** Fake Open-Meteo: answers per-location arrays in the order asked. */
function fakeMeteo({ archive429 = 0 } = {}) {
  const calls = { aq: 0, forecast: 0, archive: 0 };
  let left429 = archive429;
  const hours = Array.from({ length: 72 }, (_, i) => new Date(Date.UTC(2026, 8, 25, i)).toISOString().slice(0, 13) + ":00");
  const fetch = async (url) => {
    const u = new URL(String(url));
    const n = u.searchParams.get("latitude").split(",").length;
    const many = (f) => Response.json(Array.from({ length: n }, (_, i) => f(i)));
    if (u.host === "air-quality-api.open-meteo.com") {
      calls.aq++;
      return many((i) => ({ utc_offset_seconds: 0, hourly: { time: hours, pm2_5: hours.map((_, h) => i + h), dust: hours.map(() => 5) } }));
    }
    if (u.host === "api.open-meteo.com") {
      calls.forecast++;
      if (u.searchParams.get("daily")) return many(() => ({ daily: { time: ["2026-09-25"], temperature_2m_max: [40], relative_humidity_2m_min: [40] } }));
      return many(() => ({ hourly: { time: hours, wind_speed_10m: hours.map(() => 12), wind_direction_10m: hours.map(() => 270) } }));
    }
    if (u.host === "archive-api.open-meteo.com") {
      calls.archive++;
      if (left429 > 0) {
        left429--;
        return new Response("Too many requests", { status: 429 });
      }
      const days = Array.from({ length: 13 }, (_, d) => `x${d}`);
      return many(() => ({ daily: { time: days, temperature_2m_max: days.map((_, d) => 33 + (d % 3)), relative_humidity_2m_min: days.map(() => 40) } }));
    }
    throw new Error("unexpected " + u.host);
  };
  return { fetch, calls };
}

test("dispersion: frames start at the current hour, every 3 h, 48 h, one value per grid point", async () => {
  const { fetch, calls } = fakeMeteo();
  const d = await buildDispersion(dubai, { fetch, now: Date.parse("2026-09-25T10:20:00Z"), fires: [[25.2, 55.3, 12]] });
  assert.equal(d.times.length, 16);
  assert.equal(d.times[0], "2026-09-25T10:00");
  assert.equal(d.times[1], "2026-09-25T13:00");
  assert.equal(d.pm2_5.length, 16);
  assert.equal(d.pm2_5[0].length, 49);
  assert.equal(d.pm2_5[1][3], 3 + 13, "point 3 at hour index 13");
  assert.equal(d.windDir[0][0], 270);
  assert.deepEqual(d.fires, [[25.2, 55.3, 12]]);
  assert.match(d.source, /CAMS.*Model forecast, not measurements/);
  assert.deepEqual(calls, { aq: 1, forecast: 1, archive: 0 }, "two requests for the whole grid");
});

test("heat grid: z-score per point against its own 10-year window; baseline reused", async () => {
  const { fetch, calls } = fakeMeteo();
  const now = Date.parse("2026-09-25T10:00:00Z");
  const h = await getHeatGrid(dubai, {}, { fetch }, { now });
  assert.equal(h.cells.length, 25);
  const tws = [33, 34, 35].map((t) => wetBulbStull(t, 40));
  const c = h.cells[12];
  assert.equal(c.n, 130, "10 years × 13 days");
  assert.equal(c.tw, Math.round(wetBulbStull(40, 40) * 10) / 10);
  assert.ok(c.z > 3, "a 40 °C day is far above a 33–35 °C normal");
  assert.ok(Math.abs(c.mean - (tws[0] * 5 + tws[1] * 4 + tws[2] * 4) / 13) < 0.1);
  assert.equal(calls.archive, 10);
  assert.equal(h._baseline, undefined, "baseline internals not sent");

  // Within the cache window: nothing refetched. After it: only today's values.
  await getHeatGrid(dubai, {}, { fetch }, { now: now + 3600_000 });
  assert.deepEqual([calls.forecast, calls.archive], [1, 10]);
  await getHeatGrid(dubai, {}, { fetch }, { now: now + 4 * 3600_000 });
  assert.deepEqual([calls.forecast, calls.archive], [2, 10], "baseline kept, only today refetched");
  // A week later the calendar window has moved: baseline rebuilt.
  await getHeatGrid(dubai, {}, { fetch }, { now: now + 7 * 86_400_000 });
  assert.equal(calls.archive, 20);
});

test("heat grid: a busy archive is retried once; if still busy, today's values show without the anomaly", async () => {
  const once = await getHeatGrid(dubai, {}, { fetch: fakeMeteo({ archive429: 1 }).fetch, retryWaitMs: 0 });
  assert.equal(once.baselineError, undefined, "one 429 is retried");
  assert.ok(once.cells[0].z != null);
  _resetMemoryStore();
  const busy = await getHeatGrid(dubai, {}, { fetch: fakeMeteo({ archive429: 5 }).fetch, retryWaitMs: 0 });
  assert.match(busy.baselineError, /busy/);
  assert.equal(busy.cells[0].z, null);
  assert.ok(busy.cells[0].tw != null, "today's value still shown");
  assert.equal(await makeStore({}).get("heatgrid-base:v1:dubai"), null, "no half-built baseline is stored");
});

test("worker: map endpoints validate the region", async () => {
  for (const p of ["/api/dispersion", "/api/heatgrid"]) {
    const r = await worker.fetch(new Request(`https://z.test${p}?region=atlantis`), {}, {});
    assert.equal(r.status, 400);
  }
});
