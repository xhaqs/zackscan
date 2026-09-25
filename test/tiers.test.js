import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { buildAssessmentPrompt, validateTiered, digestMatrix, telemetryFingerprint, TIERED_SCHEMA, PROMPT_VERSION } from "../src/ai/prompts.js";
import { getProfile } from "../public/js/profiles.js";
import { _resetMemoryStore } from "../src/risk/store.js";
import { _resetMemoryLimiter } from "../src/middleware/rate-limit.js";
import worker from "../src/worker.js";

const GEMINI_KEY = "AIza" + "B".repeat(35);
const TIERED = {
  riskLevel: "high",
  plain: { headline: "Dangerous heat in Dubai", summary: "It will feel extremely hot and sticky.", whatItMeans: ["Outdoor work is risky."], whatToDo: ["Drink water often."] },
  researcher: {
    summary: "Peak wet-bulb 29.7 °C (+1.3σ).",
    findings: [{ metric: "Heat", observation: "Wet-bulb above 28 °C", value: "29.7 °C", confidence: "high" }],
    anomalies: [{ variable: "Tw", observed: "27.8 °C", baseline: "24.2 ± 2.7 °C", deviation: "+1.3σ" }],
    dataVariables: [{ name: "temperature_2m", value: "36.9", unit: "°C", source: "Open-Meteo" }],
    limitations: ["FIRMS not configured"],
  },
};
const event = (id, time = 1) => ({ id, title: "Fire " + id, category: "wildfires", lat: 1, lon: 2, time, magnitude: 10, updates: 1 });

beforeEach(() => {
  _resetMemoryStore();
  _resetMemoryLimiter();
});

test("the prompt asks for both registers in one answer, with each register's rules", () => {
  const { system, prompt, schema, version } = buildAssessmentPrompt({ profile: getProfile("wildfire"), events: [event("a")], riskDigest: [{ region: "Dubai" }] });
  assert.equal(version, PROMPT_VERSION);
  assert.equal(schema, TIERED_SCHEMA);
  assert.match(system, /BOTH registers/);
  assert.match(system, /"plain" is for members of the public/);
  assert.match(system, /No jargon/);
  assert.match(system, /"researcher" is for emergency managers and scientists/);
  assert.match(system, /Poisson p-values/);
  assert.match(system, /never contradicts/);
  for (const m of getProfile("wildfire").metrics) assert.ok(system.includes(m), "mission metrics are included");
  assert.match(prompt, /Fire a/);
  assert.match(prompt, /Risk matrix/);
});

test("the schema is strict-mode safe: every object requires all its fields and allows no extras", () => {
  const walk = (s, path) => {
    if (s.type === "object") {
      assert.equal(s.additionalProperties, false, path);
      assert.deepEqual([...s.required].sort(), Object.keys(s.properties).sort(), path);
      for (const [k, v] of Object.entries(s.properties)) walk(v, path + "." + k);
    }
    if (s.type === "array") walk(s.items, path + "[]");
  };
  walk(TIERED_SCHEMA, "$");
  assert.deepEqual(Object.keys(TIERED_SCHEMA.properties), ["riskLevel", "plain", "researcher"]);
});

test("an answer missing a register is rejected", () => {
  assert.ok(validateTiered(structuredClone(TIERED)));
  assert.throws(() => validateTiered({ ...TIERED, plain: undefined }));
  assert.throws(() => validateTiered({ ...TIERED, researcher: { ...TIERED.researcher, summary: " " } }));
  assert.throws(() => validateTiered({ ...TIERED, riskLevel: "catastrophic" }));
});

test("fingerprint changes when the data changes, not when timestamps do", async () => {
  const base = { profileId: "wildfire", events: [event("a", 100)], riskDigest: digestMatrix({ regions: [] }) };
  const fp = await telemetryFingerprint(base);
  assert.match(fp, /^[0-9a-f]{24}$/);
  assert.equal(await telemetryFingerprint({ ...base }), fp, "stable");
  assert.notEqual(await telemetryFingerprint({ ...base, events: [event("a", 200)] }), fp, "an event update changes it");
  assert.notEqual(await telemetryFingerprint({ ...base, profileId: "flood" }), fp);

  const matrixAt = (updatedAt, peak) => ({ regions: [{ name: "Dubai", updatedAt, pillars: { heat: { score: 62, status: "live", asOf: updatedAt, components: { severity: { peakWetBulbC: peak } } } } }] });
  const d1 = digestMatrix(matrixAt("2026-09-25T12:00:00Z", 29.7));
  const d2 = digestMatrix(matrixAt("2026-09-25T12:20:00Z", 29.7));
  const d3 = digestMatrix(matrixAt("2026-09-25T12:40:00Z", 31.2));
  assert.deepEqual(d1, d2, "a refresh with the same values is not a change");
  assert.notDeepEqual(d1, d3);
});

