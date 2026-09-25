import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { validateRules, evaluateRules, acknowledge, describeRule, severityOf, defaultRules, BUILTIN_CRITICAL, MAX_RULES } from "../public/js/alarm-rules.js";
import { pushReadiness } from "../public/js/platform.js";
import { VIBRATION } from "../public/js/alarm-audio.js";
import { notificationOptions } from "../public/js/alarms.js";
import { REGION_IDS } from "../public/js/regions.js";
import { encryptPushPayload, vapidAuthorization, b64uToBytes, bytesToB64u, concatBytes, hkdfBytes, isAllowedPushEndpoint } from "../src/push/webpush.js";
import { runAlertSweep } from "../src/routes/alerts.js";
import { makeStore, _resetMemoryStore } from "../src/risk/store.js";
import { _resetMemoryLimiter } from "../src/middleware/rate-limit.js";
import worker from "../src/worker.js";

const H = 3_600_000;
beforeEach(() => {
  _resetMemoryStore();
  _resetMemoryLimiter();
});

// ---------------------------------------------------------------- rules

const region = (id, { overall = 10, pm25 = null, z = null } = {}) => ({
  id,
  name: id.toUpperCase(),
  overall: { score: overall, level: "low" },
  pillars: {
    seismic: { score: 1 },
    heat: { score: 5, components: { anomaly: z == null ? null : { zScore: z } } },
    wildfire: { score: 2, components: { smoke: pm25 == null ? null : { pm25 } } },
  },
});
const matrix = (...regions) => ({ regions });

test("rules: validation keeps the built-in critical alarm and rejects nonsense", () => {
  assert.deepEqual(validateRules([], REGION_IDS).rules, [BUILTIN_CRITICAL]);
  const off = validateRules([{ ...BUILTIN_CRITICAL, enabled: false, value: 5 }], REGION_IDS).rules[0];
  assert.equal(off.enabled, false);
  assert.equal(off.value, 85, "only the on/off switch of the built-in can change");
  const ok = validateRules([{ id: "pm01", metric: "wildfire.pm25", region: "delhi", value: 150, kind: "reminder", repeatHours: 5 }], REGION_IDS);
  assert.equal(ok.rules[1].repeatHours, 6, "odd repeat periods snap to a supported one");
  assert.match(validateRules([{ id: "x1234", metric: "moon.phase", region: "any", value: 1 }], REGION_IDS).error, /Unknown measurement/);
  assert.match(validateRules([{ id: "x1234", metric: "wildfire.pm25", region: "atlantis", value: 150 }], REGION_IDS).error, /Unknown region/);
  assert.match(validateRules([{ id: "x1234", metric: "wildfire.pm25", region: "any", value: 99999 }], REGION_IDS).error, /choose a value/);
  assert.match(validateRules([{ id: "<b>", metric: "wildfire.pm25", region: "any", value: 150 }], REGION_IDS).error, /Bad rule id/);
  const many = Array.from({ length: MAX_RULES + 1 }, (_, i) => ({ id: "r" + String(i).padStart(4, "0"), metric: "heat.score", region: "any", value: 50 }));
  assert.ok(validateRules(many, REGION_IDS).error);
});

test("rules: an alarm fires once when crossing, re-arms only after falling clearly below", () => {
  const rules = [{ id: "pm1", metric: "wildfire.pm25", region: "delhi", value: 150, kind: "alarm", enabled: true }];
  let r = evaluateRules(rules, matrix(region("delhi", { pm25: 160 })), {}, 0);
  assert.equal(r.alerts.length, 1);
  assert.equal(r.alerts[0].key, "pm1:delhi");
  assert.match(r.alerts[0].title, /DELHI: air pollution \(pm2\.5\) 160 µg\/m³/);
  let st = r.state;
  assert.equal(evaluateRules(rules, matrix(region("delhi", { pm25: 170 })), st, H).alerts.length, 0, "still above: no repeat");
  st = evaluateRules(rules, matrix(region("delhi", { pm25: 148 })), st, 2 * H).state;
  assert.ok(st["pm1:delhi"].active, "within the hysteresis margin: stays armed off");
  st = evaluateRules(rules, matrix(region("delhi", { pm25: 100 })), st, 3 * H).state;
  assert.equal(st["pm1:delhi"], undefined, "clearly below: re-armed");
  assert.equal(evaluateRules(rules, matrix(region("delhi", { pm25: 155 })), st, 4 * H).alerts.length, 1, "fires again on the next crossing");
});

