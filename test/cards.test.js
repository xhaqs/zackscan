import { test } from "node:test";
import assert from "node:assert/strict";
import { briefing } from "../public/js/briefing.js";
import { divergingColor, frpColor, COOL, WARM, MID } from "../public/js/charts.js";
import { pickAnomalies } from "../public/js/anomaly-deck.js";

const dubai = { id: "dubai", name: "Dubai, UAE", lat: 25.2, lon: 55.27 };
const JARGON = /σ|sigma|z-score|VPD|AQI|FRP|p =|p-value|Poisson|Stull|kPa|µg|Tw\b|baseline/i;

const heatPillar = (tw, z) => ({
  score: 62, level: "high", status: "live", asOf: new Date().toISOString(),
  components: {
    severity: { peakWetBulbC: tw, at: "2026-09-25T14:00", tempC: 37, relativeHumidityPct: 55, series: [["2026-09-25T13:00", tw - 1], ["2026-09-25T14:00", tw]] },
    anomaly: z == null ? null : { zScore: z, dailyWetBulbC: 27.8, baselineMeanC: 24.2, baselineStdC: 2.7, baselineDays: 150 },
  },
});

test("heat briefing: plain is jargon-free and matches the danger band; researcher carries the statistics", () => {
  const b = briefing(dubai, "heat", heatPillar(29.7, 1.3));
  assert.equal(b.riskLevel, "high");
  assert.match(b.plain.headline, /Dangerous heat for outdoor work in Dubai/);
  assert.match(b.plain.summary, /hotter than usual/);
  assert.ok(b.plain.whatToDo.length >= 2);
  for (const s of [b.plain.headline, b.plain.summary, ...b.plain.whatToDo, ...b.plain.whatItMeans]) assert.doesNotMatch(s, JARGON, s);
  assert.match(b.researcher.summary, /Peak Tw 29\.7 °C/);
  assert.match(b.researcher.summary, /z = \+1\.3σ/);
  assert.equal(b.researcher.anomalies[0].deviation, "+1.3σ");
  assert.match(briefing(dubai, "heat", heatPillar(35.2, 3.1)).plain.headline, /Life-threatening/);
  assert.match(briefing(dubai, "heat", heatPillar(21, -1.4)).plain.summary, /cooler than usual/);
});

test("seismic and wildfire briefings: plain stays plain, researcher is precise", () => {
  const s = briefing(dubai, "seismic", {
    score: 55, level: "elevated", status: "live",
    area: { radiusKm: 300 },
    detail: { minMagnitude: 4, eventsLast7Days: 5, baselineEventsPerYear: 36.5, baselineYears: 10, largest: { mag: 5.4, depthKm: 12, place: "southern Iran" } },
    components: { clustering: { windowDays: 1, observed: 5, expected: 0.1, pValue: 0.000002 }, magnitudeAnomaly: { pValue: 0.03 } },
  });
  assert.match(s.plain.headline, /Moderate earthquake/);
  assert.match(s.plain.summary, /aftershocks are possible/);
  for (const x of [s.plain.headline, s.plain.summary]) assert.doesNotMatch(x, JARGON, x);
  assert.match(s.researcher.summary, /Poisson p = <0\.001/);

  const w = briefing(dubai, "wildfire", {
    score: 28, level: "guarded", status: "partial",
    components: { activity: null, fireWeather: { score: 48, vpdKpa: 2.2, relativeHumidityPct: 62, humidityDrop24hPts: -3, windKmh: 14 }, smoke: { pm25: 76.8, aqi: 166, stations: 1, likelySmoke: false } },
  });
  assert.match(w.plain.headline, /Poor air quality in Dubai/);
  assert.match(w.plain.summary, /unhealthy for everyone/);
  assert.match(w.plain.summary, /Fire detection isn't switched on/);
  for (const x of [w.plain.headline, w.plain.summary, ...w.plain.whatToDo]) assert.doesNotMatch(x, JARGON, x);
  assert.match(w.researcher.summary, /PM2\.5 median 76\.8 µg\/m³ \(US AQI 166/);
  assert.match(w.researcher.summary, /Δ24h \+3 pts/, "a humidity rise is shown as +");
});

test("GLOF briefing never pretends to be live", () => {
  const g = briefing({ name: "Kathmandu, Nepal" }, "glof", { status: "stub", label: "Preliminary / Non-Real-Time", referenceLakes: [{ name: "Tsho Rolpa", distanceKm: 114 }] });
  assert.equal(g.riskLevel, null);
  assert.match(g.plain.headline, /No live glacial lake data/);
  assert.match(g.plain.whatItMeans[0], /not a warning/);
  assert.match(g.researcher.summary, /stub/);
});

test("diverging scale: gray within ±0.5σ, symmetric arms, capped at the extremes", () => {
  assert.equal(divergingColor(0.2), MID);
  assert.equal(divergingColor(-0.4), MID);
  assert.equal(divergingColor(0.6), WARM[0]);
  assert.equal(divergingColor(-0.6), COOL[0]);
  assert.equal(divergingColor(1.3), WARM[1]);
  assert.equal(divergingColor(9), WARM[4]);
  assert.equal(divergingColor(-9), COOL[4]);
  assert.equal(divergingColor(null), MID);
  assert.deepEqual([1, 5, 20, 50, 100, 400].map(frpColor), [WARM[0], WARM[1], WARM[2], WARM[3], WARM[4], WARM[4]]);
});

test("deck: highest scores first, GLOF stubs after, pending regions skipped", () => {
  const m = {
    regions: [
      { id: "a", name: "A", pillars: { heat: { score: 20 }, wildfire: { score: 70 }, seismic: { score: null }, glof: { referenceLakes: [] } } },
      { id: "k", name: "K", pillars: { heat: { score: 5 }, wildfire: { score: 1 }, seismic: { score: 40 }, glof: { referenceLakes: [{ name: "Tsho Rolpa" }] } } },
      { id: "p", name: "P", pending: true },
    ],
  };
  const { live, stubs } = pickAnomalies(m);
  assert.deepEqual(live.map((x) => `${x.region.id}:${x.key}`), ["a:wildfire", "k:seismic", "a:heat", "k:heat", "k:wildfire"]);
  assert.deepEqual(stubs.map((x) => x.region.id), ["k"]);
});

test("heat briefing: an elevated score from an anomaly alone says 'unusually hot', not 'no heat'", () => {
  const b = briefing({ name: "Los Angeles, USA" }, "heat", heatPillar(21.8, 1.6));
  assert.match(b.plain.headline, /Unusually hot for this time of year/);
  assert.match(b.plain.summary, /Not dangerous heat/);
  assert.doesNotMatch(b.plain.summary, /hotter than usual.*hotter than usual/, "said once, not twice");
});
