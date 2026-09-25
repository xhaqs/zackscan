import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { PROFILES, getProfile } from "../public/js/profiles.js";

// Minimal Storage stand-in for KeyVault.
class MemStorage {
  #m = new Map();
  getItem(k) { return this.#m.has(k) ? this.#m.get(k) : null; }
  setItem(k, v) { this.#m.set(k, String(v)); }
  removeItem(k) { this.#m.delete(k); }
}
globalThis.window = { sessionStorage: new MemStorage(), localStorage: new MemStorage() };
const { KeyVault } = await import("../public/js/keyvault.js");

const ANTHROPIC_KEY = "sk-ant-api03-" + "A".repeat(40);
const GEMINI_KEY = "AIza" + "B".repeat(35);

beforeEach(() => {
  globalThis.window.sessionStorage = new MemStorage();
  globalThis.window.localStorage = new MemStorage();
  KeyVault.clear();
});

test("keys go to sessionStorage unless the user asks to remember", () => {
  assert.equal(KeyVault.save("gemini", GEMINI_KEY).where, "tab");
  assert.equal(window.localStorage.getItem("zackscan.byok"), null);
  assert.deepEqual(KeyVault.headers(), { "X-Custom-AI-Key": GEMINI_KEY, "X-Custom-AI-Provider": "gemini" });

  assert.equal(KeyVault.save("anthropic", ANTHROPIC_KEY, { remember: true }).where, "device");
  assert.equal(window.sessionStorage.getItem("zackscan.byok"), null, "saving one place clears the other");
  assert.equal(KeyVault.get().provider, "anthropic");
});

test("bad keys are refused before they're stored", () => {
  assert.equal(KeyVault.save("anthropic", GEMINI_KEY).ok, false);
  assert.equal(KeyVault.save("openai", ANTHROPIC_KEY).ok, false);
  assert.equal(KeyVault.get(), null);
  assert.deepEqual(KeyVault.headers(), {}, "no key means platform tier");
});

test("masked view never shows the whole key; clear removes it everywhere", () => {
  KeyVault.save("anthropic", ANTHROPIC_KEY, { remember: true });
  const m = KeyVault.masked();
  assert.ok(!m.hint.includes(ANTHROPIC_KEY.slice(7, -4)));
  KeyVault.clear();
  assert.equal(KeyVault.get(), null);
  assert.equal(KeyVault.where(), null);
});

test("blocked storage falls back to memory only", () => {
  const blocked = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }, removeItem() { throw new Error("blocked"); } };
  globalThis.window.sessionStorage = blocked;
  globalThis.window.localStorage = blocked;
  assert.equal(KeyVault.save("gemini", GEMINI_KEY).where, "memory");
  assert.equal(KeyVault.get().key, GEMINI_KEY);
});

test("every profile is complete and only uses the allowed feed hosts", () => {
  const allowed = new Set(["eonet.gsfc.nasa.gov", "earthquake.usgs.gov"]);
  for (const p of Object.values(PROFILES)) {
    assert.ok(p.pollMs >= 15_000, p.id + " polls too often");
    assert.deepEqual(Object.keys(p.palette).sort(), ["accent", "accentSoft", "alert", "bgTint"]);
    assert.ok(p.metrics.length >= 3);
    for (const f of p.feeds) assert.ok(allowed.has(new URL(f.url).host), f.url);
  }
  assert.equal(getProfile("__proto__"), null);
  assert.equal(getProfile("constructor"), null);
});
