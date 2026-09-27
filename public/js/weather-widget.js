// Daily weather widget: today's high, humidity and wind for one location, each
// against the seasonal normal ("36.3 °C: −0.8σ below seasonal average").
//
// For the 6 watchlist cities the data comes from /api/risk (pre-computed,
// already in the matrix). For any other location it comes from /api/weather
// (on-demand, same pipeline). The combobox shows Quick picks, Recent, and
// live geocoding search results.

import { divergingColor } from "./charts.js";
import { ageLabel } from "./offline-logic.js";
import { REGION_LIST, REGION_IDS } from "./regions.js";
import { searchLocations, getRecentLocations } from "./geocode.js";

const sig = (z) => `${z > 0 ? "+" : z < 0 ? "−" : ""}${Math.abs(z)}σ`;

const MEASURES = [
  {
    key: "tmax",
    field: "tmaxC",
    label: "High",
    unit: "°C",
    words: ["cooler", "hotter"],
  },
  {
    key: "rhMean",
    field: "rhMeanPct",
    label: "Humidity (daily mean)",
    unit: "%",
    words: ["drier", "more humid"],
  },
  {
    key: "windMax",
    field: "windMaxKmh",
    label: "Wind (daily max)",
    unit: "km/h",
    words: ["calmer", "windier"],
  },
];

// ---------------------------------------------------------------- telemetry

export function weatherTelemetry(matrix, regionId, now = Date.now()) {
  const r = matrix?.regions?.find((x) => x.id === regionId);
  const w = r?.weather;
  if (!w?.today) return { region: r || { id: regionId }, ready: false };
  return buildTelemetry(r, w, now);
}

/** For a searched city: pass the region object and the /api/weather response directly. */
export function weatherTelemetryDirect(regionObj, weather, now = Date.now()) {
  if (!weather?.today) return { region: regionObj, ready: false };
  return buildTelemetry(regionObj, weather, now);
}

function buildTelemetry(region, w, now) {
  const year = new Date(now).getUTCFullYear();
  return {
    region,
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
      return {
        ...m,
        value: v,
        z: n.z ?? null,
        mean: n.mean ?? null,
        std: n.std ?? null,
        text,
      };
    }),
    baselineLabel: w.baselineYears
      ? `Seasonal average: the same dates (${w.window}) in ${year - 10}–${year - 1}, from ERA5 via Open-Meteo.`
      : "The 10-year seasonal average is still being built.",
  };
}

// ---------------------------------------------------------------- location picker (combobox)

