// Watchlist regions, shared by the page (alarm rules, labels) and the Worker
// (src/risk/regions.js adds the scoring settings).
export const REGION_LIST = Object.freeze([
  { id: "nairobi", name: "Nairobi, Kenya", lat: -1.2921, lon: 36.8219, seismicMinMag: 4.0 },
  { id: "dubai", name: "Dubai, UAE", lat: 25.2048, lon: 55.2708, seismicMinMag: 4.0 },
  { id: "los-angeles", name: "Los Angeles, USA", lat: 34.0522, lon: -118.2437, seismicMinMag: 2.5 },
  { id: "tokyo", name: "Tokyo, Japan", lat: 35.6762, lon: 139.6503, seismicMinMag: 4.0 },
  { id: "delhi", name: "Delhi, India", lat: 28.6139, lon: 77.209, seismicMinMag: 4.0 },
  { id: "kathmandu", name: "Kathmandu, Nepal", lat: 27.7172, lon: 85.324, seismicMinMag: 4.0 },
]);
export const REGION_IDS = REGION_LIST.map((r) => r.id);
export const regionName = (id) => REGION_LIST.find((r) => r.id === id)?.name || id;
