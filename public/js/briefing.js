// Data-driven SitRep for one anomaly card, in both registers, written from
// the pillar's own numbers. Same shape as the AI's two-tier answer, so the
// card renders either one the same way. Instant, offline, no AI call.

export const PILLAR_TITLES = Object.freeze({
  seismic: "Seismic activity",
  wildfire: "Fire & smoke",
  heat: "Extreme heat",
  glof: "Glacial lake outburst (GLOF)",
});

const RISK_FROM_LEVEL = { low: "low", guarded: "low", elevated: "moderate", high: "high", severe: "severe" };
const n1 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10) / 10);
const sig = (z) => `${z > 0 ? "+" : ""}${n1(z)}σ`;
const hhmm = (local) => (local ? local.slice(11, 16) : "");
const dayName = (local) => (local ? new Date(local + ":00Z").toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" }) : "");
const pFmt = (p) => (p == null ? "n/a" : p < 0.001 ? "<0.001" : String(Number(p.toPrecision(2))));

/** @returns {riskLevel, plain:{headline,summary,whatItMeans,whatToDo}, researcher:{summary,findings,anomalies,dataVariables,limitations}} */
export function briefing(region, key, p) {
  if (key === "glof") return glof(region, p);
  if (!p || p.score == null) return noData(region, key, p);
  const f = { heat, seismic, wildfire }[key];
  return { riskLevel: RISK_FROM_LEVEL[p.level] || null, ...f(region, p) };
}

function noData(region, key, p) {
  return {
    riskLevel: null,
    plain: { headline: `No ${PILLAR_TITLES[key].toLowerCase()} reading right now`, summary: `We couldn't get fresh data for ${region.name}. We'll keep trying.`, whatItMeans: [], whatToDo: [] },
    researcher: { summary: `No current reading (${p?.status || "missing"}).`, findings: [], anomalies: [], dataVariables: [], limitations: (p?.notes || []).slice(0, 3) },
  };
}

// ---------------------------------------------------------------- heat

function heat(region, p) {
  const s = p.components?.severity;
  const a = p.components?.anomaly;
  const tw = s?.peakWetBulbC;
  const band =
    tw >= 35 ? ["Life-threatening heat", "Even resting in the shade can be deadly without cooling."]
    : tw >= 31 ? ["Extreme heat: dangerous for everyone outdoors", "The body can barely cool itself by sweating."]
    : tw >= 28 ? ["Dangerous heat for outdoor work", "Heavy work or exercise outside can quickly cause heat illness."]
    : tw >= 24 ? ["Hot and humid: take it easy in the afternoon", "Long, hard work outside in the hottest hours is tiring and risky."]
    : ["No dangerous heat expected", "Heat stress should stay low."];
  // Not dangerous, but clearly hotter than normal: say that, not "no heat".
  if (tw < 28 && a?.zScore >= 1.5) band.splice(0, 2, "Unusually hot for this time of year", "Not dangerous heat, but noticeably hotter than normal.");
  const unusual = a?.zScore == null ? "" : a.zScore >= 2 ? " It's far hotter than usual for this time of year." : a.zScore >= 1 ? " It's hotter than usual for this time of year." : a.zScore <= -1 ? " It's cooler than usual for this time of year." : " That's about normal for this time of year.";
  const unusualText = tw < 28 && a?.zScore >= 1.5 ? "" : unusual; // already said in the headline
  const when = s?.at ? ` Worst around ${hhmm(s.at)} on ${dayName(s.at)}.` : "";
  const todo = tw >= 28
    ? ["Move heavy outdoor work to early morning or evening.", "Drink water often, even before you feel thirsty.", "Check on older people, young children and anyone without cooling."]
    : tw >= 24
      ? ["Drink water regularly and rest in the shade at midday."]
      : [];
  const tws = (s?.series || []).map((x) => x[1]);
  return {
    plain: {
      headline: `${band[0]} in ${region.name}`,
      summary: `${band[1]}${when}${unusualText}`,
      whatItMeans: tw >= 28 ? ["Outdoor workers, older people and anyone with heart problems are most at risk."] : [],
      whatToDo: todo,
    },
    researcher: {
      summary:
        `Peak Tw ${n1(tw)} °C at ${hhmm(s?.at)} local (Stull 2011; T ${n1(s?.tempC)} °C, RH ${s?.relativeHumidityPct ?? "n/a"}%).` +
        (a ? ` Daily Stull(Tmax, RHmin) ${n1(a.dailyWetBulbC)} °C vs the ±7-day window over 10 years: ${n1(a.baselineMeanC)} ± ${n1(a.baselineStdC)} °C (z = ${sig(a.zScore)}, n = ${a.baselineDays}).` : " No 10-year baseline available."),
      findings: [
        { metric: "Heat stress (48 h peak)", observation: `${tws.filter((t) => t >= 28).length} h ≥ 28 °C, ${tws.filter((t) => t >= 31).length} h ≥ 31 °C`, value: `${n1(tw)} °C`, confidence: "medium" },
      ],
      anomalies: a ? [{ variable: "Daily wet-bulb", observed: `${n1(a.dailyWetBulbC)} °C`, baseline: `${n1(a.baselineMeanC)} ± ${n1(a.baselineStdC)} °C`, deviation: sig(a.zScore) }] : [],
      dataVariables: [
        { name: "temperature_2m, relative_humidity_2m (hourly)", value: `${tws.length} h`, unit: "°C, %", source: "Open-Meteo" },
        { name: "temperature_2m_max, relative_humidity_2m_min (daily, 10 y)", value: String(a?.baselineDays ?? "n/a"), unit: "days", source: "Open-Meteo archive" },
      ],
      limitations: ["Stull (2011) is accurate to about ±1 °C for RH 5–99%.", "The hourly peak has no baseline. The anomaly uses the daily measure."],
    },
  };
}

// ---------------------------------------------------------------- seismic

function seismic(region, p) {
  const d = p.detail || {};
  const c = p.components || {};
  const big = d.largest;
  const cl = c.clustering;
  const unusual = cl?.pValue != null && cl.pValue < 0.01;
  const headline = !big
    ? `No significant earthquakes near ${region.name} this week`
    : big.mag >= 6
      ? `Strong earthquake near ${region.name}`
      : big.mag >= 4.5
        ? `Moderate earthquake near ${region.name}`
        : `Small earthquakes near ${region.name}`;
  const felt = !big ? "Nothing large enough to worry about was recorded within 300 km." : big.mag >= 6 ? "Strong shaking was likely near the epicentre and damage is possible." : big.mag >= 4.5 ? "It may have been felt nearby; damage is unlikely." : "Most people wouldn't have felt these.";
  return {
    plain: {
      headline,
      summary: `${felt}${unusual ? " There have been more quakes than usual for this area, so aftershocks are possible." : ""}`,
      whatItMeans: big && big.mag >= 5 ? ["Aftershocks can follow a larger quake for days."] : [],
      whatToDo: big && big.mag >= 5 ? ["Know where to Drop, Cover and Hold On.", "Check buildings for cracks before going back in."] : [],
    },
    researcher: {
      summary:
        `${d.eventsLast7Days ?? 0} events ≥ M${d.minMagnitude} within ${p.area?.radiusKm ?? 300} km in 7 d vs ~${n1(d.baselineEventsPerYear)}/yr baseline (${d.baselineYears ?? 10} y USGS).` +
        (cl ? ` Clustering: ${cl.observed} observed vs λ = ${cl.expected} over ${cl.windowDays} d (Poisson p = ${pFmt(cl.pValue)}).` : "") +
        (big ? ` Max M${big.mag} at ${n1(big.depthKm)} km, ${big.place}; Gutenberg–Richter (b = 1) p = ${pFmt(c.magnitudeAnomaly?.pValue)}.` : ""),
      findings: [{ metric: "Event rate", observation: `${cl?.observed ?? 0} in ${cl?.windowDays ?? 7} d`, value: `p = ${pFmt(cl?.pValue)}`, confidence: "medium" }],
      anomalies: unusual ? [{ variable: "Event count", observed: String(cl.observed), baseline: `λ = ${cl.expected}`, deviation: `p = ${pFmt(cl.pValue)}` }] : [],
      dataVariables: [{ name: "FDSN events", value: String(d.eventsLast7Days ?? 0), unit: `≥ M${d.minMagnitude}`, source: "USGS" }],
      limitations: [d.minMagnitude >= 4 ? "Outside the US the USGS catalogue is complete only from about M4, so smaller quakes are not counted." : "Catalogue completeness from M2.5."],
    },
  };
}

// ---------------------------------------------------------------- wildfire

function wildfire(region, p) {
  const c = p.components || {};
  const act = c.activity, wx = c.fireWeather, sm = c.smoke;
  const fires = act?.detections ?? null;
  const air = sm ? (sm.aqi > 200 ? "very unhealthy" : sm.aqi > 150 ? "unhealthy for everyone" : sm.aqi > 100 ? "unhealthy for sensitive people" : sm.aqi > 50 ? "moderate" : "good") : null;
  const headline =
    fires > 0 ? `${fires} active fire${fires === 1 ? "" : "s"} detected near ${region.name}`
    : sm && sm.aqi > 100 ? `Poor air quality in ${region.name}`
    : wx && wx.score >= 50 ? `Dry, fire-prone weather in ${region.name}`
    : `No active fires near ${region.name}`;
  const parts = [];
  if (fires != null) parts.push(fires > 0 ? `Satellites spotted ${fires} fire${fires === 1 ? "" : "s"} in the last 24 hours within about 110 km.` : "Satellites saw no fires in the last 24 hours within about 110 km.");
  else parts.push("Fire detection isn't switched on for this area.");
  if (air) parts.push(`Air quality is ${air}${sm.likelySmoke ? ", probably partly from smoke" : ""}.`);
  if (wx && wx.score >= 50) parts.push("The air is very dry, so fires can start and spread easily where there's vegetation.");
  const todo = [];
  if (sm && sm.aqi > 100) todo.push("Limit long or hard activity outdoors; keep windows closed if it's smoky.");
  if (fires > 0) todo.push("Follow local fire service instructions and avoid burning anything outdoors.");
  return {
    plain: { headline, summary: parts.join(" "), whatItMeans: sm && sm.aqi > 150 ? ["Breathing this air can harm health, especially for children, older people and anyone with asthma."] : [], whatToDo: todo },
    researcher: {
      summary: [
        act ? `${act.detections} VIIRS detections (confidence ≥ nominal, ${act.lowConfidenceDropped} low dropped), ΣFRP ${act.totalFrpMw} MW.` : "FIRMS not configured.",
        wx ? `VPD ${n1(wx.vpdKpa)} kPa, RH ${wx.relativeHumidityPct}%${wx.humidityDrop24hPts != null ? ` (Δ24h ${wx.humidityDrop24hPts > 0 ? "−" : "+"}${Math.abs(wx.humidityDrop24hPts)} pts)` : ""}, wind ${n1(wx.windKmh)} km/h.` : "",
        sm ? `PM2.5 median ${sm.pm25} µg/m³ (US AQI ${sm.aqi}, n = ${sm.stations} stations within 25 km).` : "",
      ].filter(Boolean).join(" "),
      findings: [
        ...(act ? [{ metric: "Active fires", observation: `${act.detections} detections`, value: `${act.totalFrpMw} MW`, confidence: "high" }] : []),
        ...(sm ? [{ metric: "PM2.5", observation: `AQI ${sm.aqi}`, value: `${sm.pm25} µg/m³`, confidence: sm.stations > 1 ? "medium" : "low" }] : []),
      ],
      anomalies: [],
      dataVariables: [
        ...(act ? [{ name: "Active fire detections (24 h)", value: String(act.detections), unit: "count", source: "NASA FIRMS" }] : []),
        ...(wx ? [{ name: "vapour_pressure_deficit", value: String(n1(wx.vpdKpa)), unit: "kPa", source: "Open-Meteo" }] : []),
        ...(sm ? [{ name: "PM2.5 latest", value: String(sm.pm25), unit: "µg/m³", source: "OpenAQ" }] : []),
      ],
      limitations: ["Fire activity is scored in absolute terms; no historical fire baseline yet.", ...(sm && !sm.likelySmoke ? ["PM2.5 without a nearby fire may be traffic, industry or dust rather than smoke."] : [])],
    },
  };
}

// ---------------------------------------------------------------- GLOF (stub)

function glof(region, p) {
  const lakes = p?.referenceLakes || [];
  return {
    riskLevel: null,
    plain: {
      headline: `No live glacial lake data for ${region.name}`,
      summary: lakes.length
        ? `There are known glacial lakes nearby (${lakes.map((l) => l.name).join(", ")}), but Zackscan has no live monitoring of them yet. This is background information only.`
        : "There are no known reference glacial lakes within 300 km. Zackscan has no live glacial lake data yet.",
      whatItMeans: ["This is not a warning. It means no real-time information is available."],
      whatToDo: ["For flood warnings, follow your national disaster authority."],
    },
    researcher: {
      summary: `GLOF pillar is a stub (${p?.label || "Preliminary / Non-Real-Time"}): no free real-time glacial lake feed is wired in, so no score is computed.`,
      findings: [],
      anomalies: [],
      dataVariables: lakes.map((l) => ({ name: l.name, value: String(l.distanceKm), unit: "km from centre", source: "Static reference list" })),
      limitations: ["Reference coordinates are approximate.", "No lake area, water level or dam condition data."],
    },
  };
}
