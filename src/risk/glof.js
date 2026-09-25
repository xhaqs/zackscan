// GLOF (glacial lake outburst flood) pillar: STUB, NOT REAL-TIME.
//
// No free API gives reliable real-time glacial lake monitoring. This pillar
// has the full schema so a live source can be wired in later, but for now it
// returns static reference data only and NEVER a score. Everything it emits
// is labelled "Preliminary / Non-Real-Time".
//
// To make it live later, replace referenceLakesNear() with a source that
// provides per-lake readings, and compute `score` from them (see the
// GlofReading shape below). Keep `realtime:false` until then.

import { distanceKm } from "./math.js";

export const GLOF_LABEL = "Preliminary / Non-Real-Time";

/**
 * Reference only: well-known hazardous glacial lakes. Coordinates are
 * approximate. No areas, volumes or hazard levels are given, because those
 * need a cited, dated source and none is wired in yet.
 */
const REFERENCE_LAKES = Object.freeze([
  { id: "tsho-rolpa", name: "Tsho Rolpa", country: "Nepal", lat: 27.86, lon: 86.47, note: "One of Nepal's most studied potentially dangerous glacial lakes." },
  { id: "imja-tsho", name: "Imja Tsho", country: "Nepal", lat: 27.9, lon: 86.92, note: "Everest region; lowered by engineering works in 2016." },
  { id: "south-lhonak", name: "South Lhonak", country: "India (Sikkim)", lat: 27.91, lon: 88.2, note: "Outburst in October 2023 caused the Teesta valley flood." },
  { id: "palcacocha", name: "Palcacocha", country: "Peru", lat: -9.39, lon: -77.38, note: "Its 1941 outburst devastated Huaraz." },
]);

/**
 * Future live shape (not produced yet):
 * GlofReading = { lakeId, observedAt, areaKm2, areaChangePct30d, waterLevelM,
 *                 damCondition, upstreamTempAnomalyC, source }
 */

export function glofPillar(region, { radiusKm = 300 } = {}) {
  const lakes = REFERENCE_LAKES.map((l) => ({ ...l, distanceKm: Math.round(distanceKm(region.lat, region.lon, l.lat, l.lon)) }))
    .filter((l) => l.distanceKm <= radiusKm)
    .sort((a, b) => a.distanceKm - b.distanceKm);
  return {
    score: null,
    level: "unknown",
    status: "stub",
    realtime: false,
    label: GLOF_LABEL,
    asOf: null,
    referenceLakes: lakes,
    notes: [
      "Stub for the MVP: no free real-time glacial lake feed is wired in, so there is no score.",
      lakes.length ? "Nearby reference lakes are listed for context only." : "No reference lakes within 300 km.",
    ],
    sources: [],
  };
}