export function buildPicker(currentLoc, onSelect) {
  const wrap = document.createElement("div");
  wrap.className = "wx-picker";

  const input = document.createElement("input");
  input.type = "text";
  input.className = "wx-search-input";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-expanded", "false");
  input.setAttribute("aria-haspopup", "listbox");
  input.setAttribute("aria-label", "Weather location");
  input.placeholder = "Search any city or place…";
  input.value = currentLoc.name;

  const hint = document.createElement("span");
  hint.className = "wx-hint";
  hint.textContent = "Search any location";

  const list = document.createElement("div");
  list.className = "wx-dropdown";
  list.setAttribute("role", "listbox");
  list.hidden = true;

  wrap.append(hint, input, list);

  let debounce = null;
  let activeSearch = null; // promise of the in-flight search

  function selectFirst() {
    const first = list.querySelector(".wx-option");
    if (first)
      first.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  }

  function option(loc) {
    const el = document.createElement("div");
    el.className = "wx-option";
    el.setAttribute("role", "option");
    el.textContent = loc.name;
    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      close();
      input.value = loc.name;
      onSelect(loc);
    });
    return el;
  }

  function group(label) {
    const el = document.createElement("div");
    el.className = "wx-group-label";
    el.textContent = label;
    return el;
  }

  function populate(groups) {
    list.innerHTML = "";
    let any = false;
    for (const { label, items } of groups) {
      if (!items.length) continue;
      any = true;
      list.append(group(label), ...items.map(option));
    }
    list.hidden = !any;
    input.setAttribute("aria-expanded", String(!list.hidden));
  }

  function showDefault() {
    activeSearch = null;
    const recent = getRecentLocations().filter(
      (r) => !REGION_IDS.includes(r.id),
    );
    populate([
      { label: "Quick picks", items: REGION_LIST },
      ...(recent.length ? [{ label: "Recent", items: recent }] : []),
    ]);
  }

  async function search(q, { autoSelect = false } = {}) {
    list.innerHTML = "";
    list.append(group("Searching…"));
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    const p = searchLocations(q).catch(() => []);
    activeSearch = p;
    const results = await p;
    if (activeSearch !== p) return; // superseded
    activeSearch = null;
    populate([
      {
        label: results.length ? "Results" : "No results found",
        items: results,
      },
    ]);
    // Inline autocomplete: fill the rest of the first result as selected text
    if (results.length && document.activeElement === input) {
      const full = results[0].name;
      if (
        full.toLowerCase().startsWith(q.toLowerCase()) &&
        full.length > q.length
      ) {
        const start = input.selectionStart ?? q.length;
        input.value = q + full.slice(q.length);
        input.setSelectionRange(start, input.value.length);
      }
    }
    if (autoSelect) selectFirst();
  }

  function close() {
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
  }

  input.addEventListener("focus", () => {
    input.select();
    showDefault();
  });

  input.addEventListener("input", () => {
    clearTimeout(debounce);
    const q = input.value.trim();
    if (!q) {
      showDefault();
      return;
    }
    debounce = setTimeout(() => search(q), 200);
  });

  input.addEventListener("blur", () => {
    setTimeout(() => {
      close();
      if (!input.value.trim()) input.value = currentLoc.name;
    }, 150);
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      close();
      input.blur();
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const q = input.value.trim();
      if (!q) return;
      const first = list.querySelector(".wx-option");
      if (first) {
        // Results already loaded — pick the first one immediately.
        first.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      } else if (activeSearch) {
        // Still fetching — auto-select the first result when it arrives.
        activeSearch.then(() => selectFirst());
      } else {
        // Debounce hasn't fired yet — kick off the search now and auto-select.
        clearTimeout(debounce);
        search(q, { autoSelect: true });
      }
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      list.querySelector(".wx-option")?.focus();
    }
  });

  // Keyboard nav within dropdown
  list.addEventListener("keydown", (e) => {
    const opts = [...list.querySelectorAll(".wx-option")];
    const i = opts.indexOf(document.activeElement);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      opts[i + 1]?.focus();
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      i > 0 ? opts[i - 1]?.focus() : input.focus();
    }
    if (e.key === "Enter" && i >= 0)
      opts[i].dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    if (e.key === "Escape") {
      close();
      input.focus();
    }
  });

  // Make options focusable for arrow-key nav
  new MutationObserver(() => {
    for (const o of list.querySelectorAll(".wx-option")) o.tabIndex = -1;
  }).observe(list, { childList: true, subtree: true });

  return wrap;
}

// ---------------------------------------------------------------- render

export function renderWeather(el, t, { onRegion } = {}) {
  el.replaceChildren();

  const currentLoc = t.region?.name
    ? t.region
    : REGION_LIST.find((r) => r.id === t.region?.id) || {
        id: t.region?.id,
        name: t.region?.id || "",
      };

  const head = document.createElement("div");
  head.className = "wx-head";
  head.append(buildPicker(currentLoc, (loc) => onRegion?.(loc)));
  el.append(head);

  if (!t.ready) {
    const p = document.createElement("p");
    p.className = "meta";
    p.textContent =
      "Today's weather for this place isn't available yet. It appears with the next data refresh.";
    el.append(p);
    return;
  }

  const rows = document.createElement("div");
  rows.className = "wx-rows";
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
    normal.textContent =
      row.mean != null
        ? `normal ${row.mean}${row.std != null ? ` ± ${row.std}` : ""} ${row.unit}`
        : "";
    item.append(sw, label, value, anomaly, normal);
    rows.append(item);
  }
  el.append(rows);

  const now = document.createElement("p");
  now.className = "wx-now";
  const c = t.current;
  now.textContent = c
    ? `Now ${c.tempC} °C · ${c.rh}% humidity · wind ${Math.round(c.windKmh)} km/h · updated ${ageLabel(Date.parse(t.asOf))}`
    : "";

  const note = document.createElement("p");
  note.className = "meta";
  note.textContent = t.baselineLabel;

  el.append(now, note);

  // For non-watchlist cities, make it explicit that hazard scores don't follow.
  if (currentLoc.custom || !REGION_IDS.includes(currentLoc.id)) {
    const offlist = document.createElement("p");
    offlist.className = "wx-offlist";
    offlist.textContent =
      "Hazard risk scores aren't tracked outside the 6 watchlist cities.";
    el.append(offlist);
  }
}
