// AI providers. Each one talks to exactly one hardcoded official host, so a
// user's key can only ever be sent to the provider it belongs to.

import Anthropic from "@anthropic-ai/sdk";
import { AiRouteError } from "../errors.js";
import { AI_PROVIDERS as PROVIDERS } from "../../public/js/ai-catalog.js";

const ANTHROPIC_BASE = "https://api.anthropic.com";
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models/";
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

// Tried in order when the shared tier's model is overloaded (separate capacity and quota per model).
export const PLATFORM_GEMINI_FALLBACKS = ["gemini-3.8-flash", "gemini-3.5-flash-lite"];

// What every provider must return: the same shape, whatever produced it.
export const ASSESSMENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "riskLevel", "findings", "actions"],
  properties: {
    summary: { type: "string" },
    riskLevel: { type: "string", enum: ["low", "moderate", "high", "severe"] },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["metric", "observation", "confidence"],
        properties: {
          metric: { type: "string" },
          observation: { type: "string" },
          confidence: { type: "string", enum: ["low", "medium", "high"] },
        },
      },
    },
    actions: { type: "array", items: { type: "string" } },
  },
};

/**
 * Run one assessment. `route` comes from resolveAiRoute; `deps.fetch` lets
 * tests stand in for the network.
 */
export async function runAssessment(route, { system, prompt, schema = ASSESSMENT_SCHEMA }, deps = {}) {
  const fetchImpl = deps.fetch || fetch;
  const call = { anthropic: callAnthropic, gemini: callGemini, openai: callOpenAI }[route.provider];
  if (!call) throw new AiRouteError(400, "byok_provider_invalid", "Unknown AI provider.");
  const opts = deps.retryDelayMs != null ? { retryDelayMs: deps.retryDelayMs } : undefined;
  // Shared tier only: when Google says a model is overloaded, try the next
  // one. A user's own key always gets the model they chose.
  const models = route.tier === "platform" && route.provider === "gemini" ? [route.model, ...PLATFORM_GEMINI_FALLBACKS.filter((m) => m !== route.model)] : [route.model];
  let text;
  for (let i = 0; i < models.length; i++) {
    try {
      text = await call({ ...route, model: models[i] }, system, prompt, fetchImpl, schema, opts);
      route.model = models[i]; // report the model that actually answered
      break;
    } catch (e) {
      if (e.code !== "provider_busy" || i === models.length - 1) throw e;
    }
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AiRouteError(502, "ai_bad_output", "The AI answered in an unexpected format. Try again.");
  }
  return parsed;
}

async function callAnthropic(route, system, prompt, fetchImpl, schema) {
  const client = new Anthropic({ apiKey: route.apiKey, baseURL: ANTHROPIC_BASE, fetch: fetchImpl, maxRetries: 1 });
  let response;
  try {
    // No server-side refusal fallbacks: Anthropic documents them for Opus and
    // Fable models, not Sonnet. A refusal is reported as ai_refused below.
    response = await client.messages.create({
      model: route.model,
      max_tokens: 16000,
      output_config: { format: { type: "json_schema", schema } },
      system,
      messages: [{ role: "user", content: prompt }],
    });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError)
      throw keyRejected(route);
    if (e instanceof Anthropic.RateLimitError)
      throw new AiRouteError(429, "provider_rate_limited", "Anthropic is rate-limiting this key. Wait a minute and try again.");
    if (e instanceof Anthropic.APIError) throw new AiRouteError(502, "provider_error", `Anthropic returned an error (${e.status ?? "network"}).`);
    throw e;
  }
  if (response.stop_reason === "refusal")
    throw new AiRouteError(422, "ai_refused", "The AI declined to assess this data.");
  const block = response.content.find((b) => b.type === "text");
  if (!block) throw new AiRouteError(502, "ai_bad_output", "The AI returned no answer.");
  return block.text;
}

