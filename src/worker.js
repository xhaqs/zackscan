// Zackscan Worker. Static files in /public are served by Workers Assets;
// this handles /api/*.
//
// No CORS headers on purpose: the API is same-origin only. Requests carrying
// X-Custom-AI-Key need a preflight, and without CORS headers other sites'
// pages can't make them.

import { PROFILES, getProfile } from "../public/js/profiles.js";
import { withAiRoute } from "./middleware/ai-key.js";
import { handleAnalyze } from "./routes/analyze.js";
import { loadProfileEvents } from "./feeds.js";
import { json } from "./http.js";
import { getMatrix, refreshStalest } from "./risk/matrix.js";
import { getRegion } from "./risk/regions.js";

const MAX_BODY = 4 * 1024;
const analyze = withAiRoute(handleAnalyze);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;

    if (route === "GET /api/profiles") return json({ profiles: Object.values(PROFILES).map(publicProfile) });

    if (route === "GET /api/feed") {
      const profile = getProfile(url.searchParams.get("profile"));
      if (!profile) return json({ error: "Unknown mission profile.", code: "profile_invalid" }, 400);
      return json({ profile: profile.id, ...(await loadProfileEvents(profile)) });
    }

    if (route === "GET /api/risk") {
      const regionId = url.searchParams.get("region");
      if (regionId && !getRegion(regionId)) return json({ error: "Unknown region.", code: "region_invalid" }, 400);
      const matrix = await getMatrix(env, {}, { regionId });
      // Short public cache: data changes every ~20 min, and this soaks up bursts.
      return json(matrix, 200, { "Cache-Control": "public, max-age=60" });
    }

    if (route === "POST /api/analyze") {
      if (Number(request.headers.get("Content-Length") || 0) > MAX_BODY)
        return json({ error: "Request too large.", code: "too_large" }, 413);
      return analyze(request, env, ctx);
    }

    if (url.pathname.startsWith("/api/")) return json({ error: "Not found.", code: "not_found" }, 404);
    return env.ASSETS.fetch(request);
  },

  // Cron (wrangler.toml): keep the risk matrix warm, a few regions per run.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshStalest(env).then((ids) => console.log("risk refreshed:", ids.join(",") || "none due")));
  },
};

// What the browser needs to know about a profile. Feed URLs and the metric
// wording are included; nothing here is secret.
function publicProfile(p) {
  return { id: p.id, name: p.name, audience: p.audience, pollMs: p.pollMs, palette: p.palette, metrics: p.metrics };
}