// ---------------------------------------------------------------- the endpoint

function stubUpstream() {
  let llmCalls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = new URL(String(url));
    if (u.host === "eonet.gsfc.nasa.gov")
      return Response.json({ events: [{ id: "E1", title: "Fire A", categories: [{ id: "wildfires" }], geometry: [{ type: "Point", date: "2026-09-25T00:00:00Z", coordinates: [36.8, -1.3] }] }] });
    if (u.host === "generativelanguage.googleapis.com") {
      llmCalls++;
      const body = JSON.parse(init.body);
      assert.deepEqual(body.generationConfig.responseJsonSchema, TIERED_SCHEMA, "the two-tier schema is sent");
      return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(TIERED) }] } }] });
    }
    throw new Error("unexpected " + u.host);
  };
  return { calls: () => llmCalls, restore: () => (globalThis.fetch = realFetch) };
}

const post = (body, headers = {}, env = {}) =>
  worker.fetch(
    new Request("https://z.test/api/analyze", { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": "7.7.7.7", ...headers }, body: JSON.stringify(body) }),
    env,
    {},
  );

test("one call returns both tiers; the same telemetry again is 'unchanged' with no LLM call", async () => {
  const up = stubUpstream();
  try {
    const byok = { "X-Custom-AI-Key": GEMINI_KEY, "X-Custom-AI-Provider": "gemini" };
    const first = await (await post({ profile: "wildfire" }, byok)).json();
    assert.equal(up.calls(), 1);
    assert.equal(first.assessment.plain.headline, TIERED.plain.headline);
    assert.equal(first.assessment.researcher.anomalies[0].deviation, "+1.3σ");
    assert.equal(first.billing, "byok");
    assert.match(first.fingerprint, /^[0-9a-f]{24}$/);

    const again = await (await post({ profile: "wildfire", knownFingerprint: first.fingerprint }, byok)).json();
    assert.deepEqual(again, { profile: "wildfire", fingerprint: first.fingerprint, unchanged: true });
    assert.equal(up.calls(), 1, "no second LLM call");

    const noKey = await post({ profile: "wildfire", knownFingerprint: first.fingerprint });
    assert.equal(noKey.status, 200, "an unchanged check needs no key and no shared tier");

    const stale = await (await post({ profile: "wildfire", knownFingerprint: "0".repeat(24) }, byok)).json();
    assert.ok(stale.assessment);
    assert.equal(up.calls(), 2, "a different fingerprint regenerates");
  } finally {
    up.restore();
  }
});

test("shared tier: visitors share one generation and don't use up each other's allowance", async () => {
  const up = stubUpstream();
  try {
    const env = { PLATFORM_GEMINI_KEY: GEMINI_KEY, PLATFORM_DAILY_LIMIT: "1" };
    const a = await (await post({ profile: "wildfire" }, {}, env)).json();
    assert.equal(a.billing, "platform");
    assert.equal(a.allowance.used, 1);
    const b = await post({ profile: "wildfire" }, {}, env);
    const bj = await b.json();
    assert.equal(b.status, 200, "served from the shared cache though this IP's allowance is spent");
    assert.equal(bj.cached, true);
    assert.equal(up.calls(), 1);
  } finally {
    up.restore();
  }
});

test("an incomplete model answer is a clear error, not half a view", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    if (u.host === "eonet.gsfc.nasa.gov") return Response.json({ events: [{ id: "E1", title: "x", categories: [{ id: "wildfires" }], geometry: [] }] });
    return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ riskLevel: "low", plain: TIERED.plain }) }] } }] });
  };
  try {
    const res = await post({ profile: "wildfire" }, { "X-Custom-AI-Key": GEMINI_KEY, "X-Custom-AI-Provider": "gemini" });
    assert.equal(res.status, 502);
    assert.equal((await res.json()).code, "ai_bad_output");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a failed shared-tier generation doesn't use up the visitor's allowance", async () => {
  const realFetch = globalThis.fetch;
  let geminiOk = false;
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    if (u.host === "eonet.gsfc.nasa.gov") return Response.json({ events: [{ id: "E1", title: "Fire A", categories: [{ id: "wildfires" }], geometry: [] }] });
    return geminiOk
      ? Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(TIERED) }] } }] })
      : new Response(JSON.stringify({ error: { code: 503, message: "high demand" } }), { status: 503 });
  };
  try {
    const env = { PLATFORM_GEMINI_KEY: GEMINI_KEY, PLATFORM_DAILY_LIMIT: "1" };
    const failed = await post({ profile: "wildfire" }, {}, env);
    assert.equal(failed.status, 502);
    geminiOk = true;
    const ok = await post({ profile: "wildfire" }, {}, env);
    assert.equal(ok.status, 200, "the allowance of 1 is still there after the failure");
    assert.equal((await ok.json()).allowance.used, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---------------------------------------------------------------- anomaly-card SitReps

import { makeStore } from "../src/risk/store.js";
import { cardDigest, buildCardPrompt } from "../src/ai/prompts.js";

async function seedHeat(peak = 29.7) {
  const now = new Date().toISOString();
  await makeStore({}).put("risk:v1:dubai", {
    id: "dubai", name: "Dubai, UAE", updatedAt: now, overall: { score: 62, level: "high" },
    pillars: { heat: { score: 62, level: "high", status: "live", asOf: now, components: {
      severity: { score: 62, peakWetBulbC: peak, at: "2026-09-25T14:00", tempC: 37, relativeHumidityPct: 55, series: [["2026-09-25T13:00", 29.1], ["2026-09-25T14:00", peak]] },
      anomaly: { score: 33, zScore: 1.3, dailyWetBulbC: 27.8, baselineMeanC: 24.2, baselineStdC: 2.7, baselineDays: 150 },
    } } },
  });
}

test("card digest: values only, timestamps out, the two heat measures kept apart", () => {
  const p = { score: 62, level: "high", status: "live", asOf: "x", components: { severity: { peakWetBulbC: 29.7, at: "2026-09-25T14:00", series: [["a", 28.5], ["b", 31.2], ["c", 27]] }, anomaly: { zScore: 1.3, dailyWetBulbC: 27.8, baselineMeanC: 24.2 } } };
  const d = cardDigest("heat", p);
  assert.equal(d.severity_hourlyPeakWetBulbNext48hC, 29.7);
  assert.equal(d.anomaly_dailyWetBulbC, 27.8);
  assert.equal(d.hoursAbove28C, 2);
  assert.equal(d.hoursAbove31C, 1);
  assert.ok(!JSON.stringify(d).includes('"asOf"'));
  const { system, prompt } = buildCardPrompt({ regionName: "Dubai, UAE", key: "heat", digest: d });
  assert.match(system, /ONE anomaly on Zackscan: the Extreme Heat reading for Dubai, UAE/);
  assert.match(system, /BOTH registers/);
  assert.match(prompt, /hourlyPeakWetBulbNext48hC/);
});

test("card SitRep: one call for both tiers, unchanged on the same data, clear errors otherwise", async () => {
  await seedHeat();
  const up = stubUpstream();
  try {
    const byok = { "X-Custom-AI-Key": GEMINI_KEY, "X-Custom-AI-Provider": "gemini" };
    const r = await (await post({ region: "dubai", pillar: "heat" }, byok)).json();
    assert.equal(r.region, "dubai");
    assert.equal(r.pillar, "heat");
    assert.ok(r.assessment.plain && r.assessment.researcher);
    assert.equal(up.calls(), 1);
    const again = await (await post({ region: "dubai", pillar: "heat", knownFingerprint: r.fingerprint }, byok)).json();
    assert.equal(again.unchanged, true);
    assert.equal(up.calls(), 1, "no second call");
    await seedHeat(31.5); // the reading changed
    const changed = await (await post({ region: "dubai", pillar: "heat", knownFingerprint: r.fingerprint }, byok)).json();
    assert.ok(changed.assessment, "regenerated when the telemetry changed");
    assert.equal((await post({ region: "tokyo", pillar: "heat" }, byok)).status, 409, "no data yet");
    assert.equal((await post({ region: "dubai", pillar: "glof" }, byok)).status, 400, "GLOF is a stub: no AI SitRep");
    assert.equal((await post({ region: "atlantis", pillar: "heat" }, byok)).status, 400);
  } finally {
    up.restore();
  }
});
