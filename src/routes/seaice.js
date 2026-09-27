// GET /api/seaice — Arctic sea ice extent anomaly vs 1981-2010 baseline.
// KV cache: "seaice:v1:north" TTL 6 hours (NSIDC data updates once daily).

import {
  fetchSeaIceExtent,
  fetchClimatology,
  seaIceSummary,
} from "../risk/sources/seaice.js";
import { makeStore } from "../risk/store.js";
import { json } from "../http.js";

const CACHE_KEY = "seaice:v1:north";
const CACHE_TTL = 6 * 3600;

export async function handleSeaIce(request, env, deps = {}) {
  const store = deps.store || makeStore(env);
  const fetchImpl = deps.fetch || fetch;

  const cached = await store.get(CACHE_KEY);
  if (cached) return json({ ...cached, cached: true });

  const [extentResult, climResult] = await Promise.allSettled([
    fetchSeaIceExtent({ fetch: fetchImpl }),
    fetchClimatology({ fetch: fetchImpl }),
  ]);

  if (extentResult.status === "rejected") {
    return json(
      {
        error: "Sea ice data couldn't be loaded right now. Try again.",
        code: "seaice_unavailable",
      },
      502,
    );
  }

  const extentRows = extentResult.value;
  const climRows = climResult.status === "fulfilled" ? climResult.value : [];

  const north = seaIceSummary(extentRows, climRows);

  const result = {
    north,
    asOf: new Date().toISOString(),
  };

  await store.put(CACHE_KEY, result, CACHE_TTL);
  return json(result);
}
