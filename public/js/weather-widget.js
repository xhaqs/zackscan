// Daily weather widget: today's high, humidity and wind for one region, each
// against the seasonal normal ("36.3 °C: −0.8σ below seasonal average").
// Reads the `weather` block the Worker attaches to every region in
// /api/risk. It shares the heat pillar's forecast and archive data, so it
// makes no API calls of its own.

import { divergingColor } from "./charts.js";
import { ageLabel } from "./offline-logic.js";
import { REGION_LIST } from "./regions.js";

// Signed with a real minus sign: +1.4σ / −0.8σ / 0σ.
const sig = (z) => `${z > 0 ? "+" : z < 0 ? "−" : ""}${Math.abs(z)}σ`;

const MEASURES = [
  { key: "tmax", field: "tmaxC", label: "High", unit: "°C", words: ["cooler", "hotter"] },
  { key: "rhMean", field: "rhMeanPct", label: "Humidity (daily mean)", unit: "%", words: ["drier", "more humid"] },
  { key: "windMax", field: "windMaxKmh", label: "Wind (daily max)", unit: "km/h", words: ["calmer", "windier"] },
];

/**
 * The "weather telemetry hook": everything the widget shows for a region,
 * derived from a risk matrix. Pure, so it's testable.
 */
export function weatherTelemetry(matrix, regionId, now = Date.now()) {
  const r = matrix?.regions?.find((x) => x.id === regionId);
  const w = r?.weather;
  if (!w?.today) return { region: r || { id: regionId }, ready: false };
  const year = new Date(now).getUTCFullYear();
  return {
    region: r,
    ready: true,
    asOf: w.asOf,
    current: w.current,
    rows: MEASURES.map((m) => {
      const v = w.today[m.field];
      const n = w.normals?.[m.key] || {};
      let text = "no seasonal comparison yet";
      if (n.z != null)
        text =
          Math.abs(n.z) < 0.5
            ? `${sig(n.z)}, about the seasonal average`
            : `${sig(n.z)} ${n.z > 0 ? "above" : "below"} seasonal average (${m.words[n.z > 0 ? 1 : 0]})`;
      return { ...m, value: v, z: n.z ?? null, mean: n.mean ?? null, std: n.std ?? null, text };
    }),
    baselineLabel: w.baselineYears ? `Seasonal average: the same dates (${w.window}) in ${year - 10}–${year - 1}, from ERA5 via Open-Meteo.` : "The 10-year seasonal average is still being built.",
  };
}

export function renderWeather(el, t, { onRegion } = {}) {
  el.replaceChildren();
  const head = document.createElement("div");
  head.className = "wx-head";
  const pick = document.createElement("select");
  pick.setAttribute("aria-label", "Weather location");
  for (const r of REGION_LIST) pick.add(new Option(r.name, r.id, false, r.id === t.region.id));
  pick.addEventListener("change", () => onRegion?.(pick.value));
  head.append(pick);
  el.append(head);
  if (!t.ready) {
    const p = document.createElement("p");
    p.className = "meta";
    p.textContent = "Today's weather for this place isn't available yet. It appears with the next data refresh.";
    el.append(p);
    return;
  }
  const list = document.createElement("div");
  list.className = "wx-rows";
  for (const row of t.rows) {
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
    value.textContent = row.value == null ? "n/a" : `${row.value} ${row.unit}`;
    const anomaly = document.createElement("span");
    anomaly.className = "wx-anom";
    anomaly.textContent = row.text;
    const normal = document.createElement("span");
    normal.className = "wx-normal";
    normal.textContent = row.mean != null ? `normal ${row.mean}${row.std != null ? ` ± ${row.std}` : ""} ${row.unit}` : "";
    item.append(sw, label, value, anomaly, normal);
    list.append(item);
  }
  el.append(list);
  const now = document.createElement("p");
  now.className = "wx-now";
  const c = t.current;
  now.textContent = c ? `Now ${c.tempC} °C · ${c.rh}% humidity · wind ${Math.round(c.windKmh)} km/h · updated ${ageLabel(Date.parse(t.asOf))}` : "";
  const note = document.createElement("p");
  note.className = "meta";
  note.textContent = t.baselineLabel;
  el.append(now, note);
}
