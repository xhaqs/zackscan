import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { nextPollDelay, wantDataSaver, mergeLastGood, goodPillars, ageLabel } from "../public/js/offline-logic.js";
import * as store from "../public/js/offline-store.js";
import worker from "../src/worker.js";
import { _resetMemoryStore, makeStore } from "../src/risk/store.js";

const MIN = 60_000;
const noJitter = () => 0.5;

test("polling: offline stops, failures back off exponentially, data saver slows down", () => {
  assert.equal(nextPollDelay({ baseMs: 5 * MIN, online: false }), null, "no timers while offline");
  assert.equal(nextPollDelay({ baseMs: 5 * MIN, random: noJitter }), 5 * MIN);
  assert.equal(nextPollDelay({ baseMs: 5 * MIN, failures: 1, random: noJitter }), 10 * MIN);
  assert.equal(nextPollDelay({ baseMs: 5 * MIN, failures: 2, random: noJitter }), 20 * MIN);
  assert.equal(nextPollDelay({ baseMs: 5 * MIN, failures: 9, random: noJitter }), 30 * MIN, "capped");
  assert.equal(nextPollDelay({ baseMs: 30_000, failures: 3, random: noJitter }), 4 * MIN, "fast profiles back off too");
  assert.equal(nextPollDelay({ baseMs: 5 * MIN, dataSaver: true, random: noJitter }), 15 * MIN);
  assert.equal(nextPollDelay({ baseMs: 5 * MIN, dataSaver: true, failures: 9, random: noJitter }), 60 * MIN);
  const lo = nextPollDelay({ baseMs: 10 * MIN, random: () => 0 });
  const hi = nextPollDelay({ baseMs: 10 * MIN, random: () => 0.9999 });
  assert.ok(lo >= 9 * MIN && hi <= 11 * MIN && hi > lo, "±10% jitter");
});

test("data saver: user setting wins, then browser hints, then measured slowness", () => {
  assert.equal(wantDataSaver({ userSetting: "on" }), true);
  assert.equal(wantDataSaver({ userSetting: "off", connection: { saveData: true } }), false);
  assert.equal(wantDataSaver({ connection: { saveData: true } }), true);
  assert.equal(wantDataSaver({ connection: { effectiveType: "2g" } }), true);
  assert.equal(wantDataSaver({ connection: { effectiveType: "4g" } }), false);
  assert.equal(wantDataSaver({ slowResponses: 2 }), true);
  assert.equal(wantDataSaver({}), false, "no connection info (Safari/Firefox) means normal mode");
});

const pillar = (score, asOf, status = "live") => ({ score, level: "high", status, asOf, notes: [] });

test("last good pillar fills gaps, marked cached with its own time; live data is never replaced", () => {
  const lastGood = {
    "dubai:heat": { key: "dubai:heat", pillar: pillar(62, "2026-09-25T10:00:00Z") },
    "dubai:seismic": { key: "dubai:seismic", pillar: pillar(5, "2026-09-25T10:00:00Z") },
    "tokyo:seismic": { key: "tokyo:seismic", pillar: pillar(16, "2026-09-25T09:00:00Z") },
  };
  const m = {
    regions: [
      { id: "dubai", pillars: { heat: pillar(null, null, "error"), seismic: pillar(3, "2026-09-25T11:00:00Z"), wildfire: pillar(10, "2026-09-25T11:00:00Z"), glof: { score: null, status: "stub" } } },
      { id: "tokyo", pending: true },
      { id: "delhi", pending: true },
    ],
  };
  const out = mergeLastGood(m, lastGood);
  const dubai = out.regions[0].pillars;
  assert.equal(dubai.heat.status, "cached");
  assert.equal(dubai.heat.score, 62);
  assert.equal(dubai.heat.asOf, "2026-09-25T10:00:00Z", "keeps its real timestamp");
  assert.equal(dubai.seismic.score, 3, "fresh data wins over saved");
  assert.equal(dubai.glof.status, "stub", "GLOF untouched");
  assert.equal(out.regions[1].fromDevice, true);
  assert.equal(out.regions[1].pillars.seismic.status, "cached");
  assert.equal(out.regions[2].pending, true, "nothing saved: still pending");
});

test("only real readings are remembered", () => {
  const m = { regions: [{ id: "x", pillars: { seismic: pillar(3, "2026-09-25T11:00:00Z"), heat: pillar(null, null, "error"), wildfire: pillar(9, "2026-09-25T08:00:00Z", "cached") } }] };
  assert.deepEqual(goodPillars(m).map((g) => g.key), ["x:seismic"]);
});

test("age labels", () => {
  const now = Date.parse("2026-09-25T12:00:00Z");
  assert.equal(ageLabel(now - 20_000, now), "just now");
  assert.equal(ageLabel(now - 23 * MIN, now), "23 min ago");
  assert.equal(ageLabel(now - 3 * 60 * MIN, now), "3 h ago");
  assert.equal(ageLabel(now - 72 * 60 * MIN, now), "3 days ago");
  assert.equal(ageLabel(NaN, now), "unknown time");
});

