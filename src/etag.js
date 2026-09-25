// Conditional responses: if the client already has this version, answer
// 304 with no body. Field devices polling every few minutes mostly get 304s,
// because the risk matrix only changes about every 20 minutes.
//
// The tag is computed from `stable`, the parts that mean "the data changed"
// (e.g. each region's updatedAt), not from the whole body, which also holds
// per-request fields like generatedAt.

import { json } from "./http.js";

export async function etagFor(stable) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(stable)));
  return 'W/"' + [...new Uint8Array(buf).slice(0, 10)].map((b) => b.toString(16).padStart(2, "0")).join("") + '"';
}

export async function jsonWithEtag(request, body, stable, headers = {}) {
  const tag = await etagFor(stable);
  const sent = (request.headers.get("If-None-Match") || "").split(",").map((s) => s.trim());
  if (sent.includes(tag) || sent.includes("*")) return new Response(null, { status: 304, headers: { ETag: tag, ...headers } });
  return json(body, 200, { ETag: tag, ...headers });
}
