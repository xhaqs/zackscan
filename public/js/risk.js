// Risk matrix panel: one row per watchlist region, one chip per pillar.
// Tap a region for the components behind each score.
//
// Offline behaviour: every successful load is saved to IndexedDB. When the
// network fails, the last saved matrix is shown with a banner saying how
// old it is, and every pillar shows its own age. Old data is never shown as
// if it were live. On data saver, the small summary is fetched and details
// load on request.

import { createPoller, dataSaverOn, timed } from "./poller.js";
import { saveSnapshot, newestSnapshot, rememberPillars, lastGoodPillars } from "./offline-store.js";
import { mergeLastGood, ageLabel } from "./offline-logic.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const ORDER = ["seismic", "wildfire", "heat", "glof"];
const SHORT = { seismic: "Seismic", wildfire: "Fire & smoke", heat: "Heat", glof: "GLOF" };
const BASE_MS = 5 * 60_000;

function chip(key, p) {
  if (!p) return "";
  if (key === "glof")
    return `<span class="chip chip-stub" title="${esc(p.label)}">${SHORT.glof}<b>—</b><small>${esc(p.label)}</small></span>`;
  const age = p.asOf ? ageLabel(Date.parse(p.asOf)) : "";
  const flag =
    { stale: ` · stale, ${age}`, cached: ` · saved ${age}`, partial: " · partial", error: " · no data" }[p.status] || "";
  return `<span class="chip lvl-${esc(p.level)}">${SHORT[key]}<b>${p.score ?? "—"}</b><small>${esc(p.level)}${esc(flag)}</small></span>`;
}

const fullDetails = new Map(); // regionId -> full region fetched via "Load details"

function details(r) {
  const loaded = fullDetails.get(r.id);
  if (loaded && loaded.updatedAt === r.updatedAt) r = loaded;
  const p = r.pillars;
  if (!p.seismic?.components && !p.heat?.components && !p.wildfire?.components)
    return `<p class="meta">Details weren't downloaded (data saver). <button type="button" class="link load-details" data-region="${esc(r.id)}">Load details</button></p>`;
  const s = p.seismic, h = p.heat?.components, w = p.wildfire?.components;
  const line = (label, text) => (text ? `<li><b>${label}:</b> ${text}</li>` : "");
  const notes = ORDER.flatMap((k) => (p[k]?.notes || []).map((n) => `<li class="note">${esc(SHORT[k])}: ${esc(n)}</li>`)).join("");
  return `<ul class="risk-detail">
    ${line("Seismic", s?.detail && `${s.detail.eventsLast7Days} quakes ≥M${s.detail.minMagnitude} this week vs ~${s.detail.baselineEventsPerYear}/yr normally` +
      (s.detail.largest ? `; largest M${esc(s.detail.largest.mag)} ${esc(s.detail.largest.place)}` : ""))}
    ${line("Heat", h?.severity && `peak wet-bulb ${h.severity.peakWetBulbC} °C in the next 48 h` +
      (h.anomaly ? `; ${h.anomaly.zScore > 0 ? "+" : ""}${h.anomaly.zScore}σ vs the 10-year normal (${h.anomaly.baselineMeanC} ± ${h.anomaly.baselineStdC} °C)` : ""))}
    ${line("Fire weather", w?.fireWeather && `VPD ${w.fireWeather.vpdKpa} kPa, humidity ${w.fireWeather.relativeHumidityPct}%` +
      (w.fireWeather.humidityDrop24hPts != null ? ` (${w.fireWeather.humidityDrop24hPts >= 0 ? "down" : "up"} ${Math.abs(w.fireWeather.humidityDrop24hPts)} pts in 24 h)` : ""))}
    ${line("Active fires", w?.activity && `${w.activity.detections} satellite detections in the last 24 h`)}
    ${line("PM2.5", w?.smoke && `${w.smoke.pm25} µg/m³ (AQI ${w.smoke.aqi}) from ${w.smoke.stations} station(s)`)}
    ${p.glof ? line("GLOF", `${esc(p.glof.label)}. ` + (p.glof.referenceLakes?.length ? "Reference lakes: " + p.glof.referenceLakes.map((l) => `${esc(l.name)} (${l.distanceKm} km)`).join(", ") : "No reference lakes nearby.")) : ""}
    ${notes}
  </ul>`;
}

