// BYOK routing: decides whose key pays for an AI call.
//
//   X-Custom-AI-Key + X-Custom-AI-Provider present -> the user's key ("byok")
//   neither present                                -> platform key, rate-limited ("platform")
//
// Rules this file enforces:
// - The user's key lives only in this request. It is never logged, stored,
//   echoed in a response, or sent anywhere but the provider's official host.
// - A bad or rejected user key is an error. It never quietly falls back to
//   the platform key, which would hide the problem and spend shared quota.

import { AI_PROVIDERS as PROVIDERS, PROVIDER_IDS, isKnownModel } from "../../public/js/ai-catalog.js";
import { checkRateLimit } from "./rate-limit.js";
import { AiRouteError } from "../errors.js";

export { AiRouteError };

export const KEY_HEADER = "X-Custom-AI-Key";
export const PROVIDER_HEADER = "X-Custom-AI-Provider";
export const MODEL_HEADER = "X-Custom-AI-Model"; // optional; must be in the catalog

/**
 * Work out which provider and key to use for this request.
 * Returns { tier, provider, apiKey, model, limit? }. apiKey must stay inside
 * the Worker. Throws AiRouteError for anything the caller should see.
 */
export async function resolveAiRoute(request, env) {
  const rawKey = request.headers.get(KEY_HEADER);
  const rawProvider = request.headers.get(PROVIDER_HEADER);
  const rawModel = request.headers.get(MODEL_HEADER);

  if (rawKey !== null || rawProvider !== null || rawModel !== null) {
    const provider = (rawProvider || "").trim().toLowerCase();
    const apiKey = (rawKey || "").trim();
    if (!Object.hasOwn(PROVIDERS, provider))
      throw new AiRouteError(400, "byok_provider_invalid", `${PROVIDER_HEADER} must be one of: ${PROVIDER_IDS.join(", ")}.`);
    // Loose format check: catches a typo or a key pasted under the wrong
    // provider before we spend a round trip. The provider has the final say.
    if (!PROVIDERS[provider].keyPattern.test(apiKey))
      throw new AiRouteError(400, "byok_key_malformed", `That doesn't look like a ${PROVIDERS[provider].label} API key (${PROVIDERS[provider].keyHint}).`);
    const model = (rawModel || "").trim() || PROVIDERS[provider].defaultModel;
    if (!isKnownModel(provider, model))
      throw new AiRouteError(400, "byok_model_invalid", `Choose one of the listed ${PROVIDERS[provider].label} models.`);
    return { tier: "byok", provider, apiKey, model };
  }

  // Platform tier: Gemini on the platform key, limited per client IP.
  if (!env.PLATFORM_GEMINI_KEY)
    throw new AiRouteError(503, "platform_unavailable", "The shared AI tier isn't set up. Add your own key in Settings to use AI analysis.");
  const limit = await checkRateLimit(request, env);
  if (!limit.allowed)
    throw new AiRouteError(429, "platform_rate_limited", "You've used the free AI allowance for today. Add your own key in Settings to keep going.", {
      retryAfter: limit.retryAfter,
    });
  return { tier: "platform", provider: "gemini", apiKey: env.PLATFORM_GEMINI_KEY, model: PROVIDERS.gemini.defaultModel, limit };
}

/**
 * Wrap a handler that needs AI. The handler gets `route` without the key
 * attached to anything it might serialize by accident.
 */
export function withAiRoute(handler) {
  return async (request, env, ctx) => {
    let route;
    try {
      route = await resolveAiRoute(request, env);
    } catch (e) {
      if (e instanceof AiRouteError) return aiErrorResponse(e);
      throw e;
    }
    try {
      return await handler(request, env, ctx, route);
    } catch (e) {
      if (e instanceof AiRouteError) return aiErrorResponse(e);
      // Unknown failure: say nothing specific, in case the message holds request data.
      console.error("ai handler failed:", e && e.name);
      return aiErrorResponse(new AiRouteError(502, "ai_failed", "The AI request failed. Try again shortly."));
    }
  };
}

export function aiErrorResponse(e) {
  const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };
  if (e.extra && e.extra.retryAfter) headers["Retry-After"] = String(e.extra.retryAfter);
  return new Response(JSON.stringify({ error: e.message, code: e.code }), { status: e.status, headers });
}
