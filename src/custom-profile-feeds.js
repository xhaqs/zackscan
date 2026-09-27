// Server-side feed category map for custom mission profiles.
// Feed URLs are always built here, never accepted from clients.
// Shared by the interpret and analyze routes.

const EONET = "https://eonet.gsfc.nasa.gov/api/v3/events?status=open&days=7&limit=200&category=";
const USGS  = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/";

export const FEED_CATEGORIES = Object.freeze({
  eonet_all:        { source: "eonet", url: EONET + "wildfires,floods,severeStorms,volcanoes,earthquakes" },
  eonet_wildfires:  { source: "eonet", url: EONET + "wildfires" },
  eonet_floods:     { source: "eonet", url: EONET + "floods,severeStorms,seaLakeIce,snow,landslides" },
  eonet_seismic:    { source: "eonet", url: EONET + "volcanoes,earthquakes" },
  eonet_storms:     { source: "eonet", url: EONET + "severeStorms" },
  usgs_hourly:      { source: "usgs", url: USGS + "all_hour.geojson" },
  usgs_significant: { source: "usgs", url: USGS + "significant_day.geojson" },
});

export function buildCustomProfileFeeds(feedCategories) {
  return (feedCategories || [])
    .filter((c) => Object.hasOwn(FEED_CATEGORIES, c))
    .map((c) => FEED_CATEGORIES[c]);
}

/** Build a server-usable profile object from a client-supplied spec. Returns null if invalid. */
export function buildCustomProfileForServer(spec) {
  if (!spec || !Array.isArray(spec.feedCategories) || !Array.isArray(spec.metrics)) return null;
  const feeds = buildCustomProfileFeeds(spec.feedCategories);
  if (!feeds.length) return null;
  const metrics = spec.metrics
    .filter((m) => typeof m === "string" && m.trim())
    .slice(0, 5)
    .map((m) => String(m).slice(0, 300));
  if (!metrics.length) return null;
  return {
    id: "custom",
    name: String(spec.name || "Custom Profile").slice(0, 80),
    audience: spec.audience === "professional" ? "professional" : "citizen",
    pollMs: [30000, 60000, 120000, 300000].includes(spec.pollMs) ? spec.pollMs : 300000,
    palette: { accent: "#1f8a70", accentSoft: "#d6efe7", alert: "#c2410c", bgTint: "#f4f8f6" },
    feeds,
    metrics,
  };
}
