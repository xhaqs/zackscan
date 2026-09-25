// Anomaly Card: one region × one hazard pillar.
//
//   header   hazard badge + level, title, live/saved telemetry status, score
//   viz      real data only: heat 48 h wet-bulb + ±σ gauge, quakes over the
//            week, satellite fire map, GLOF reference lakes (stub, labelled)
//   SitRep   Plain / Researcher toggle. Both registers are already in hand
//            (data briefing, or an AI SitRep generated in one call), so
//            switching is instant with no fetch.
//   footer   SHARE SITREP (+ NASA FIRMS map link on fire cards)

import { briefing, PILLAR_TITLES } from "./briefing.js";
import { heatChart, sigmaGauge, quakeChart, fireMap, lakeMap } from "./charts.js";
import { preferredTier, setPreferredTier, TIER_LABELS } from "./tier-toggle.js";
import { ageLabel } from "./offline-logic.js";
import { loadSitrep, saveSitrep } from "./offline-store.js";
import { api } from "./api.js";

const LEVEL_LABEL = { low: "Low", guarded: "Guarded", elevated: "Elevated", high: "High", severe: "Severe", unknown: "Unknown" };
const SHORT = { seismic: "SEISMIC", wildfire: "FIRE & SMOKE", heat: "HEAT", glof: "GLOF" };

function h(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null && c !== false && c !== 0) e.append(c instanceof Node ? c : String(c)); // 0: a stray && result, never content
  return e;
}

function telemetry(key, p, source) {
  if (key === "glof") return ["stub", p?.label || "Preliminary / Non-Real-Time"];
  const age = p?.asOf ? ageLabel(Date.parse(p.asOf)) : "";
  if (!source?.live) return ["saved", `Saved on this device · ${age}`];
  const s = p?.status;
  if (s === "stale") return ["stale", `Stale · ${age}`];
  if (s === "cached") return ["saved", `Saved reading · ${age}`];
  if (s === "error") return ["error", "No data"];
  return [s === "partial" ? "partial" : "live", `${s === "partial" ? "Live, partial" : "Live"} · ${age}`];
}

function viz(key, region, p) {
  const c = p?.components;
  if (key === "glof") return lakeMap(p?.referenceLakes || [], { center: [region.lat, region.lon] });
  if (!c) return h("p", { class: "viz-empty" }, p?.score == null ? "No data to chart yet." : "Charts need the full data (data saver is on).");
  if (key === "heat") {
    const parts = [];
    if (c.severity?.series?.length) parts.push(heatChart(c.severity.series));
    if (c.anomaly?.zScore != null) parts.push(sigmaGauge(c.anomaly.zScore, { label: "daily wet-bulb vs normal for the date" }));
    return parts.length ? h("div", {}, parts) : h("p", { class: "viz-empty" }, "No hourly forecast available.");
  }
  if (key === "seismic") return quakeChart(p.detail?.events || [], { minMag: p.detail?.minMagnitude ?? 4 });
  if (key === "wildfire") {
    const kids = [];
    if (c.activity && p.area) kids.push(fireMap(c.activity.points || [], p.area));
    else kids.push(h("p", { class: "viz-empty" }, "Satellite fire detection isn't switched on for this area."));
    const tiles = [];
    if (c.smoke) tiles.push(["PM2.5", `${c.smoke.pm25} µg/m³`, `AQI ${c.smoke.aqi}`]);
    if (c.fireWeather) tiles.push(["Dryness (VPD)", `${c.fireWeather.vpdKpa} kPa`, `RH ${c.fireWeather.relativeHumidityPct}%`]);
    if (c.fireWeather?.windKmh != null) tiles.push(["Wind", `${Math.round(c.fireWeather.windKmh)} km/h`, ""]);
    if (tiles.length) kids.push(h("div", { class: "stat-row" }, tiles.map(([l, v, sub]) => h("div", { class: "stat" }, h("span", { class: "stat-label" }, l), h("span", { class: "stat-value" }, v), sub && h("span", { class: "stat-sub" }, sub)))));
    return h("div", {}, kids);
  }
  return h("p", { class: "viz-empty" }, "No chart.");
}