test("offline store (memory fallback in Node): newest snapshot, pillars never go backwards", async () => {
  await store.saveSnapshot("risk:full", { v: 1 }, 1000);
  await store.saveSnapshot("risk:summary", { v: 2 }, 2000);
  assert.deepEqual((await store.newestSnapshot(["risk:full", "risk:summary"])).data, { v: 2 });
  const at = (iso) => ({ regions: [{ id: "r", pillars: { heat: pillar(50, iso) } }] });
  await store.rememberPillars(at("2026-09-25T11:00:00Z"));
  await store.rememberPillars(at("2026-09-25T09:00:00Z")); // older: ignored
  assert.equal((await store.lastGoodPillars())["r:heat"].pillar.asOf, "2026-09-25T11:00:00Z");
  await store.saveSitrep("wildfire", { assessment: { summary: "s" } }, 5);
  assert.equal((await store.loadSitrep("wildfire")).savedAt, 5);
});

test("service worker and page agree on the database", () => {
  const sw = readFileSync("public/sw.js", "utf8");
  assert.match(sw, new RegExp(`const DB_NAME = "${store.DB_NAME}"`));
  assert.match(sw, new RegExp(`const DB_VERSION = ${store.DB_VERSION};`));
  assert.deepEqual(JSON.parse(sw.match(/const STORES = (\[.*?\]);/)[1]), store.STORES);
});

test("service worker precaches every app file, and every listed file exists", () => {
  const sw = readFileSync("public/sw.js", "utf8");
  const listed = JSON.parse(sw.match(/const SHELL_FILES = (\[[\s\S]*?\]);/)[1].replace(/,\s*]/, "]"));
  const expected = [
    ...readdirSync("public/js").map((f) => "/js/" + f),
    ...readdirSync("public/css").map((f) => "/css/" + f),
    ...readdirSync("public/icons").map((f) => "/icons/" + f),
    "/", "/favicon.svg", "/manifest.webmanifest",
  ];
  for (const f of expected) assert.ok(listed.includes(f), `sw.js SHELL_FILES is missing ${f}`);
  for (const f of listed) assert.ok(f === "/" || existsSync("public" + f), `sw.js lists ${f}, which doesn't exist`);
  assert.ok(!listed.some((f) => f.startsWith("/api/")), "API responses are never precached");
});

test("service worker never touches /api or non-GET requests (keys stay out of caches)", () => {
  const sw = readFileSync("public/sw.js", "utf8");
  assert.match(sw, /req\.method !== "GET" \|\| url\.origin !== location\.origin \|\| url\.pathname\.startsWith\("\/api\/"\)\) return;/);
});

// ---------------------------------------------------------------- server side

async function seededEnv() {
  _resetMemoryStore();
  const s = makeStore({});
  const now = new Date().toISOString();
  const p = (score) => ({ score, level: "low", status: "live", realtime: true, asOf: now, sources: [], components: { big: "x".repeat(2000) }, notes: ["n"] });
  const { REGIONS } = await import("../src/risk/regions.js");
  for (const r of REGIONS)
    await s.put(`risk:v1:${r.id}`, {
      id: r.id, name: r.name, updatedAt: now,
      overall: { score: 10, level: "low", drivers: [] },
      pillars: { seismic: p(1), wildfire: p(2), heat: p(10), glof: { score: null, level: "unknown", status: "stub", realtime: false, label: "Preliminary / Non-Real-Time" } },
    });
  return {};
}

test("/api/risk: ETag gives 304 when unchanged; summary is small and keeps the GLOF label", async () => {
  const env = await seededEnv();
  const first = await worker.fetch(new Request("https://z.test/api/risk"), env, {});
  const tag = first.headers.get("ETag");
  const fullSize = (await first.text()).length;
  assert.ok(tag);
  const again = await worker.fetch(new Request("https://z.test/api/risk", { headers: { "If-None-Match": tag } }), env, {});
  assert.equal(again.status, 304);
  assert.equal(await again.text(), "");

  const sum = await worker.fetch(new Request("https://z.test/api/risk?fields=summary"), env, {});
  assert.notEqual(sum.headers.get("ETag"), tag, "summary and full are different representations");
  const body = await sum.json();
  assert.equal(body.fields, "summary");
  assert.ok(JSON.stringify(body).length < fullSize / 3, "summary is much smaller");
  assert.equal(body.regions[0].pillars.heat.components, undefined);
  assert.equal(body.regions[0].pillars.glof.label, "Preliminary / Non-Real-Time");
});

test("/api/feed: ETag gives 304 when the events are unchanged", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({ events: [{ id: "E1", title: "Fire", categories: [{ id: "wildfires" }], geometry: [{ type: "Point", date: "2026-09-25T00:00:00Z", coordinates: [1, 2] }] }] });
  try {
    const first = await worker.fetch(new Request("https://z.test/api/feed?profile=wildfire"), {}, {});
    assert.equal(first.headers.get("Cache-Control"), "no-cache");
    const again = await worker.fetch(new Request("https://z.test/api/feed?profile=wildfire", { headers: { "If-None-Match": first.headers.get("ETag") } }), {}, {});
    assert.equal(again.status, 304);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("every browser script parses (the Node tests don't import them all)", async () => {
  const { spawnSync } = await import("node:child_process");
  const files = [...readdirSync("public/js").map((f) => "public/js/" + f), "public/sw.js"];
  for (const f of files) {
    const r = spawnSync(process.execPath, ["--check", f], { encoding: "utf8" });
    assert.equal(r.status, 0, `${f} has a syntax error:\n${r.stderr}`);
  }
});
