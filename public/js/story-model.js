// What goes on a Visual Story Card, decided without any canvas so it can be
// tested: header, key metrics, SitRep text in the tier the user is looking
// at, sources and link. story-card.js draws it.

import { PILLAR_TITLES } from "./briefing.js";

const LEVEL = { low: "LOW", guarded: "GUARDED", elevated: "ELEVATED", high: "HIGH", severe: "SEVERE", unknown: "PRELIMINARY" };
const SHORT = { seismic: "SEISMIC", wildfire: "FIRE & SMOKE", heat: "EXTREME HEAT", glof: "GLOF" };
const SOURCES = {
  seismic: ["USGS earthquake catalogue"],
  wildfire: ["NASA FIRMS (satellite fires)", "Open-Meteo (weather)", "OpenAQ (air quality)"],
  heat: ["Open-Meteo forecast", "ERA5 10-year archive (Open-Meteo)"],
  glof: ["Static reference list (not live)"],
};
const n1 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10) / 10);
const sig = (z) => (z == null ? "n/a" : `${z > 0 ? "+" : z < 0 ? "−" : ""}${Math.abs(n1(z))}σ`);

/** Up to three headline numbers for the pillar. */
export function keyMetrics(key, p) {
  const c = p?.components || {};
  if (key === "heat") {
    const tws = (c.severity?.series || []).map((s) => s[1]);
    return [
      ["Peak wet-bulb (48 h)", c.severity ? `${n1(c.severity.peakWetBulbC)} °C` : "n/a"],
      ["vs normal for date", sig(c.anomaly?.zScore)],
      ["Hours ≥ 28 °C", String(tws.filter((t) => t >= 28).length)],
    ];
  }
  if (key === "wildfire")
    return [
      ["Active fires (24 h)", c.activity ? String(c.activity.detections) : "n/a"],
      ["PM2.5", c.smoke ? `${c.smoke.pm25} µg/m³` : "n/a"],
      ["Air quality (AQI)", c.smoke ? String(c.smoke.aqi) : "n/a"],
    ];
  if (key === "seismic")
    return [
      ["Quakes this week", String(p?.detail?.eventsLast7Days ?? 0)],
      ["Largest", p?.detail?.largest ? `M${p.detail.largest.mag}` : "none"],
      ["Normal rate", p?.detail?.baselineEventsPerYear != null ? `~${n1(p.detail.baselineEventsPerYear)}/yr` : "n/a"],
    ];
  return [
    ["Status", "Not live"],
    ["Reference lakes", String(p?.referenceLakes?.length ?? 0)],
    ["Score", "none"],
  ];
}

/** SitRep lines for the tier currently shown on the card. */
export function sitrepText(tiered, tier) {
  if (tier === "researcher") {
    const r = tiered.researcher;
    return {
      headline: null,
      body: r.summary,
      bullets: (r.anomalies || []).slice(0, 2).map((a) => `${a.variable}: ${a.observed} vs ${a.baseline} (${a.deviation})`),
    };
  }
  const p = tiered.plain;
  return { headline: p.headline, body: p.summary, bullets: (p.whatToDo || []).slice(0, 2) };
}

/**
 * Everything the card shows.
 * @param state {region, key, pillar, tiered, tier, sourceLabel, live, url, now}
 */
export function buildStoryModel({ region, key, pillar, tiered, tier, sourceLabel, live = true, origin = "", now = Date.now() }) {
  const level = key === "glof" ? "unknown" : pillar?.level || "unknown";
  const asOf = pillar?.asOf ? new Date(pillar.asOf) : new Date(now);
  return {
    region,
    key,
    level,
    badge: `${SHORT[key]} · ${LEVEL[level] || level.toUpperCase()}`,
    title: `${region.name}: ${PILLAR_TITLES[key]}`,
    score: pillar?.score ?? null,
    when: `${live ? "Live" : "Saved"} · ${asOf.toISOString().slice(0, 16).replace("T", " ")} UTC`,
    metrics: keyMetrics(key, pillar),
    tierLabel: tier === "researcher" ? "Researcher" : "Plain language",
    sitrep: sitrepText(tiered, tier),
    sitrepSource: sourceLabel,
    sources: SOURCES[key],
    stub: key === "glof" ? pillar?.label || "Preliminary / Non-Real-Time" : null,
    link: `${origin.replace(/^https?:\/\//, "")}/?focus=${encodeURIComponent(region.id)}`,
    fileName: `zackscan-${region.id}-${key}-${asOf.toISOString().slice(0, 10)}.jpg`,
  };
}

/**
 * Greedy word wrap. `measure(text) -> width`. Returns at most `maxLines`
 * lines; if the text doesn't fit, the last line ends with an ellipsis.
 */
export function wrapText(text, maxWidth, measure, maxLines = Infinity) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (measure(next) <= maxWidth || !line) line = next;
    else {
      lines.push(line);
      line = w;
    }
  }
  if (line) lines.push(line);
  if (lines.length <= maxLines) return lines;
  const out = lines.slice(0, maxLines);
  let last = out[maxLines - 1];
  while (last && measure(last + "…") > maxWidth) last = last.replace(/\s*\S+$/, "");
  out[maxLines - 1] = (last || "").replace(/[\s,;:.]+$/, "") + "…";
  return out;
}
