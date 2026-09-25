// Gridded heatmap (plain SVG) for the dispersion and heat-anomaly views.
// Cells are drawn at their true geographic size (longitude shrunk by
// cos(latitude)) with a 2px surface gap; optional wind arrows and fire
// detections on top. One hit layer handles pointer and keyboard (arrow keys
// move between cells), so every value is reachable without a mouse, and the
// sheet adds a data table.

const NS = "http://www.w3.org/2000/svg";
const INK = { primary: "#e5e7eb", secondary: "#9ca3af", muted: "#6b7280", surface: "#111827", grid: "#1f2937" };

function el(name, attrs = {}, parent) {
  const e = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  parent?.appendChild(e);
  return e;
}

/**
 * @param grid      {n, spacingDeg, points:[[lat,lon]...]} row-major, north-west first
 * @param colorOf   (value) => fill
 * @param describe  (index) => [strongLine, ...otherLines] for the tooltip
 * @param center    [lat, lon] of the region
 * @param fires     [[lat, lon, frp]...] optional
 * @returns {el, update(values, wind?)}
 */
export function gridMap({ grid, values, colorOf, describe, center, fires = [], wind = null, label = "Map" }) {
  const { n, spacingDeg: d, points } = grid;
  const midLat = points[Math.floor(points.length / 2)][0];
  const k = Math.cos((midLat * Math.PI) / 180);
  const W = 340, pad = 8;
  const cellW = (W - 2 * pad) / n;
  const cellH = cellW / k; // degrees of latitude are longer than degrees of longitude here
  const H = Math.round(cellH * n + 2 * pad);
  const lon0 = points[0][1] - d / 2, lat0 = points[0][0] + d / 2;
  const x = (lon) => pad + ((lon - lon0) / d) * cellW;
  const y = (lat) => pad + ((lat0 - lat) / d) * cellH;

  const wrap = document.createElement("div");
  wrap.className = "chart grid-map";
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, width: "100%", role: "img", "aria-label": label }, wrap);
  const tip = document.createElement("div");
  tip.className = "chart-tip";
  tip.hidden = true;
  wrap.appendChild(tip);

  const cells = points.map(([lat, lon]) =>
    el("rect", { x: x(lon - d / 2) + 1, y: y(lat + d / 2) + 1, width: cellW - 2, height: cellH - 2, rx: 2 }, svg),
  );
  const arrows = el("g", { "pointer-events": "none" }, svg);
  // Fire detections: light dots with a surface ring, above the colour.
  const fireLayer = el("g", { "pointer-events": "none" }, svg);
  for (const [lat, lon] of fires) {
    const fx = x(lon), fy = y(lat);
    if (fx < pad || fx > W - pad || fy < pad || fy > H - pad) continue;
    el("circle", { cx: fx, cy: fy, r: 4, fill: INK.surface }, fireLayer);
    el("circle", { cx: fx, cy: fy, r: 2.5, fill: INK.primary }, fireLayer);
  }
  const cx = x(center[1]), cy = y(center[0]);
  for (const [w, c] of [[4, INK.surface], [2, INK.primary]])
    el("path", { d: `M${cx - 7},${cy} H${cx + 7} M${cx},${cy - 7} V${cy + 7}`, stroke: c, "stroke-width": w, "pointer-events": "none" }, svg);
  const sel = el("rect", { fill: "none", stroke: INK.primary, "stroke-width": 2, rx: 3, visibility: "hidden", "pointer-events": "none" }, svg);
  const hit = el("rect", { x: pad, y: pad, width: W - 2 * pad, height: H - 2 * pad, fill: "transparent", tabindex: 0, "aria-label": `${label}. Use arrow keys to read each cell.` }, svg);

  let idx = Math.floor(points.length / 2);
  function show(i) {
    idx = Math.max(0, Math.min(points.length - 1, i));
    const [lat, lon] = points[idx];
    for (const [a, v] of Object.entries({ x: x(lon - d / 2), y: y(lat + d / 2), width: cellW, height: cellH })) sel.setAttribute(a, v);
    sel.setAttribute("visibility", "visible");
    const lines = describe(idx);
    tip.replaceChildren(
      ...lines.map((t, j) => {
        const row = document.createElement("div");
        if (j === 0) {
          const b = document.createElement("b");
          b.textContent = t;
          row.className = "tip-value";
          row.append(b);
        } else row.textContent = t;
        return row;
      }),
    );
    tip.hidden = false;
    const box = svg.getBoundingClientRect();
    tip.style.left = Math.min(Math.max((x(lon) / W) * box.width, 70), box.width - 70) + "px";
    tip.style.top = Math.max((y(lat + d / 2) / H) * box.height - 4, 0) + "px";
  }
  const hide = () => {
    sel.setAttribute("visibility", "hidden");
    tip.hidden = true;
  };
  hit.addEventListener("pointermove", (e) => {
    const r = svg.getBoundingClientRect();
    const col = Math.floor((((e.clientX - r.left) / r.width) * W - pad) / cellW);
    const row = Math.floor((((e.clientY - r.top) / r.height) * H - pad) / cellH);
    if (col >= 0 && col < n && row >= 0 && row < n) show(row * n + col);
  });
  hit.addEventListener("pointerleave", hide);
  hit.addEventListener("focus", () => show(idx));
  hit.addEventListener("blur", hide);
  hit.addEventListener("keydown", (e) => {
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: n, ArrowUp: -n }[e.key];
    if (step == null) return;
    e.preventDefault();
    const next = idx + step;
    if ((e.key === "ArrowRight" && idx % n === n - 1) || (e.key === "ArrowLeft" && idx % n === 0)) return;
    if (next >= 0 && next < points.length) show(next);
  });

  function update(vals, windNow = null) {
    vals.forEach((v, i) => cells[i].setAttribute("fill", colorOf(v)));
    arrows.replaceChildren();
    if (windNow)
      points.forEach(([lat, lon], i) => {
        const sp = windNow.speed[i], dir = windNow.dir[i];
        if (sp == null || dir == null) return;
        const to = ((dir + 180) * Math.PI) / 180; // meteorological "from" → arrow points where air goes
        const len = Math.min(cellW * 0.42, 5 + sp / 2.5);
        const ax = x(lon), ay = y(lat);
        const ex = ax + Math.sin(to) * len, ey = ay - Math.cos(to) * len;
        const head = (a) => `${ex - Math.sin(to + a) * 4},${ey + Math.cos(to + a) * 4}`;
        for (const [w, c] of [[3.5, INK.surface], [1.5, INK.primary]]) {
          el("line", { x1: ax, y1: ay, x2: ex, y2: ey, stroke: c, "stroke-width": w, "stroke-linecap": "round" }, arrows);
          el("polyline", { points: `${head(0.5)} ${ex},${ey} ${head(-0.5)}`, fill: "none", stroke: c, "stroke-width": w, "stroke-linejoin": "round", "stroke-linecap": "round" }, arrows);
        }
      });
    if (!sel.getAttribute("visibility") || sel.getAttribute("visibility") === "visible") show(idx);
  }
  update(values, wind);
  hide();
  return { el: wrap, update };
}

/** Horizontal legend: swatches with labels under them. */
export function legend(items, title) {
  const box = document.createElement("div");
  box.className = "map-legend";
  if (title) {
    const t = document.createElement("div");
    t.className = "map-legend-title";
    t.textContent = title;
    box.append(t);
  }
  const row = document.createElement("div");
  row.className = "map-legend-row";
  for (const [color, label] of items) {
    const it = document.createElement("span");
    const sw = document.createElement("i");
    sw.style.background = color;
    it.append(sw, label);
    row.append(it);
  }
  box.append(row);
  return box;
}
