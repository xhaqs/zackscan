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

import { AI_PROVIDERS, isKnownModel } from "./ai-catalog.js";

const SLOT = "zackscan.byok";
const known = (p) => Object.hasOwn(AI_PROVIDERS, p);

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
    if (!v || !known(v.provider) || typeof v.key !== "string") return null;
    // A model dropped from the catalog since it was saved: keep the key, use the default.
    if (!isKnownModel(v.provider, v.model)) v.model = AI_PROVIDERS[v.provider].defaultModel;
    return v;
  } catch {
    return null;
  }
}

// Kept in memory as a last resort, when storage is blocked.
let memoryOnly = null;

export const KeyVault = {
  /** Validate and save. Returns {ok} or {ok:false, error}. */
  save(provider, key, { remember = false, model } = {}) {
    key = String(key || "").trim();
    if (!known(provider)) return { ok: false, error: "Choose a provider." };
    const p = AI_PROVIDERS[provider];
    if (!p.keyPattern.test(key)) return { ok: false, error: `${p.label} keys: ${p.keyHint}.` };
    model = model || p.defaultModel;
    if (!isKnownModel(provider, model)) return { ok: false, error: "Choose a model from the list." };
    this.clear();
    const entry = { provider, model, key, savedAt: Date.now() };
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

  /** Change the model for the saved key, keeping where it's stored. */
  setModel(model) {
    const v = this.get();
    if (!v || !isKnownModel(v.provider, model)) return { ok: false, error: "Choose a model from the list." };
    return this.save(v.provider, v.key, { remember: this.where() === "device", model });
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
    return v ? { "X-Custom-AI-Key": v.key, "X-Custom-AI-Provider": v.provider, "X-Custom-AI-Model": v.model } : {};
  },

  /** A safe-to-display version, e.g. "sk-ant-…9fQ2". */
  masked() {
    const v = this.get();
    if (!v) return null;
    const p = AI_PROVIDERS[v.provider];
    return {
      provider: v.provider,
      providerLabel: p.label,
      model: v.model,
      modelLabel: p.models.find((m) => m.id === v.model)?.label || v.model,
      hint: v.key.slice(0, 7) + "…" + v.key.slice(-4),
    };
  },
};
