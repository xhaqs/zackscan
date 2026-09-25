// Turns raw hazard data into 0-100 Anomaly Risk Scores. Pure functions.
//
// Every pillar blends two ideas and reports both:
//   anomaly  - how unusual this is for THIS place (vs. its own history)
//   severity - how dangerous it is in absolute terms
// The pillar score is the larger of the two, so a routine-but-deadly
// condition (Dubai's summer heat) and a mild-but-freakish one (a swarm in a
// quiet region) both come through.

import { clamp, piecewise, poissonUpperTail, surpriseScore, wetBulbStull, meanStd, median, aqiFromPm25 } from "./math.js";
import { isConfident } from "./sources/firms.js";

const DAY_MS = 86_400_000;
const r1 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10) / 10);

// ---------------------------------------------------------------- seismic

export const SEISMIC_WINDOWS_DAYS = [1, 7];
// Absolute danger from the largest recent quake.
const QUAKE_SEVERITY = [[4.0, 0], [4.5, 10], [5.0, 25], [6.0, 55], [7.0, 80], [7.5, 100]];

/**
 * @param events   quakes >= minMag in the last 7 days
 * @param baseline {count, days} historical count at the same threshold
 */
export function scoreSeismic({ events, baseline, minMag, now = Date.now() }) {
  // Half an event as a floor, so a region with an empty history doesn't make
  // a single quake look infinitely unlikely.
  const ratePerDay = Math.max(baseline.count, 0.5) / baseline.days;

  const windows = SEISMIC_WINDOWS_DAYS.map((w) => {
    const observed = events.filter((e) => now - e.time <= w * DAY_MS).length;
    const expected = ratePerDay * w;
    const p = poissonUpperTail(observed, expected);
    return { windowDays: w, observed, expected: Math.round(expected * 1000) / 1000, pValue: p, score: Math.round(surpriseScore(p)) };
  });
  // Most surprising window wins; when equally unremarkable, show the longer one.
  const clustering = windows.reduce((a, b) => (b.pValue < a.pValue || (b.pValue === a.pValue && b.windowDays > a.windowDays) ? b : a));

  // Magnitude anomaly: Gutenberg-Richter with b = 1, i.e. each extra unit of
  // magnitude is 10x rarer. How likely is at least one quake this big in 7 days?
  const maxMag = events.length ? Math.max(...events.map((e) => e.mag)) : null;
  let magnitudeAnomaly = { score: 0, maxMagnitude: null, pValue: 1 };
  if (maxMag != null) {
    const rate = ratePerDay * 7 * 10 ** -(maxMag - minMag);
    const p = 1 - Math.exp(-rate);
    magnitudeAnomaly = { score: Math.round(surpriseScore(p)), maxMagnitude: maxMag, pValue: p };
  }
  const severity = { score: maxMag == null ? 0 : Math.round(piecewise(maxMag, QUAKE_SEVERITY)), maxMagnitude: maxMag };

  return {
    score: Math.max(clustering.score, magnitudeAnomaly.score, severity.score),
    components: {
      clustering: { ...clustering, windows },
      magnitudeAnomaly,
      severity,
    },
    detail: {
      minMagnitude: minMag,
      eventsLast7Days: events.length,
      baselineEventsPerYear: r1(ratePerDay * 365.25),
      baselineYears: baseline.years,
      largest: events.length ? pick(events.reduce((a, b) => (b.mag > a.mag ? b : a)), ["mag", "place", "time", "depthKm"]) : null,
    },
  };
}

// ---------------------------------------------------------------- wildfire

const VPD_SCORE = [[0.5, 0], [1.5, 30], [2.5, 60], [3.5, 85], [4.5, 100]]; // kPa
const RH_SCORE = [[8, 100], [15, 80], [30, 40], [60, 0]]; // %
const WIND_FACTOR = [[0, 0.8], [20, 1.0], [40, 1.2]]; // km/h

/**
 * @param detections FIRMS detections, or null if FIRMS isn't configured
 * @param weather    {vpdKpa, rh, rh24hAgo, windKmh}, or null
 * @param pm25       array of PM2.5 readings (µg/m³), or null if OpenAQ isn't configured
 */
