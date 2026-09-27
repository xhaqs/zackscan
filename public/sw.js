// Zackscan service worker (classic script, for the widest browser support).
//
// 1. App shell: precached at install, served cache-first and refreshed in
//    the background (stale-while-revalidate), so the app opens offline.
// 2. /api/*: NOT intercepted. The page handles offline itself, falling back
//    to IndexedDB with visible timestamps. This also means AI requests (which
//    carry the user's key) never touch the service worker.
// 3. Background Sync / Periodic Background Sync (Chromium): when connectivity
//    returns, or periodically for an installed app, fetch the small risk
//    matrix and save it to IndexedDB so the next offline visit is fresher.
//
// BUILD is replaced with the commit SHA in CI. Any deploy changes this
// file, so browsers install the new version and old caches are removed.

const BUILD = "__BUILD__";
const SHELL_CACHE = "zackscan-shell-" + BUILD;
const SHELL_FILES = [
  "/",
  "/css/app.css",
  "/js/app.js",
  "/js/api.js",
  "/js/state.js",
  "/js/profiles.js",
  "/js/keyvault.js",
  "/js/ai-catalog.js",
  "/js/risk.js",
  "/js/offline-logic.js",
  "/js/offline-store.js",
  "/js/poller.js",
  "/js/tier-toggle.js",
  "/js/alarm-rules.js",
  "/js/alarm-audio.js",
  "/js/alarm-settings.js",
  "/js/alarms.js",
  "/js/platform.js",
  "/js/regions.js",
  "/js/briefing.js",
  "/js/charts.js",
  "/js/anomaly-card.js",
  "/js/anomaly-deck.js",
  "/js/grid-map.js",
  "/js/map-sheet.js",
  "/js/operator.js",
  "/js/custom-profiles.js",
  "/js/profile-creator.js",
  "/js/weather-widget.js",
  "/js/story-model.js",
  "/js/story-card.js",
  "/favicon.svg",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

// Must match public/js/offline-store.js.
const DB_NAME = "zackscan-offline";
const DB_VERSION = 1;
const STORES = ["snapshots", "pillars", "sitreps"];
const SYNC_TAG = "risk-refresh";

self.addEventListener("install", (event) => {
  // cache: "reload" skips the HTTP cache, so a new build never precaches old files.
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((c) =>
        c.addAll(SHELL_FILES.map((u) => new Request(u, { cache: "reload" }))),
      ),
  );
  // No skipWaiting here: the page offers "Update available" and sends SKIP_WAITING,
  // so a running session never mixes old and new modules.
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys())
        if (key.startsWith("zackscan-shell-") && key !== SHELL_CACHE)
          await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (
    req.method !== "GET" ||
    url.origin !== location.origin ||
    url.pathname.startsWith("/api/")
  )
    return;

  if (req.mode === "navigate") {
    // Network first for the page itself (fresh HTML when online), shell when not.
    event.respondWith(
      (async () => {
        try {
          const res = await fetchWithTimeout(req, 4000);
          if (res.ok) (await caches.open(SHELL_CACHE)).put("/", res.clone());
          return res;
        } catch {
          return (
            (await caches.match("/")) ||
            new Response("Offline and Zackscan isn't cached yet.", {
              status: 503,
              headers: { "Content-Type": "text/plain" },
            })
          );
        }
      })(),
    );
    return;
  }

  // Static files: cache first, refresh in the background.
  event.respondWith(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      const cached = await cache.match(req, { ignoreSearch: true });
      const network = fetch(req)
        .then((res) => {
          if (res.ok && res.type === "basic") cache.put(req, res.clone());
          return res;
        })
        .catch(() => null);
      if (cached) {
        event.waitUntil(network);
        return cached;
      }
      return (await network) || new Response("", { status: 504 });
    })(),
  );
});

// ------------------------------------------------------------ background refresh

