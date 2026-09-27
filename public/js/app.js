import { createMissionState } from "./state.js";
import { KeyVault } from "./keyvault.js";
import { api } from "./api.js";
import { AI_PROVIDERS } from "./ai-catalog.js";
import { startRiskPanel } from "./risk.js";
import { dataSaverOn } from "./poller.js";
import { saveSitrep, loadSitrep } from "./offline-store.js";
import { ageLabel } from "./offline-logic.js";
import {
  renderTieredAssessment,
  preferredTier,
  setPreferredTier,
  isTiered,
} from "./tier-toggle.js";
import { createAlarmController } from "./alarms.js";
import { renderAlarmSettings } from "./alarm-settings.js";
import { renderAnomalies } from "./anomaly-deck.js";
import {
  getOperator,
  setOperator,
  deviceCapabilities,
  ROLES,
} from "./operator.js";
import {
  weatherTelemetry,
  weatherTelemetryDirect,
  renderWeather,
  buildPicker,
} from "./weather-widget.js";
import { REGION_LIST, REGION_IDS, regionName } from "./regions.js";
import { getCustomProfiles, getCustomProfile } from "./custom-profiles.js";
import { initProfileCreator } from "./profile-creator.js";
import { PROFILES } from "./profiles.js";
import { addRecentLocation } from "./geocode.js";
import { fetchAndRenderSeaIce } from "./sea-ice-card.js";

// ------------------------------------------------------------ profile bar (header)
// Nothing about the operator is hardcoded: mission, name, organization and
// role come from this device's settings; the chips report real capabilities.
async function renderProfileBar() {
  const bar = document.querySelector("#profile-bar");
  if (!bar) return;
  const op = getOperator();
  const mission =
    document.querySelector("#profile")?.selectedOptions?.[0]?.textContent || "";
  const caps = await deviceCapabilities({
    hasOwnKey: !!KeyVault.get(),
    dataSaver: dataSaverOn(),
  });
  bar.replaceChildren();
  const m = document.createElement("span");
  m.className = "pb-mission";
  m.textContent = mission;
  bar.append(m);
  const who = document.createElement("span");
  who.className = "pb-who";
  if (op.name || op.organization)
    who.textContent = [op.name, op.organization, ROLES[op.role].label]
      .filter(Boolean)
      .join(" · ");
  else {
    const set = document.createElement("button");
    set.type = "button";
    set.className = "link";
    set.textContent = "Set up your profile";
    set.addEventListener("click", () => {
      document.querySelector("#settings").showModal();
      document.querySelector("#op-name")?.focus();
    });
    who.append(set);
  }
  bar.append(who);
  const chips = document.createElement("span");
  chips.className = "pb-caps";
  for (const c of caps) {
    const chip = document.createElement("span");
    chip.className = "cap " + (c.ok ? "cap-ok" : "cap-warn");
    chip.textContent = (c.ok ? "✓ " : "! ") + c.label;
    chips.append(chip);
  }
  bar.append(chips);
}
addEventListener("zackscan:operator", renderProfileBar);
navigator.serviceWorker?.addEventListener("controllerchange", renderProfileBar);

// ------------------------------------------------------------ weather widget
// wxLocation is either { id } for a watchlist city or { id, name, lat, lon, custom:true }
// for a searched city. Only the weather panel follows this; the risk matrix always
// shows all 6 watchlist cities regardless of what's searched here.
let wxLocation = getOperator().homeLocation || { id: getOperator().homeRegion };
let wxWeatherCache = null; // { id, data } — avoids re-fetching on matrix refreshes

function onWeatherSelect(loc) {
  // loc is a location object from the combobox (pinned or searched)
  wxLocation = typeof loc === "string" ? { id: loc } : loc;
  wxWeatherCache = null;
  if (wxLocation.custom) addRecentLocation(wxLocation);
  drawWeather();
}

