// Visual Story Card: a 1080×1350 image (portrait, sized for messaging apps
// and social feeds) of one anomaly: header, the anomaly map or chart, three
// key numbers, the SitRep in the tier the user is looking at, sources and a
// link. Drawn straight onto a canvas from the data (not a screenshot of the
// page), so it's sharp, and it works offline.
//
// Sharing: the Web Share API with the image file + a caption; if the
// browser can't share files, the image is downloaded instead.

import { buildStoryModel, wrapText } from "./story-model.js";
import { WARM, COOL, MID, divergingColor, frpColor } from "./charts.js";
import { loadSnapshot } from "./offline-store.js";

const W = 1080, H = 1350, PAD = 64;
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const C = { bg: "#0b0f17", glass: "rgba(17, 24, 39, 0.9)", border: "rgba(255, 255, 255, 0.10)", ink: "#e5e7eb", ink2: "#9ca3af", ink3: "#6b7280", grid: "#1f2937", cyan: "#22d3ee" };
const STATUS = { low: "#0ca30c", guarded: "#0ca30c", elevated: "#fab219", high: "#ec835a", severe: "#d03b3b", unknown: "#6b7280" };
const PM25_BINS = [9, 35.5, 55.5, 125.5];

const font = (px, weight = 400) => `${weight} ${px}px ${FONT}`;
function rrect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}
function textLine(ctx, s, x, y, { px = 28, weight = 400, color = C.ink, align = "left", baseline = "alphabetic" } = {}) {
  ctx.font = font(px, weight);
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
  ctx.fillText(s, x, y);
}
// Labels that sit on a plot get a solid backing pill (a thin halo wasn't
// enough over a 4px line).
function haloText(ctx, s, x, y, opts) {
  const px = opts.px || 22;
  ctx.font = font(px, opts.weight || 400);
  const w = ctx.measureText(s).width;
  const left = opts.align === "right" ? x - w : opts.align === "center" ? x - w / 2 : x;
  ctx.save();
  ctx.fillStyle = "rgba(17, 24, 39, 0.92)";
  rrect(ctx, left - 8, y - px * 0.95, w + 16, px * 1.35, 6);
  ctx.fill();
  ctx.restore();
  textLine(ctx, s, x, y, opts);
}
const measurer = (ctx, px, weight = 400) => (s) => {
  ctx.font = font(px, weight);
  return ctx.measureText(s).width;
};

// ---------------------------------------------------------------- visuals (drawn into a box)

function noVisual(ctx, b, msg) {
  textLine(ctx, msg, b.x + b.w / 2, b.y + b.h / 2, { px: 28, color: C.ink2, align: "center", baseline: "middle" });
}

