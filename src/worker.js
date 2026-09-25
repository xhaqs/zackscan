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
import { getMatrix, refreshStalest, summarizeMatrix, matrixVersion } from "./risk/matrix.js";
import { jsonWithEtag } from "./etag.js";
import { makeStore } from "./risk/store.js";
import { handleAlerts, runAlertSweep } from "./routes/alerts.js";
import { getDispersion, getHeatGrid } from "./risk/grids.js";
import { getRegion } from "./risk/regions.js";

const MAX_BODY = 4 * 1024;
const analyze = withAiRoute(handleAnalyze, { lazy: true });

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;

    if (route === "GET /api/profiles") return json({ profiles: Object.values(PROFILES).map(publicProfile) });

    if (route === "GET /api/feed") {
      const profile = getProfile(url.searchParams.get("profile"));
      if (!profile) return json({ error: "Unknown mission profile.", code: "profile_invalid" }, 400);
      const feed = await loadProfileEvents(profile);
      // no-cache = "check with me first": the browser revalidates with the ETag
      // and gets an empty 304 when the events haven't changed.
      return jsonWithEtag(request, { profile: profile.id, ...feed }, [profile.id, feed.events.map((e) => [e.id, e.time]), feed.errors], {
        "Cache-Control": "no-cache",
      });
    }

    if (route === "GET /api/health") {
      const cron = await makeStore(env).get("cron:last");
      return json({
        ok: true,
        cron: cron || { state: "never run" },
        keys: { firms: !!env.FIRMS_MAP_KEY, openaq: !!env.OPENAQ_API_KEY, platformAi: !!env.PLATFORM_GEMINI_KEY, push: !!(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) },
      });
    }

    if (url.pathname.startsWith("/api/alerts/")) {
      const res = await handleAlerts(route, request, env);
      return res || json({ error: "Not found.", code: "not_found" }, 404);
    }

    // Gridded maps, built on demand and cached per region (see src/risk/grids.js).
    if (route === "GET /api/dispersion" || route === "GET /api/heatgrid") {
      const region = getRegion(url.searchParams.get("region"));
      if (!region) return json({ error: "Unknown region.", code: "region_invalid" }, 400);
      try {
        let body;
        if (route === "GET /api/dispersion") {
          // Fire detections come from the cached risk matrix: no extra FIRMS call.
          const m = await getMatrix(env, {}, { regionId: region.id, computeBudget: 0 }).catch(() => null);
          body = await getDispersion(region, env, {}, { fires: m?.regions?.[0]?.pillars?.wildfire?.components?.activity?.points || [] });
        } else body = await getHeatGrid(region, env);
        return jsonWithEtag(request, body, [route, region.id, body.fetchedAt], { "Cache-Control": "public, max-age=600" });
      } catch (e) {
        return json({ error: "The map data couldn't be loaded right now. Try again in a few minutes.", code: "source_error", detail: String(e?.message || e).slice(0, 120) }, 502);
      }
    }

    if (route === "GET /api/risk") {
      const regionId = url.searchParams.get("region");
      if (regionId && !getRegion(regionId)) return json({ error: "Unknown region.", code: "region_invalid" }, 400);
      const fields = url.searchParams.get("fields") === "summary" ? "summary" : "full";
      const matrix = await getMatrix(env, {}, { regionId });
      const body = fields === "summary" ? summarizeMatrix(matrix) : matrix;
      // Fresh for 60 s, then revalidated by ETag: unchanged data costs a 304.
      return jsonWithEtag(request, body, matrixVersion(matrix, fields), { "Cache-Control": "public, max-age=60" });
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
  // Every run leaves a heartbeat in KV, so /api/health can show whether the
  // cron is actually firing without needing access to the Worker's logs.
  async scheduled(event, env, ctx) {
    const store = makeStore(env);
    const startedAt = new Date().toISOString();
    ctx.waitUntil(
      (async () => {
        await store.put("cron:last", { startedAt, cron: event.cron, state: "running" });
        try {
          const refreshed = await refreshStalest(env, { store });
          // Then check every device's alarm rules against the fresh data.
          const alerts = await runAlertSweep(env, { store }).catch((e) => ({ error: String(e?.message || e) }));
          await store.put("cron:last", { startedAt, finishedAt: new Date().toISOString(), cron: event.cron, state: "ok", refreshed, alerts });
        } catch (e) {
          await store.put("cron:last", { startedAt, finishedAt: new Date().toISOString(), cron: event.cron, state: "error", error: String(e?.message || e) });
        }
      })(),
    );
  },
};

// What the browser needs to know about a profile. Feed URLs and the metric
// wording are included; nothing here is secret.
function publicProfile(p) {
  return { id: p.id, name: p.name, audience: p.audience, pollMs: p.pollMs, palette: p.palette, metrics: p.metrics };
}
