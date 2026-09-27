import { test } from "node:test";
import assert from "node:assert/strict";
import { weatherSummary, climateFromArchive } from "../src/risk/weather.js";
import { weatherTelemetry } from "../public/js/weather-widget.js";

// 10 years × the ±7-day window around 25 Sep: Tmax 38 ± ~1.4, RH 60, wind 20 ± ~2.
function archive() {
  const rows = [];
  for (let y = 2016; y <= 2025; y++)
    for (let d = 18; d <= 30; d++)
      rows.push({
        date: `${y}-09-${String(d).padStart(2, "0")}`,
        tmaxC: 36 + (d % 5),
        rhMeanPct: 55 + (d % 3) * 5,
        windMaxKmh: 18 + (d % 4),
      });
  // Outside the window: must be ignored.
  for (let y = 2016; y <= 2025; y++)
    rows.push({ date: `${y}-01-15`, tmaxC: 22, rhMeanPct: 40, windMaxKmh: 40 });
  return rows;
}

test("weather: today's daily values vs the same calendar window over 10 years", () => {
  const climate = climateFromArchive(archive());
  const s = weatherSummary({
    current: { time: "2026-09-25T14:00", tempC: 35.2, rh: 55, windKmh: 12.4 },
    today: { date: "2026-09-25", tmaxC: 41.5, rhMeanPct: 60, windMaxKmh: 14 },
    climate,
    asOf: "2026-09-25T10:00:00Z",
  });
  assert.equal(
    s.normals.tmax.n,
    130,
    "only the ±7-day window (Jan rows excluded)",
  );
  assert.equal(s.normals.tmax.mean, 38.1); // 495 / 13 days
  assert.ok(s.normals.tmax.z > 2, "41.5 °C is well above a 38 °C normal");
  assert.ok(
    s.normals.windMax.z < -1,
    "14 km/h is calmer than a ~19.5 km/h normal",
  );
  assert.equal(s.current.tempC, 35.2);
  assert.equal(s.baselineYears, 10);
  const none = weatherSummary({
    current: null,
    today: { date: "2026-09-25", tmaxC: 30 },
    climate: null,
  });
  assert.deepEqual(none.normals, {});
  assert.equal(none.baselineYears, 0);
});

test("weather telemetry: the widget's text matches the brief's format", () => {
  const climate = climateFromArchive(archive());
  const weather = weatherSummary({
    current: { time: "t", tempC: 35, rh: 50, windKmh: 10 },
    today: { date: "2026-09-25", tmaxC: 41.5, rhMeanPct: 60, windMaxKmh: 14 },
    climate,
    asOf: new Date().toISOString(),
  });
  const t = weatherTelemetry(
    { regions: [{ id: "dubai", name: "Dubai, UAE", weather }] },
    "dubai",
    Date.parse("2026-09-25T12:00:00Z"),
  );
  assert.equal(t.ready, true);
  const high = t.rows.find((r) => r.key === "tmax");
  assert.equal(high.value, 41.5);
  assert.match(high.text, /^\+\d\.\dσ above seasonal average \(hotter\)$/);
  assert.match(
    t.rows.find((r) => r.key === "windMax").text,
    /below seasonal average \(calmer\)/,
  );
  assert.match(
    t.rows.find((r) => r.key === "rhMean").text,
    /about the seasonal average|seasonal average/,
  );
  assert.match(t.baselineLabel, /2016–2025/);
  assert.equal(weatherTelemetry({ regions: [] }, "tokyo").ready, false);
});

test("operator profile: cleaned, bounded, unknown values fall back", async () => {
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => mem.get(k) ?? null,
    setItem: (k, v) => mem.set(k, String(v)),
  };
  globalThis.dispatchEvent = () => true;
  globalThis.CustomEvent ??= class extends Event {
    constructor(t, o) {
      super(t);
      this.detail = o?.detail;
    }
  };
  const { getOperator, setOperator } = await import("../public/js/operator.js");
  const def = getOperator();
  assert.equal(def.name, "");
  assert.equal(def.role, "public");
  assert.equal(def.homeRegion, "nairobi");
  assert.deepEqual(def.homeLocation, { id: "nairobi" });
  const v = setOperator({
    name: "  Amina\u0007 Wanjiru  ",
    organization: "x".repeat(200),
    role: "admin",
    homeRegion: "atlantis",
  });
  assert.equal(v.name, "Amina Wanjiru");
  assert.equal(v.organization.length, 80);
  assert.equal(v.role, "public", "no made-up roles");
  assert.equal(v.homeRegion, "nairobi");
  assert.equal(
    setOperator({ role: "analyst", homeRegion: "dubai" }).role,
    "analyst",
  );
  assert.equal(getOperator().homeRegion, "dubai");
  // Custom location stores full object
  const custom = {
    id: "geo_13.75_100.517",
    name: "Bangkok, Thailand",
    lat: 13.75,
    lon: 100.517,
    custom: true,
  };
  const vc = setOperator({ homeLocation: custom });
  assert.deepEqual(vc.homeLocation, custom);
  assert.equal(
    vc.homeRegion,
    "nairobi",
    "custom loc doesn't overwrite homeRegion fallback",
  );
});