test("rules: reminders repeat until acknowledged; missing data never counts as 'below'", () => {
  const rules = [{ id: "hz1", metric: "heat.zScore", region: "any", value: 3, kind: "reminder", repeatHours: 3, enabled: true }];
  let r = evaluateRules(rules, matrix(region("dubai", { z: 3.4 })), {}, 0);
  assert.equal(r.alerts[0].reason, "crossed");
  assert.equal(evaluateRules(rules, matrix(region("dubai", { z: 3.4 })), r.state, 2 * H).alerts.length, 0);
  const rem = evaluateRules(rules, matrix(region("dubai", { z: 3.5 })), r.state, 3 * H);
  assert.equal(rem.alerts[0].reason, "reminder");
  assert.match(rem.alerts[0].title, /^Reminder: /);
  const acked = acknowledge(rem.state, "hz1:dubai", 3 * H);
  assert.equal(evaluateRules(rules, matrix(region("dubai", { z: 3.5 })), acked, 9 * H).alerts.length, 0, "acknowledged: quiet");
  const unknown = evaluateRules(rules, matrix(region("dubai", { z: null })), acked, 10 * H);
  assert.deepEqual(unknown.state, acked, "no reading leaves the state alone");
});

test("rules: the built-in critical alarm covers every region; custom score rules above 85 are critical too", () => {
  const r = evaluateRules(defaultRules(), matrix(region("nairobi", { overall: 50 }), region("tokyo", { overall: 90 })), {}, 0);
  assert.deepEqual(r.alerts.map((a) => [a.regionId, a.severity]), [["tokyo", "critical"]]);
  assert.match(r.alerts[0].title, /^CRITICAL: /);
  assert.equal(r.alerts[0].url, "/?focus=tokyo#risk-h");
  assert.equal(severityOf({ metric: "heat.score", kind: "alarm" }, 90), "critical");
  assert.equal(severityOf({ metric: "heat.score", kind: "alarm" }, 70), "alarm");
  assert.equal(describeRule({ metric: "heat.zScore", region: "dubai", value: 3, kind: "reminder", repeatHours: 6 }, "Dubai, UAE"), "Heat above normal for the date above +3σ in Dubai, UAE, remind every 6 h");
});

test("platform: iOS needs the Home Screen, in-app browsers can't push, blocked is explained", () => {
  const base = { iOS: false, iosVersion: null, standalone: false, inAppBrowser: false, hasPush: true, permission: "default", canVibrate: true };
  assert.equal(pushReadiness({ ...base, iOS: true, iosVersion: 17.5 }).status, "install");
  assert.match(pushReadiness({ ...base, iOS: true, iosVersion: 17.5 }).message, /Add to Home Screen/);
  assert.equal(pushReadiness({ ...base, iOS: true, iosVersion: 16.3, standalone: true }).status, "unsupported");
  assert.equal(pushReadiness({ ...base, iOS: true, iosVersion: 17.5, standalone: true }).status, "needs-permission");
  assert.equal(pushReadiness({ ...base, inAppBrowser: true }).status, "unsupported");
  assert.equal(pushReadiness({ ...base, permission: "denied" }).status, "blocked");
  assert.equal(pushReadiness({ ...base, permission: "granted" }).status, "ready");
  assert.equal(pushReadiness({ ...base, hasPush: false }).status, "unsupported");
});

test("vibration patterns: critical is long and distinct from the others", () => {
  assert.ok(VIBRATION.critical.reduce((a, b) => a + b, 0) >= 9000);
  assert.ok(VIBRATION.alarm.length < VIBRATION.critical.length);
});

// ---------------------------------------------------------------- web push crypto