function drawHeat(ctx, b, pillar) {
  const s = pillar.components?.severity?.series || [];
  if (!s.length) return noVisual(ctx, b, "No hourly forecast available");
  const vals = s.map((p) => p[1]);
  const lo = Math.floor(Math.min(...vals, 22) - 1), hi = Math.ceil(Math.max(...vals, 29) + 1);
  const L = b.x + 60, R = b.x + b.w - 20, T = b.y + 50, B = b.y + b.h - 110;
  const x = (i) => L + (i / (s.length - 1)) * (R - L);
  const y = (v) => B - ((v - lo) / (hi - lo)) * (B - T);
  textLine(ctx, "Wet-bulb temperature, next 48 h (°C)", b.x + 20, b.y + 34, { px: 24, color: C.ink2 });
  ctx.lineWidth = 1;
  for (let v = Math.ceil(lo / 2) * 2; v <= hi; v += 2) {
    ctx.strokeStyle = C.grid;
    ctx.beginPath();
    ctx.moveTo(L, y(v));
    ctx.lineTo(R, y(v));
    ctx.stroke();
    textLine(ctx, String(v), L - 12, y(v), { px: 20, color: C.ink3, align: "right", baseline: "middle" });
  }
  const thresholdLabels = []; // drawn after the line, so the line never covers them
  for (const [v, label] of [[28, "28 °C heavy work unsafe"], [31, "31 °C extreme"], [35, "35 °C survival limit"]]) {
    if (v < lo || v > hi) continue;
    ctx.strokeStyle = C.ink2;
    ctx.globalAlpha = 0.6;
    ctx.beginPath();
    ctx.moveTo(L, y(v));
    ctx.lineTo(R, y(v));
    ctx.stroke();
    ctx.globalAlpha = 1;
    thresholdLabels.push([label, y(v) - 8]);
  }
  ctx.beginPath();
  ctx.moveTo(x(0), B);
  vals.forEach((v, i) => ctx.lineTo(x(i), y(v)));
  ctx.lineTo(x(vals.length - 1), B);
  ctx.closePath();
  ctx.fillStyle = WARM[3];
  ctx.globalAlpha = 0.12;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.beginPath();
  vals.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
  ctx.strokeStyle = WARM[3];
  ctx.lineWidth = 4;
  ctx.lineJoin = ctx.lineCap = "round";
  ctx.stroke();
  const iMax = vals.indexOf(Math.max(...vals));
  ctx.fillStyle = C.glass;
  ctx.beginPath();
  ctx.arc(x(iMax), y(vals[iMax]), 11, 0, 7);
  ctx.fill();
  ctx.fillStyle = WARM[3];
  ctx.beginPath();
  ctx.arc(x(iMax), y(vals[iMax]), 7, 0, 7);
  ctx.fill();
  for (const [label, ly] of thresholdLabels) haloText(ctx, label, R - 4, ly, { px: 20, color: C.ink2, align: "right" });
  haloText(ctx, `${vals[iMax]} °C`, x(iMax), y(vals[iMax]) - 20, { px: 26, weight: 700, align: iMax > s.length * 0.8 ? "right" : "center" });
  s.forEach(([t], i) => {
    if (i % 12) return;
    const d = new Date(t + ":00Z");
    textLine(ctx, `${d.toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" })} ${t.slice(11, 16)}`, x(i), B + 32, { px: 20, color: C.ink3, align: i ? "center" : "left" });
  });
  // ±σ gauge
  const z = pillar.components?.anomaly?.zScore;
  if (z != null) {
    const gx = b.x + 20, gw = b.w - 40, gy = b.y + b.h - 50;
    const zx = (v) => gx + ((v + 3) / 6) * gw;
    const cells = [-3, -2.5, -2, -1.5, -1, -0.5, 0.5, 1, 1.5, 2, 2.5, 3];
    for (let i = 0; i < cells.length - 1; i++) {
      ctx.fillStyle = divergingColor((cells[i] + cells[i + 1]) / 2);
      rrect(ctx, zx(cells[i]) + 2, gy, zx(cells[i + 1]) - zx(cells[i]) - 4, 16, 4);
      ctx.fill();
    }
    const zc = Math.max(-3, Math.min(3, z));
    ctx.fillStyle = C.ink;
    ctx.beginPath();
    ctx.moveTo(zx(zc) - 10, gy - 14);
    ctx.lineTo(zx(zc) + 10, gy - 14);
    ctx.lineTo(zx(zc), gy - 2);
    ctx.fill();
    textLine(ctx, `${z > 0 ? "+" : z < 0 ? "−" : ""}${Math.abs(z)}σ daily wet-bulb vs normal for the date`, b.x + b.w / 2, gy + 42, { px: 20, color: C.ink2, align: "center" });
  }
}

