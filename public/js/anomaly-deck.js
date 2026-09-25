// The "Top anomalies" deck: highest-scoring region × hazard pairs first,
// as Anomaly Cards. GLOF reference cards (stub, never scored) go last and
// are always labelled Preliminary / Non-Real-Time.

import { createAnomalyCard } from "./anomaly-card.js";

const LIVE = ["heat", "wildfire", "seismic"];
const TOP = 6;
let showAll = false;

export function pickAnomalies(matrix) {
  const live = [];
  const stubs = [];
  for (const r of matrix?.regions || []) {
    if (!r.pillars) continue;
    for (const k of LIVE) if (r.pillars[k]?.score != null) live.push({ region: r, key: k, pillar: r.pillars[k] });
    if (r.pillars.glof?.referenceLakes?.length) stubs.push({ region: r, key: "glof", pillar: r.pillars.glof });
  }
  live.sort((a, b) => b.pillar.score - a.pillar.score);
  return { live, stubs };
}

/**
 * @param full  optional map regionId -> full region data fetched on demand (data saver)
 */
export function renderAnomalies(container, matrix, source, { full = {}, onNeedFull } = {}) {
  const merged = { ...matrix, regions: (matrix?.regions || []).map((r) => full[r.id] || r) };
  const { live, stubs } = pickAnomalies(merged);
  for (const old of container.querySelectorAll(".anomaly-card")) old.__destroy?.();
  const shown = showAll ? live : live.slice(0, TOP);
  const cards = [...shown, ...(showAll || live.length <= TOP ? stubs : stubs.slice(0, 1))].map((a) =>
    createAnomalyCard({ region: a.region, key: a.key, pillar: a.pillar, source, onNeedFull }),
  );
  container.replaceChildren(...cards);
  if (!cards.length) {
    const p = document.createElement("p");
    p.className = "viz-empty";
    p.textContent = "No readings yet. They'll appear here within a few minutes.";
    container.append(p);
  }
  if (live.length > TOP) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "show-all";
    more.textContent = showAll ? "Show top anomalies only" : `Show all ${live.length} readings`;
    more.addEventListener("click", () => {
      showAll = !showAll;
      renderAnomalies(container, matrix, source, { full, onNeedFull });
    });
    container.append(more);
  }
}
