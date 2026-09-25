import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { resolveAiRoute, withAiRoute, AiRouteError } from "../src/middleware/ai-key.js";
import { _resetMemoryLimiter } from "../src/middleware/rate-limit.js";
import { runAssessment } from "../src/ai/providers.js";
import worker from "../src/worker.js";

const ANTHROPIC_KEY = "sk-ant-api03-" + "A".repeat(40);
const GEMINI_KEY = "AIza" + "B".repeat(35);
const GOOD = { summary: "s", riskLevel: "low", findings: [], actions: [] };

const req = (headers = {}, ip = "1.2.3.4") =>
  new Request("https://zackscan.test/api/analyze", { method: "POST", headers: { "CF-Connecting-IP": ip, ...headers } });

const headersOf = (init) => Object.fromEntries(new Headers(init?.headers || {}).entries());

beforeEach(() => _resetMemoryLimiter());

test("user key routes to BYOK with that provider", async () => {
  const r = await resolveAiRoute(req({ "X-Custom-AI-Key": ANTHROPIC_KEY, "X-Custom-AI-Provider": "anthropic" }), {});
  assert.equal(r.tier, "byok");
  assert.equal(r.provider, "anthropic");
  assert.equal(r.model, "claude-sonnet-5");
});

test("BYOK works even when the platform tier is missing or exhausted", async () => {
  const r = await resolveAiRoute(req({ "X-Custom-AI-Key": GEMINI_KEY, "X-Custom-AI-Provider": "gemini" }), { PLATFORM_DAILY_LIMIT: "0" });
  assert.equal(r.tier, "byok");
});

test("malformed, mismatched or half-sent keys are rejected, never downgraded to platform", async () => {
  const env = { PLATFORM_GEMINI_KEY: GEMINI_KEY };
  for (const [headers, code] of [
    [{ "X-Custom-AI-Key": "nope", "X-Custom-AI-Provider": "gemini" }, "byok_key_malformed"],
    [{ "X-Custom-AI-Key": ANTHROPIC_KEY, "X-Custom-AI-Provider": "gemini" }, "byok_key_malformed"],
    [{ "X-Custom-AI-Key": ANTHROPIC_KEY, "X-Custom-AI-Provider": "openai" }, "byok_provider_invalid"],
    [{ "X-Custom-AI-Key": ANTHROPIC_KEY }, "byok_provider_invalid"],
    [{ "X-Custom-AI-Provider": "anthropic" }, "byok_key_malformed"],
  ]) {
    await assert.rejects(resolveAiRoute(req(headers), env), (e) => e instanceof AiRouteError && e.code === code && e.status === 400);
  }
});

test("no key falls back to the platform tier, limited per IP", async () => {
  const env = { PLATFORM_GEMINI_KEY: GEMINI_KEY, PLATFORM_DAILY_LIMIT: "2" };
  assert.equal((await resolveAiRoute(req(), env)).tier, "platform");
  assert.equal((await resolveAiRoute(req(), env)).limit.used, 2);
  await assert.rejects(resolveAiRoute(req(), env), (e) => e.status === 429 && e.extra.retryAfter > 0);
  assert.equal((await resolveAiRoute(req({}, "5.6.7.8"), env)).tier, "platform", "another IP has its own allowance");
});

test("platform tier without a platform key says so", async () => {
  await assert.rejects(resolveAiRoute(req(), {}), (e) => e.status === 503 && e.code === "platform_unavailable");
});

test("rate limiter uses KV when bound, storing only hashed IPs", async () => {
  const kv = new Map();
  const RATE_LIMIT = { get: async (k) => kv.get(k) ?? null, put: async (k, v) => void kv.set(k, v) };
  await resolveAiRoute(req(), { PLATFORM_GEMINI_KEY: GEMINI_KEY, RATE_LIMIT });
  const [key] = kv.keys();
  assert.match(key, /^rl:\d{4}-\d\d-\d\d:[0-9a-f]{24}$/);
  assert.ok(!key.includes("1.2.3.4"));
});

test("Gemini: key goes in a header to Google's host only, never in the URL", async () => {
  let seen;
  const fetch = async (url, init) => {
    seen = { url: String(url), headers: headersOf(init), body: JSON.parse(init.body) };
    return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(GOOD) }] } }] });
  };
  const out = await runAssessment({ tier: "byok", provider: "gemini", apiKey: GEMINI_KEY, model: "gemini-3.6-flash" }, { system: "s", prompt: "p" }, { fetch });
  assert.deepEqual(out, GOOD);
  assert.equal(new URL(seen.url).host, "generativelanguage.googleapis.com");
  assert.ok(!seen.url.includes(GEMINI_KEY));
  assert.equal(seen.headers["x-goog-api-key"], GEMINI_KEY);
  assert.equal(seen.body.generationConfig.responseMimeType, "application/json");
});