function drawQuakes(ctx, b, pillar) {
  const ev = pillar.detail?.events || [];
  const minMag = pillar.detail?.minMagnitude ?? 4;
  const now = Date.now(), t0 = now - 7 * 86_400_000;
  const mags = ev.map((e) => e[1]);
  const hi = Math.ceil(Math.max(minMag + 2, ...mags) + 0.3), lo = Math.floor((minMag - 0.3) * 2) / 2;
  const L = b.x + 70, R = b.x + b.w - 30, T = b.y + 60, B = b.y + b.h - 60;
  const x = (t) => L + ((t - t0) / (now - t0)) * (R - L);
  const y = (m) => B - ((m - lo) / (hi - lo)) * (B - T);
  textLine(ctx, "Earthquakes in the last 7 days (magnitude)", b.x + 20, b.y + 34, { px: 24, color: C.ink2 });
  for (let m = Math.ceil(lo); m <= hi; m++) {
    ctx.strokeStyle = C.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(L, y(m));
    ctx.lineTo(R, y(m));
    ctx.stroke();
    textLine(ctx, `M${m}`, L - 12, y(m), { px: 20, color: C.ink3, align: "right", baseline: "middle" });
  }
  for (const d of [7, 4, 2, 0]) textLine(ctx, d ? `${d} d ago` : "now", x(now - d * 86_400_000), B + 34, { px: 20, color: C.ink3, align: d === 7 ? "left" : d ? "center" : "right" });
  if (!ev.length) return noVisual(ctx, { ...b, y: b.y + 20 }, `No quakes ≥ M${minMag} this week`);
  for (const [t, m] of [...ev].sort((a, b2) => a[1] - b2[1])) {
    ctx.fillStyle = C.glass;
    ctx.beginPath();
    ctx.arc(x(Math.max(t, t0)), y(m), 12, 0, 7);
    ctx.fill();
    ctx.fillStyle = COOL[3];
    ctx.beginPath();
    ctx.arc(x(Math.max(t, t0)), y(m), 8, 0, 7);
    ctx.fill();
  }
  const big = ev.reduce((a, e) => (!a || e[1] > a[1] ? e : a), null);
  haloText(ctx, `M${big[1]}`, x(big[0]), y(big[1]) - 22, { px: 26, weight: 700, align: "center" });
}

/** Grid of coloured cells (heat anomaly or CAMS PM2.5), plus overlays. */
function drawGrid(ctx, b, { title, grid, values, colorOf, fires = [], center, legend }) {
  textLine(ctx, title, b.x + 20, b.y + 34, { px: 24, color: C.ink2 });
  const { n, spacingDeg: d, points } = grid;
  const k = Math.cos((points[Math.floor(points.length / 2)][0] * Math.PI) / 180);
  const availH = b.h - 130, availW = b.w - 40;
  let cw = availW / n, ch = cw / k;
  if (ch * n > availH) (ch = availH / n), (cw = ch * k);
  const gx = b.x + (b.w - cw * n) / 2, gy = b.y + 52;
  const lon0 = points[0][1] - d / 2, lat0 = points[0][0] + d / 2;
  const px = (lon) => gx + ((lon - lon0) / d) * cw, py = (lat) => gy + ((lat0 - lat) / d) * ch;
  points.forEach(([lat, lon], i) => {
    ctx.fillStyle = colorOf(values[i]);
    rrect(ctx, px(lon - d / 2) + 2, py(lat + d / 2) + 2, cw - 4, ch - 4, 4);
    ctx.fill();
  });
  for (const [lat, lon] of fires) {
    const fx = px(lon), fy = py(lat);
    if (fx < gx || fx > gx + cw * n || fy < gy || fy > gy + ch * n) continue;
    ctx.fillStyle = C.glass;
    ctx.beginPath();
    ctx.arc(fx, fy, 8, 0, 7);
    ctx.fill();
    ctx.fillStyle = C.ink;
    ctx.beginPath();
    ctx.arc(fx, fy, 5, 0, 7);
    ctx.fill();
  }
  const cx = px(center[1]), cy = py(center[0]);
  for (const [w, c] of [[8, C.glass], [4, C.ink]]) {
    ctx.strokeStyle = c;
    ctx.lineWidth = w;
    ctx.beginPath();
    ctx.moveTo(cx - 14, cy);
    ctx.lineTo(cx + 14, cy);
    ctx.moveTo(cx, cy - 14);
    ctx.lineTo(cx, cy + 14);
    ctx.stroke();
  }
  // Legend
  const ly = b.y + b.h - 56, lw = (b.w - 40) / legend.length;
  legend.forEach(([color, label], i) => {
    ctx.fillStyle = color;
    rrect(ctx, b.x + 20 + i * lw + 2, ly, lw - 4, 14, 3);
    ctx.fill();
    if (label) textLine(ctx, label, b.x + 20 + i * lw + lw / 2, ly + 40, { px: 19, color: C.ink2, align: "center" });
  });
}

