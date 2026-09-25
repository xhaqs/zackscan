// Full-screen map sheet for an anomaly card:
//   openDispersion(region)  CAMS PM2.5 / dust forecast, 48 h, animated
//   openHeatGrid(region)    heat anomaly (±σ) around the region
// Both load on demand, are cached by the server, and are saved on the
// device so the last map still opens offline (labelled with its age).

import { gridMap, legend } from "./grid-map.js";
import { WARM, MID, divergingColor } from "./charts.js";
import { saveSnapshot, loadSnapshot } from "./offline-store.js";
import { ageLabel } from "./offline-logic.js";

const VARS = {
  pm2_5: {
    label: "PM2.5",
    unit: "µg/m³",
    // US EPA (2024) PM2.5 AQI categories, one step of the sequential ramp each.
    bins: [9, 35.5, 55.5, 125.5],
    names: ["Good (≤9)", "Moderate (9–35)", "Sensitive groups (35–55)", "Unhealthy (55–125)", "Very unhealthy (125+)"],
  },
  dust: { label: "Dust", unit: "µg/m³", bins: [20, 50, 100, 250], names: ["<20", "20–50", "50–100", "100–250", "250+"] },
};
const binColor = (v, bins) => (v == null ? MID : WARM[bins.filter((b) => v >= b).length]);
const compass = (dLat, dLon) => {
  if (Math.abs(dLat) < 0.05 && Math.abs(dLon) < 0.05) return "at the centre";
  const a = (Math.atan2(dLon, dLat) * 180) / Math.PI;
  return "to the " + ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"][Math.round(((a + 360) % 360) / 45) % 8];
};
const fmtLocal = (s) => {
  const d = new Date(s + ":00Z");
  return `${d.toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" })} ${s.slice(11, 16)}`;
};

function sheet(title) {
  let dlg = document.getElementById("map-sheet");
  if (!dlg) {
    dlg = document.createElement("dialog");
    dlg.id = "map-sheet";
    dlg.className = "sheet map-sheet";
    dlg.innerHTML = `<header class="sheet-head"><h2 id="map-sheet-title"></h2><button type="button" data-close>✕ Close</button></header><div class="sheet-body"></div>`;
    dlg.setAttribute("aria-labelledby", "map-sheet-title");
    dlg.addEventListener("close", () => dlg.__stop?.());
    document.body.append(dlg);
  }
  dlg.__stop?.();
  dlg.querySelector("#map-sheet-title").textContent = title;
  const body = dlg.querySelector(".sheet-body");
  const status = document.createElement("p");
  status.className = "viz-empty";
  body.replaceChildren(status);
  if (!dlg.open) dlg.showModal();
  return { dlg, body, status };
}