async function drawWeather() {
  const el = document.querySelector("#weather");
  if (!el) return;
  const loc = wxLocation;
  if (loc.custom) {
    // Non-watchlist city: fetch from /api/weather, cache until location changes.
    let data = wxWeatherCache?.id === loc.id ? wxWeatherCache.data : null;
    if (!data) {
      try {
        data = await api.weather(loc.lat, loc.lon);
        wxWeatherCache = { id: loc.id, data };
      } catch {
        renderWeather(
          el,
          { region: loc, ready: false },
          { onRegion: onWeatherSelect },
        );
        return;
      }
    }
    renderWeather(el, weatherTelemetryDirect(loc, data.weather), {
      onRegion: onWeatherSelect,
    });
  } else {
    if (deck.matrix)
      renderWeather(el, weatherTelemetry(deck.matrix, loc.id), {
        onRegion: onWeatherSelect,
      });
  }
}

// ------------------------------------------------------------ anomaly cards
const deck = { matrix: null, source: null, full: {} };
function drawDeck() {
  if (deck.matrix)
    renderAnomalies(
      document.querySelector("#anomalies"),
      deck.matrix,
      deck.source,
      { full: deck.full, onNeedFull: loadFullRegion },
    );
}
// Data saver sends the small summary; a card can ask for its region in full.
async function loadFullRegion(id) {
  try {
    const m = await (
      await fetch("/api/risk?region=" + encodeURIComponent(id), {
        cache: "no-cache",
      })
    ).json();
    if (m.regions?.[0]?.pillars) deck.full[id] = m.regions[0];
    drawDeck();
  } catch {}
}

const $ = (s) => document.querySelector(s);
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

let mission = null; // assigned below; render() can run before createMissionState returns

// ------------------------------------------------------------ connection status
// One line that always says whether the screen is live, and if not, how old it is.
const net = { risk: null, feed: null };
function renderNet() {
  const el = $("#net-status");
  const parts = [];
  // "starting" = saved data drawn while the first fetch is in flight: not offline yet.
  const offline =
    navigator.onLine === false ||
    (net.risk && net.risk.live === false && !net.risk.starting);
  if (offline) {
    parts.push("<b>Offline.</b> Showing data saved on this device:");
    parts.push(
      `risk matrix ${net.risk?.fetchedAt ? "from " + esc(ageLabel(net.risk.fetchedAt)) : "not saved yet"}`,
    );
    if (mission?.state.offlineFrom)
      parts.push(`· events from ${esc(ageLabel(mission.state.offlineFrom))}`);
  } else if (
    (net.risk?.poll?.failures || 0) > 0 ||
    (net.feed?.failures || 0) > 0
  ) {
    const next = [net.risk?.poll?.nextAt, net.feed?.nextAt]
      .filter(Boolean)
      .sort()[0];
    parts.push(
      `<b>Connection problems.</b> Retrying ${next ? "in " + Math.max(1, Math.round((next - Date.now()) / 60_000)) + " min" : "soon"}, slowing down to save battery and data.`,
    );
  }
  if (dataSaverOn())
    parts.push("Data saver on: smaller, less frequent updates.");
  el.innerHTML = parts.join(" ");
  el.hidden = !parts.length;
  el.classList.toggle("offline", !!offline);
}
addEventListener("online", renderNet);
addEventListener("offline", renderNet);
setInterval(renderNet, 30_000);

// ------------------------------------------------------------ alarms
const alarms = createAlarmController({
  banner: $("#alarm-banner"),
  onView: (a) => focusRegion(a.regionId),
});

/** Open a region's row in the risk matrix and bring it into view ("View SitRep"). */
function focusRegion(id, tries = 40) {
  const row =
    id && document.querySelector(`#risk [data-region="${CSS.escape(id)}"]`);
  if (!row)
    return tries > 0 && setTimeout(() => focusRegion(id, tries - 1), 250);
  row.querySelector("details").open = true;
  row.scrollIntoView({ behavior: "smooth", block: "start" });
  row.classList.add("focused");
  setTimeout(() => row.classList.remove("focused"), 4000);
}
// Opened from a notification: /?focus=<region>
const focusParam = new URLSearchParams(location.search).get("focus");
if (focusParam) {
  focusRegion(focusParam);
  history.replaceState(null, "", location.pathname + location.hash);
}

let health = null;
$("#open-alarms").addEventListener("click", async () => {
  health ||= await fetch("/api/health", { cache: "no-cache" })
    .then((r) => r.json())
    .catch(() => null);
  await renderAlarmSettings($("#alarms-body"), alarms, health);
  $("#alarms").showModal();
});
$("#alarms-close").addEventListener("click", () => $("#alarms").close());
// Pinned "✕ Close" at the top of every sheet: always reachable, however long the content.
document.addEventListener("click", (e) =>
  e.target.closest("[data-close]")?.closest("dialog")?.close(),
);