function drawFires(ctx, b, pillar) {
  const pts = pillar.components?.activity?.points;
  const area = pillar.area;
  if (!pts || !area) return noVisual(ctx, b, "Satellite fire detection is off for this area");
  const [w, s, e, n] = area.box;
  const k = Math.cos((((s + n) / 2) * Math.PI) / 180);
  textLine(ctx, "Satellite fire detections, last 24 h", b.x + 20, b.y + 34, { px: 24, color: C.ink2 });
  const availH = b.h - 130, availW = b.w - 40;
  let mw = availW, mh = ((n - s) / ((e - w) * k)) * mw;
  if (mh > availH) (mh = availH), (mw = mh * ((e - w) * k) / (n - s));
  const mx = b.x + (b.w - mw) / 2, my = b.y + 52;
  const x = (lon) => mx + ((lon - w) / (e - w)) * mw, y = (lat) => my + ((n - lat) / (n - s)) * mh;
  ctx.strokeStyle = C.grid;
  ctx.lineWidth = 2;
  ctx.strokeRect(mx, my, mw, mh);
  const cx = x(area.center[1]), cy = y(area.center[0]);
  const kmPerPx = ((e - w) * 111.32 * k) / mw;
  for (const km of [50, 100]) {
    ctx.beginPath();
    ctx.arc(cx, cy, km / kmPerPx, 0, 7);
    ctx.stroke();
  }
  haloText(ctx, "100 km", cx, cy - 100 / kmPerPx - 8, { px: 19, color: C.ink3, align: "center" });
  for (const [lat, lon, frp] of [...pts].sort((a, b2) => a[2] - b2[2])) {
    ctx.fillStyle = C.glass;
    ctx.beginPath();
    ctx.arc(x(lon), y(lat), 11, 0, 7);
    ctx.fill();
    ctx.fillStyle = frpColor(frp);
    ctx.beginPath();
    ctx.arc(x(lon), y(lat), 7.5, 0, 7);
    ctx.fill();
  }
  ctx.strokeStyle = C.ink;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(cx - 14, cy);
  ctx.lineTo(cx + 14, cy);
  ctx.moveTo(cx, cy - 14);
  ctx.lineTo(cx, cy + 14);
  ctx.stroke();
  if (!pts.length) noVisual(ctx, b, "No fires detected in the last 24 h");
  const labels = ["<5", "5–20", "20–50", "50–100", "≥100 MW"];
  const ly = b.y + b.h - 56, lw = (b.w - 40) / 5;
  labels.forEach((l, i) => {
    ctx.fillStyle = WARM[i];
    rrect(ctx, b.x + 20 + i * lw + 2, ly, lw - 4, 14, 3);
    ctx.fill();
    textLine(ctx, l, b.x + 20 + i * lw + lw / 2, ly + 40, { px: 19, color: C.ink2, align: "center" });
  });
}

