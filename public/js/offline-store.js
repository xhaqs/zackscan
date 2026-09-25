// IndexedDB storage for offline use. Holds only public data: telemetry
// snapshots, each pillar's last good reading, and AI situation reports.
// Never AI keys (those stay in keyvault.js).
//
// If IndexedDB is unavailable (private mode, blocked storage) everything
// falls back to memory, so the app still works online.
//
// The service worker (sw.js) writes snapshots to the same database; keep
// DB_NAME, DB_VERSION and the store names in step with it (a test checks).

import { goodPillars } from "./offline-logic.js";

export const DB_NAME = "zackscan-offline";
export const DB_VERSION = 1;
export const STORES = ["snapshots", "pillars", "sitreps"];

let dbPromise = null;
const memory = new Map(STORES.map((s) => [s, new Map()]));

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s, { keyPath: "key" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function tx(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export async function put(store, record) {
  const db = await openDb();
  if (!db) return void memory.get(store).set(record.key, record);
  try {
    await tx(db, store, "readwrite", (s) => s.put(record));
  } catch {
    memory.get(store).set(record.key, record); // quota full etc.: keep it for this session at least
  }
}

export async function get(store, key) {
  const db = await openDb();
  if (!db) return memory.get(store).get(key) ?? null;
  try {
    return (await tx(db, store, "readonly", (s) => s.get(key))) ?? memory.get(store).get(key) ?? null;
  } catch {
    return memory.get(store).get(key) ?? null;
  }
}

export async function getAll(store) {
  const db = await openDb();
  if (!db) return [...memory.get(store).values()];
  try {
    return (await tx(db, store, "readonly", (s) => s.getAll())) || [];
  } catch {
    return [...memory.get(store).values()];
  }
}

// ---------------------------------------------------------------- telemetry

/** Save a successful API response with the time it was fetched. */
export const saveSnapshot = (key, data, fetchedAt = Date.now()) => put("snapshots", { key, data, fetchedAt });
export const loadSnapshot = (key) => get("snapshots", key);

/** Newest of several snapshot keys, e.g. the full and the data-saver risk matrix. */
export async function newestSnapshot(keys) {
  const found = (await Promise.all(keys.map(loadSnapshot))).filter(Boolean);
  return found.sort((a, b) => b.fetchedAt - a.fetchedAt)[0] || null;
}

/** Keep each pillar's most recent real reading, never overwriting newer with older. */
export async function rememberPillars(matrix) {
  for (const rec of goodPillars(matrix)) {
    const old = await get("pillars", rec.key);
    if (!old || old.asOf < rec.asOf) await put("pillars", rec);
  }
}

export async function lastGoodPillars() {
  return Object.fromEntries((await getAll("pillars")).map((r) => [r.key, r]));
}

// ---------------------------------------------------------------- SitReps

/** Last AI assessment per mission profile, kept for offline reading. */
export const saveSitrep = (profileId, result, savedAt = Date.now()) => put("sitreps", { key: profileId, result, savedAt });
export const loadSitrep = (profileId) => get("sitreps", profileId);
