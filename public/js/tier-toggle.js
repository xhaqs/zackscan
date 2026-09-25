// Dual-view assessment: "Plain language" and "Researcher" versions of the
// same AI assessment. Both arrive in one response (and are stored together
// offline), so switching is instant and never makes a network call.
//
// The chosen view is remembered as the user's preferred tier and shared with
// the Settings dialog, so every open view follows it.

const PREF = "zackscan.tier";
export const TIER_LABELS = { plain: "Plain language", researcher: "Researcher" };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function preferredTier() {
  try {
    return localStorage.getItem(PREF) === "researcher" ? "researcher" : "plain";
  } catch {
    return "plain";
  }
}

export function setPreferredTier(tier) {
  if (!(tier in TIER_LABELS)) return;
  try {
    localStorage.setItem(PREF, tier);
  } catch {}
  dispatchEvent(new CustomEvent("zackscan:tier", { detail: tier }));
}

/** True for results from the two-tier pipeline (older saved results aren't). */
export const isTiered = (r) => !!(r?.assessment?.plain && r?.assessment?.researcher);

function list(items) {
  return items?.length ? `<ul>${items.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : "";
}

function table(caption, cols, rows) {
  if (!rows?.length) return "";
  return `<div class="table-wrap"><table>
    <caption>${esc(caption)}</caption>
    <thead><tr>${cols.map(([, h]) => `<th scope="col">${esc(h)}</th>`).join("")}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${cols.map(([k]) => `<td>${esc(r[k])}</td>`).join("")}</tr>`).join("")}</tbody>
  </table></div>`;
}

function plainPanel(p) {
  return `<h3 class="tier-headline">${esc(p.headline)}</h3>
    <p>${esc(p.summary)}</p>
    ${p.whatItMeans.length ? `<h4>What it means</h4>${list(p.whatItMeans)}` : ""}
    ${p.whatToDo.length ? `<h4>What to do</h4>${list(p.whatToDo)}` : ""}`;
}

function researcherPanel(r) {
  return `<p>${esc(r.summary)}</p>
    ${table("Findings", [["metric", "Metric"], ["observation", "Observation"], ["value", "Value"], ["confidence", "Confidence"]], r.findings)}
    ${table("Anomalies against baseline", [["variable", "Variable"], ["observed", "Observed"], ["baseline", "Baseline"], ["deviation", "Deviation"]], r.anomalies)}
    ${table("Data variables used", [["name", "Variable"], ["value", "Value"], ["unit", "Unit"], ["source", "Source"]], r.dataVariables)}
    ${r.limitations.length ? `<h4>Limitations</h4>${list(r.limitations)}` : ""}`;
}

/**
 * Render a two-tier result into `container`.
 * @param result  API result ({assessment:{riskLevel, plain, researcher}, model, billing, ...})
 * @param note    optional HTML-safe notice shown above (e.g. saved/offline, unchanged)
 */
export function renderTieredAssessment(container, result, { note = "" } = {}) {
  const a = result.assessment;
  const id = "t" + Math.random().toString(36).slice(2, 8);
  container.innerHTML = `
    ${note}
    <p class="risk risk-${esc(a.riskLevel)}">Risk: ${esc(a.riskLevel)}</p>
    <div class="tier-toggle" role="group" aria-label="Explanation style">
      ${Object.entries(TIER_LABELS).map(([t, label]) => `<button type="button" data-tier="${t}" aria-controls="${id}-${t}">${label}</button>`).join("")}
    </div>
    <div class="tier-panel" id="${id}-plain" data-tier="plain">${plainPanel(a.plain)}</div>
    <div class="tier-panel" id="${id}-researcher" data-tier="researcher">${researcherPanel(a.researcher)}</div>
    <p class="meta">${result.billing === "byok" ? "Your key" : "Shared tier" + (result.allowance ? ` (${result.allowance.used}/${result.allowance.max} today)` : "")} · ${esc(result.model)} · ${esc(result.eventCount)} events${result.generatedAt ? " · generated " + esc(new Date(result.generatedAt).toLocaleString()) : ""}</p>`;

  const show = (tier) => {
    for (const b of container.querySelectorAll(".tier-toggle button")) b.setAttribute("aria-pressed", String(b.dataset.tier === tier));
    for (const p of container.querySelectorAll(".tier-panel")) p.hidden = p.dataset.tier !== tier;
  };
  container.querySelector(".tier-toggle").addEventListener("click", (ev) => {
    const b = ev.target.closest("button[data-tier]");
    if (b) setPreferredTier(b.dataset.tier); // the event below does the switching, here and in any other open view
  });
  // One listener per container, replaced on re-render (no leak).
  container.__tierOff?.();
  const onPref = (ev) => show(ev.detail);
  addEventListener("zackscan:tier", onPref);
  container.__tierOff = () => removeEventListener("zackscan:tier", onPref);
  show(preferredTier());
}
