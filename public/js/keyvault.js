// KeyVault: the browser-side half of BYOK. Holds the user's own AI key and
// attaches it to API calls. The key never goes to Zackscan's storage; the
// Worker uses it for one request and forgets it.
//
// Where the key is kept:
// - sessionStorage by default: gone when the tab closes.
// - localStorage only when the user ticks "Remember on this device".
// Anything that can run script on this page can read either one, which is why
// the page ships a strict Content-Security-Policy (public/_headers) and loads
// no third-party scripts.

const SLOT = "zackscan.byok";
export const PROVIDERS = ["anthropic", "gemini"];
const SHAPES = {
  anthropic: /^sk-ant-[A-Za-z0-9_-]{20,250}$/,
  gemini: /^AIza[A-Za-z0-9_-]{30,60}$/,
};

function store(kind) {
  try {
    const s = kind === "local" ? window.localStorage : window.sessionStorage;
    const probe = SLOT + ".probe";
    s.setItem(probe, "1");
    s.removeItem(probe);
    return s;
  } catch {
    return null; // private mode or blocked storage
  }
}

function read(s) {
  if (!s) return null;
  try {
    const v = JSON.parse(s.getItem(SLOT) || "null");
    return v && PROVIDERS.includes(v.provider) && typeof v.key === "string" ? v : null;
  } catch {
    return null;
  }
}

// Kept in memory as a last resort, when storage is blocked.
let memoryOnly = null;

export const KeyVault = {
  /** Validate and save. Returns {ok} or {ok:false, error}. */
  save(provider, key, { remember = false } = {}) {
    key = String(key || "").trim();
    if (!PROVIDERS.includes(provider)) return { ok: false, error: "Choose a provider." };
    if (!SHAPES[provider].test(key))
      return { ok: false, error: provider === "anthropic" ? "Anthropic keys start with sk-ant-." : "Gemini keys start with AIza." };
    this.clear();
    const entry = { provider, key, savedAt: Date.now() };
    const s = store(remember ? "local" : "session");
    if (s) {
      try {
        s.setItem(SLOT, JSON.stringify(entry));
        return { ok: true, where: remember ? "device" : "tab" };
      } catch {}
    }
    memoryOnly = entry;
    return { ok: true, where: "memory" };
  },

  get() {
    return memoryOnly || read(store("session")) || read(store("local"));
  },

  /** Where the key is kept now: "tab" | "device" | "memory" | null. */
  where() {
    if (memoryOnly) return "memory";
    if (read(store("session"))) return "tab";
    if (read(store("local"))) return "device";
    return null;
  },

  clear() {
    memoryOnly = null;
    for (const k of ["session", "local"]) {
      try {
        store(k)?.removeItem(SLOT);
      } catch {}
    }
  },

  /** Headers for an AI request: the user's key if set, else none (platform tier). */
  headers() {
    const v = this.get();
    return v ? { "X-Custom-AI-Key": v.key, "X-Custom-AI-Provider": v.provider } : {};
  },

  /** A safe-to-display version, e.g. "sk-ant-…9fQ2". */
  masked() {
    const v = this.get();
    return v ? { provider: v.provider, hint: v.key.slice(0, 7) + "…" + v.key.slice(-4) } : null;
  },
};
