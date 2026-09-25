// Page-side alarm controller.
//
// While Zackscan is open, every fresh risk matrix is checked against the
// user's rules and a crossing raises an alarm at once: an on-screen alert,
// the synthesized sound, vibration, and a system notification if the tab is
// in the background. With background alerts on, the same rules are synced to
// the server, whose cron pushes alerts while the app is closed. Notification
// tags are shared (rule:region), so a device never shows the same alert twice.

import { defaultRules, validateRules, evaluateRules, acknowledge, describeRule } from "./alarm-rules.js";
import { playAlarm, stopAlarm, vibrate, armAudioUnlock, unlockAudio } from "./alarm-audio.js";
import { detectPlatform, pushReadiness } from "./platform.js";
import { REGION_IDS, regionName } from "./regions.js";

const K = { rules: "zackscan.alarmRules", state: "zackscan.alarmState", prefs: "zackscan.alarmPrefs", notice: "zackscan.alertNoticeSeen" };
const read = (k, fallback) => {
  try {
    const v = JSON.parse(localStorage.getItem(k));
    return v ?? fallback;
  } catch {
    return fallback;
  }
};
const write = (k, v) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {}
};
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const RECENT_MS = 10 * 60_000;

function b64uToBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

export function createAlarmController({ banner, onView = () => {}, onChange = () => {} }) {
  let rules = validateRules(read(K.rules, defaultRules()), REGION_IDS).rules || defaultRules();
  let state = read(K.state, {});
  let prefs = { sound: true, volume: 0.8, vibrate: true, ...read(K.prefs, {}) };
  const raisedAt = new Map(); // key -> time shown on this page, to merge page + push copies
  const open = new Map(); // key -> alert currently on screen
  armAudioUnlock();

  // ---------------------------------------------------------------- showing alerts
  function renderBanner() {
    const list = [...open.values()].sort((a, b) => (a.severity === "critical" ? -1 : 0) - (b.severity === "critical" ? -1 : 0));
    banner.hidden = !list.length;
    banner.className = "alarm-banner" + (list.some((a) => a.severity === "critical") ? " critical" : "");
    banner.innerHTML = list
      .map(
        (a) => `<div class="alarm-item sev-${esc(a.severity)}" role="alert" data-key="${esc(a.key)}">
          <b>${esc(a.title)}</b><span>${esc(a.body)}</span>
          <div class="row"><button type="button" data-act="ack">Acknowledge</button><button type="button" data-act="view">View SitRep</button></div>
        </div>`,
      )
      .join("");
  }

  banner.addEventListener("click", (ev) => {
    const btn = ev.target.closest("button[data-act]");
    const key = btn?.closest("[data-key]")?.dataset.key;
    if (!key) return;
    const a = open.get(key);
    if (btn.dataset.act === "ack") ack(key);
    else {
      stopAlarm();
      onView(a);
    }
  });

  async function raise(alert, { fromPush = false } = {}) {
    const seen = raisedAt.get(alert.key);
    if (seen && alert.at - seen < RECENT_MS && open.has(alert.key)) return; // page and push both saw it
    raisedAt.set(alert.key, alert.at || Date.now());
    open.set(alert.key, alert);
    // A modal dialog makes the rest of the page inert, which would leave the
    // alarm impossible to acknowledge. An alarm outranks settings: close them.
    for (const d of document.querySelectorAll("dialog[open]")) d.close();
    renderBanner();
    if (prefs.sound) playAlarm(alert.severity, { volume: prefs.volume });
    if (prefs.vibrate) vibrate(alert.severity);
    // Tab in the background: also a system notification (push brings its own).
    if (!fromPush && document.visibilityState !== "visible" && globalThis.Notification?.permission === "granted") {
      const reg = await navigator.serviceWorker?.getRegistration();
      reg?.showNotification(alert.title, notificationOptions(alert));
    }
  }

  async function ack(key, { fromServiceWorker = false } = {}) {
    stopAlarm();
    open.delete(key);
    renderBanner();
    state = acknowledge(state, key);
    write(K.state, state);
    if (!fromServiceWorker) {
      const sub = await currentSubscription();
      if (sub) fetch("/api/alerts/ack", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint: sub.endpoint, key }) }).catch(() => {});
      const reg = await navigator.serviceWorker?.getRegistration();
      for (const n of (await reg?.getNotifications({ tag: key })) || []) n.close();
    }
  }

  // From the service worker: a push arrived, or "Acknowledge" was tapped on a notification.
  navigator.serviceWorker?.addEventListener("message", (e) => {
    if (e.data?.type === "alarm" && e.data.alert && !e.data.alert.test) raise(e.data.alert, { fromPush: true });
    if (e.data?.type === "alarm" && e.data.alert?.test) raise({ ...e.data.alert, key: "test", severity: e.data.alert.severity || "alarm" }, { fromPush: true });
    if (e.data?.type === "alarm-ack") ack(e.data.key, { fromServiceWorker: true });
  });

  // ---------------------------------------------------------------- evaluating
  /** Call with each FRESH matrix (never with saved offline data). */
  let lastMatrix = null;
  function onMatrix(matrix) {
    lastMatrix = matrix;
    const r = evaluateRules(rules, matrix, state);
    if (r.changed) {
      state = r.state;
      write(K.state, state);
    }
    for (const a of r.alerts) raise(a);
    for (const key of open.keys()) if (!state[key]?.active && key !== "test") open.delete(key); // condition over
    renderBanner();
  }

  // ---------------------------------------------------------------- background (push)
  async function currentSubscription() {
    const reg = await navigator.serviceWorker?.getRegistration();
    return (await reg?.pushManager?.getSubscription()) || null;
  }

  async function syncServer(sub) {
    const res = await fetch("/api/alerts/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subscription: sub.toJSON(), rules }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Couldn't register this device.");
  }

  async function enableBackground() {
    await unlockAudio(); // this runs from a tap, a good moment to allow sound too
    const readiness = pushReadiness(detectPlatform());
    if (readiness.status === "install" || readiness.status === "unsupported" || readiness.status === "blocked") throw new Error(readiness.message);
    const perm = await Notification.requestPermission();
    if (perm !== "granted") throw new Error(perm === "denied" ? pushReadiness({ ...detectPlatform(), permission: "denied" }).message : "Notifications weren't allowed.");
    const keyRes = await fetch("/api/alerts/key");
    const { publicKey, error } = await keyRes.json();
    if (!publicKey) throw new Error(error || "Background alerts aren't available yet.");
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (sub && sub.options?.applicationServerKey) {
      // Server key changed since this device subscribed: start fresh.
      const had = new Uint8Array(sub.options.applicationServerKey);
      const want = b64uToBytes(publicKey);
      if (had.length !== want.length || had.some((b, i) => b !== want[i])) {
        await sub.unsubscribe();
        sub = null;
      }
    }
    sub ||= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(publicKey) });
    await syncServer(sub);
    onChange();
  }

  async function disableBackground() {
    const sub = await currentSubscription();
    if (sub) {
      await fetch("/api/alerts/unsubscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint: sub.endpoint }) }).catch(() => {});
      await sub.unsubscribe().catch(() => {});
    }
    onChange();
  }

  async function testPush(severity = "alarm") {
    const sub = await currentSubscription();
    if (!sub) throw new Error("Turn on background alerts first.");
    const res = await fetch("/api/alerts/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint: sub.endpoint, severity }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Test failed.");
  }

  /** Sound + vibration + on-screen alert, right here, from a tap. */
  async function testLocal(severity) {
    await unlockAudio();
    raise({
      key: "test",
      severity,
      at: Date.now(),
      title: severity === "critical" ? "TEST: critical alarm" : severity === "reminder" ? "TEST: reminder" : "TEST: alarm",
      body: "This is how an alert looks and sounds on this device.",
      url: "/",
    });
  }

  // Keep the server copy fresh (rules, and the 90-day expiry) whenever the app opens.
  currentSubscription()
    .then((sub) => sub && globalThis.Notification?.permission === "granted" && syncServer(sub))
    .catch(() => {});

  return {
    onMatrix,
    raise,
    ack,
    get rules() {
      return rules;
    },
    get prefs() {
      return prefs;
    },
    describe: (r) => describeRule(r, regionName(r.region)),
    /** Replace the rule list (validated); syncs to the server when background alerts are on. */
    async setRules(next) {
      const v = validateRules(next, REGION_IDS);
      if (v.error) throw new Error(v.error);
      rules = v.rules;
      write(K.rules, rules);
      if (lastMatrix) onMatrix(lastMatrix); // check a new rule against current data right away
      const sub = await currentSubscription();
      if (sub) await syncServer(sub);
      onChange();
    },
    setPrefs(p) {
      prefs = { ...prefs, ...p };
      write(K.prefs, prefs);
      onChange();
    },
    currentSubscription,
    enableBackground,
    disableBackground,
    testPush,
    testLocal,
    readiness: () => pushReadiness(detectPlatform()),
    platform: () => detectPlatform(),
    /** One-time notice when background alerts can't be relied on here. */
    noticeOnce() {
      const r = pushReadiness(detectPlatform());
      if (!["install", "unsupported"].includes(r.status) || read(K.notice, false)) return null;
      return { ...r, dismiss: () => write(K.notice, true) };
    },
  };
}

export function notificationOptions(a) {
  const critical = a.severity === "critical";
  return {
    body: a.body,
    tag: a.key,
    renotify: true,
    requireInteraction: critical,
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    vibrate: critical ? [700, 200, 700, 200, 700] : [300, 150, 300],
    timestamp: a.at || Date.now(),
    data: { url: a.url || "/", alertKey: a.key, severity: a.severity },
    actions: [
      { action: "view", title: "View SitRep" },
      { action: "ack", title: "Acknowledge" },
    ],
  };
}