function panels(t) {
  const plain = h(
    "div",
    { class: "tier-panel", "data-tier": "plain" },
    h("p", { class: "sitrep-headline" }, t.plain.headline),
    h("p", {}, t.plain.summary),
    t.plain.whatToDo?.length ? h("ul", {}, t.plain.whatToDo.slice(0, 3).map((x) => h("li", {}, x))) : null,
  );
  const r = t.researcher;
  const researcher = h(
    "div",
    { class: "tier-panel", "data-tier": "researcher" },
    h("p", {}, r.summary),
    r.anomalies?.length ? h("ul", { class: "anoms" }, r.anomalies.map((a) => h("li", {}, h("b", {}, a.variable), `: ${a.observed} vs ${a.baseline} (${a.deviation})`))) : null,
    r.findings?.length ? h("ul", { class: "anoms" }, r.findings.slice(0, 4).map((f) => h("li", {}, h("b", {}, f.metric), `: ${f.value}, ${f.observation} (confidence ${f.confidence})`))) : null,
    r.limitations?.length ? h("p", { class: "limits" }, "Limitations: " + r.limitations.slice(0, 2).join(" ")) : null,
  );
  return [plain, researcher];
}

/**
 * @param region  {id, name, lat, lon}
 * @param key     "seismic" | "wildfire" | "heat" | "glof"
 * @param pillar  the pillar object from /api/risk
 * @param source  {live, fetchedAt}: is this fresh data or saved on the device?
 * @param onNeedFull  called when the card needs the full data (data saver)
 */
