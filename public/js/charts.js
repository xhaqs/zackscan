// Scientific charts for anomaly cards: plain SVG, no library.
//
// Palette (validated with the dataviz skill's validator on the dark card
// surface #111827; each arm is one hue with monotone lightness):
//   diverging  cool arm (below normal) → gray midpoint → warm arm (above normal)
//   sequential the warm arm, dim → bright = more (fire intensity)
// Marks: 2px lines, ≥ 8px dots with a 2px surface ring, 24px hit targets,
// 10% area wash, 1px solid hairline grid. Text never wears the data colour.
// Every chart has a hover/focus tooltip AND a data table, so no value is
// only reachable by hovering.

export const COOL = ["#155e75", "#0e7490", "#0891b2", "#22d3ee", "#a5f3fc"]; // dim → bright
export const WARM = ["#92400e", "#b45309", "#d97706", "#f59e0b", "#fbbf24"]; // dim → bright
export const MID = "#4b5563";
const INK = { primary: "#e5e7eb", secondary: "#9ca3af", muted: "#6b7280", grid: "#1f2937", surface: "#111827" };
const NS = "http://www.w3.org/2000/svg";

/** Diverging colour for a z-score: gray within ±0.5σ, then one step per 0.5σ, capped. */
export function divergingColor(z) {
  if (z == null || !Number.isFinite(z) || Math.abs(z) < 0.5) return MID;
  const step = Math.min(4, Math.floor((Math.abs(z) - 0.5) / 0.5));
  return (z > 0 ? WARM : COOL)[step];
}

/** Sequential colour for fire radiative power (MW), fixed bins so maps compare. */
export const FRP_BINS = [5, 20, 50, 100]; // <5 | 5–20 | 20–50 | 50–100 | ≥100
export const frpColor = (mw) => WARM[FRP_BINS.filter((b) => mw >= b).length];

// ---------------------------------------------------------------- helpers

function el(name, attrs = {}, parent) {
  const e = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  parent?.appendChild(e);
  return e;
}
function text(parent, x, y, str, { anchor = "start", fill = INK.muted, size = 10, weight = 400, baseline = "auto", halo = false } = {}) {
  const t = el("text", { x, y, "text-anchor": anchor, fill, "font-size": size, "font-weight": weight, "dominant-baseline": baseline }, parent);
  // Labels over the plot get a surface-coloured halo, so a line crossing them never hides the text.
  if (halo) for (const [k, v] of Object.entries({ stroke: INK.surface, "stroke-width": 3, "paint-order": "stroke", "stroke-linejoin": "round" })) t.setAttribute(k, v);
  t.textContent = str; // untrusted strings (place names) only ever go in as text
  return t;
}
const scale = (d0, d1, r0, r1) => (v) => r0 + ((v - d0) / (d1 - d0 || 1)) * (r1 - r0);

function frame(w, h, label) {
  const wrap = document.createElement("div");
  wrap.className = "chart";
  const svg = el("svg", { viewBox: `0 0 ${w} ${h}`, width: "100%", role: "img", "aria-label": label, preserveAspectRatio: "xMidYMid meet" }, wrap);
  const tip = document.createElement("div");
  tip.className = "chart-tip";
  tip.hidden = true;
  wrap.appendChild(tip);
  return { wrap, svg, tip };
}

function showTip(tip, wrap, svg, x, y, lines) {
  tip.replaceChildren(
    ...lines.map(([strong, rest], i) => {
      const row = document.createElement("div");
      if (i === 0) row.className = "tip-value";
      const b = document.createElement("b");
      b.textContent = strong;
      row.append(b, rest ? " " + rest : "");
      return row;
    }),
  );
  tip.hidden = false;
  const box = svg.getBoundingClientRect();
  const vb = svg.viewBox.baseVal;
  const px = (x / vb.width) * box.width;
  const py = (y / vb.height) * box.height;
  tip.style.left = Math.min(Math.max(px, 60), box.width - 60) + "px";
  tip.style.top = Math.max(py - 8, 0) + "px";
}

