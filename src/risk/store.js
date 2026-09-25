// Cache for risk data. Uses the RISK_CACHE KV namespace when bound; without
// it (tests, or local dev without KV) falls back to per-isolate memory.
//
// Freshness is decided by the `fetchedAt` stored in each value, not by KV
// expiry. Values are kept for 2 days so a failed refresh can fall back to
// the last good data, marked stale.

const KEEP_S = 2 * 86_400;
const memory = new Map();

export function makeStore(env) {
  const kv = env.RISK_CACHE;
  return {
    async get(key) {
      if (kv) return (await kv.get(key, "json")) ?? null;
      const hit = memory.get(key);
      return hit && hit.until > Date.now() ? hit.value : null;
    },
    async put(key, value, keepSeconds = KEEP_S) {
      if (kv) return kv.put(key, JSON.stringify(value), { expirationTtl: Math.max(60, keepSeconds) });
      memory.set(key, { value, until: Date.now() + keepSeconds * 1000 });
    },
    async delete(key) {
      if (kv) return kv.delete(key);
      memory.delete(key);
    },
    /** All keys with this prefix (up to `max`). */
    async list(prefix, max = 1000) {
      if (!kv) return [...memory.entries()].filter(([k, v]) => k.startsWith(prefix) && v.until > Date.now()).map(([k]) => k).slice(0, max);
      const keys = [];
      let cursor;
      do {
        const page = await kv.list({ prefix, cursor, limit: Math.min(1000, max - keys.length) });
        keys.push(...page.keys.map((k) => k.name));
        cursor = page.list_complete ? null : page.cursor;
      } while (cursor && keys.length < max);
      return keys;
    },
  };
}

export function _resetMemoryStore() {
  memory.clear();
}