function drawLakes(ctx, b, pillar, region) {
  const lakes = pillar?.referenceLakes || [];
  textLine(ctx, "Reference glacial lakes (not live)", b.x + 20, b.y + 34, { px: 24, color: C.ink2 });
  if (!lakes.length) return noVisual(ctx, b, "No reference lakes within 300 km");
  const all = [[region.lat, region.lon], ...lakes.map((l) => [l.lat, l.lon])];
  const lats = all.map((p) => p[0]), lons = all.map((p) => p[1]);
  const x0 = Math.min(...lons) - 0.4, x1 = Math.max(...lons) + 0.4, y0 = Math.min(...lats) - 0.4, y1 = Math.max(...lats) + 0.4;
  const x = (lon) => b.x + 60 + ((lon - x0) / (x1 - x0)) * (b.w - 240), y = (lat) => b.y + 70 + ((y1 - lat) / (y1 - y0)) * (b.h - 150);
  // Labels avoid every lake's dot and each other: right of the dot, else left, else nudged down.
  const dots = lakes.map((l) => [x(l.lon), y(l.lat)]);
  for (const [dx, dy] of dots) {
    ctx.fillStyle = MID;
    ctx.beginPath();
    ctx.arc(dx, dy, 9, 0, 7);
    ctx.fill();
  }
  ctx.font = font(22);
  const placed = [];
  const hits = (r) =>
    dots.some(([dx, dy]) => dx > r.x0 - 12 && dx < r.x1 + 12 && dy > r.y0 - 12 && dy < r.y1 + 12) ||
    placed.some((q) => r.x0 < q.x1 && r.x1 > q.x0 && r.y0 < q.y1 && r.y1 > q.y0);
  lakes.forEach((l, i) => {
    const [dx, dy] = dots[i];
    const label = `${l.name} · ${l.distanceKm} km`;
    const w = ctx.measureText(label).width;
    const box = (x0, base) => ({ x0, x1: x0 + w, y0: base - 20, y1: base + 6 });
    let r = box(dx + 16, dy + 7);
    if (hits(r) || r.x1 > b.x + b.w - 10) r = box(dx - 16 - w, dy + 7);
    for (let k = 0; hits(r) && k < 6; k++) r = box(r.x0, r.y1 + 26);
    placed.push(r);
    textLine(ctx, label, r.x0, r.y1 - 6, { px: 22, color: C.ink2 });
  });
  ctx.strokeStyle = C.ink;
  ctx.lineWidth = 4;
  const cx = x(region.lon), cy = y(region.lat);
  ctx.beginPath();
  ctx.moveTo(cx - 14, cy);
  ctx.lineTo(cx + 14, cy);
  ctx.moveTo(cx, cy - 14);
  ctx.lineTo(cx, cy + 14);
  ctx.stroke();
}

/** The best visual for this card: a recently opened gridded map, else the card's chart. */
export async function pickVisual({ region, key, pillar }) {
  const fresh = (snap, hours) => snap && Date.now() - snap.fetchedAt < hours * 3_600_000;
  if (key === "heat") {
    const snap = await loadSnapshot(`heatgrid:${region.id}`).catch(() => null);
    if (fresh(snap, 24) && snap.data.cells?.some((c) => c.z != null)) return { kind: "heatgrid", data: snap.data };
  }
  if (key === "wildfire") {
    const snap = await loadSnapshot(`dispersion:${region.id}`).catch(() => null);
    if (fresh(snap, 12)) return { kind: "dispersion", data: snap.data };
  }
  return { kind: key };
}