/** Points with a visible dot and a bigger invisible hit/focus target. */
function point(g, x, y, fill, label, onShow) {
  el("circle", { cx: x, cy: y, r: 6, fill: INK.surface, "pointer-events": "none" }, g); // 2px surface ring
  const dot = el("circle", { cx: x, cy: y, r: 4, fill, "pointer-events": "none" }, g);
  // The 24px hit target is drawn last, on top, so the whole area responds.
  const hit = el("circle", { cx: x, cy: y, r: 12, fill: "transparent", tabindex: 0, role: "img", "aria-label": label, class: "hit" }, g);
  const on = () => (dot.setAttribute("r", 5), onShow());
  const off = () => dot.setAttribute("r", 4);
  hit.addEventListener("pointerenter", on);
  hit.addEventListener("focus", on);
  hit.addEventListener("pointerleave", off);
  hit.addEventListener("blur", off);
  return dot;
}

function table(caption, head, rows) {
  const d = document.createElement("details");
  d.className = "viz-table";
  const s = document.createElement("summary");
  s.textContent = "Data table";
  const t = document.createElement("table");
  const cap = document.createElement("caption");
  cap.textContent = caption;
  const thead = t.createTHead().insertRow();
  for (const h of head) {
    const th = document.createElement("th");
    th.scope = "col";
    th.textContent = h;
    thead.appendChild(th);
  }
  const tb = t.createTBody();
  for (const r of rows) {
    const tr = tb.insertRow();
    for (const c of r) tr.insertCell().textContent = c;
  }
  t.prepend(cap);
  d.append(s, t);
  return d;
}

const fmtLocal = (s) => {
  const d = new Date(s + ":00Z");
  return `${d.toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" })} ${s.slice(11, 16)}`;
};

// ---------------------------------------------------------------- heat: 48 h wet-bulb vs danger thresholds

const THRESHOLDS = [
  [28, "28 °C heavy work unsafe"],
  [31, "31 °C extreme"],
  [35, "35 °C survival limit"],
];

export function heatChart(series, { title = "Wet-bulb temperature, next 48 h" } = {}) {
  const W = 340, H = 170, L = 30, R = 8, T = 10, B = 26;
  const vals = series.map((s) => s[1]);
  const lo = Math.floor(Math.min(...vals, 22) - 1);
  const hi = Math.ceil(Math.max(...vals, 29) + 1);
  const { wrap, svg, tip } = frame(W, H, `${title}. Peak ${Math.max(...vals)} °C.`);
  const x = scale(0, series.length - 1, L, W - R);
  const y = scale(lo, hi, H - B, T);

  for (let v = Math.ceil(lo / 2) * 2; v <= hi; v += 2) {
    el("line", { x1: L, x2: W - R, y1: y(v), y2: y(v), stroke: INK.grid, "stroke-width": 1 }, svg);
    text(svg, L - 4, y(v), String(v), { anchor: "end", baseline: "middle" });
  }
  for (const [v, label] of THRESHOLDS) {
    if (v < lo || v > hi) continue;
    el("line", { x1: L, x2: W - R, y1: y(v), y2: y(v), stroke: INK.secondary, "stroke-width": 1, opacity: 0.6 }, svg);
    text(svg, W - R - 2, y(v) - 3, label, { anchor: "end", fill: INK.secondary, size: 9, halo: true });
  }
  series.forEach(([t], i) => {
    if (i % 12 === 0) text(svg, x(i), H - 8, fmtLocal(t), { anchor: i === 0 ? "start" : "middle" });
  });

  const pts = series.map(([, v], i) => `${x(i)},${y(v)}`);
  el("path", { d: `M${x(0)},${H - B} L${pts.join(" L")} L${x(series.length - 1)},${H - B} Z`, fill: WARM[3], opacity: 0.1 }, svg);
  el("polyline", { points: pts.join(" "), fill: "none", stroke: WARM[3], "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }, svg);

  const iMax = vals.indexOf(Math.max(...vals));
  el("circle", { cx: x(iMax), cy: y(vals[iMax]), r: 6, fill: INK.surface }, svg);
  el("circle", { cx: x(iMax), cy: y(vals[iMax]), r: 4, fill: WARM[3] }, svg);
  text(svg, x(iMax), y(vals[iMax]) - 9, `${vals[iMax]} °C`, { anchor: iMax > series.length * 0.8 ? "end" : "middle", fill: INK.primary, weight: 600, halo: true });

  // Crosshair: snaps to the nearest hour, keyboard-accessible via arrow keys.
  const cross = el("line", { y1: T, y2: H - B, stroke: INK.secondary, "stroke-width": 1, visibility: "hidden" }, svg);
  const dot = el("circle", { r: 4, fill: WARM[3], stroke: INK.surface, "stroke-width": 2, visibility: "hidden" }, svg);
  const overlay = el("rect", { x: L, y: T, width: W - L - R, height: H - T - B, fill: "transparent", tabindex: 0, "aria-label": "Chart: use left and right arrows to read hours" }, svg);
  let idx = iMax;
  const show = (i) => {
    idx = Math.max(0, Math.min(series.length - 1, i));
    const [t, v] = series[idx];
    for (const n of [cross, dot]) n.setAttribute("visibility", "visible");
    cross.setAttribute("x1", x(idx));
    cross.setAttribute("x2", x(idx));
    dot.setAttribute("cx", x(idx));
    dot.setAttribute("cy", y(v));
    showTip(tip, wrap, svg, x(idx), y(v), [[`${v} °C`, "wet-bulb"], [fmtLocal(t), ""]]);
  };
  const hide = () => {
    for (const n of [cross, dot]) n.setAttribute("visibility", "hidden");
    tip.hidden = true;
  };
  overlay.addEventListener("pointermove", (e) => {
    const r = svg.getBoundingClientRect();
    const vx = ((e.clientX - r.left) / r.width) * W;
    show(Math.round(((vx - L) / (W - L - R)) * (series.length - 1)));
  });
  overlay.addEventListener("pointerleave", hide);
  overlay.addEventListener("focus", () => show(idx));
  overlay.addEventListener("blur", hide);
  overlay.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      show(idx + (e.key === "ArrowRight" ? 1 : -1));
    }
  });

  wrap.appendChild(table(title, ["Local time", "Wet-bulb °C"], series.map(([t, v]) => [fmtLocal(t), String(v)])));
  return wrap;
}

