// Background alerts: devices register a Web Push subscription plus their
// alarm rules. After each risk refresh the cron evaluates every device's
// rules (same engine as the page: public/js/alarm-rules.js) and pushes an
// alert when a value crosses a threshold.
//
// Identity: a subscription's endpoint URL is a secret only that browser
// knows, so it doubles as the device's credential. Records are keyed by a
// hash of it, and every change must present the endpoint again.
//
//   GET  /api/alerts/key          VAPID public key for PushManager.subscribe
//   POST /api/alerts/subscribe    {subscription, rules}  create or update
//   POST /api/alerts/unsubscribe  {endpoint}
//   POST /api/alerts/ack          {endpoint, key}  stop reminders for this alert
//   POST /api/alerts/test         {endpoint, severity?}  one test push (1/min)

import { validateRules, evaluateRules, acknowledge } from "../../public/js/alarm-rules.js";
import { REGIONS } from "../risk/regions.js";
import { makeStore } from "../risk/store.js";
import { getMatrix } from "../risk/matrix.js";
import { isAllowedPushEndpoint, sendWebPush, vapidKeys } from "../push/webpush.js";
import { checkRateLimit } from "../middleware/rate-limit.js";
import { json } from "../http.js";

const PREFIX = "alertsub:";
const KEEP_S = 90 * 86_400; // refreshed every time the app opens; abandoned devices expire
const MAX_BODY = 16 * 1024;
const REGION_IDS = REGIONS.map((r) => r.id);

async function subKey(endpoint) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
  return PREFIX + [...new Uint8Array(buf).slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function readBody(request) {
  const raw = await request.text();
  if (raw.length > MAX_BODY) return null;
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return null;
  }
}

/** Accept only a well-formed subscription for a real push service. */
export function cleanSubscription(s) {
  const endpoint = s?.endpoint;
  const p256dh = s?.keys?.p256dh;
  const auth = s?.keys?.auth;
  if (typeof endpoint !== "string" || endpoint.length > 1024 || !isAllowedPushEndpoint(endpoint)) return null;
  if (typeof p256dh !== "string" || !/^[A-Za-z0-9_-]{80,100}$/.test(p256dh)) return null; // 65-byte P-256 point
  if (typeof auth !== "string" || !/^[A-Za-z0-9_-]{16,32}$/.test(auth)) return null; // 16-byte secret
  return { endpoint, p256dh, auth };
}

const bad = (error, status = 400) => json({ error }, status);

export async function handleAlerts(path, request, env, deps = {}) {
  const store = deps.store || makeStore(env);

  if (path === "GET /api/alerts/key") {
    const { pub, priv } = vapidKeys(env);
    return pub && priv ? json({ publicKey: pub }) : bad("Background alerts aren't set up on this server yet.", 503);
  }
  if (request.method !== "POST") return null;
  const body = await readBody(request);
  if (!body) return bad("Bad request.");

  if (path === "POST /api/alerts/subscribe") {
    const sub = cleanSubscription(body.subscription);
    if (!sub) return bad("That isn't a valid push subscription.");
    const v = validateRules(body.rules ?? [], REGION_IDS);
    if (v.error) return bad(v.error);
    const limit = await checkRateLimit(request, env, { name: "alertsub", max: 60 });
    if (!limit.allowed) return bad("Too many changes today. Try again tomorrow.", 429);
    const key = await subKey(sub.endpoint);
    const old = await store.get(key);
    const now = Date.now();
    await store.put(key, { sub, rules: v.rules, state: old?.state || {}, createdAt: old?.createdAt || now, updatedAt: now, lastTestAt: old?.lastTestAt || 0 }, KEEP_S);
    return json({ ok: true, rules: v.rules });
  }

  const endpoint = typeof body.endpoint === "string" ? body.endpoint : "";
  if (!isAllowedPushEndpoint(endpoint)) return bad("Unknown device.", 404);
  const key = await subKey(endpoint);
  const rec = await store.get(key);

  if (path === "POST /api/alerts/unsubscribe") {
    if (rec) await store.delete(key);
    return json({ ok: true });
  }
  if (!rec) return bad("This device isn't registered for alerts.", 404);

  if (path === "POST /api/alerts/ack") {
    if (typeof body.key !== "string" || body.key.length > 80) return bad("Bad alert.");
    await store.put(key, { ...rec, state: acknowledge(rec.state || {}, body.key), updatedAt: Date.now() }, KEEP_S);
    return json({ ok: true });
  }

  if (path === "POST /api/alerts/test") {
    const now = Date.now();
    if (now - (rec.lastTestAt || 0) < 60_000) return bad("One test a minute. Try again shortly.", 429);
    await store.put(key, { ...rec, lastTestAt: now }, KEEP_S);
    const severity = body.severity === "critical" ? "critical" : "alarm";
    const status = await sendWebPush(
      env,
      rec.sub,
      {
        title: severity === "critical" ? "TEST: critical alarm" : "TEST: Zackscan alert",
        body: "This is a test. Background alerts reach this device.",
        severity,
        tag: "test",
        alertKey: "test",
        url: "/#risk-h",
        at: now,
        test: true,
      },
      { fetch: deps.fetch, ttlSeconds: 300 },
    );
    if (status === 404 || status === 410) {
      await store.delete(key);
      return bad("The browser's push service says this subscription has expired. Turn background alerts off and on again.", 410);
    }
    return status >= 200 && status < 300 ? json({ ok: true, status }) : bad(`The push service didn't accept the test (${status || "network error"}).`, 502);
  }
  return null;
}

// Push topics must be 32 URL-safe characters or fewer.
const topicFor = (alertKey) => alertKey.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 32);

/**
 * Cron: evaluate every device's rules against the cached matrix and push
 * what fired. Stops before `maxSends` so one run stays inside the Worker's
 * subrequest limit. Devices not reached are evaluated on the next run, and
 * their state isn't touched, so nothing is lost.
 */
export async function runAlertSweep(env, deps = {}, { now = Date.now(), maxSends = 15 } = {}) {
  const { pub, priv } = vapidKeys(env);
  if (!pub || !priv) return { skipped: "no VAPID keys" };
  const store = deps.store || makeStore(env);
  const matrix = await getMatrix(env, { ...deps, store }, { computeBudget: 0, now });
  const keys = await store.list(PREFIX, 500);
  let sent = 0;
  let removed = 0;
  let evaluated = 0;
  for (const key of keys) {
    if (sent >= maxSends) break;
    const rec = await store.get(key);
    if (!rec) continue;
    const { alerts, state, changed } = evaluateRules(rec.rules, matrix, rec.state || {}, now);
    if (sent + alerts.length > maxSends) break; // leave this device for the next run
    evaluated++;
    let dead = false;
    for (const a of alerts) {
      const status = await sendWebPush(
        env,
        rec.sub,
        { title: a.title, body: a.body, severity: a.severity, tag: a.key, alertKey: a.key, regionId: a.regionId, url: a.url, at: a.at },
        {
          fetch: deps.fetch,
          topic: topicFor(a.key),
          urgency: a.severity === "reminder" ? "normal" : "high",
          ttlSeconds: a.severity === "critical" ? 6 * 3600 : 3600,
        },
      );
      sent++;
      if (status === 404 || status === 410) {
        dead = true;
        break;
      }
    }
    if (dead) {
      await store.delete(key);
      removed++;
    } else if (changed) await store.put(key, { ...rec, state, updatedAt: rec.updatedAt }, KEEP_S);
  }
  return { devices: keys.length, evaluated, sent, removed };
}
