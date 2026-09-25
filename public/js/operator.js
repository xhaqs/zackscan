// Operator profile: who is using this device, shown in the header.
// (The plain-JS counterpart of a `useMissionProfile` hook: read with
// getOperator(), change with setOperator(), and listen for "zackscan:operator".)
//
// Stored in this browser only. Anyone holding the device can edit it, so it
// sets display and defaults, never access. Real permissions would need
// server-side accounts. The header's capability chips instead report what
// this device can actually do (own AI key, background alerts, offline).

import { REGION_IDS } from "./regions.js";

const KEY = "zackscan.operator";
export const ROLES = Object.freeze({
  public: { label: "Member of the public", tier: "plain" },
  responder: { label: "Field responder", tier: "plain" },
  analyst: { label: "Analyst / researcher", tier: "researcher" },
});
const EMPTY = { name: "", organization: "", role: "public", homeRegion: "nairobi" };

const clean = (s, max = 60) => String(s ?? "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, max);

export function getOperator() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || "null") || {};
    return {
      name: clean(v.name),
      organization: clean(v.organization, 80),
      role: Object.hasOwn(ROLES, v.role) ? v.role : EMPTY.role,
      homeRegion: REGION_IDS.includes(v.homeRegion) ? v.homeRegion : EMPTY.homeRegion,
    };
  } catch {
    return { ...EMPTY };
  }
}

export function setOperator(patch) {
  const next = { ...getOperator(), ...patch };
  const v = { name: clean(next.name), organization: clean(next.organization, 80), role: Object.hasOwn(ROLES, next.role) ? next.role : "public", homeRegion: REGION_IDS.includes(next.homeRegion) ? next.homeRegion : "nairobi" };
  try {
    localStorage.setItem(KEY, JSON.stringify(v));
  } catch {}
  dispatchEvent(new CustomEvent("zackscan:operator", { detail: v }));
  return v;
}

/** What this device can actually do right now (the honest "permissions"). */
export async function deviceCapabilities({ hasOwnKey, dataSaver }) {
  const caps = [];
  if (hasOwnKey) caps.push({ id: "key", label: "Own AI key", ok: true });
  const perm = globalThis.Notification?.permission;
  let sub = null;
  try {
    sub = await (await navigator.serviceWorker?.getRegistration())?.pushManager?.getSubscription();
  } catch {}
  if (sub && perm === "granted") caps.push({ id: "alerts", label: "Background alerts on", ok: true });
  else if (perm === "denied") caps.push({ id: "alerts", label: "Alerts blocked", ok: false });
  if (navigator.serviceWorker?.controller) caps.push({ id: "offline", label: "Works offline", ok: true });
  if (dataSaver) caps.push({ id: "saver", label: "Data saver", ok: true });
  return caps;
}
