// Risk matrix panel: one row per watchlist region, one chip per pillar.
// Tap a region for the components behind each score.

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const ORDER = ["seismic", "wildfire", "heat", "glof"];
const SHORT = { seismic: "Seismic", wildfire: "Fire & smoke", heat: "Heat", glof: "GLOF" };
const REFRESH_MS = 5 * 60_000;

function chip(key, p) {
  if (key === "glof")
    return `<span class="chip chip-stub" title="${esc(p.label)}">${SHORT.glof}<b>—</b><small>${esc(p.label)}</small></span>`;
  const flag = { stale: " (stale)", partial: " (partial)", error: " (no data)" }[p.status] || "";
  return `<span class="chip lvl-${esc(p.level)}">${SHORT[key]}<b>${p.score ?? "—"}</b><small>${esc(p.level)}${flag}</small></span>`;
}

function details(r) {
  const p = r.pillars;
  const s = p.seismic.components, h = p.heat.components, w = p.wildfire.components;
  const line = (label, text) => (text ? `<li><b>${label}:</b> ${text}</li>` : "");
  const notes = ORDER.flatMap((k) => (p[k].notes || []).map((n) => `<li class="note">${esc(SHORT[k])}: ${esc(n)}</li>`)).join("");
  return `<ul class="risk-detail">
    ${line("Seismic", s && `${p.seismic.detail.eventsLast7Days} quakes ≥M${p.seismic.detail.minMagnitude} this week vs ~${p.seismic.detail.baselineEventsPerYear}/yr normally` +
      (p.seismic.detail.largest ? `; largest M${esc(p.seismic.detail.largest.mag)} ${esc(p.seismic.detail.largest.place)}` : ""))}
    ${line("Heat", h?.severity && `peak wet-bulb ${h.severity.peakWetBulbC} °C in the next 48 h` +
      (h.anomaly ? `; ${h.anomaly.zScore > 0 ? "+" : ""}${h.anomaly.zScore}σ vs the 10-year normal (${h.anomaly.baselineMeanC} ± ${h.anomaly.baselineStdC} °C)` : ""))}
    ${line("Fire weather", w?.fireWeather && `VPD ${w.fireWeather.vpdKpa} kPa, humidity ${w.fireWeather.relativeHumidityPct}%` +
      (w.fireWeather.humidityDrop24hPts != null ? ` (${w.fireWeather.humidityDrop24hPts >= 0 ? "down" : "up"} ${Math.abs(w.fireWeather.humidityDrop24hPts)} pts in 24 h)` : ""))}
    ${line("Active fires", w?.activity && `${w.activity.detections} satellite detections in the last 24 h`)}
    ${line("PM2.5", w?.smoke && `${w.smoke.pm25} µg/m³ (AQI ${w.smoke.aqi}) from ${w.smoke.stations} station(s)`)}
    ${line("GLOF", `${esc(p.glof.label)}. ` + (p.glof.referenceLakes.length ? "Reference lakes: " + p.glof.referenceLakes.map((l) => `${esc(l.name)} (${l.distanceKm} km)`).join(", ") : "No reference lakes nearby."))}
    ${notes}
  </ul>`;
}

function row(r) {
  if (r.pending) return `<li class="risk-row"><div class="risk-head"><span>${esc(r.name)}</span><small>Loading… check back in a minute.</small></div></li>`;
  const age = r.ageSeconds != null ? Math.round(r.ageSeconds / 60) : null;
  return `<li class="risk-row"><details>
    <summary class="risk-head">
      <span>${esc(r.name)}</span>
      <span class="chip lvl-${esc(r.overall.level)} overall">Overall<b>${r.overall.score ?? "—"}</b><small>${esc(r.overall.level)}</small></span>
    </summary>
    <div class="chips">${ORDER.map((k) => chip(k, r.pillars[k])).join("")}</div>
    <small class="meta">Updated ${age == null ? "?" : age < 1 ? "just now" : age + " min ago"}${r.outdated ? " · refreshing" : ""}</small>
    ${details(r)}
  </details></li>`;
}

export function startRiskPanel(el) {
  let timer;
  async function load() {
    try {
      const res = await fetch("/api/risk", { credentials: "same-origin" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const m = await res.json();
      el.innerHTML = m.regions.map(row).join("");
      // Regions still computing: look again soon.
      clearTimeout(timer);
      timer = setTimeout(load, m.regions.some((r) => r.pending || r.outdated) ? 20_000 : REFRESH_MS);
    } catch (e) {
      el.innerHTML = `<li class="err">Couldn't load the risk matrix (${esc(e.message)}).</li>`;
      timer = setTimeout(load, 60_000);
    }
  }
  load();
}
