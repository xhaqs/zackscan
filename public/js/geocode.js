// Open-Meteo Geocoding API — no key required.
// Also manages the "recent locations" list in localStorage.

const API = "https://geocoding-api.open-meteo.com/v1/search";
const RECENT_KEY = "zackscan.recent_locations";
const MAX_RECENT = 5;

export async function searchLocations(query) {
  if (!query || query.trim().length < 2) return [];
  const res = await fetch(
    `${API}?name=${encodeURIComponent(query.trim())}&count=6&language=en&format=json`,
  );
  if (!res.ok) return [];
  const data = await res.json().catch(() => ({}));
  return (data.results || []).map((r) => ({
    id: `geo_${r.latitude}_${r.longitude}`,
    name: [r.name, r.admin1, r.country].filter(Boolean).join(", "),
    lat: r.latitude,
    lon: r.longitude,
    custom: true,
  }));
}

export function getRecentLocations() {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
  } catch {
    return [];
  }
}

export function addRecentLocation(loc) {
  const recent = getRecentLocations().filter((r) => r.id !== loc.id);
  recent.unshift({
    id: loc.id,
    name: loc.name,
    lat: loc.lat,
    lon: loc.lon,
    custom: true,
  });
  try {
    localStorage.setItem(
      RECENT_KEY,
      JSON.stringify(recent.slice(0, MAX_RECENT)),
    );
  } catch {}
}