// ---------------------------------------------------------------- ±σ gauge (diverging)

export function sigmaGauge(z, { label = "vs normal for the date" } = {}) {
  const W = 340, H = 46, L = 8, R = 8;
  const { wrap, svg } = frame(W, H, `Anomaly ${z > 0 ? "+" : ""}${z}σ ${label}`);
  wrap.classList.add("gauge");
  const x = scale(-3, 3, L, W - R);
  const cells = [-3, -2.5, -2, -1.5, -1, -0.5, 0.5, 1, 1.5, 2, 2.5, 3];
  // 12 half-sigma cells from -3σ to +3σ with a 2px surface gap between them.
  for (let i = 0; i < cells.length - 1; i++) {
    const a = cells[i], b = cells[i + 1];
    const mid = (a + b) / 2;
    el("rect", { x: x(a) + 1, y: 8, width: x(b) - x(a) - 2, height: 10, rx: 2, fill: divergingColor(mid) }, svg);
  }
  for (const v of [-3, -2, -1, 0, 1, 2, 3]) text(svg, x(v), 32, v === 0 ? "normal" : `${v > 0 ? "+" : ""}${v}σ`, { anchor: "middle", size: 9 });
  const zc = Math.max(-3, Math.min(3, z));
  el("path", { d: `M${x(zc) - 6},2 L${x(zc) + 6},2 L${x(zc)},9 Z`, fill: INK.primary }, svg);
  text(svg, x(zc), H - 2, `${z > 0 ? "+" : ""}${z}σ ${label}`, { anchor: zc > 1.5 ? "end" : zc < -1.5 ? "start" : "middle", fill: INK.primary, size: 10, weight: 600 });
  return wrap;
}

// ---------------------------------------------------------------- seismic: magnitude over the week

