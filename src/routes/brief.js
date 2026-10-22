// GET /api/brief: get the latest daily brief
// POST /api/brief: manually trigger a brief refresh (rate-limited)

import { makeStore } from "../risk/store.js";
import { json } from "../http.js";
import { runDailyBrief } from "../brief/cron.js";

const BRIEF_KEY = "daily-brief:v1:latest";
const REFRESH_LIMIT_KEY = "brief-refresh:ip:";
const REFRESH_WINDOW_S = 3600; // 1 hour
const REFRESH_MAX_PER_WINDOW = 3;

/**
 * GET /api/brief: return the latest brief, or an empty state if none exists.
 */
export async function getBrief(env, deps = {}) {
  const store = deps.store || makeStore(env);
  const brief = await store.get(BRIEF_KEY);

  if (!brief) {
    return json({
      brief: null,
      message:
        "No brief available yet. It will be generated at 04:00 UTC (07:00 EAT).",
    });
  }

  return json({
    brief: {
      text: brief.text,
      generatedAt: brief.generatedAt,
      sources: brief.sources,
      model: brief.model,
    },
  });
}

/**
 * POST /api/brief: manually refresh the brief now (rate-limited per IP).
 */
export async function refreshBrief(request, env, deps = {}) {
  const store = deps.store || makeStore(env);
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const limitKey = REFRESH_LIMIT_KEY + hashIp(ip);

  // Check rate limit
  const count = (await store.get(limitKey)) || 0;
  if (count >= REFRESH_MAX_PER_WINDOW) {
    return json(
      {
        error: "Too many refresh requests. Try again in an hour.",
        code: "rate_limited",
      },
      429,
    );
  }

  // Run the brief job
  const result = await runDailyBrief(env, deps);

  // Update rate limit
  await store.put(limitKey, count + 1, REFRESH_WINDOW_S);

  if (!result.ok) {
    return json(
      {
        error: result.error || "Brief generation failed",
        code: "brief_failed",
        kept: result.kept,
      },
      result.error === "GEMINI_API_KEY not set" ? 503 : 502,
    );
  }

  // Return the new brief
  const brief = await store.get(BRIEF_KEY);
  return json({
    brief: {
      text: brief.text,
      generatedAt: brief.generatedAt,
      sources: brief.sources,
      model: brief.model,
    },
    refreshed: true,
  });
}

// Simple hash for IP addresses (same as rate-limit.js pattern)
function hashIp(ip) {
  let h = 0;
  for (let i = 0; i < ip.length; i++) {
    h = (h << 5) - h + ip.charCodeAt(i);
    h = h & h;
  }
  return (h >>> 0).toString(36);
}