test("Anthropic: official host, Sonnet, structured output, key in x-api-key", async () => {
  let seen;
  const fetch = async (url, init) => {
    seen = { url: String(url), headers: headersOf(init), body: JSON.parse(init.body) };
    return Response.json({
      id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-5", stop_reason: "end_turn",
      content: [{ type: "text", text: JSON.stringify(GOOD) }], usage: { input_tokens: 1, output_tokens: 1 },
    });
  };
  const out = await runAssessment({ tier: "byok", provider: "anthropic", apiKey: ANTHROPIC_KEY, model: "claude-sonnet-5" }, { system: "s", prompt: "p" }, { fetch });
  assert.deepEqual(out, GOOD);
  assert.equal(new URL(seen.url).host, "api.anthropic.com");
  assert.equal(seen.headers["x-api-key"], ANTHROPIC_KEY);
  assert.equal(seen.body.model, "claude-sonnet-5");
  assert.equal(seen.body.fallbacks, undefined);
  assert.equal(seen.body.output_config.format.type, "json_schema");
});

test("a rejected user key is a 401 that never echoes the key", async () => {
  const cases = [
    ["gemini", GEMINI_KEY, () => new Response(JSON.stringify({ error: { details: [{ reason: "API_KEY_INVALID" }] } }), { status: 400 })],
    ["anthropic", ANTHROPIC_KEY, () => Response.json({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, { status: 401 })],
  ];
  for (const [provider, apiKey, reply] of cases) {
    const handler = withAiRoute((request, env, ctx, route) =>
      runAssessment(route, { system: "s", prompt: "p" }, { fetch: async () => reply() }).then((a) => Response.json(a)),
    );
    const res = await handler(req({ "X-Custom-AI-Key": apiKey, "X-Custom-AI-Provider": provider }), {}, {});
    const text = await res.text();
    assert.equal(res.status, 401, provider);
    assert.equal(JSON.parse(text).code, "byok_key_rejected");
    assert.ok(!text.includes(apiKey), "key must not be echoed");
  }
});

test("Anthropic refusal becomes a clear 422", async () => {
  const fetch = async () =>
    Response.json({ id: "m", type: "message", role: "assistant", model: "claude-sonnet-5", stop_reason: "refusal", content: [], usage: { input_tokens: 1, output_tokens: 0 } });
  await assert.rejects(
    runAssessment({ tier: "byok", provider: "anthropic", apiKey: ANTHROPIC_KEY, model: "claude-sonnet-5" }, { system: "s", prompt: "p" }, { fetch }),
    (e) => e.status === 422 && e.code === "ai_refused",
  );
});

test("worker: /api/analyze end to end with stubbed feeds and Gemini", async () => {
  const realFetch = globalThis.fetch;
  const hosts = [];
  globalThis.fetch = async (url, init) => {
    const u = new URL(String(url));
    hosts.push(u.host);
    if (u.host === "eonet.gsfc.nasa.gov")
      return Response.json({ events: [{ id: "E1", title: "Fire A", categories: [{ id: "wildfires" }], geometry: [{ type: "Point", date: "2026-09-25T00:00:00Z", coordinates: [36.8, -1.3] }] }] });
    if (u.host === "generativelanguage.googleapis.com") {
      assert.ok(JSON.parse(init.body).contents[0].parts[0].text.includes("Fire A"));
      return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(GOOD) }] } }] });
    }
    throw new Error("unexpected host " + u.host);
  };
  try {
    const res = await worker.fetch(
      new Request("https://zackscan.test/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Custom-AI-Key": GEMINI_KEY, "X-Custom-AI-Provider": "gemini" },
        body: JSON.stringify({ profile: "wildfire" }),
      }),
      {},
      {},
    );
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(data.tier, "byok");
    assert.equal(data.eventCount, 1);
    assert.deepEqual(data.assessment, GOOD);
    assert.deepEqual([...new Set(hosts)].sort(), ["eonet.gsfc.nasa.gov", "generativelanguage.googleapis.com"]);
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), null, "API must not be opened cross-origin");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("worker: unknown profile and oversized bodies are refused", async () => {
  const env = { PLATFORM_GEMINI_KEY: GEMINI_KEY };
  const post = (body) =>
    worker.fetch(new Request("https://zackscan.test/api/analyze", { method: "POST", body, headers: { "CF-Connecting-IP": "9.9.9.9" } }), env, {});
  assert.equal((await post(JSON.stringify({ profile: "../../etc" }))).status, 400);
  assert.equal((await post("x".repeat(5000))).status, 413);
});