export function quakeChart(events, { minMag = 4, now = Date.now(), title = "Earthquakes in the last 7 days" } = {}) {
  const W = 340, H = 170, L = 30, R = 10, T = 12, B = 26;
  const { wrap, svg, tip } = frame(W, H, `${title}: ${events.length} events.`);
  const t0 = now - 7 * 86_400_000;
  const mags = events.map((e) => e[1]);
  const hi = Math.ceil(Math.max(minMag + 2, ...mags) + 0.3);
  const lo = Math.floor((minMag - 0.3) * 2) / 2;
  const x = scale(t0, now, L, W - R);
  const y = scale(lo, hi, H - B, T);
  for (let m = Math.ceil(lo); m <= hi; m++) {
    el("line", { x1: L, x2: W - R, y1: y(m), y2: y(m), stroke: INK.grid, "stroke-width": 1 }, svg);
    text(svg, L - 4, y(m), `M${m}`, { anchor: "end", baseline: "middle" });
  }
  for (let d = 7; d >= 0; d -= 1) {
    if (d % 2) continue;
    text(svg, x(now - d * 86_400_000), H - 8, d === 0 ? "now" : `${d} d ago`, { anchor: d === 7 ? "start" : d === 0 ? "end" : "middle" });
  }
  if (!events.length) text(svg, W / 2, H / 2, `No quakes ≥ M${minMag} this week`, { anchor: "middle", fill: INK.secondary, size: 12 });
  const g = el("g", {}, svg);
  const biggest = events.reduce((a, b) => (!a || b[1] > a[1] ? b : a), null);
  for (const e of [...events].sort((a, b) => a[1] - b[1])) {
    const [t, mag, depth, place] = e;
    const cx = x(Math.max(t, t0)), cy = y(mag);
    point(g, cx, cy, COOL[3], `M${mag}, ${place}`, () =>
      showTip(tip, wrap, svg, cx, cy, [[`M${mag}`, depth != null ? `· ${Math.round(depth)} km deep` : ""], [place || "", ""], [new Date(t).toUTCString().slice(0, 22), ""]]),
    );
  }
  g.addEventListener("pointerleave", () => (tip.hidden = true));
  if (biggest) text(svg, x(biggest[0]), y(biggest[1]) - 10, `M${biggest[1]}`, { anchor: x(biggest[0]) > W - 40 ? "end" : "middle", fill: INK.primary, weight: 600, halo: true });
  wrap.appendChild(table(title, ["Time (UTC)", "Magnitude", "Depth km", "Place"], [...events].sort((a, b) => b[0] - a[0]).map(([t, m, d, p]) => [new Date(t).toISOString().slice(0, 16).replace("T", " "), String(m), d == null ? "" : String(Math.round(d)), p || ""])));
  return wrap;
}

// ---------------------------------------------------------------- wildfire: detections map

