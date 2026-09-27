// NSIDC Sea Ice Index data source.
// Arctic sea ice extent vs 1981–2010 climatological baseline.
//
// Endpoints (no key required):
//   Daily extent:    https://noaadata.apps.nsidc.org/NOAA/G02135/north/daily/data/N_seaice_extent_daily_v3.0.csv
//   Climatology:     https://noaadata.apps.nsidc.org/NOAA/G02135/north/daily/data/N_seaice_extent_climatology_1981-2010_v3.0.csv

import { getText, SourceError } from "./http.js";

const SOURCE = "NSIDC";

const EXTENT_URL =
  "https://noaadata.apps.nsidc.org/NOAA/G02135/north/daily/data/N_seaice_extent_daily_v3.0.csv";

const CLIM_URL =
  "https://noaadata.apps.nsidc.org/NOAA/G02135/north/daily/data/N_seaice_extent_climatology_1981-2010_v3.0.csv";

// Parse the raw extent CSV into row objects.
// Header lines start with '#'. Data lines: Year,Month,Day,Extent,Missing,Source Data
function parseExtentCsv(text) {
  const rows = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(",");
    if (parts.length < 4) continue;
    const year = parseInt(parts[0], 10);
    const month = parseInt(parts[1], 10);
    const day = parseInt(parts[2], 10);
    const extent = parseFloat(parts[3]);
    if (
      !isFinite(year) ||
      !isFinite(month) ||
      !isFinite(day) ||
      !isFinite(extent)
    )
      continue;
    if (extent < 0) continue; // sentinel for missing data
    rows.push({ year, month, day, extentMkm2: extent });
  }
  return rows;
}

// Parse the climatology CSV defensively.
// Expected columns (may vary): Month, Day, Mean, Std (and possibly others)
// Also computes std from daily history when std column is missing or zero.
function parseClimatologyCsv(text, extentRows = []) {
  const lines = text.split("\n");

  // Find the header line (non-comment, non-empty).
  let headerIdx = -1;
  let headerCols = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l || l.startsWith("#")) continue;
    headerCols = l
      .toLowerCase()
      .split(",")
      .map((c) => c.trim());
    headerIdx = i;
    break;
  }

  // Locate column indices by name heuristics.
  const colIdx = (names) => {
    for (const n of names) {
      const i = headerCols.findIndex((c) => c.includes(n));
      if (i >= 0) return i;
    }
    return -1;
  };

  const iMonth = colIdx(["month", "mo"]);
  const iDay = colIdx(["day"]);
  const iMean = colIdx(["mean", "avg", "average"]);
  const iStd = colIdx(["std", "stdev", "sd"]);

  // If we can't identify month/day/mean columns, bail and compute from extent rows.
  const canParse = iMonth >= 0 && iDay >= 0 && iMean >= 0;

  const rows = [];

  if (canParse) {
    for (let i = headerIdx + 1; i < lines.length; i++) {
      const l = lines[i].trim();
      if (!l || l.startsWith("#")) continue;
      const parts = l.split(",");
      const month = parseInt(parts[iMonth], 10);
      const day = parseInt(parts[iDay], 10);
      const mean = parseFloat(parts[iMean]);
      const std = iStd >= 0 ? parseFloat(parts[iStd]) : NaN;
      if (!isFinite(month) || !isFinite(day) || !isFinite(mean)) continue;
      rows.push({
        month,
        day,
        mean,
        std: isFinite(std) && std > 0 ? std : null,
      });
    }
  }

  // Fill missing std values (or build the whole climatology) from daily extent history.
  // Use the 1981–2010 window.
  if (rows.length === 0 || rows.some((r) => r.std == null)) {
    const byKey = new Map(); // "M-D" → [extents]
    for (const r of extentRows) {
      if (r.year < 1981 || r.year > 2010) continue;
      const key = `${r.month}-${r.day}`;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(r.extentMkm2);
    }

    if (rows.length === 0) {
      // Build from scratch using extent history for mean too.
      for (const [key, vals] of byKey.entries()) {
        const [m, d] = key.split("-").map(Number);
        const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
        const variance =
          vals.reduce((a, v) => a + (v - mean) ** 2, 0) / vals.length;
        rows.push({ month: m, day: d, mean, std: Math.sqrt(variance) });
      }
    } else {
      // Patch missing std values.
      for (const r of rows) {
        if (r.std != null) continue;
        const vals = byKey.get(`${r.month}-${r.day}`) || [];
        if (vals.length > 1) {
          const m = r.mean;
          const variance =
            vals.reduce((a, v) => a + (v - m) ** 2, 0) / vals.length;
          r.std = Math.sqrt(variance);
        } else {
          r.std = 0.5; // sensible fallback (roughly 1 Mkm² range)
        }
      }
    }
  }

  return rows;
}

export async function fetchSeaIceExtent({ fetch: fetchImpl = fetch } = {}) {
  const text = await getText(SOURCE, EXTENT_URL, { fetch: fetchImpl });
  const rows = parseExtentCsv(text);
  if (rows.length === 0)
    throw new SourceError(SOURCE, "no extent rows parsed", {
      code: "bad_response",
    });
  return rows;
}

export async function fetchClimatology({
  fetch: fetchImpl = fetch,
  extentRows = [],
} = {}) {
  const text = await getText(SOURCE, CLIM_URL, { fetch: fetchImpl });
  const rows = parseClimatologyCsv(text, extentRows);
  if (rows.length === 0)
    throw new SourceError(SOURCE, "no climatology rows parsed", {
      code: "bad_response",
    });
  return rows;
}

export function seaIceSummary(extentRows, climatologyRows) {
  if (!extentRows || extentRows.length === 0) return null;

  // Most recent valid row.
  const latest = extentRows[extentRows.length - 1];
  const { year, month, day, extentMkm2 } = latest;

  const pad = (n) => String(n).padStart(2, "0");
  const date = `${year}-${pad(month)}-${pad(day)}`;

  // Find matching climatology entry.
  const clim = climatologyRows?.find((r) => r.month === month && r.day === day);
  if (!clim) {
    return { date, extentMkm2, dataYear: year };
  }

  const baselineMkm2 = clim.mean;
  const anomalyMkm2 = extentMkm2 - baselineMkm2;
  const anomalyPct = (anomalyMkm2 / baselineMkm2) * 100;
  const std = clim.std && clim.std > 0 ? clim.std : null;
  const z = std != null ? anomalyMkm2 / std : null;

  return {
    date,
    extentMkm2,
    baselineMkm2,
    anomalyMkm2,
    anomalyPct,
    z,
    dataYear: year,
  };
}
