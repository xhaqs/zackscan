// AI providers. Each one talks to exactly one hardcoded official host, so a
// user's key can only ever be sent to the provider it belongs to.

import Anthropic from "@anthropic-ai/sdk";
import { AiRouteError } from "../errors.js";

const ANTHROPIC_BASE = "https://api.anthropic.com";
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models/";

export const PROVIDERS = Object.freeze({
  anthropic: { label: "Anthropic", defaultModel: "claude-opus-5" },
  gemini: { label: "Gemini", defaultModel: "gemini-3.6-flash" },
});

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
export async function runAssessment(route, { system, prompt }, deps = {}) {
  const fetchImpl = deps.fetch || fetch;
  const text =
    route.provider === "anthropic"
      ? await callAnthropic(route, system, prompt, fetchImpl)
      : await callGemini(route, system, prompt, fetchImpl);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AiRouteError(502, "ai_bad_output", "The AI answered in an unexpected format. Try again.");
  }
  return parsed;
}

async function callAnthropic(route, system, prompt, fetchImpl) {
  const client = new Anthropic({ apiKey: route.apiKey, baseURL: ANTHROPIC_BASE, fetch: fetchImpl, maxRetries: 1 });
  let response;
  try {
    response = await client.beta.messages.create({
      model: route.model,
      max_tokens: 16000,
      // If a safety classifier declines, Anthropic re-runs the request on its
      // recommended fallback model instead of returning a refusal.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { format: { type: "json_schema", schema: ASSESSMENT_SCHEMA } },
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

async function callGemini(route, system, prompt, fetchImpl) {
  const res = await fetchImpl(GEMINI_BASE + encodeURIComponent(route.model) + ":generateContent", {
    method: "POST",
    // Key in a header, not the URL, so it can't end up in URL logs.
    headers: { "Content-Type": "application/json", "x-goog-api-key": route.apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: "application/json",
        responseJsonSchema: ASSESSMENT_SCHEMA,
        maxOutputTokens: 2048,
      },
    }),
  });
  if (res.status === 401 || res.status === 403) throw keyRejected(route);
  if (res.status === 400) {
    // Gemini reports a bad key as a 400 with reason API_KEY_INVALID.
    const body = await res.text();
    if (/API_KEY_INVALID/.test(body)) throw keyRejected(route);
    throw new AiRouteError(502, "provider_error", "Gemini rejected the request (400).");
  }
  if (res.status === 429)
    throw new AiRouteError(429, "provider_rate_limited", route.tier === "platform"
      ? "The shared AI tier is busy or out of quota. Add your own key in Settings, or try later."
      : "Gemini is rate-limiting this key. Wait a minute and try again.");
  if (!res.ok) throw new AiRouteError(502, "provider_error", `Gemini returned an error (${res.status}).`);
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("");
  if (!text) throw new AiRouteError(502, "ai_bad_output", "The AI returned no answer.");
  return text;
}

function keyRejected(route) {
  return route.tier === "byok"
    ? new AiRouteError(401, "byok_key_rejected", `${PROVIDERS[route.provider].label} rejected your API key. Check it in Settings.`)
    : new AiRouteError(502, "platform_key_rejected", "The shared AI tier is misconfigured. Add your own key in Settings for now.");
}