function drawVisual(ctx, b, visual, state) {
  const { region, pillar } = state;
  if (visual.kind === "heatgrid") {
    const d = visual.data;
    const steps = [-2.75, -2.25, -1.75, -1.25, -0.75, 0, 0.75, 1.25, 1.75, 2.25, 2.75];
    const labels = ["−2.5σ", "", "", "", "", "normal", "", "", "", "", "+2.5σ"];
    return drawGrid(ctx, b, { title: `Heat vs normal for the date, ${d.date} (σ)`, grid: d.grid, values: d.cells.map((c) => c.z), colorOf: divergingColor, center: [region.lat, region.lon], legend: steps.map((z, i) => [divergingColor(z), labels[i]]) });
  }
  if (visual.kind === "dispersion") {
    const d = visual.data;
    // The forecast frame closest to now.
    const nowMs = Date.now();
    let fi = 0;
    d.times.forEach((t, i) => Math.abs(Date.parse(t + ":00Z") - nowMs) < Math.abs(Date.parse(d.times[fi] + ":00Z") - nowMs) && (fi = i));
    const names = ["Good", "Moderate", "Sensitive", "Unhealthy", "V. unhealthy"];
    return drawGrid(ctx, b, {
      title: `PM2.5 forecast (CAMS model), ${d.times[fi].slice(5, 16).replace("T", " ")} local`,
      grid: d.grid,
      values: d.pm2_5[fi],
      colorOf: (v) => (v == null ? MID : WARM[PM25_BINS.filter((x) => v >= x).length]),
      fires: d.fires || [],
      center: [region.lat, region.lon],
      legend: names.map((nm, i) => [WARM[i], nm]),
    });
  }
  if (visual.kind === "heat") return drawHeat(ctx, b, pillar);
  if (visual.kind === "seismic") return drawQuakes(ctx, b, pillar);
  if (visual.kind === "wildfire") return drawFires(ctx, b, pillar);
  return drawLakes(ctx, b, pillar, region);
}

// ---------------------------------------------------------------- the card

