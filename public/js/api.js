// Same-origin API client. AI calls carry the user's key when one is set.
import { KeyVault } from "./keyvault.js";

async function call(path, opts = {}) {
  const res = await fetch(path, { credentials: "same-origin", ...opts });
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
  analyze: (profile) =>
    call("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...KeyVault.headers() },
      body: JSON.stringify({ profile }),
    }),
};