async function vapidEnv() {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
  return { env: { VAPID_PUBLIC_KEY: bytesToB64u(raw), VAPID_PRIVATE_KEY: jwk.d }, publicKey: kp.publicKey };
}

async function browserKeys() {
  const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return { kp, sub: { p256dh: bytesToB64u(pub), auth: bytesToB64u(auth) }, pub, auth };
}

/** What the browser does on receipt (RFC 8291), to prove the Worker's encryption is right. */
async function browserDecrypt(ua, body) {
  const te = new TextEncoder();
  const salt = body.slice(0, 16);
  const idLen = body[20];
  const asPublic = body.slice(21, 21 + idLen);
  const ct = body.slice(21 + idLen);
  const asKey = await crypto.subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asKey }, ua.kp.privateKey, 256));
  const ikm = await hkdfBytes(ua.auth, ecdh, concatBytes(te.encode("WebPush: info\0"), ua.pub, asPublic), 32);
  const cek = await hkdfBytes(salt, ikm, te.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdfBytes(salt, ikm, te.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ct));
  let end = plain.length - 1;
  while (plain[end] === 0) end--;
  assert.equal(plain[end], 2, "last-record delimiter");
  return JSON.parse(new TextDecoder().decode(plain.slice(0, end)));
}

test("web push: the payload decrypts in the browser's way, and the VAPID token verifies", async () => {
  const ua = await browserKeys();
  const body = await encryptPushPayload(ua.sub, new TextEncoder().encode(JSON.stringify({ title: "hi", severity: "critical" })));
  assert.deepEqual(await browserDecrypt(ua, body), { title: "hi", severity: "critical" });

  const { env, publicKey } = await vapidEnv();
  const auth = await vapidAuthorization(env, "https://fcm.googleapis.com/fcm/send/abc", Date.parse("2026-09-25T12:00:00Z"));
  const [, jwt, k] = auth.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.equal(k, env.VAPID_PUBLIC_KEY);
  const [h, c, s] = jwt.split(".");
  const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, b64uToBytes(s), new TextEncoder().encode(h + "." + c));
  assert.ok(ok, "signature verifies with the public key");
  const claims = JSON.parse(new TextDecoder().decode(b64uToBytes(c)));
  assert.equal(claims.aud, "https://fcm.googleapis.com");
  assert.ok(isAllowedPushEndpoint("https://fcm.googleapis.com/fcm/send/abc"));
  assert.ok(!isAllowedPushEndpoint("https://evil.example/fcm.googleapis.com"));
  assert.ok(!isAllowedPushEndpoint("http://fcm.googleapis.com/x"));
});

// ---------------------------------------------------------------- API + cron sweep

const ENDPOINT = "https://fcm.googleapis.com/fcm/send/device-1";
const api = (path, body, env, ip = "5.5.5.5") =>
  worker.fetch(new Request("https://z.test" + path, { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip }, body: JSON.stringify(body) }), env, {});

function capturePushes(status = 201) {
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sent.push({ url: String(url), headers: Object.fromEntries(new Headers(init.headers)), body: new Uint8Array(init.body) });
    return new Response(null, { status: typeof status === "function" ? status(sent.length) : status });
  };
  return { sent, restore: () => (globalThis.fetch = realFetch) };
}

async function seedMatrix(overallByRegion) {
  const s = makeStore({});
  const now = new Date().toISOString();
  for (const [id, overall] of Object.entries(overallByRegion))
    await s.put(`risk:v1:${id}`, { id, name: id, updatedAt: now, overall: { score: overall, level: overall >= 80 ? "severe" : "low" }, pillars: { seismic: { score: overall, level: "low", status: "live", asOf: now } } });
}

