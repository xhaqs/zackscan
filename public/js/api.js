// Same-origin API client. AI calls carry the user's key when one is set.
import { KeyVault } from "./keyvault.js";

async function call(path, opts = {}) {
  const res = await fetch(path, {
    credentials: "same-origin",
    cache: "no-cache",
    ...opts,
  }); // revalidate, never trust the HTTP cache blindly
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.code = data.code;
    err.status = res.status;
    throw err;
  }
  return data;
}

export const api = {
  profiles: () => call("/api/profiles"),
  feed: (profile) => call("/api/feed?profile=" + encodeURIComponent(profile)),
  /** Live events for a custom profile (inline spec, feed URLs built server-side). */
  feedCustom: (customProfile) =>
    call("/api/feed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ customProfile }),
    }),
  /** knownFingerprint: the data version we already hold; the server says {unchanged:true} if it's current. */
  analyze: (profile, knownFingerprint) =>
    call("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...KeyVault.headers() },
      body: JSON.stringify({
        profile,
        ...(knownFingerprint ? { knownFingerprint } : {}),
      }),
    }),
  /** Assessment for a custom profile (inline spec, feed URLs built server-side). */
  analyzeCustom: (customProfile, knownFingerprint) =>
    call("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...KeyVault.headers() },
      body: JSON.stringify({
        customProfile,
        ...(knownFingerprint ? { knownFingerprint } : {}),
      }),
    }),
  /** AI SitRep for one anomaly card (region × hazard pillar), both registers in one call. */
  analyzeCard: (region, pillar, knownFingerprint) =>
    call("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...KeyVault.headers() },
      body: JSON.stringify({
        region,
        pillar,
        ...(knownFingerprint ? { knownFingerprint } : {}),
      }),
    }),
  /** On-demand weather + seasonal baseline for any lat/lon. */
  weather: (lat, lon) =>
    call(
      `/api/weather?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`,
    ),
  /** Interpret a free-text description into a structured mission profile spec. */
  interpretProfile: (description) =>
    call("/api/profiles/interpret", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...KeyVault.headers() },
      body: JSON.stringify({ description }),
    }),
};