export function fireMap(points, { box, center, title = "Satellite fire detections, last 24 h" } = {}) {
  const [w, s, e, n] = box;
  const k = Math.cos((((s + n) / 2) * Math.PI) / 180); // shrink longitude with latitude
  const W = 340, pad = 10;
  const H = Math.round(((n - s) / ((e - w) * k)) * (W - 2 * pad) + 2 * pad + 30);
  const { wrap, svg, tip } = frame(W, H, `${title}: ${points.length} detections.`);
  const x = scale(w, e, pad, W - pad);
  const y = scale(s, n, H - 30 - pad, pad);
  el("rect", { x: pad, y: pad, width: W - 2 * pad, height: H - 30 - 2 * pad, fill: "none", stroke: INK.grid, "stroke-width": 1 }, svg);
  // Centre of the region, and a ring every ~50 km for scale.
  const cx = x(center[1]), cy = y(center[0]);
  const kmPerPx = ((e - w) * 111.32 * k) / (W - 2 * pad);
  for (const km of [50, 100]) el("circle", { cx, cy, r: km / kmPerPx, fill: "none", stroke: INK.grid, "stroke-width": 1 }, svg);
  text(svg, cx + 100 / kmPerPx, cy - 3, "100 km", { size: 9 });
  el("path", { d: `M${cx - 6},${cy} H${cx + 6} M${cx},${cy - 6} V${cy + 6}`, stroke: INK.primary, "stroke-width": 2 }, svg);
  if (!points.length) text(svg, W / 2, (H - 30) / 2 + 18, "No fires detected in the last 24 h", { anchor: "middle", fill: INK.secondary, size: 12 });
  const g = el("g", {}, svg);
  for (const [lat, lon, frp] of [...points].sort((a, b) => a[2] - b[2])) {
    const px = x(lon), py = y(lat);
    point(g, px, py, frpColor(frp), `Fire ${frp} MW`, () => showTip(tip, wrap, svg, px, py, [[`${frp} MW`, "fire radiative power"], [`${lat.toFixed(3)}, ${lon.toFixed(3)}`, ""]]));
  }
  g.addEventListener("pointerleave", () => (tip.hidden = true));
  // Sequential legend: fixed FRP bins.
  const labels = ["<5", "5–20", "20–50", "50–100", "≥100 MW"];
  const lw = (W - 2 * pad) / 5;
  labels.forEach((lab, i) => {
    el("rect", { x: pad + i * lw + 1, y: H - 24, width: lw - 2, height: 6, rx: 2, fill: WARM[i] }, svg);
    text(svg, pad + i * lw + lw / 2, H - 6, lab, { anchor: "middle", size: 9 });
  });
  wrap.appendChild(table(title, ["Latitude", "Longitude", "FRP (MW)"], points.map(([la, lo, f]) => [la.toFixed(3), lo.toFixed(3), String(f)])));
  return wrap;
}

// ---------------------------------------------------------------- GLOF: reference lakes (not live)

export function lakeMap(lakes, { center, title = "Reference glacial lakes (not live)" } = {}) {
  const W = 340, H = 160, pad = 24;
  const { wrap, svg, tip } = frame(W, H, `${title}: ${lakes.length} lakes within 300 km.`);
  const all = [[center[0], center[1]], ...lakes.map((l) => [l.lat, l.lon])];
  const lats = all.map((p) => p[0]), lons = all.map((p) => p[1]);
  const x = scale(Math.min(...lons) - 0.3, Math.max(...lons) + 0.3, pad, W - pad);
  const y = scale(Math.min(...lats) - 0.3, Math.max(...lats) + 0.3, H - pad, pad);
  el("rect", { x: 4, y: 4, width: W - 8, height: H - 8, fill: "none", stroke: INK.grid, "stroke-width": 1 }, svg);
  const cx = x(center[1]), cy = y(center[0]);
  el("path", { d: `M${cx - 6},${cy} H${cx + 6} M${cx},${cy - 6} V${cy + 6}`, stroke: INK.primary, "stroke-width": 2 }, svg);
  const g = el("g", {}, svg);
  const placed = []; // label boxes so far, to nudge overlapping names apart
  for (const l of [...lakes].sort((a, b) => a.lon - b.lon)) {
    const px = x(l.lon), py = y(l.lat);
    point(g, px, py, MID, `${l.name}, ${l.distanceKm} km`, () => showTip(tip, wrap, svg, px, py, [[l.name, `· ${l.distanceKm} km`], [l.note || "", ""]]));
    const wText = l.name.length * 5.6;
    const right = px + 8 + wText > W - 6; // near the right edge: label on the left
    let ly = py + 4;
    const lx0 = right ? px - 8 - wText : px + 8;
    while (placed.some((b) => Math.abs(b.y - ly) < 12 && lx0 < b.x1 && lx0 + wText > b.x0)) ly += 12;
    placed.push({ x0: lx0, x1: lx0 + wText, y: ly });
    text(svg, right ? px - 8 : px + 8, ly, l.name, { anchor: right ? "end" : "start", fill: INK.secondary, size: 10, halo: true });
  }
  if (!lakes.length) text(svg, W / 2, H / 2, "No reference lakes within 300 km", { anchor: "middle", fill: INK.secondary, size: 12 });
  text(svg, 10, H - 10, "Preliminary / Non-Real-Time · positions approximate", { size: 9 });
  wrap.appendChild(table(title, ["Lake", "Country", "Distance km"], lakes.map((l) => [l.name, l.country, String(l.distanceKm)])));
  return wrap;
}
