// POST /api/analyze
//   {profile, knownFingerprint?}          whole-profile assessment (feeds + risk digest)
//   {region, pillar, knownFingerprint?}   one anomaly card's SitRep (that region's pillar only)
//
// Either way the server builds the data itself (the client sends only ids)
// and returns ONE assessment in two registers (plain + researcher, see
// src/ai/prompts.js).
//
// Regenerate only when the telemetry changed:
// - The server fingerprints exactly what the prompt would be built from.
// - If the client already holds an assessment with that fingerprint, the
//   answer is {unchanged:true}: no LLM call, no key check, no allowance used.
// - Shared-tier results are cached in KV by fingerprint, so many visitors
//   share one generation instead of each spending the small shared quota.

import { getProfile } from "../../public/js/profiles.js";
import { buildCustomProfileForServer } from "../custom-profile-feeds.js";
import { AI_PROVIDERS } from "../../public/js/ai-catalog.js";
import { loadProfileEvents } from "../feeds.js";
import { runAssessment } from "../ai/providers.js";
import {
  buildAssessmentPrompt,
  buildCardPrompt,
  cardDigest,
  CARD_PILLARS,
  validateTiered,
  digestMatrix,
  telemetryFingerprint,
  PROMPT_VERSION,
} from "../ai/prompts.js";
import { getMatrix } from "../risk/matrix.js";
import { getRegion } from "../risk/regions.js";
import { makeStore } from "../risk/store.js";
import {
  KEY_HEADER,
  PROVIDER_HEADER,
  MODEL_HEADER,
} from "../middleware/ai-key.js";
import { refundRateLimit } from "../middleware/rate-limit.js";
import { AiRouteError } from "../errors.js";
import { json } from "../http.js";

const MAX_EVENTS = 120;
const SHARED_CACHE_S = 6 * 3600;

/** @param getRoute lazy route resolver from withAiRoute(..., {lazy:true}) */
export async function handleAnalyze(request, env, ctx, getRoute, deps = {}) {
  const raw = await request.text();
  if (raw.length > 4096)
    throw new AiRouteError(413, "too_large", "Request too large.");
  let body = {};
  try {
    body = JSON.parse(raw || "{}");
  } catch {}
  const known =
    typeof body.knownFingerprint === "string" &&
    /^[0-9a-f]{24}$/.test(body.knownFingerprint)
      ? body.knownFingerprint
      : null;
  const store = deps.store || makeStore(env);

  const job =
    body.region != null || body.pillar != null
      ? await cardJob(body, env, deps, store)
      : await profileJob(body, env, deps, store);
  if (job.empty) return json(job.empty);
  const { fingerprint } = job;
  if (known === fingerprint)
    return json({ ...job.ids, fingerprint, unchanged: true });

  const byok = [KEY_HEADER, PROVIDER_HEADER, MODEL_HEADER].some((h) =>
    request.headers.has(h),
  );
  const sharedKey = `assess:v1:${fingerprint}:${AI_PROVIDERS.gemini.defaultModel}`;
  if (!byok) {
    const hit = await store.get(sharedKey);
    if (hit) return json({ ...hit, cached: true });
  }

  const route = await getRoute();
  let assessment;
  try {
    assessment = validateTiered(await runAssessment(route, job.prompt(), deps));
  } catch (e) {
    // Nothing was delivered, so it doesn't count against the visitor's daily allowance.
    if (route.tier === "platform")
      await refundRateLimit(request, env).catch(() => {});
    if (e instanceof AiRouteError) throw e;
    throw new AiRouteError(
      502,
      "ai_bad_output",
      "The AI's answer was incomplete. Try again.",
    );
  }

  const result = {
    ...job.ids,
    fingerprint,
    promptVersion: PROMPT_VERSION,
    generatedAt: new Date().toISOString(),
    billing: route.tier, // "byok" (user's key) or "platform" (shared tier)
    provider: route.provider,
    model: route.model,
    eventCount: job.eventCount,
    feedErrors: job.feedErrors,
    assessment,
  };
  if (route.tier === "platform")
    await store.put(sharedKey, result, SHARED_CACHE_S);
  return json({
    ...result,
    ...(route.limit
      ? { allowance: { used: route.limit.used, max: route.limit.max } }
      : {}),
  });
}

async function profileJob(body, env, deps, store) {
  const profile = body.customProfile
    ? buildCustomProfileForServer(body.customProfile)
    : getProfile(body.profile);
  if (!profile)
    throw new AiRouteError(400, "profile_invalid", "Unknown mission profile.");
  const [{ events, errors }, matrix] = await Promise.all([
    loadProfileEvents(profile, deps),
    // Cached regions only: an assessment never waits on fresh risk computation.
    getMatrix(env, { ...deps, store }, { computeBudget: 0 }).catch(() => null),
  ]);
  const used = events.slice(0, MAX_EVENTS);
  const riskDigest = matrix ? digestMatrix(matrix) : null;
  const fingerprint = await telemetryFingerprint({
    profileId: profile.id,
    events: used,
    riskDigest,
  });
  const ids = { profile: profile.id };
  if (!events.length)
    return {
      empty: {
        ...ids,
        fingerprint,
        assessment: null,
        note: "No open events in this profile's feeds.",
        feedErrors: errors,
      },
    };
  return {
    ids,
    fingerprint,
    eventCount: events.length,
    feedErrors: errors,
    prompt: () => buildAssessmentPrompt({ profile, events: used, riskDigest }),
  };
}

async function cardJob(body, env, deps, store) {
  const region = getRegion(body.region);
  if (!region) throw new AiRouteError(400, "region_invalid", "Unknown region.");
  if (!Object.hasOwn(CARD_PILLARS, body.pillar))
    throw new AiRouteError(
      400,
      "pillar_invalid",
      "No AI SitRep for this hazard type.",
    );
  const m = await getMatrix(
    env,
    { ...deps, store },
    { regionId: region.id, computeBudget: 0 },
  ).catch(() => null);
  const pillar = m?.regions?.[0]?.pillars?.[body.pillar];
  if (!pillar || pillar.score == null)
    throw new AiRouteError(
      409,
      "no_data",
      "There's no data for this anomaly yet. Try again in a few minutes.",
    );
  const digest = cardDigest(body.pillar, pillar);
  const fingerprint = await telemetryFingerprint({
    profileId: `card:${region.id}:${body.pillar}`,
    events: [],
    riskDigest: digest,
  });
  return {
    ids: { region: region.id, pillar: body.pillar },
    fingerprint,
    eventCount: 0,
    feedErrors: [],
    prompt: () =>
      buildCardPrompt({ regionName: region.name, key: body.pillar, digest }),
  };
}
