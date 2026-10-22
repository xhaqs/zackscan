// Open-Meteo Geocoding API — no key required.
// Also manages the "recent locations" list in localStorage.

const API = "https://geocoding-api.open-meteo.com/v1/search";
const NOMINATIM = "https://nominatim.openstreetmap.org/reverse";
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

/** Resolve the browser's current position into a named location object.
 *  Reverse-geocodes via Nominatim; falls back to "My location (lat, lon)". */
export function getCurrentLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation)
      return reject(new Error("Geolocation not supported"));
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { latitude: lat, longitude: lon } = pos.coords;
        const id = `geo_${lat.toFixed(4)}_${lon.toFixed(4)}`;
        let name = `My location (${lat.toFixed(2)}, ${lon.toFixed(2)})`;
        try {
          const r = await fetch(
            `${NOMINATIM}?lat=${lat}&lon=${lon}&format=json&zoom=10`,
            { headers: { Accept: "application/json" } },
          );
          if (r.ok) {
            const d = await r.json();
            const a = d.address || {};
            const parts = [
              a.city || a.town || a.village || a.county,
              a.state || a.region,
              a.country,
            ].filter(Boolean);
            if (parts.length) name = parts.join(", ");
          }
        } catch {}
        resolve({ id, name, lat, lon, custom: true });
      },
      (err) => reject(err),
      { timeout: 10_000 },
    );
  });
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
