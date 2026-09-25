// Shared fetch helper for the public hazard APIs.

const UA = "Zackscan/0.1 (+https://zackscan.riakoine.workers.dev)";

export class SourceError extends Error {
  constructor(source, message, { status, code } = {}) {
    super(`${source}: ${message}`);
    this.source = source;
    this.status = status;
    this.code = code; // e.g. "unauthorized", "rate_limited", "bad_response"
  }
}

export async function getText(source, url, { fetch = globalThis.fetch, headers = {}, timeoutMs = 15_000 } = {}) {
  let res;
  try {
    res = await fetch(url, { headers: { "User-Agent": UA, ...headers }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new SourceError(source, e?.name === "TimeoutError" ? "timed out" : "network error", { code: "network" });
  }
  if (res.status === 401 || res.status === 403) throw new SourceError(source, "key rejected", { status: res.status, code: "unauthorized" });
  if (res.status === 429) throw new SourceError(source, "rate limited", { status: 429, code: "rate_limited" });
  if (!res.ok) throw new SourceError(source, `HTTP ${res.status}`, { status: res.status, code: "http" });
  return res.text();
}

export async function getJson(source, url, opts) {
  const text = await getText(source, url, opts);
  try {
    return JSON.parse(text);
  } catch {
    throw new SourceError(source, "response was not JSON", { code: "bad_response" });
  }
}