export function createAnomalyCard({ region, key, pillar, source, onNeedFull }) {
  const level = key === "glof" ? "unknown" : pillar?.level || "unknown";
  const [tstate, tlabel] = telemetry(key, pillar, source);
  const cardKey = `card:${region.id}:${key}`;
  let current = briefing(region, key, pillar); // what the SitRep shows now
  let currentSource = "Written from the data";

  const toggle = h(
    "div",
    { class: "tier-toggle", role: "group", "aria-label": "Explanation style" },
    Object.entries(TIER_LABELS).map(([t, label]) => h("button", { type: "button", "data-tier": t, onclick: () => setPreferredTier(t) }, label)),
  );
  const body = h("div", { class: "sitrep-body" });
  const src = h("span", { class: "sitrep-src" });
  const err = h("p", { class: "card-err", role: "status" });
  const show = (tier) => {
    for (const b of toggle.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.tier === tier));
    for (const p of body.querySelectorAll(".tier-panel")) p.hidden = p.dataset.tier !== tier;
  };
  const renderSitrep = (t, label) => {
    current = t;
    currentSource = label;
    src.textContent = label;
    body.replaceChildren(...panels(t));
    show(preferredTier());
  };
  renderSitrep(current, currentSource);

  const aiBtn =
    key !== "glof" && pillar?.score != null
      ? h("button", { type: "button", class: "ai-btn", onclick: () => generateAi() }, "✨ AI SitRep")
      : null;

  async function generateAi() {
    aiBtn.disabled = true;
    const was = aiBtn.textContent;
    aiBtn.textContent = "Checking for new data…";
    err.textContent = "";
    try {
      const saved = await loadSitrep(cardKey);
      const r = await api.analyzeCard(region.id, key, saved?.result?.fingerprint);
      if (r.unchanged && saved) renderSitrep(saved.result.assessment, `AI · ${saved.result.model} · no new data since ${ageLabel(Date.parse(saved.result.generatedAt))}`);
      else if (r.assessment) {
        await saveSitrep(cardKey, r);
        renderSitrep(r.assessment, `AI · ${r.model} · just now`);
      }
    } catch (e) {
      err.textContent = navigator.onLine === false || e instanceof TypeError ? "You're offline, so no AI SitRep right now." : e.message;
    } finally {
      aiBtn.disabled = false;
      aiBtn.textContent = was;
    }
  }

  // A saved AI SitRep for this card is shown straight away (labelled with its age).
  if (aiBtn)
    loadSitrep(cardKey).then((saved) => {
      if (saved?.result?.assessment?.plain) renderSitrep(saved.result.assessment, `AI · ${saved.result.model} · ${ageLabel(Date.parse(saved.result.generatedAt))}`);
    });

  async function share() {
    const tier = preferredTier();
    const t = current;
    const lines =
      tier === "plain"
        ? [t.plain.headline, t.plain.summary, ...(t.plain.whatToDo || []).map((x) => "• " + x)]
        : [t.researcher.summary, ...(t.researcher.anomalies || []).map((a) => `• ${a.variable}: ${a.observed} vs ${a.baseline} (${a.deviation})`)];
    const title = `${region.name}: ${PILLAR_TITLES[key]}${pillar?.score != null ? ` (${LEVEL_LABEL[level]}, ${pillar.score}/100)` : ""}`;
    const text = `${title}\n${lines.join("\n")}\n— Zackscan SitRep (${TIER_LABELS[tier]}, ${currentSource})`;
    const url = `${location.origin}/?focus=${encodeURIComponent(region.id)}#anom-h`;
    // The phone's share sheet first; if it's missing or fails (not cancelled), copy instead.
    if (navigator.share) {
      try {
        return await navigator.share({ title, text, url });
      } catch (e) {
        if (e?.name === "AbortError") return; // the user closed the sheet
      }
    }
    try {
      await navigator.clipboard.writeText(`${text}\n${url}`);
      shareBtn.textContent = "COPIED ✓";
      setTimeout(() => (shareBtn.textContent = "SHARE SITREP"), 2000);
    } catch {
      err.textContent = "Couldn't share. Long-press the SitRep text to copy it.";
    }
  }
  const shareBtn = h("button", { type: "button", class: "action", onclick: share }, "SHARE SITREP");

  const firmsLink =
    key === "wildfire"
      ? h("a", { class: "ext", href: `https://firms.modaps.eosdis.nasa.gov/map/#d:24hrs;@${region.lon.toFixed(2)},${region.lat.toFixed(2)},9.0z`, target: "_blank", rel: "noopener noreferrer" }, "Open in NASA FIRMS ↗")
      : null;

  const needFull = !pillar?.components && key !== "glof" && pillar?.score != null && onNeedFull
    ? h("button", { type: "button", class: "link", onclick: () => onNeedFull(region.id) }, "Load full data")
    : null;

  const card = h(
    "article",
    { class: `anomaly-card lvl-${level}`, "data-card": `${region.id}:${key}`, "aria-labelledby": `t-${region.id}-${key}` },
    h(
      "header",
      { class: "card-head" },
      h("div", { class: "card-meta" },
        h("span", { class: `badge badge-${level}` }, h("span", { class: "dot", "aria-hidden": "true" }), `${SHORT[key]} · ${key === "glof" ? "PRELIMINARY" : LEVEL_LABEL[level].toUpperCase()}`),
        h("span", { class: `telemetry t-${tstate}` }, h("span", { class: "pulse", "aria-hidden": "true" }), tlabel),
      ),
      h("div", { class: "card-title-row" },
        h("h3", { id: `t-${region.id}-${key}` }, `${region.name}: ${PILLAR_TITLES[key]}`),
        pillar?.score != null && h("div", { class: "score", "aria-label": `Score ${pillar.score} out of 100` }, String(pillar.score), h("small", {}, "/100")),
      ),
    ),
    h("div", { class: "viz" }, viz(key, region, pillar), needFull),
    h("section", { class: "sitrep", "aria-label": "Situation report" },
      h("div", { class: "sitrep-head" }, h("span", { class: "sitrep-label" }, "SitRep"), toggle),
      body,
      h("div", { class: "sitrep-foot" }, src, aiBtn),
      err,
    ),
    h("footer", { class: "card-foot" }, shareBtn, firmsLink),
  );

  const onPref = (e) => show(e.detail);
  addEventListener("zackscan:tier", onPref);
  card.__destroy = () => removeEventListener("zackscan:tier", onPref);
  return card;
}
