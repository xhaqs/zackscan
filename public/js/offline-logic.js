// Pure offline/bandwidth decisions, kept free of browser APIs so they can be
// unit-tested in Node.

export const LIVE_PILLARS = ["seismic", "wildfire", "heat"];

/**
 * How long to wait before the next poll.
 * - Offline: don't schedule at all (null). The poller waits for the
 *   browser's "online" event instead of retrying into the void.
 * - Failures: exponential backoff (x2 each time), capped at `maxMs`.
 * - Data saver / slow link: 3x the normal interval.
 * - ±10% jitter so many field devices don't all poll at the same moment.
 */
export function nextPollDelay({ baseMs, failures = 0, online = true, dataSaver = false, maxMs = 30 * 60_000, random = Math.random }) {
  if (!online) return null;
  const ms = Math.min(baseMs * (dataSaver ? 3 : 1) * 2 ** Math.min(failures, 10), maxMs * (dataSaver ? 2 : 1));
  return Math.round(ms * (0.9 + 0.2 * random()));
}

/** Should we ask for the small payloads? `connection` is navigator.connection (may be undefined). */
export function wantDataSaver({ connection, userSetting = "auto", slowResponses = 0 }) {
  if (userSetting === "on") return true;
  if (userSetting === "off") return false;
  if (connection?.saveData) return true;
  if (["slow-2g", "2g"].includes(connection?.effectiveType)) return true;
  return slowResponses >= 2; // two slow answers in a row: the link is poor whatever it claims
}

/**
 * Fill gaps in a matrix with the last good reading of each pillar from this
 * device, marked status "cached" with its own timestamp, so old data never
 * passes as live. A pillar is only replaced when the fresh one has no score.
 */
export function mergeLastGood(matrix, lastGood) {
  if (!matrix?.regions) return matrix;
  return {
    ...matrix,
    regions: matrix.regions.map((r) => {
      if (!r.pillars) {
        // Region still pending on the server: build it from local data if we have any.
        const local = Object.fromEntries(LIVE_PILLARS.map((k) => [k, lastGood[`${r.id}:${k}`]]).filter(([, v]) => v));
        if (!Object.keys(local).length) return r;
        return { ...r, pending: false, fromDevice: true, pillars: Object.fromEntries(Object.entries(local).map(([k, v]) => [k, asCached(v)])) };
      }
      const pillars = { ...r.pillars };
      for (const k of LIVE_PILLARS) {
        const lg = lastGood[`${r.id}:${k}`];
        if (pillars[k]?.score == null && lg) pillars[k] = asCached(lg);
      }
      return { ...r, pillars };
    }),
  };
}

const asCached = (rec) => ({ ...rec.pillar, status: "cached", notes: [...(rec.pillar.notes || []), "Last good reading saved on this device."] });

/** The pillars worth remembering: real scores only. */
export function goodPillars(matrix) {
  const out = [];
  for (const r of matrix?.regions || [])
    for (const k of LIVE_PILLARS) {
      const p = r.pillars?.[k];
      if (p && p.score != null && p.asOf && p.status !== "cached") out.push({ key: `${r.id}:${k}`, regionId: r.id, pillar: p, asOf: Date.parse(p.asOf) });
    }
  return out;
}

/** "just now", "5 min ago", "3 h ago", "2 days ago". */
export function ageLabel(fromMs, now = Date.now()) {
  if (!Number.isFinite(fromMs)) return "unknown time";
  const m = Math.max(0, Math.round((now - fromMs) / 60_000));
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}