test("alerts API: only real push services and well-formed keys are accepted", async () => {
  const { env } = await vapidEnv();
  const ua = await browserKeys();
  const good = { subscription: { endpoint: ENDPOINT, keys: ua.sub }, rules: [] };
  assert.equal((await api("/api/alerts/subscribe", { ...good, subscription: { ...good.subscription, endpoint: "https://evil.example/x" } }, env)).status, 400);
  assert.equal((await api("/api/alerts/subscribe", { ...good, subscription: { endpoint: ENDPOINT, keys: { p256dh: "short", auth: "x" } } }, env)).status, 400);
  assert.equal((await api("/api/alerts/subscribe", { ...good, rules: [{ id: "x1234", metric: "nope", region: "any", value: 1 }] }, env)).status, 400);
  const ok = await (await api("/api/alerts/subscribe", good, env)).json();
  assert.deepEqual(ok.rules, [BUILTIN_CRITICAL]);
  const key = await (await worker.fetch(new Request("https://z.test/api/alerts/key"), env, {})).json();
  assert.equal(key.publicKey, env.VAPID_PUBLIC_KEY);
  assert.equal((await worker.fetch(new Request("https://z.test/api/alerts/key"), {}, {})).status, 503, "no keys: says so");
});

test("alerts API: test push is encrypted, VAPID-signed, 1 per minute; a dead subscription is removed", async () => {
  const { env } = await vapidEnv();
  const ua = await browserKeys();
  await api("/api/alerts/subscribe", { subscription: { endpoint: ENDPOINT, keys: ua.sub }, rules: [] }, env);
  const cap = capturePushes(201);
  try {
    const res = await api("/api/alerts/test", { endpoint: ENDPOINT, severity: "critical" }, env);
    assert.equal(res.status, 200);
    const push = cap.sent[0];
    assert.equal(push.url, ENDPOINT);
    assert.equal(push.headers["content-encoding"], "aes128gcm");
    assert.match(push.headers.authorization, /^vapid t=.+, k=/);
    const payload = await browserDecrypt(ua, push.body);
    assert.equal(payload.severity, "critical");
    assert.equal(payload.test, true);
    assert.equal((await api("/api/alerts/test", { endpoint: ENDPOINT }, env)).status, 429, "one a minute");
  } finally {
    cap.restore();
  }
  // Expired subscription: the push service answers 410.
  _resetMemoryStore();
  await api("/api/alerts/subscribe", { subscription: { endpoint: ENDPOINT, keys: ua.sub }, rules: [] }, env, "6.6.6.6");
  const gone = capturePushes(410);
  try {
    assert.equal((await api("/api/alerts/test", { endpoint: ENDPOINT }, env)).status, 410);
    assert.equal((await api("/api/alerts/ack", { endpoint: ENDPOINT, key: "critical:x" }, env)).status, 404, "record deleted");
  } finally {
    gone.restore();
  }
});

test("cron sweep: a critical crossing pushes once, acknowledge is stored, dead devices are dropped", async () => {
  const { env } = await vapidEnv();
  const ua = await browserKeys();
  await api("/api/alerts/subscribe", { subscription: { endpoint: ENDPOINT, keys: ua.sub }, rules: [] }, env);
  await seedMatrix({ dubai: 91, nairobi: 20 });
  const cap = capturePushes(201);
  try {
    const first = await runAlertSweep(env);
    assert.equal(first.sent, 1);
    const p = await browserDecrypt(ua, cap.sent[0].body);
    assert.equal(p.severity, "critical");
    assert.equal(p.tag, "critical:dubai");
    assert.equal(p.url, "/?focus=dubai#risk-h");
    assert.equal(cap.sent[0].headers.urgency, "high");
    assert.equal(cap.sent[0].headers.topic, "critical-dubai");
    assert.equal((await runAlertSweep(env)).sent, 0, "no repeat while it stays above");
    assert.equal((await api("/api/alerts/ack", { endpoint: ENDPOINT, key: "critical:dubai" }, env)).status, 200);
  } finally {
    cap.restore();
  }
  const dead = capturePushes(410);
  try {
    await seedMatrix({ dubai: 91, nairobi: 95 });
    const r = await runAlertSweep(env);
    assert.equal(r.removed, 1);
    assert.equal((await runAlertSweep(env)).devices, 0);
  } finally {
    dead.restore();
  }
});

test("cron sweep: skipped cleanly without VAPID keys", async () => {
  assert.deepEqual(await runAlertSweep({}), { skipped: "no VAPID keys" });
});