// Once per device: say plainly when background alerts can't be relied on here.
const notice = alarms.noticeOnce();
if (notice) {
  const el = $("#alert-notice");
  el.innerHTML = `<b>Alerts on this device:</b> ${esc(notice.message)} <button type="button">Got it</button>`;
  el.hidden = false;
  el.querySelector("button").addEventListener("click", () => {
    notice.dismiss();
    el.hidden = true;
  });
}

startRiskPanel($("#risk"), {
  onMatrix: (m) => alarms.onMatrix(m),
  onRender: (m, s) => {
    Object.assign(deck, { matrix: m, source: s, full: {} });
    drawDeck();
    drawWeather();
  },
  onStatus: (s) => {
    net.risk = s;
    renderNet();
    // Only after a real failed fetch, not while saved data is drawn at startup.
    if (s && s.live === false && !s.starting) requestBackgroundRefresh();
  },
});

// ------------------------------------------------------------ mission + feed
mission = createMissionState({
  onChange: render,
  onPoll: (s) => {
    net.feed = s;
    renderNet();
  },
  resolveProfile: (id) => getCustomProfile(id),
});

// Profile picker — includes custom profiles stored in localStorage.
const picker = $("#profile");

function rebuildPicker() {
  const current = mission.state.profile.id;
  const all = [...Object.values(PROFILES), ...getCustomProfiles()];
  picker.innerHTML = all
    .map((p) => `<option value="${p.id}">${esc(p.name)}</option>`)
    .join("");
  if (all.some((p) => p.id === current)) picker.value = current;
}
rebuildPicker();

picker.addEventListener("change", () => {
  const id = picker.value;
  const custom = getCustomProfile(id);
  mission.setProfile(id, custom || null);
  showSavedSitrep();
});

addEventListener("zackscan:profiles", () => {
  rebuildPicker();
  renderProfileBar();
});

// "＋ New profile" button opens the creator sheet.
$("#open-creator").addEventListener("click", () =>
  $("#profile-creator").showModal(),
);
initProfileCreator({
  onSaved(profile) {
    rebuildPicker();
    mission.setProfile(profile.id, profile);
    showSavedSitrep();
    renderProfileBar();
  },
});

function render(s) {
  const p = s.profile;
  const every =
    p.pollMs >= 60000 ? p.pollMs / 60000 + " min" : p.pollMs / 1000 + " s";
  $("#poll").textContent =
    `Refreshes about every ${every}${dataSaverOn() ? " (slower on data saver)" : ""}`;
  $("#status").textContent = s.loading
    ? "Updating…"
    : s.offlineFrom
      ? `Offline: ${s.events.length} events saved ${ageLabel(s.offlineFrom)}`
      : s.error
        ? "Couldn't update: " + s.error
        : `${s.events.length} open events` +
          (s.lastFetch
            ? " · " + new Date(s.lastFetch).toLocaleTimeString()
            : "");
  $("#feed-warn").textContent = s.feedErrors.length
    ? "Some sources didn't answer: " + s.feedErrors.join(", ")
    : "";
  $("#events").innerHTML = s.events
    .slice(0, 50)
    .map(
      (e) => `<li><span class="cat">${esc(e.category)}</span> ${esc(e.title)}
        <small>${e.magnitude != null ? esc(e.magnitude + " " + (e.magnitudeUnit || "")) + " · " : ""}${e.time ? new Date(e.time).toLocaleString() : ""}</small></li>`,
    )
    .join("");
  renderNet();
}

// ------------------------------------------------------------ AI assessment (SitRep)
// Each assessment holds BOTH registers (plain + researcher). The toggle switches
// between them locally; a new AI call happens only when the data changed.
async function savedSitrep(profileId) {
  const saved = await loadSitrep(profileId);
  return saved && isTiered(saved.result) ? saved : null; // results from before the two-tier layer are ignored
}

async function showSavedSitrep(prefix = "") {
  const saved = await savedSitrep(mission.state.profile.id);
  const out = $("#assessment");
  if (!saved) return void (out.innerHTML = prefix);
  const note = `${prefix}<p class="saved-note">Saved assessment from ${esc(ageLabel(saved.savedAt))}. Not live.</p>`;
  renderTieredAssessment(out, saved.result, { note });
}
showSavedSitrep();

