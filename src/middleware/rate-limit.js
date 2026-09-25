// Daily per-IP allowance for the platform AI tier.
// Uses the RATE_LIMIT KV namespace when bound. Without it (local dev, or
// before the namespace exists) it falls back to a per-isolate counter, which
// only slows abuse down; bind KV before going public.

const DAY_S = 86_400;
const memory = new Map();

export async function checkRateLimit(request, env) {
  const max = Number(env.PLATFORM_DAILY_LIMIT) || 10;
  const ip = request.headers.get("CF-Connecting-IP") || "local";
  const day = new Date().toISOString().slice(0, 10);
  const key = `rl:${day}:${await hashIp(ip)}`;
  const retryAfter = DAY_S - (Math.floor(Date.now() / 1000) % DAY_S);

  let used;
  if (env.RATE_LIMIT) {
    used = Number(await env.RATE_LIMIT.get(key)) || 0;
    if (used >= max) return { allowed: false, used, max, retryAfter };
    // KV is eventually consistent, so a burst can slip a few calls past the
    // limit. Good enough for a free tier; use a Durable Object if it must be exact.
    await env.RATE_LIMIT.put(key, String(used + 1), { expirationTtl: DAY_S + 3600 });
  } else {
    used = memory.get(key) || 0;
    if (used >= max) return { allowed: false, used, max, retryAfter };
    memory.set(key, used + 1);
  }
  return { allowed: true, used: used + 1, max, retryAfter };
}

// IPs are personal data: store only a hash.
async function hashIp(ip) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("zackscan:" + ip));
  return [...new Uint8Array(buf).slice(0, 12)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function _resetMemoryLimiter() {
  memory.clear();
}