/** Google's own error text (never contains the key), for messages and diagnosis. */
async function geminiError(res) {
  const body = await res.text().catch(() => "");
  try {
    const e = JSON.parse(body).error || {};
    return { text: body, message: String(e.message || "").slice(0, 200), status: e.status || "" };
  } catch {
    return { text: body, message: body.slice(0, 200), status: "" };
  }
}

async function callGemini(route, system, prompt, fetchImpl, schema, { retryDelayMs = 2000 } = {}) {
  const send = () =>
    fetchImpl(GEMINI_BASE + encodeURIComponent(route.model) + ":generateContent", {
      method: "POST",
      // Key in a header, not the URL, so it can't end up in URL logs.
      headers: { "Content-Type": "application/json", "x-goog-api-key": route.apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseJsonSchema: schema,
          // Gemini 3.x spends part of this on thinking before it answers; two tiers need room.
          maxOutputTokens: 8192,
        },
      }),
    });
  let res = await send();
  // 500/503 mean "overloaded, try again": Google recommends a short backoff retry.
  if (res.status === 503 || res.status === 500) {
    await new Promise((r) => setTimeout(r, retryDelayMs));
    res = await send();
  }
  if (res.status === 401 || res.status === 403) throw keyRejected(route);
  if (res.status === 400) {
    // Gemini reports a bad key as a 400 with reason API_KEY_INVALID.
    const e = await geminiError(res);
    if (/API_KEY_INVALID/.test(e.text)) throw keyRejected(route);
    throw new AiRouteError(502, "provider_error", `Gemini rejected the request (400): ${e.message || "no details"}`);
  }
  if (res.status === 429)
    throw new AiRouteError(429, "provider_rate_limited", route.tier === "platform"
      ? "The shared AI tier is busy or out of quota. Add your own key in Settings, or try later."
      : "Gemini is rate-limiting this key. Wait a minute and try again.");
  if (!res.ok) {
    const e = await geminiError(res);
    const busy = res.status === 503 || res.status === 500;
    throw new AiRouteError(502, busy ? "provider_busy" : "provider_error", busy
      ? `Gemini is overloaded right now (${res.status}${e.message ? ": " + e.message : ""}). Try again in a few minutes.`
      : `Gemini returned an error (${res.status}${e.message ? ": " + e.message : ""}).`);
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("");
  if (!text) throw new AiRouteError(502, "ai_bad_output", "The AI returned no answer.");
  return text;
}

async function callOpenAI(route, system, prompt, fetchImpl, schema) {
  const res = await fetchImpl(OPENAI_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + route.apiKey },
    body: JSON.stringify({
      model: route.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
      response_format: { type: "json_schema", json_schema: { name: "assessment", strict: true, schema } },
      // GPT-6 models reason before answering, and that uses part of this budget.
      max_completion_tokens: 16000,
    }),
  });
  if (res.status === 401 || res.status === 403) throw keyRejected(route);
  if (res.status === 429) {
    // OpenAI uses 429 both for "slow down" and for "this account has no credit".
    const body = await res.json().catch(() => ({}));
    throw new AiRouteError(429, "provider_rate_limited", body?.error?.code === "insufficient_quota"
      ? "Your OpenAI account is out of credit. Add billing on platform.openai.com, or use another key."
      : "OpenAI is rate-limiting this key. Wait a minute and try again.");
  }
  if (!res.ok) throw new AiRouteError(502, "provider_error", `OpenAI returned an error (${res.status}).`);
  const data = await res.json();
  const msg = data?.choices?.[0]?.message;
  if (msg?.refusal) throw new AiRouteError(422, "ai_refused", "The AI declined to assess this data.");
  if (!msg?.content) throw new AiRouteError(502, "ai_bad_output", "The AI returned no answer.");
  return msg.content;
}

function keyRejected(route) {
  return route.tier === "byok"
    ? new AiRouteError(401, "byok_key_rejected", `${PROVIDERS[route.provider].label} rejected your API key. Check it in Settings.`)
    : new AiRouteError(502, "platform_key_rejected", "The shared AI tier is misconfigured. Add your own key in Settings for now.");
}