$("#analyze").addEventListener("click", async () => {
  const out = $("#assessment");
  const btn = $("#analyze");
  const profileId = mission.state.profile.id;
  btn.disabled = true;
  const saved = await savedSitrep(profileId);
  out.insertAdjacentHTML(
    "afterbegin",
    '<p class="meta assessing">Checking for new data…</p>',
  );
  try {
    const profile = mission.state.profile;
    const r = await (profile.custom
      ? api.analyzeCustom(profile, saved?.result.fingerprint)
      : api.analyze(profileId, saved?.result.fingerprint));
    if (r.unchanged && saved) {
      // Same telemetry as the saved assessment: reuse it, no AI call was made.
      const note = `<p class="saved-note fresh">No new data since this assessment (${esc(ageLabel(Date.parse(saved.result.generatedAt) || saved.savedAt))}), so it wasn’t regenerated.</p>`;
      renderTieredAssessment(out, saved.result, { note });
      return;
    }
    if (!r.assessment) {
      out.innerHTML = `<p>${esc(r.note)}</p>`;
      return;
    }
    renderTieredAssessment(out, r);
    await saveSitrep(profileId, r); // the public result only; the key is never stored here
  } catch (e) {
    const offline = navigator.onLine === false || e instanceof TypeError; // fetch network failure
    await showSavedSitrep(
      `<p class="err">${esc(offline ? "You’re offline, so no new assessment." : e.message)}</p>`,
    );
    if (
      e.code === "byok_key_rejected" ||
      e.code === "platform_rate_limited" ||
      e.code === "platform_unavailable"
    )
      $("#settings").showModal();
  } finally {
    out.querySelector(".assessing")?.remove();
    btn.disabled = false;
  }
});

// Settings: default explanation style, kept in step with every open toggle.
for (const r of document.querySelectorAll("input[name=tier-pref]")) {
  r.checked = r.value === preferredTier();
  r.addEventListener("change", () => r.checked && setPreferredTier(r.value));
}
addEventListener("zackscan:tier", (e) => {
  for (const r of document.querySelectorAll("input[name=tier-pref]"))
    r.checked = r.value === e.detail;
});

// ------------------------------------------------------------ service worker
let swReg = null;
async function requestBackgroundRefresh() {
  // One-off Background Sync (Chromium): the browser fires it once connectivity returns.
  try {
    await swReg?.sync?.register("risk-refresh");
  } catch {}
}

if ("serviceWorker" in navigator) {
  let updateRequested = false;
  navigator.serviceWorker
    .register("/sw.js")
    .then(async (reg) => {
      swReg = reg;
      const offerUpdate = (worker) => {
        $("#update-bar").hidden = false;
        $("#update-now").onclick = () => {
          updateRequested = true;
          worker.postMessage({ type: "SKIP_WAITING" });
        };
      };
      if (reg.waiting && navigator.serviceWorker.controller)
        offerUpdate(reg.waiting);
      reg.addEventListener("updatefound", () => {
        const w = reg.installing;
        w?.addEventListener(
          "statechange",
          () =>
            w.state === "installed" &&
            navigator.serviceWorker.controller &&
            offerUpdate(w),
        );
      });
      // Force a fetch of sw.js on every page load so the update banner appears
      // within seconds of opening the app after a deploy.
      reg.update().catch(() => {});
      // Periodic Background Sync (installed app, Chromium only; the browser sets the real rate).
      try {
        const perm = await navigator.permissions.query({
          name: "periodic-background-sync",
        });
        if (perm.state === "granted")
          await reg.periodicSync.register("risk-refresh", {
            minInterval: 60 * 60_000,
          });
      } catch {}
    })
    .catch(() => {}); // no service worker: the app still works online
  // Reload only when the user tapped "Update", never out from under them.
  navigator.serviceWorker.addEventListener(
    "controllerchange",
    () => updateRequested && location.reload(),
  );
  // Check for updates whenever the tab becomes visible again (catches deploys
  // that happened while the tab was in the background).
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") swReg?.update().catch(() => {});
  });
}

