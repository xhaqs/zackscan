// POST /api/analyze {profile, knownFingerprint?}
//
// Fetches the profile's feeds (plus the cached risk matrix) on the server,
// and returns ONE assessment in two registers (plain + researcher, see
// src/ai/prompts.js). The client sends only the profile id, never the data.
//
// Regenerate only when the telemetry changed:
// - The server fingerprints exactly what the prompt would be built from.
// - If the client already holds an assessment with that fingerprint, the
//   answer is {unchanged:true}: no LLM call, no key check, no allowance used.
// - Shared-tier results are cached in KV by fingerprint, so many visitors
//   share one generation instead of each spending the small shared quota.

import { getProfile } from "../../public/js/profiles.js";
import { AI_PROVIDERS } from "../../public/js/ai-catalog.js";
import { loadProfileEvents } from "../feeds.js";
import { runAssessment } from "../ai/providers.js";
import { buildAssessmentPrompt, validateTiered, digestMatrix, telemetryFingerprint, PROMPT_VERSION } from "../ai/prompts.js";
import { getMatrix } from "../risk/matrix.js";
import { makeStore } from "../risk/store.js";
import { KEY_HEADER, PROVIDER_HEADER, MODEL_HEADER } from "../middleware/ai-key.js";
import { AiRouteError } from "../errors.js";
import { json } from "../http.js";

const MAX_EVENTS = 120;
const SHARED_CACHE_S = 6 * 3600;

/** @param getRoute lazy route resolver from withAiRoute(..., {lazy:true}) */
export async function handleAnalyze(request, env, ctx, getRoute, deps = {}) {
  const raw = await request.text();
  if (raw.length > 4096) throw new AiRouteError(413, "too_large", "Request too large.");
  let body = {};
  try {
    body = JSON.parse(raw || "{}");
  } catch {}
  const profile = getProfile(body.profile);
  if (!profile) throw new AiRouteError(400, "profile_invalid", "Unknown mission profile.");
  const known = typeof body.knownFingerprint === "string" && /^[0-9a-f]{24}$/.test(body.knownFingerprint) ? body.knownFingerprint : null;

  const store = deps.store || makeStore(env);
  const [{ events, errors }, matrix] = await Promise.all([
    loadProfileEvents(profile, deps),
    // Cached regions only: an assessment never waits on fresh risk computation.
    getMatrix(env, { ...deps, store }, { computeBudget: 0 }).catch(() => null),
  ]);
  const used = events.slice(0, MAX_EVENTS);
  const riskDigest = matrix ? digestMatrix(matrix) : null;
  const fingerprint = await telemetryFingerprint({ profileId: profile.id, events: used, riskDigest });

  if (!events.length)
    return json({ profile: profile.id, fingerprint, assessment: null, note: "No open events in this profile's feeds.", feedErrors: errors });
  if (known === fingerprint) return json({ profile: profile.id, fingerprint, unchanged: true });

  const byok = [KEY_HEADER, PROVIDER_HEADER, MODEL_HEADER].some((h) => request.headers.has(h));
  const sharedKey = `assess:v1:${fingerprint}:${AI_PROVIDERS.gemini.defaultModel}`;
  if (!byok) {
    const hit = await store.get(sharedKey);
    if (hit) return json({ ...hit, cached: true });
  }

  const route = await getRoute();
  let assessment;
  try {
    assessment = validateTiered(await runAssessment(route, buildAssessmentPrompt({ profile, events: used, riskDigest }), deps));
  } catch (e) {
    if (e instanceof AiRouteError) throw e;
    throw new AiRouteError(502, "ai_bad_output", "The AI's answer was incomplete. Try again.");
  }

  const result = {
    profile: profile.id,
    fingerprint,
    promptVersion: PROMPT_VERSION,
    generatedAt: new Date().toISOString(),
    billing: route.tier, // "byok" (user's key) or "platform" (shared tier)
    provider: route.provider,
    model: route.model,
    eventCount: events.length,
    feedErrors: errors,
    assessment,
  };
  if (route.tier === "platform") await store.put(sharedKey, result, SHARED_CACHE_S);
  return json({ ...result, ...(route.limit ? { allowance: { used: route.limit.used, max: route.limit.max } } : {}) });
}