async function load(kind, region, status, retry) {
  const key = `${kind}:${region.id}`;
  try {
    const res = await fetch(`/api/${kind}?region=${encodeURIComponent(region.id)}`, { cache: "no-cache" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
    await saveSnapshot(key, data, data.fetchedAt);
    return { data, saved: false };
  } catch (e) {
    const snap = await loadSnapshot(key);
    if (snap) return { data: snap.data, saved: true, error: e };
    status.textContent = navigator.onLine === false ? "You're offline and this map hasn't been saved on this device yet." : e.message + " ";
    const again = document.createElement("button");
    again.type = "button";
    again.className = "ai-btn";
    again.textContent = "Try again";
    again.addEventListener("click", retry);
    status.append(again);
    return null;
  }
}

function table(caption, head, rows) {
  const d = document.createElement("details");
  d.className = "viz-table";
  const s = document.createElement("summary");
  s.textContent = "Data table";
  const t = document.createElement("table");
  t.createCaption().textContent = caption;
  const hr = t.createTHead().insertRow();
  for (const h of head) {
    const th = document.createElement("th");
    th.scope = "col";
    th.textContent = h;
    hr.append(th);
  }
  const tb = t.createTBody();
  for (const r of rows) {
    const tr = tb.insertRow();
    for (const c of r) tr.insertCell().textContent = c;
  }
  d.append(s, t);
  return d;
}

function note(text, cls = "map-note") {
  const p = document.createElement("p");
  p.className = cls;
  p.textContent = text;
  return p;
}

// ---------------------------------------------------------------- dispersion

export async function openDispersion(region) {
  const { dlg, body, status } = sheet(`${region.name}: smoke & dust forecast`);
  status.textContent = "Loading the Copernicus CAMS forecast…";
  const got = await load("dispersion", region, status, () => openDispersion(region));
  if (!got) return;
  const { data: d, saved } = got;
  let variable = d.dust.flat().some((v) => v >= 100) && !d.pm2_5.flat().some((v) => v >= 55.5) ? "dust" : "pm2_5";
  let frame = 0;
  let timer = null;

  const V = () => VARS[variable];
  const map = gridMap({
    grid: d.grid,
    values: d[variable][0],
    colorOf: (v) => binColor(v, V().bins),
    describe: (i) => {
      const [lat, lon] = d.grid.points[i];
      const v = d[variable][frame][i];
      return [`${v ?? "n/a"} ${V().unit}`, `${V().label} · ${fmtLocal(d.times[frame])}`, `wind ${d.windSpeed[frame][i] ?? "?"} km/h`, `${lat.toFixed(2)}, ${lon.toFixed(2)}`];
    },
    center: [region.lat, region.lon],
    fires: d.fires,
    wind: { speed: d.windSpeed[0], dir: d.windDir[0] },
    label: `${region.name} forecast map`,
  });

  const toggle = document.createElement("div");
  toggle.className = "tier-toggle";
  toggle.setAttribute("role", "group");
  toggle.setAttribute("aria-label", "Pollutant");
  for (const [k, v] of Object.entries(VARS)) {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.var = k;
    b.textContent = v.label;
    b.addEventListener("click", () => {
      variable = k;
      render();
    });
    toggle.append(b);
  }

  const slider = document.createElement("input");
  Object.assign(slider, { type: "range", min: 0, max: d.times.length - 1, value: 0, step: 1 });
  slider.setAttribute("aria-label", "Forecast time");
  const when = document.createElement("span");
  when.className = "map-when";
  const play = document.createElement("button");
  play.type = "button";
  play.className = "ai-btn";
  play.textContent = "▶ Play";
  const stop = () => {
    clearInterval(timer);
    timer = null;
    play.textContent = "▶ Play";
  };
  play.addEventListener("click", () => {
    if (timer) return stop();
    play.textContent = "❚❚ Pause";
    timer = setInterval(() => {
      frame = (frame + 1) % d.times.length;
      slider.value = frame;
      render();
    }, 800);
  });
  dlg.__stop = stop;
  slider.addEventListener("input", () => {
    frame = Number(slider.value);
    render();
  });

  const legendBox = document.createElement("div");
  const summary = note("", "map-summary");
  const tableBox = document.createElement("div");

  function render() {
    for (const b of toggle.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.var === variable));
    map.update(d[variable][frame], { speed: d.windSpeed[frame], dir: d.windDir[frame] });
    when.textContent = `${fmtLocal(d.times[frame])} local · +${frame * 3} h`;
    legendBox.replaceChildren(legend(V().bins.concat(Infinity).map((_, i) => [WARM[i], V().names[i]]), `${V().label} (${V().unit}), model forecast`));
    // Summary: worst point over the whole 48 h.
    let best = { v: -1 };
    d[variable].forEach((row, t) => row.forEach((v, i) => v != null && v > best.v && (best = { v, t, i })));
    const [lat, lon] = d.grid.points[best.i];
    summary.textContent = `Highest ${V().label} in the next 48 h: ${best.v} ${V().unit} (${V().names[V().bins.filter((b) => best.v >= b).length]}) around ${fmtLocal(d.times[best.t])}, ${compass(lat - region.lat, lon - region.lon)} of ${region.name.split(",")[0]}.`;
    tableBox.replaceChildren(
      table(`${V().label} at ${fmtLocal(d.times[frame])}`, ["Latitude", "Longitude", `${V().label} (${V().unit})`, "Wind (km/h)"], d.grid.points.map(([la, lo], i) => [la.toFixed(2), lo.toFixed(2), String(d[variable][frame][i] ?? ""), String(d.windSpeed[frame][i] ?? "")])),
    );
  }

  const controls = document.createElement("div");
  controls.className = "map-controls";
  controls.append(play, slider, when);
  body.replaceChildren(
    ...(saved ? [note(`Offline: showing the forecast saved ${ageLabel(d.fetchedAt)}.`, "saved-note")] : []),
    toggle,
    summary,
    map.el,
    controls,
    legendBox,
    note(`${d.source} Arrows show the wind; light dots are satellite fire detections (last 24 h); + is ${region.name.split(",")[0]}.`),
    tableBox,
  );
  render();
}

// ---------------------------------------------------------------- heat anomaly grid

export async function openHeatGrid(region) {
  const { body, status } = sheet(`${region.name}: heat compared with normal`);
  status.textContent = "Loading… The first time for a region builds a 10-year comparison and can take about 20 seconds.";
  const got = await load("heatgrid", region, status, () => openHeatGrid(region));
  if (!got) return;
  const { data: h, saved } = got;
  const zs = h.cells.map((c) => c.z);
  const map = gridMap({
    grid: h.grid,
    values: zs,
    colorOf: divergingColor,
    describe: (i) => {
      const c = h.cells[i];
      return [c.z == null ? "no comparison" : `${c.z > 0 ? "+" : ""}${c.z}σ`, `daily wet-bulb ${c.tw ?? "?"} °C`, c.mean != null ? `normal ${c.mean} ± ${c.std} °C (${c.n} days)` : "", `${c.lat.toFixed(2)}, ${c.lon.toFixed(2)}`].filter(Boolean);
    },
    center: [region.lat, region.lon],
    label: `${region.name} heat anomaly map`,
  });
  const ok = h.cells.filter((c) => c.z != null);
  const hot = ok.reduce((a, c) => (!a || c.z > a.z ? c : a), null);
  const mid = h.cells[Math.floor(h.cells.length / 2)];
  const plain = (z) => (z >= 2 ? "far hotter than normal" : z >= 1 ? "hotter than normal" : z <= -1 ? "cooler than normal" : "about normal");
  const summaryText = hot
    ? `Today around ${region.name.split(",")[0]} is ${plain(mid.z)} for the date (${mid.z > 0 ? "+" : ""}${mid.z}σ). The most unusual spot is ${compass(hot.lat - region.lat, hot.lon - region.lon)} at ${hot.z > 0 ? "+" : ""}${hot.z}σ (${hot.tw} °C vs a normal ${hot.mean} °C).`
    : "Today's values are shown, but the comparison with normal isn't available yet.";
  const steps = [-2.75, -2.25, -1.75, -1.25, -0.75, 0, 0.75, 1.25, 1.75, 2.25, 2.75];
  const labels = ["−2.5σ+", "", "", "", "−0.5σ", "normal", "+0.5σ", "", "", "", "+2.5σ+"];
  body.replaceChildren(
    ...(saved ? [note(`Offline: showing the map saved ${ageLabel(h.fetchedAt)}.`, "saved-note")] : []),
    ...(h.baselineError ? [note(h.baselineError, "saved-note")] : []),
    note(summaryText, "map-summary"),
    map.el,
    legend(steps.map((z, i) => [divergingColor(z), labels[i]]), "Daily wet-bulb vs normal for the date (standard deviations)"),
    note(`${h.source} Cyan = cooler than normal, amber = hotter, gray = within half a standard deviation. + is ${region.name.split(",")[0]}.`),
    table(`Heat anomaly on ${h.date}`, ["Latitude", "Longitude", "Daily wet-bulb °C", "Normal °C", "σ", "z"], h.cells.map((c) => [c.lat.toFixed(2), c.lon.toFixed(2), String(c.tw ?? ""), String(c.mean ?? ""), String(c.std ?? ""), c.z == null ? "" : String(c.z)])),
  );
}
