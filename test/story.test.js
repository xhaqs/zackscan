import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStoryModel, keyMetrics, sitrepText, wrapText } from "../public/js/story-model.js";

const measure = (s) => s.length * 10; // 10px per character
const tiered = {
  riskLevel: "high",
  plain: { headline: "Dangerous heat for outdoor work in Dubai", summary: "Heavy work outside can quickly cause heat illness.", whatItMeans: [], whatToDo: ["Work early or late.", "Drink water.", "Check on neighbours."] },
  researcher: { summary: "Peak Tw 30 °C; z = +1.1σ.", findings: [], anomalies: [{ variable: "Daily wet-bulb", observed: "27.3 °C", baseline: "24.2 ± 2.7 °C", deviation: "+1.1σ" }], dataVariables: [], limitations: [] },
};

test("story text follows the tier the user is looking at", () => {
  const p = sitrepText(tiered, "plain");
  assert.equal(p.headline, "Dangerous heat for outdoor work in Dubai");
  assert.deepEqual(p.bullets, ["Work early or late.", "Drink water."], "at most two actions");
  const r = sitrepText(tiered, "researcher");
  assert.equal(r.headline, null);
  assert.match(r.body, /z = \+1\.1σ/);
  assert.deepEqual(r.bullets, ["Daily wet-bulb: 27.3 °C vs 24.2 ± 2.7 °C (+1.1σ)"]);
});

test("story model: header, metrics, sources, link and file name", () => {
  const pillar = {
    score: 65, level: "high", asOf: "2026-09-25T20:00:00Z",
    components: { severity: { peakWetBulbC: 30, series: [["a", 28.5], ["b", 30], ["c", 27]] }, anomaly: { zScore: -0.84 } },
  };
  const m = buildStoryModel({ region: { id: "dubai", name: "Dubai, UAE" }, key: "heat", pillar, tiered, tier: "researcher", sourceLabel: "Written from the data", origin: "https://zackscan.riakoine.workers.dev" });
  assert.equal(m.badge, "EXTREME HEAT · HIGH");
  assert.equal(m.title, "Dubai, UAE: Extreme heat");
  assert.equal(m.score, 65);
  assert.equal(m.when, "Live · 2026-09-25 20:00 UTC");
  assert.deepEqual(m.metrics, [["Peak wet-bulb (48 h)", "30 °C"], ["vs normal for date", "−0.8σ"], ["Hours ≥ 28 °C", "2"]]);
  assert.equal(m.tierLabel, "Researcher");
  assert.equal(m.link, "zackscan.riakoine.workers.dev/?focus=dubai");
  assert.equal(m.fileName, "zackscan-dubai-heat-2026-09-25.jpg");
  assert.ok(m.sources.some((s) => /ERA5/.test(s)));
});

test("GLOF story is marked as not live", () => {
  const m = buildStoryModel({ region: { id: "kathmandu", name: "Kathmandu, Nepal" }, key: "glof", pillar: { status: "stub", label: "Preliminary / Non-Real-Time", referenceLakes: [1, 2, 3] }, tiered, tier: "plain", sourceLabel: "x" });
  assert.equal(m.badge, "GLOF · PRELIMINARY");
  assert.equal(m.stub, "Preliminary / Non-Real-Time");
  assert.equal(m.score, null);
  assert.deepEqual(keyMetrics("glof", { referenceLakes: [1, 2, 3] })[1], ["Reference lakes", "3"]);
});

test("wrapText: fits the width, respects max lines, ellipsis when cut", () => {
  const lines = wrapText("one two three four five six seven", 100, measure);
  assert.ok(lines.every((l) => measure(l) <= 100));
  assert.equal(lines.join(" "), "one two three four five six seven");
  const cut = wrapText("alpha beta gamma delta epsilon zeta eta theta", 100, measure, 2);
  assert.equal(cut.length, 2);
  assert.ok(cut[1].endsWith("…"));
  assert.ok(measure(cut[1]) <= 100);
  assert.deepEqual(wrapText("", 100, measure), []);
  assert.deepEqual(wrapText("supercalifragilistic", 50, measure), ["supercalifragilistic"], "a single long word is kept, not lost");
});