export function scoreWildfire({ detections, weather, pm25 }) {
  const notes = [];

  let activity = null;
  if (detections) {
    const confident = detections.filter(isConfident);
    const frp = confident.reduce((s, d) => s + (d.frpMw || 0), 0);
    // Log scales: 10 detections -> 26, 100 -> 50, 1000 -> 75; FRP 1 GW -> 40, 10 GW -> 60.
    const score = Math.round(clamp(Math.max(25 * Math.log10(1 + confident.length), 20 * Math.log10(1 + frp / 10))));
    activity = { score, detections: confident.length, lowConfidenceDropped: detections.length - confident.length, totalFrpMw: Math.round(frp) };
  } else notes.push("Active-fire detection is off: add a NASA FIRMS MAP_KEY.");

  let fireWeather = null;
  if (weather) {
    const drop = weather.rh24hAgo != null ? weather.rh24hAgo - weather.rh : null;
    const base = Math.max(piecewise(weather.vpdKpa, VPD_SCORE), piecewise(weather.rh, RH_SCORE));
    const score = Math.round(clamp(base * piecewise(weather.windKmh, WIND_FACTOR) + (drop != null && drop >= 20 ? 15 : 0)));
    fireWeather = { score, vpdKpa: weather.vpdKpa, relativeHumidityPct: weather.rh, humidityDrop24hPts: drop, windKmh: weather.windKmh };
  }

  // Fire score: detected fire, pushed up by bad fire weather. With no fire
  // detected (or no FIRMS key), weather alone is only potential: capped at 40.
  let fireScore = 0;
  if (activity && activity.detections > 0)
    fireScore = activity.score + 0.4 * Math.max(0, (fireWeather?.score ?? 0) - activity.score);
  else if (fireWeather) {
    fireScore = 0.4 * fireWeather.score;
    if (fireWeather.score >= 50) notes.push("Fire weather only: dry air raises ignition risk where there's fuel, but no fire is detected here.");
  }

  let smoke = null;
  if (pm25) {
    const pm = median(pm25.map((r) => r.value));
    if (pm == null) notes.push("No recent PM2.5 readings from stations within 25 km.");
    else {
      const aqi = aqiFromPm25(pm);
      // PM2.5 isn't only smoke (traffic, industry, dust). Without a nearby
      // fire it counts at half weight.
      const nearbyFire = !!(activity && activity.detections > 0);
      smoke = { score: Math.round(clamp(aqi / 3)), pm25: r1(pm), aqi, stations: pm25.length, likelySmoke: nearbyFire, weight: nearbyFire ? 1 : 0.5 };
    }
  } else notes.push("Smoke (PM2.5) is off: add an OpenAQ API key.");

  const inputs = [activity, fireWeather, smoke].filter(Boolean).length;
  if (!inputs) return { score: null, components: { activity, fireWeather, smoke }, notes };
  return {
    score: Math.round(clamp(Math.max(fireScore, smoke ? smoke.score * smoke.weight : 0))),
    components: { activity, fireWeather, smoke },
    notes,
    partial: !activity || !smoke,
  };
}

// ---------------------------------------------------------------- heat

// Wet-bulb 35 °C is the theoretical limit of human survival; around 31 °C
// sustained activity becomes dangerous even for healthy adults.
const WETBULB_SEVERITY = [[24, 0], [26, 20], [28, 45], [31, 75], [33, 90], [35, 100]];

/** Day-of-year distance with wrap-around, from "YYYY-MM-DD" strings. */
function doy(date) {
  const d = new Date(date + "T00:00:00Z");
  return Math.floor((d - Date.UTC(d.getUTCFullYear(), 0, 1)) / DAY_MS);
}
const doyGap = (a, b) => Math.min(Math.abs(a - b), 365 - Math.abs(a - b));

/**
 * Baseline: daily max wet-bulb, approximated as Stull(Tmax, RHmin), for
 * every day in the archive, kept as [dayOfYear, Tw] pairs. The window is
 * picked at scoring time, so a week-old baseline still centres on today.
 */
export function heatBaselineFromArchive(rows) {
  return rows.map((r) => [doy(r.date), r1(wetBulbStull(r.tmaxC, r.rhMinPct))]);
}

export function scoreHeat({ hourlyAhead, daily, baseline, windowDays = 7 }) {
  // Severity: true hourly peak wet-bulb over the next 48 h.
  const hourly = hourlyAhead.filter((h) => Number.isFinite(h.tempC) && Number.isFinite(h.rh));
  const peak = hourly.reduce((best, h) => {
    const tw = wetBulbStull(h.tempC, h.rh);
    return !best || tw > best.tw ? { tw, time: h.time, tempC: h.tempC, rh: h.rh } : best;
  }, null);
  const severity = peak
    ? { score: Math.round(piecewise(peak.tw, WETBULB_SEVERITY)), peakWetBulbC: r1(peak.tw), at: peak.time, tempC: peak.tempC, relativeHumidityPct: peak.rh }
    : null;

  // Anomaly: compare like with like. Today's and tomorrow's Stull(Tmax, RHmin)
  // against the same measure on the same calendar days in past years.
  let anomaly = null;
  const days = daily.filter((d) => Number.isFinite(d.tmaxC) && Number.isFinite(d.rhMinPct));
  if (baseline?.length && days.length) {
    const hottest = days.reduce((a, b) => (wetBulbStull(b.tmaxC, b.rhMinPct) > wetBulbStull(a.tmaxC, a.rhMinPct) ? b : a));
    const target = doy(hottest.date);
    const { mean, std, n } = meanStd(baseline.filter(([d]) => doyGap(d, target) <= windowDays).map(([, tw]) => tw));
    const tw = wetBulbStull(hottest.tmaxC, hottest.rhMinPct);
    if (n >= 20 && std > 0) {
      const z = (tw - mean) / std;
      anomaly = { score: Math.round(clamp(25 * z)), zScore: r1(z), dailyWetBulbC: r1(tw), date: hottest.date, baselineMeanC: r1(mean), baselineStdC: r1(std), baselineDays: n };
    }
  }

  if (!severity && !anomaly) return { score: null, components: { severity, anomaly } };
  return {
    score: Math.max(severity?.score ?? 0, anomaly?.score ?? 0),
    components: { severity, anomaly },
    method:
      "Wet-bulb by Stull (2011). Severity uses the hourly peak over the next 48 h. The anomaly compares daily Stull(Tmax, RHmin) with the same calendar window (±7 days) over the past 10 years.",
  };
}

function pick(o, keys) {
  return Object.fromEntries(keys.map((k) => [k, o[k]]));
}