// ---------------------------------------------------------------- service worker push handling

function loadServiceWorker() {
  const listeners = {};
  const shown = [];
  const posted = [];
  const fetched = [];
  const opened = [];
  const client = { url: "https://z.test/", focus: async () => {}, navigate: async (u) => opened.push("navigate " + u), postMessage: (m) => posted.push(JSON.parse(JSON.stringify(m))) }; // clone out of the vm realm
  const self = {
    location: { origin: "https://z.test" },
    addEventListener: (t, fn) => (listeners[t] = fn),
    registration: { showNotification: async (title, opts) => shown.push({ title, opts }), pushManager: { getSubscription: async () => ({ endpoint: ENDPOINT }) } },
    clients: { matchAll: async () => [client], openWindow: async (u) => opened.push("open " + u), claim: async () => {} },
    skipWaiting: () => {},
  };
  const sandbox = { self, caches: {}, fetch: async (u, init) => (fetched.push({ u, body: JSON.parse(init.body) }), new Response("{}")), URL, Request, Response, location: self.location, setTimeout, clearTimeout, AbortController, console };
  vm.runInNewContext(readFileSync("public/sw.js", "utf8"), sandbox);
  const fire = async (type, ev) => {
    let done;
    listeners[type]({ ...ev, waitUntil: (p) => (done = p) });
    await done;
  };
  return { fire, shown, posted, fetched, opened, client };
}

test("service worker: critical pushes stay on screen with View SitRep / Acknowledge; the page is told", async () => {
  const sw = loadServiceWorker();
  const payload = { title: "CRITICAL: Dubai", body: "b", severity: "critical", tag: "critical:dubai", alertKey: "critical:dubai", url: "/?focus=dubai#risk-h", at: 1 };
  await sw.fire("push", { data: { json: () => payload, text: () => "" } });
  const n = sw.shown[0];
  assert.equal(n.title, "CRITICAL: Dubai");
  assert.equal(n.opts.requireInteraction, true);
  assert.equal(n.opts.tag, "critical:dubai");
  assert.deepEqual(JSON.parse(JSON.stringify(n.opts.actions.map((a) => a.title))), ["View SitRep", "Acknowledge"]); // vm arrays are cross-realm
  assert.equal(sw.posted[0].type, "alarm");
  assert.equal(sw.posted[0].alert.key, "critical:dubai");

  await sw.fire("push", { data: { json: () => ({ ...payload, severity: "reminder" }), text: () => "" } });
  assert.equal(sw.shown[1].opts.requireInteraction, false, "only critical alerts insist");

  const note = (action) => ({ action, notification: { data: n.opts.data, close: () => {} } });
  await sw.fire("notificationclick", note("ack"));
  assert.deepEqual(sw.fetched[0], { u: "/api/alerts/ack", body: { endpoint: ENDPOINT, key: "critical:dubai" } });
  assert.deepEqual(sw.posted.at(-1), { type: "alarm-ack", key: "critical:dubai" });
  await sw.fire("notificationclick", note("view"));
  assert.deepEqual(sw.opened, ["navigate https://z.test/?focus=dubai#risk-h"]);
});

test("service worker: an unreadable push still shows a notification (never silent)", async () => {
  const sw = loadServiceWorker();
  await sw.fire("push", { data: { json: () => { throw new Error("bad"); }, text: () => "raw text" } });
  assert.equal(sw.shown[0].title, "Zackscan alert");
  assert.equal(sw.shown[0].opts.body, "raw text");
});

test("page and service worker build the same notification (so tags merge)", () => {
  const sw = readFileSync("public/sw.js", "utf8");
  const a = { key: "k", tag: "k", alertKey: "k", severity: "critical", body: "b", url: "/u", at: 5 };
  const sandbox = { self: { addEventListener() {} }, location: {}, URL, console };
  vm.runInNewContext(sw + "\nthis.__opts = alertNotificationOptions;", sandbox);
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.__opts(a))), JSON.parse(JSON.stringify(notificationOptions(a))));
});