function row(r, open, saved) {
  if (r.pending) return `<li class="risk-row"><div class="risk-head"><span>${esc(r.name)}</span><small>Loading… check back in a minute.</small></div></li>`;
  const updated = r.updatedAt ? ageLabel(Date.parse(r.updatedAt)) : r.fromDevice ? "saved on this device" : "?";
  return `<li class="risk-row" data-region="${esc(r.id)}"><details${open ? " open" : ""}>
    <summary class="risk-head">
      <span>${esc(r.name)}</span>
      ${r.overall ? `<span class="chip lvl-${esc(r.overall.level)} overall">Overall<b>${r.overall.score ?? "—"}</b><small>${esc(r.overall.level)}</small></span>` : ""}
    </summary>
    <div class="chips">${ORDER.map((k) => chip(k, r.pillars[k])).join("")}</div>
    <small class="meta">${saved ? "<b>Saved on this device</b> · " : ""}Updated ${esc(updated)}${r.outdated && !saved ? " · refreshing" : ""}</small>
    <div class="risk-body">${details(r)}</div>
  </details></li>`;
}

export function startRiskPanel(el, { onStatus = () => {} } = {}) {
  let shown = null; // what's on screen, to redraw ages and keep open rows open

  function render(matrix, source) {
    shown = { matrix, source };
    const open = new Set([...el.querySelectorAll("details[open]")].map((d) => d.closest("[data-region]")?.dataset.region));
    el.innerHTML = matrix.regions.map((r) => row(r, open.has(r.id), !source.live)).join("");
    el.classList.toggle("saved", !source.live);
    onStatus(source);
  }

  async function load() {
    const summary = dataSaverOn();
    const key = summary ? "risk:summary" : "risk:full";
    try {
      // cache: "no-cache" = always ask the server (a cheap 304 if unchanged), so the
      // HTTP cache can never pass old data off as live when the network is down.
      const res = await timed(() => fetch("/api/risk" + (summary ? "?fields=summary" : ""), { credentials: "same-origin", cache: "no-cache" }));
      if (!res.ok) throw new Error("HTTP " + res.status);
      const m = await res.json();
      await saveSnapshot(key, m);
      await rememberPillars(m);
      render(mergeLastGood(m, await lastGoodPillars()), { live: true, fetchedAt: Date.now(), summary });
    } catch (e) {
      await showSaved(e);
      throw e; // tell the poller, so it backs off
    }
  }

  async function showSaved(error, { starting = false } = {}) {
    const snap = await newestSnapshot(["risk:full", "risk:summary"]);
    if (!snap) {
      el.innerHTML = `<li class="err">Can't load the risk matrix (${esc(error?.message || "offline")}) and nothing is saved on this device yet.</li>`;
      onStatus({ live: false, starting, fetchedAt: null });
      return;
    }
    render(mergeLastGood(snap.data, await lastGoodPillars()), { live: false, starting, fetchedAt: snap.fetchedAt, summary: snap.data.fields === "summary" });
  }

  // "Load details" in data-saver mode: fetch one region in full.
  el.addEventListener("click", async (ev) => {
    const btn = ev.target.closest(".load-details");
    if (!btn) return;
    btn.disabled = true;
    btn.textContent = "Loading…";
    try {
      const res = await fetch("/api/risk?region=" + encodeURIComponent(btn.dataset.region), { cache: "no-cache" });
      const m = await res.json();
      const full = m.regions[0];
      if (!full?.pillars) throw new Error("not ready");
      fullDetails.set(full.id, full);
      btn.closest(".risk-body").innerHTML = details(full);
    } catch {
      btn.textContent = "Couldn't load. Try again";
      btn.disabled = false;
    }
  });

  const poller = createPoller({ task: load, baseMs: () => BASE_MS, onState: (s) => onStatus({ ...(shown?.source || {}), poll: s }) });
  // Show saved data at once (instant offline start), then fetch.
  showSaved(null, { starting: true }).then(() => poller.run());
  // Keep "x min ago" labels honest while the page sits open.
  setInterval(() => shown && render(shown.matrix, shown.source), 60_000);
  // The service worker refreshed data in the background.
  navigator.serviceWorker?.addEventListener("message", (e) => e.data?.type === "risk-updated" && !shown?.source?.live && showSaved());
  return poller;
}
