// Arctic sea ice anomaly card — renders data from /api/seaice.
// Follows the same wx-row / wx-swatch / wx-label / wx-value / wx-anom / wx-normal
// pattern as weather-widget.js so no new CSS is needed.

import { divergingColor } from "./charts.js";

const SECTION_ID = "sea-ice";

function fmtMkm2(v) {
  return v == null ? "n/a" : v.toFixed(2);
}

function fmtPct(v) {
  if (v == null) return "";
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toFixed(1)}%`;
}

function fmtAnom(mkm2) {
  if (mkm2 == null) return "";
  const sign = mkm2 > 0 ? "+" : "";
  return `${sign}${mkm2.toFixed(2)} Mkm²`;
}

function fmtZ(z) {
  if (z == null) return "";
  const sign = z > 0 ? "+" : "";
  return ` (${sign}${z.toFixed(1)}σ)`;
}

/**
 * Build the wx-rows element for one sea-ice summary object.
 * @param {object} north  — the `north` field from /api/seaice
 * @returns {HTMLElement}
 */
function buildRows(north) {
  const rows = document.createElement("div");
  rows.className = "wx-rows";

  const items = [
    {
      label: "Extent",
      value: fmtMkm2(north.extentMkm2),
      unit: "Mkm²",
      anomText:
        north.anomalyMkm2 != null
          ? `${fmtAnom(north.anomalyMkm2)}${fmtZ(north.z)} vs 1981–2010`
          : "",
      normalText:
        north.baselineMkm2 != null
          ? `normal ${fmtMkm2(north.baselineMkm2)} Mkm²`
          : "",
      z: north.z,
    },
    north.anomalyPct != null && {
      label: "Anomaly",
      value: fmtPct(north.anomalyPct),
      unit: "",
      anomText: fmtAnom(north.anomalyMkm2),
      normalText: "",
      z: north.z,
    },
  ].filter(Boolean);

  for (const row of items) {
    const item = document.createElement("div");
    item.className = "wx-row";

    const sw = document.createElement("i");
    sw.className = "wx-swatch";
    sw.style.background = divergingColor(row.z);
    sw.setAttribute("aria-hidden", "true");

    const label = document.createElement("span");
    label.className = "wx-label";
    label.textContent = row.label;

    const value = document.createElement("b");
    value.className = "wx-value";
    value.textContent =
      row.value == null
        ? "n/a"
        : `${row.value}${row.unit ? " " + row.unit : ""}`;

    const anomaly = document.createElement("span");
    anomaly.className = "wx-anom";
    anomaly.textContent = row.anomText;

    const normal = document.createElement("span");
    normal.className = "wx-normal";
    normal.textContent = row.normalText;

    item.append(sw, label, value, anomaly, normal);
    rows.append(item);
  }

  return rows;
}

/**
 * Fetch /api/seaice and render the card into #sea-ice.
 * Called once from app.js on page load.
 */
export async function fetchAndRenderSeaIce() {
  const section = document.getElementById(SECTION_ID);
  if (!section) return;

  const container = section.querySelector(".sea-ice-body");
  if (!container) return;

  try {
    const res = await fetch("/api/seaice");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    if (data.error) {
      container.innerHTML = `<p class="meta">${data.error}</p>`;
      return;
    }

    const north = data.north;
    if (!north) {
      container.innerHTML = `<p class="meta">No sea ice data available.</p>`;
      return;
    }

    container.replaceChildren();

    // Rows
    container.append(buildRows(north));

    // Footer: date + cached flag
    const meta = document.createElement("p");
    meta.className = "meta";
    const dateStr = north.date || "";
    const cacheNote = data.cached ? " · cached" : "";
    meta.textContent = `As of ${dateStr}${cacheNote} · Source: NSIDC Sea Ice Index v3`;
    container.append(meta);
  } catch (e) {
    container.innerHTML = `<p class="meta">Sea ice data couldn't be loaded right now.</p>`;
  }
}
