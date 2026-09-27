// POST /api/profiles/interpret
// Takes {description} (plain text) and uses AI to build a custom mission profile spec:
// name, audience, poll interval, feed categories, assessment metrics, and palette key.
// Feed URLs are never accepted from clients; feedCategories are mapped server-side.
// Results are cached in KV by description hash for 24 hours.

import { FEED_CATEGORIES } from "../custom-profile-feeds.js";
import { runAssessment } from "../ai/providers.js";
import { AiRouteError } from "../errors.js";
import { json } from "../http.js";
import { makeStore } from "../risk/store.js";
import { refundRateLimit } from "../middleware/rate-limit.js";

const INTERPRET_VERSION = "interpret-v1";
const INTERPRET_CACHE_S = 24 * 3600;

const POLL_MAP = { "30s": 30000, "60s": 60000, "2min": 120000, "5min": 300000 };
const FEED_KEYS = Object.keys(FEED_CATEGORIES);
const PALETTE_KEYS = ["green", "orange", "blue", "purple", "red", "teal"];

const str = { type: "string" };
const INTERPRET_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "name",
    "audience",
    "pollInterval",
    "feedCategories",
    "metrics",
    "paletteKey",
  ],
  properties: {
    name: str,
    audience: { type: "string", enum: ["citizen", "professional"] },
    pollInterval: { type: "string", enum: Object.keys(POLL_MAP) },
    feedCategories: {
      type: "array",
      items: { type: "string", enum: FEED_KEYS },
    },
    metrics: { type: "array", items: str },
    paletteKey: { type: "string", enum: PALETTE_KEYS },
  },
};

function interpretPrompt(description) {
  const system = [
    "Convert a plain-language description of a monitoring need into a structured mission profile for Zackscan, an environmental hazard platform.",
    "",
    "Feed categories (pick 1–3 that best match):",
    "  eonet_all: all open events (wildfire, flood, storm, volcano, earthquake)",
    "  eonet_wildfires: wildfire events only",
    "  eonet_floods: flood, storm, ice, snow, landslide",
    "  eonet_seismic: volcano and earthquake",
    "  eonet_storms: severe storms only",
    "  usgs_hourly: all earthquakes last hour (real-time seismic)",
    "  usgs_significant: significant earthquakes today",
    "",
    "Poll interval guidance:",
    "  30s: real-time seismic/volcanic watch (professional)",
    "  60s: active wildfire or fast-moving flood ops (professional)",
    "  2min: flood, glacial, storm monitoring (professional)",
    "  5min: general awareness, multi-hazard overview",
    "",
    "name: 2–5 words, no trailing punctuation.",
    "audience: professional if the description mentions an agency, team, researcher, or technical role; otherwise citizen.",
    "metrics: 3–4 precise assessment questions the AI should answer from the data, tailored to the described audience and hazard.",
    "paletteKey: green=general/multi-hazard, orange=wildfire, blue=flood/water, purple=seismic, red=volcanic/extreme heat, teal=health/air quality.",
    "Return only valid JSON matching the schema.",
  ].join("\n");
  return {
    system,
    prompt: `Description: ${description}`,
    schema: INTERPRET_SCHEMA,
    version: INTERPRET_VERSION,
  };
}

async function descriptionFingerprint(description) {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      INTERPRET_VERSION + "|" + description.trim().toLowerCase(),
    ),
  );
  return [...new Uint8Array(buf).slice(0, 12)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function validate(r) {
  if (!r || typeof r.name !== "string" || !r.name.trim())
    throw new Error("missing name");
  if (!POLL_MAP[r.pollInterval]) r.pollInterval = "5min";
  r.feedCategories = (r.feedCategories || []).filter((c) =>
    FEED_KEYS.includes(c),
  );
  if (!r.feedCategories.length) throw new Error("no valid feed categories");
  r.metrics = (r.metrics || []).filter(
    (m) => typeof m === "string" && m.trim(),
  );
  if (!r.metrics.length) throw new Error("no valid metrics");
  if (!PALETTE_KEYS.includes(r.paletteKey)) r.paletteKey = "green";
  return r;
}

export async function handleInterpretProfile(
  request,
  env,
  ctx,
  getRoute,
  deps = {},
) {
  const raw = await request.text();
  if (raw.length > 2048)
    throw new AiRouteError(413, "too_large", "Request body too large.");
  let body = {};
  try {
    body = JSON.parse(raw || "{}");
  } catch {}

  const description =
    typeof body.description === "string" ? body.description.trim() : "";
  if (description.length < 10)
    throw new AiRouteError(
      400,
      "description_required",
      "Provide a description of at least 10 characters.",
    );
  if (description.length > 500)
    throw new AiRouteError(
      400,
      "description_too_long",
      "Description must be 500 characters or fewer.",
    );

  const fingerprint = await descriptionFingerprint(description);
  const store = deps.store || makeStore(env);
  const cacheKey = `interpret:v1:${fingerprint}`;

  const byok = request.headers.has("X-Custom-AI-Key");
  if (!byok) {
    const hit = await store.get(cacheKey);
    if (hit) return json({ ...hit, cached: true });
  }

  const route = await getRoute();
  let raw_result;
  try {
    raw_result = await runAssessment(route, interpretPrompt(description), deps);
  } catch (e) {
    if (route.tier === "platform")
      await refundRateLimit(request, env).catch(() => {});
    if (e instanceof AiRouteError) throw e;
    throw new AiRouteError(
      502,
      "ai_bad_output",
      "The AI couldn't interpret your description. Try rephrasing it.",
    );
  }

  let interpreted;
  try {
    interpreted = validate(raw_result);
  } catch {
    throw new AiRouteError(
      502,
      "ai_bad_output",
      "The AI returned an incomplete profile. Try again.",
    );
  }

  const result = {
    fingerprint,
    name: interpreted.name.trim().slice(0, 80),
    audience: interpreted.audience,
    pollMs: POLL_MAP[interpreted.pollInterval],
    feedCategories: interpreted.feedCategories,
    metrics: interpreted.metrics.map((m) => m.trim()),
    paletteKey: interpreted.paletteKey,
    interpretedAt: new Date().toISOString(),
  };

  if (!byok) await store.put(cacheKey, result, INTERPRET_CACHE_S);
  return json({
    ...result,
    ...(route.limit
      ? { allowance: { used: route.limit.used, max: route.limit.max } }
      : {}),
  });
}
