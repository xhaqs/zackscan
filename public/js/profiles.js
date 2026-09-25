// Mission Profiles: one definition shared by the browser (polling + palette)
// and the Worker (which feeds to fetch + what the AI evaluates).
// Feed URLs live here, never in a request, so the Worker can't be pointed at
// arbitrary hosts.

const EONET = "https://eonet.gsfc.nasa.gov/api/v3/events?status=open&days=7&limit=200&category=";
const USGS = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/";

export const PROFILES = Object.freeze({
  general: {
    id: "general",
    name: "General Awareness",
    audience: "citizen",
    pollMs: 5 * 60_000,
    palette: { accent: "#1f8a70", accentSoft: "#d6efe7", alert: "#c2410c", bgTint: "#f4f8f6" },
    feeds: [
      { source: "eonet", url: EONET + "wildfires,floods,severeStorms,volcanoes,earthquakes" },
      { source: "usgs", url: USGS + "significant_day.geojson" },
    ],
    metrics: [
      "Is anyone likely to be in danger in the next 24 hours?",
      "Which events are growing, and which are stable or ending?",
      "Plain-language advice a member of the public can act on",
    ],
  },
  wildfire: {
    id: "wildfire",
    name: "Wildfire Operations",
    audience: "professional",
    pollMs: 60_000,
    palette: { accent: "#c2410c", accentSoft: "#fde3d3", alert: "#991b1b", bgTint: "#fbf6f2" },
    feeds: [{ source: "eonet", url: EONET + "wildfires" }],
    metrics: [
      "Rate of spread and direction, from how event geometry changes over time",
      "Distance to populated places and critical infrastructure",
      "Size of the evacuation window",
      "Clusters of fires that may merge",
    ],
  },
  flood: {
    id: "flood",
    name: "Glacial / Flood Monitoring",
    audience: "professional",
    pollMs: 2 * 60_000,
    palette: { accent: "#1d4ed8", accentSoft: "#dbe6fd", alert: "#b91c1c", bgTint: "#f3f6fb" },
    feeds: [{ source: "eonet", url: EONET + "floods,severeStorms,seaLakeIce,snow,landslides" }],
    metrics: [
      "Signs of a glacial lake outburst flood (GLOF): lake-ice events upstream of settlements",
      "Rain or storms over catchments that are already flooding",
      "Landslide and debris-flow risk downstream",
      "Areas that may be cut off by water",
    ],
  },
  seismic: {
    id: "seismic",
    name: "Seismic Tracking",
    audience: "professional",
    pollMs: 30_000,
    palette: { accent: "#6d28d9", accentSoft: "#e9e0fb", alert: "#be123c", bgTint: "#f6f4fb" },
    feeds: [
      { source: "usgs", url: USGS + "all_hour.geojson" },
      { source: "eonet", url: EONET + "volcanoes,earthquakes" },
    ],
    metrics: [
      "Magnitude and depth, and what they mean for shaking at the surface",
      "Aftershock or swarm patterns (several events close in space and time)",
      "Tsunami potential for shallow offshore events of magnitude 6.5 or more",
      "Volcanic unrest near recent quakes",
    ],
  },
});

export const DEFAULT_PROFILE = "general";

export function getProfile(id) {
  return Object.hasOwn(PROFILES, id) ? PROFILES[id] : null;
}