// ------------------------------------------------------------ data saver setting
const saver = $("#data-saver");
try {
  saver.checked = localStorage.getItem("zackscan.dataSaver") === "on";
} catch {}
saver.addEventListener("change", () => {
  try {
    localStorage.setItem("zackscan.dataSaver", saver.checked ? "on" : "auto");
  } catch {}
  render(mission.state);
});

// ------------------------------------------------------------ settings: bring your own key
const provSel = $("#key-provider");
const modelSel = $("#key-model");
provSel.innerHTML = Object.entries(AI_PROVIDERS)
  .map(([id, p]) => `<option value="${id}">${esc(p.label)}</option>`)
  .join("");

function fillModels(provider, selected) {
  const p = AI_PROVIDERS[provider];
  modelSel.innerHTML = p.models
    .map((m) => `<option value="${m.id}">${esc(m.label)}</option>`)
    .join("");
  modelSel.value = selected || p.defaultModel;
  $("#key-hint").textContent = "(" + p.keyHint + ")";
}
provSel.addEventListener("change", () => fillModels(provSel.value));

function renderKey() {
  const m = KeyVault.masked();
  const where = {
    tab: "until this tab closes",
    device: "on this device",
    memory: "until the page reloads",
  }[KeyVault.where()];
  $("#key-state").textContent = m
    ? `Using your ${m.providerLabel} key ${m.hint} with ${m.modelLabel}, kept ${where}.`
    : "No key set. AI uses the shared tier with a daily limit.";
  $("#key-clear").hidden = !m;
  $("#key-remember").checked = KeyVault.where() === "device";
  provSel.value = m ? m.provider : provSel.value || "gemini";
  fillModels(provSel.value, m?.model);
  $("#key-input").placeholder =
    m && m.provider === provSel.value
      ? "Leave empty to keep your saved key"
      : "";
}
$("#open-settings").addEventListener("click", () => $("#settings").showModal());
$("#settings-close").addEventListener("click", () => $("#settings").close());
$("#key-form").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const key = $("#key-input").value.trim();
  const saved = KeyVault.masked();
  let r;
  if (key)
    r = KeyVault.save(provSel.value, key, {
      remember: $("#key-remember").checked,
      model: modelSel.value,
    });
  else if (saved && saved.provider === provSel.value)
    r = KeyVault.setModel(modelSel.value); // just switching model
  else
    r = {
      ok: false,
      error: `Paste your ${AI_PROVIDERS[provSel.value].label} API key.`,
    };
  $("#key-error").textContent = r.ok ? "" : r.error;
  if (r.ok) {
    $("#key-input").value = "";
    renderKey();
  }
});
$("#key-clear").addEventListener("click", () => {
  KeyVault.clear();
  renderKey();
});
renderKey();

// ------------------------------------------------------------ settings: your profile
{
  const op = getOperator();
  const role = document.querySelector("#op-role");
  for (const [id, r] of Object.entries(ROLES))
    role.add(new Option(r.label, id, false, id === op.role));
  document.querySelector("#op-name").value = op.name;
  document.querySelector("#op-org").value = op.organization;

  // Home region: searchable location picker (replaces static <select>).
  const homeLoc = op.homeLocation || {
    id: op.homeRegion,
    name: regionName(op.homeRegion),
  };
  if (!homeLoc.name) homeLoc.name = regionName(homeLoc.id);
  const pickerEl = buildPicker(homeLoc, (loc) => {
    setOperator({ homeLocation: loc });
    wxLocation = loc;
    wxWeatherCache = null;
    drawWeather();
  });
  document.querySelector("#op-home-picker").append(pickerEl);

  const save = () => {
    const before = getOperator();
    const next = setOperator({
      name: document.querySelector("#op-name").value,
      organization: document.querySelector("#op-org").value,
      role: role.value,
    });
    // A new role sets the default reading level for AI assessments.
    if (next.role !== before.role) setPreferredTier(ROLES[next.role].tier);
  };
  for (const el of ["#op-name", "#op-org"])
    document.querySelector(el).addEventListener("change", save);
  role.addEventListener("change", save);
}
document.querySelector("#profile").addEventListener("change", renderProfileBar);
document.querySelector("#settings").addEventListener("close", renderProfileBar);
document.querySelector("#alarms").addEventListener("close", renderProfileBar);
renderProfileBar();

// ------------------------------------------------------------ sea ice card
fetchAndRenderSeaIce();