export function drawStoryCard(model, visual, state, canvas = document.createElement("canvas")) {
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  // Background: deep slate with a cyan and an amber glow.
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);
  for (const [gx, gy, r, color] of [[160, 0, 700, "rgba(8,145,178,0.22)"], [W - 80, 260, 600, "rgba(217,119,6,0.16)"]]) {
    const g = ctx.createRadialGradient(gx, gy, 0, gx, gy, r);
    g.addColorStop(0, color);
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  // Header
  textLine(ctx, "ZACKSCAN  ·  SITREP", PAD, 84, { px: 26, weight: 800, color: C.cyan });
  ctx.font = font(26, 700);
  const bw = ctx.measureText(model.badge).width + 64;
  rrect(ctx, PAD, 112, bw, 50, 25);
  ctx.strokeStyle = C.border;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = STATUS[model.level] || STATUS.unknown;
  ctx.beginPath();
  ctx.arc(PAD + 28, 137, 8, 0, 7);
  ctx.fill();
  textLine(ctx, model.badge, PAD + 46, 146, { px: 26, weight: 700 });
  if (model.score != null) {
    textLine(ctx, String(model.score), W - PAD - 70, 262, { px: 120, weight: 800, align: "right" });
    textLine(ctx, "/100", W - PAD, 262, { px: 30, color: C.ink2, align: "right" });
  }
  const titleW = W - 2 * PAD - (model.score != null ? 260 : 0);
  const title = wrapText(model.title, titleW, measurer(ctx, 52, 800), 2);
  title.forEach((l, i) => textLine(ctx, l, PAD, 228 + i * 60, { px: 52, weight: 800 }));
  const afterTitle = 228 + (title.length - 1) * 60;
  textLine(ctx, model.stub ? model.stub : model.when, PAD, afterTitle + 48, { px: 26, color: model.stub ? STATUS.elevated : C.ink2 });

  // Visual panel
  // A two-line title takes its room from the chart, not from the SitRep.
  const vb = { x: PAD, y: afterTitle + 80, w: W - 2 * PAD, h: title.length > 1 ? 410 : 470 };
  rrect(ctx, vb.x, vb.y, vb.w, vb.h, 24);
  ctx.fillStyle = C.glass;
  ctx.fill();
  ctx.strokeStyle = C.border;
  ctx.stroke();
  ctx.save();
  rrect(ctx, vb.x, vb.y, vb.w, vb.h, 24);
  ctx.clip();
  drawVisual(ctx, vb, visual, state);
  ctx.restore();

  // Key metrics
  const my = vb.y + vb.h + 24, mw = (W - 2 * PAD - 2 * 20) / 3;
  model.metrics.forEach(([label, value], i) => {
    const mx = PAD + i * (mw + 20);
    rrect(ctx, mx, my, mw, 118, 18);
    ctx.fillStyle = "rgba(255,255,255,0.04)";
    ctx.fill();
    ctx.strokeStyle = C.border;
    ctx.stroke();
    textLine(ctx, wrapText(label, mw - 36, measurer(ctx, 22), 1)[0], mx + 18, my + 38, { px: 22, color: C.ink3 });
    textLine(ctx, wrapText(value, mw - 36, measurer(ctx, 40, 800), 1)[0], mx + 18, my + 92, { px: 40, weight: 800 });
  });

  // SitRep panel (fills the space down to the footer)
  const sy = my + 118 + 24, footerY = H - 96;
  const sh = footerY - sy - 20;
  rrect(ctx, PAD, sy, W - 2 * PAD, sh, 24);
  ctx.fillStyle = C.glass;
  ctx.fill();
  ctx.strokeStyle = C.border;
  ctx.stroke();
  textLine(ctx, `SITREP  ·  ${model.tierLabel.toUpperCase()}`, PAD + 32, sy + 48, { px: 22, weight: 800, color: C.cyan });
  const tw = W - 2 * PAD - 64;
  let ty = sy + 96;
  const room = (lineH) => Math.max(0, Math.floor((sy + sh - 24 - ty) / lineH) + 1);
  const { headline, body, bullets } = model.sitrep;
  if (headline) {
    const hl = wrapText(headline, tw, measurer(ctx, 34, 800), Math.min(2, room(42)));
    hl.forEach((l) => ((textLine(ctx, l, PAD + 32, ty, { px: 34, weight: 800 }), (ty += 42))));
    ty += 6;
  }
  const bodyLines = wrapText(body, tw, measurer(ctx, 29), Math.min(bullets.length ? 4 : 6, room(38)));
  bodyLines.forEach((l) => ((textLine(ctx, l, PAD + 32, ty, { px: 29, color: C.ink }), (ty += 38))));
  ty += 6;
  for (const bl of bullets) {
    const lines = wrapText(bl, tw - 30, measurer(ctx, 26), Math.min(2, room(34)));
    if (!lines.length) break;
    textLine(ctx, "•", PAD + 34, ty, { px: 26, color: C.cyan });
    lines.forEach((l) => ((textLine(ctx, l, PAD + 62, ty, { px: 26, color: C.ink2 }), (ty += 34))));
  }

  // Footer: sources, SitRep origin, link
  const src = wrapText(`Data: ${model.sources.join(" · ")}  |  SitRep: ${model.sitrepSource}`, W - 2 * PAD, measurer(ctx, 20), 2);
  src.forEach((l, i) => textLine(ctx, l, PAD, footerY + 14 + i * 26, { px: 20, color: C.ink3 }));
  textLine(ctx, model.link, PAD, H - 26, { px: 22, weight: 700, color: C.ink2 });
  return canvas;
}

// ---------------------------------------------------------------- export & share

export async function makeStoryImage(state) {
  if (document.fonts?.ready) await document.fonts.ready;
  const model = buildStoryModel({ ...state, origin: location.origin });
  const visual = await pickVisual(state);
  const canvas = drawStoryCard(model, visual, state);
  // JPEG keeps a phone-sized card to a couple of hundred KB for messaging apps.
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.88));
  return { model, blob, file: new File([blob], model.fileName, { type: "image/jpeg" }) };
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/**
 * One tap: build the image and open the share sheet with it (and a short
 * caption). Falls back to downloading the image.
 * @returns "shared" | "downloaded" | "cancelled"
 */
export async function shareStoryCard(state) {
  const { model, blob, file } = await makeStoryImage(state);
  const text = `${model.title} (${model.badge})\n${model.sitrep.headline || model.sitrep.body.split(". ")[0]}\n${location.origin}/?focus=${encodeURIComponent(model.region.id)}`;
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: model.title, text });
      return "shared";
    } catch (e) {
      if (e?.name === "AbortError") return "cancelled";
      // Any other failure (no share target, lost gesture): save the image instead.
    }
  }
  download(blob, model.fileName);
  return "downloaded";
}
