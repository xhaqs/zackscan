// Custom Mission Profiles — created by the user with AI assistance, stored in localStorage.
// The AI interprets a free-text description into a structured profile spec.
// Dispatches "zackscan:profiles" when the set changes.

const STORAGE_KEY = "zackscan.custom_profiles";

export const PALETTE_PRESETS = Object.freeze({
  green: {
    accent: "#1f8a70",
    accentSoft: "#d6efe7",
    alert: "#c2410c",
    bgTint: "#f4f8f6",
  },
  orange: {
    accent: "#c2410c",
    accentSoft: "#fde3d3",
    alert: "#991b1b",
    bgTint: "#fbf6f2",
  },
  blue: {
    accent: "#1d4ed8",
    accentSoft: "#dbe6fd",
    alert: "#b91c1c",
    bgTint: "#f3f6fb",
  },
  purple: {
    accent: "#6d28d9",
    accentSoft: "#e9e0fb",
    alert: "#be123c",
    bgTint: "#f6f4fb",
  },
  red: {
    accent: "#b91c1c",
    accentSoft: "#ffd5d5",
    alert: "#7f1d1d",
    bgTint: "#fdf4f4",
  },
  teal: {
    accent: "#0f766e",
    accentSoft: "#ccfbf1",
    alert: "#c2410c",
    bgTint: "#f0fdfb",
  },
});

const FEED_LABELS = Object.freeze({
  eonet_all: "All hazards (EONET)",
  eonet_wildfires: "Wildfires (EONET)",
  eonet_floods: "Floods & storms (EONET)",
  eonet_seismic: "Volcanoes & earthquakes (EONET)",
  eonet_storms: "Severe storms (EONET)",
  usgs_hourly: "Earthquakes – last hour (USGS)",
  usgs_significant: "Significant earthquakes today (USGS)",
});
export { FEED_LABELS };

function load() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}
function persist(profiles) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(profiles));
  } catch {}
}

export function getCustomProfiles() {
  return Object.values(load());
}

export function getCustomProfile(id) {
  return load()[id] ?? null;
}

export function saveCustomProfile(profile) {
  const all = load();
  all[profile.id] = profile;
  persist(all);
  dispatchEvent(new CustomEvent("zackscan:profiles"));
}

export function deleteCustomProfile(id) {
  const all = load();
  delete all[id];
  persist(all);
  dispatchEvent(new CustomEvent("zackscan:profiles"));
}

export function newCustomId() {
  return (
    "custom_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  );
}

/** Build a full profile object (compatible with state.js) from an interpret result. */
export function buildProfileFromInterpret(interpreted, id, description) {
  const palette =
    PALETTE_PRESETS[interpreted.paletteKey] ?? PALETTE_PRESETS.green;
  return {
    id,
    name: interpreted.name,
    audience: interpreted.audience,
    pollMs: interpreted.pollMs,
    palette,
    feedCategories: interpreted.feedCategories,
    metrics: interpreted.metrics,
    custom: true,
    description,
    createdAt: interpreted.interpretedAt ?? new Date().toISOString(),
  };
}
