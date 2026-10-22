// Collect all the live data the app uses into one snapshot for the daily brief.

import { getMatrix, summarizeMatrix } from "../risk/matrix.js";
import { loadProfileEvents } from "../feeds.js";
import { PROFILES } from "../../public/js/profiles.js";
import { handleSeaIce } from "../routes/seaice.js";

/**
 * Collect current data from all sources. Returns { data, sources } where:
 * - data: { matrix, events, seaIce } with current readings
 * - sources: [{ name, fetchedAt }] for every source that contributed data
 */
export async function collectBriefData(env, deps = {}) {
  const now = Date.now();
  const sources = [];

  // Risk matrix: full data for all regions
  const matrix = await getMatrix(env, deps, { now });
  const matrixTime = new Date(now).toISOString();
  sources.push({ name: "Risk Matrix", fetchedAt: matrixTime });

  // Events from the general awareness profile (wildfires, floods, storms,
  // volcanoes, earthquakes, significant quakes)
  const profile = PROFILES.general;
  const feed = await loadProfileEvents(profile, deps);
  const feedTime = new Date(feed.fetchedAt || now).toISOString();
  sources.push({ name: "NASA EONET", fetchedAt: feedTime });
  sources.push({ name: "USGS Earthquakes", fetchedAt: feedTime });

  // Sea ice extent and anomaly
  let seaIce = null;
  try {
    const seaIceRes = await handleSeaIce({}, env, deps);
    if (seaIceRes.status === 200) {
      const body = await seaIceRes.json();
      seaIce = body;
      sources.push({ name: "NSIDC Sea Ice Index", fetchedAt: body.asOf });
    }
  } catch (e) {
    console.warn("Sea ice data unavailable for brief:", e?.message);
  }

  return {
    data: {
      matrix: summarizeMatrix(matrix), // Use summary to save tokens
      events: feed.events.slice(0, 30), // Top 30 most recent events
      seaIce,
    },
    sources,
  };
}