self.addEventListener("sync", (event) => {
  if (event.tag === SYNC_TAG) event.waitUntil(refreshRisk());
});
self.addEventListener("periodicsync", (event) => {
  if (event.tag === SYNC_TAG) event.waitUntil(refreshRisk());
});

async function refreshRisk() {
  // The small (data-saver) matrix: this runs on the user's data plan in the background.
  const res = await fetch("/api/risk?fields=summary", { cache: "no-store" });
  if (!res.ok) throw new Error("risk refresh failed: " + res.status); // sync retries later
  const data = await res.json();
  await idbPut("snapshots", {
    key: "risk:summary",
    data,
    fetchedAt: Date.now(),
  });
  for (const client of await self.clients.matchAll({ type: "window" }))
    client.postMessage({ type: "risk-updated" });
}

// ------------------------------------------------------------ alerts (Web Push)
// Payload from the Worker (src/routes/alerts.js):
//   {title, body, severity: "critical"|"alarm"|"reminder", tag, alertKey, url, at, test?}
// Critical alerts stay on screen until the user acts (requireInteraction).
// Tags are "rule:region", the same as the page uses, so an alert shown by an
// open page and by a push replaces itself instead of stacking up.

function alertNotificationOptions(a) {
  const critical = a.severity === "critical";
  return {
    body: a.body || "",
    tag: a.tag || a.alertKey || "zackscan",
    renotify: true,
    requireInteraction: critical,
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    vibrate: critical ? [700, 200, 700, 200, 700] : [300, 150, 300],
    timestamp: a.at || Date.now(),
    data: {
      url: a.url || "/",
      alertKey: a.alertKey || a.tag,
      severity: a.severity,
    },
    actions: [
      { action: "view", title: "View SitRep" },
      { action: "ack", title: "Acknowledge" },
    ],
  };
}

self.addEventListener("push", (event) => {
  let a;
  try {
    a = event.data ? event.data.json() : {};
  } catch {
    a = { title: "Zackscan alert", body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(
    (async () => {
      // Always show a notification: browsers require it for every push, and a
      // silent failure is the worst outcome for a safety alert.
      await self.registration.showNotification(
        a.title || "Zackscan alert",
        alertNotificationOptions(a),
      );
      // An open page sounds the alarm (a service worker can't play audio).
      for (const c of await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      }))
        c.postMessage({
          type: "alarm",
          alert: { ...a, key: a.alertKey || a.tag },
        });
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  const n = event.notification;
  const { url = "/", alertKey } = n.data || {};
  n.close();
  if (event.action === "ack") {
    event.waitUntil(acknowledgeAlert(alertKey));
    return;
  }
  // "View SitRep" or a tap on the notification body: open (or focus) the app on that region.
  event.waitUntil(
    (async () => {
      const target = new URL(url, self.location.origin).href;
      for (const c of await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      })) {
        if (new URL(c.url).origin === self.location.origin) {
          await c.focus();
          return c.navigate ? c.navigate(target) : undefined;
        }
      }
      return self.clients.openWindow(target);
    })(),
  );
});

async function acknowledgeAlert(key) {
  if (!key || key === "test") return;
  for (const c of await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  }))
    c.postMessage({ type: "alarm-ack", key });
  const sub = await self.registration.pushManager.getSubscription();
  if (!sub) return;
  await fetch("/api/alerts/ack", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint: sub.endpoint, key }),
  }).catch(() => {});
}

function fetchWithTimeout(req, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(req, { signal: ctrl.signal }).finally(() => clearTimeout(t));
}

function idbPut(store, record) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, DB_VERSION);
    open.onupgradeneeded = () => {
      for (const s of STORES)
        if (!open.result.objectStoreNames.contains(s))
          open.result.createObjectStore(s, { keyPath: "key" });
    };
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(store, "readwrite");
      tx.objectStore(store).put(record);
      tx.oncomplete = () => (db.close(), resolve());
      tx.onerror = () => (db.close(), reject(tx.error));
    };
  });
}
