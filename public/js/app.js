import { createMissionState } from "./state.js";
import { KeyVault } from "./keyvault.js";
import { api } from "./api.js";
import { AI_PROVIDERS } from "./ai-catalog.js";
import { startRiskPanel } from "./risk.js";
import { dataSaverOn } from "./poller.js";
import { saveSitrep, loadSitrep } from "./offline-store.js";
import { ageLabel } from "./offline-logic.js";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

let mission = null; // assigned below; render() can run before createMissionState returns

// ------------------------------------------------------------ connection status
// One line that always says whether the screen is live, and if not, how old it is.
const net = { risk: null, feed: null };
function renderNet() {
  const el = $("#net-status");
  const parts = [];
  // "starting" = saved data drawn while the first fetch is in flight: not offline yet.
  const offline = navigator.onLine === false || (net.risk && net.risk.live === false && !net.risk.starting);
  if (offline) {
    parts.push("<b>Offline.</b> Showing data saved on this device:");
    parts.push(`risk matrix ${net.risk?.fetchedAt ? "from " + esc(ageLabel(net.risk.fetchedAt)) : "not saved yet"}`);
    if (mission?.state.offlineFrom) parts.push(`· events from ${esc(ageLabel(mission.state.offlineFrom))}`);
  } else if ((net.risk?.poll?.failures || 0) > 0 || (net.feed?.failures || 0) > 0) {
    const next = [net.risk?.poll?.nextAt, net.feed?.nextAt].filter(Boolean).sort()[0];
    parts.push(
      `<b>Connection problems.</b> Retrying ${next ? "in " + Math.max(1, Math.round((next - Date.now()) / 60_000)) + " min" : "soon"}, slowing down to save battery and data.`,
    );
  }
  if (dataSaverOn()) parts.push("Data saver on: smaller, less frequent updates.");
  el.innerHTML = parts.join(" ");
  el.hidden = !parts.length;
  el.classList.toggle("offline", !!offline);
}
addEventListener("online", renderNet);
addEventListener("offline", renderNet);
setInterval(renderNet, 30_000);

startRiskPanel($("#risk"), {
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
});

// Profile picker
const picker = $("#profile");
picker.innerHTML = mission.profiles.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("");
picker.value = mission.state.profile.id;
picker.addEventListener("change", () => {
  mission.setProfile(picker.value);
  showSavedSitrep();
});

function render(s) {
  const p = s.profile;
  const every = p.pollMs >= 60000 ? p.pollMs / 60000 + " min" : p.pollMs / 1000 + " s";
  $("#poll").textContent = `Refreshes about every ${every}${dataSaverOn() ? " (slower on data saver)" : ""}`;
  $("#status").textContent = s.loading
    ? "Updating…"
    : s.offlineFrom
      ? `Offline: ${s.events.length} events saved ${ageLabel(s.offlineFrom)}`
      : s.error
        ? "Couldn't update: " + s.error
        : `${s.events.length} open events` + (s.lastFetch ? " · " + new Date(s.lastFetch).toLocaleTimeString() : "");
  $("#feed-warn").textContent = s.feedErrors.length ? "Some sources didn't answer: " + s.feedErrors.join(", ") : "";
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
function renderSitrep(r, savedAt) {
  const a = r.assessment;
  return `
    ${savedAt ? `<p class="saved-note">Saved assessment from ${esc(ageLabel(savedAt))} (${esc(new Date(savedAt).toLocaleString())}). Not live.</p>` : ""}
    <p class="risk risk-${esc(a.riskLevel)}">Risk: ${esc(a.riskLevel)}</p>
    <p>${esc(a.summary)}</p>
    <ul>${a.findings.map((f) => `<li><b>${esc(f.metric)}</b>: ${esc(f.observation)} <small>(${esc(f.confidence)} confidence)</small></li>`).join("")}</ul>
    ${a.actions.length ? `<h3>Actions</h3><ul>${a.actions.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
    <p class="meta">${r.tier === "byok" ? "Your key" : "Shared tier" + (r.allowance ? ` (${r.allowance.used}/${r.allowance.max} today)` : "")} · ${esc(r.model)} · ${r.eventCount} events</p>`;
}

async function showSavedSitrep(prefix = "") {
  const saved = await loadSitrep(mission.state.profile.id);
  $("#assessment").innerHTML = prefix + (saved ? renderSitrep(saved.result, saved.savedAt) : "");
}
showSavedSitrep();

$("#analyze").addEventListener("click", async () => {
  const out = $("#assessment");
  const btn = $("#analyze");
  const profileId = mission.state.profile.id;
  btn.disabled = true;
  out.innerHTML = "<p>Assessing…</p>";
  try {
    const r = await api.analyze(profileId);
    if (!r.assessment) {
      out.innerHTML = `<p>${esc(r.note)}</p>`;
      return;
    }
    out.innerHTML = renderSitrep(r);
    await saveSitrep(profileId, r); // the public result only; the key is never stored here
  } catch (e) {
    const offline = navigator.onLine === false || e instanceof TypeError; // fetch's network failure
    await showSavedSitrep(`<p class="err">${esc(offline ? "You're offline, so no new assessment." : e.message)}</p>`);
    if (e.code === "byok_key_rejected" || e.code === "platform_rate_limited" || e.code === "platform_unavailable") $("#settings").showModal();
  } finally {
    btn.disabled = false;
  }
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
      if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg.waiting);
      reg.addEventListener("updatefound", () => {
        const w = reg.installing;
        w?.addEventListener("statechange", () => w.state === "installed" && navigator.serviceWorker.controller && offerUpdate(w));
      });
      // Periodic Background Sync (installed app, Chromium only; the browser sets the real rate).
      try {
        const perm = await navigator.permissions.query({ name: "periodic-background-sync" });
        if (perm.state === "granted") await reg.periodicSync.register("risk-refresh", { minInterval: 60 * 60_000 });
      } catch {}
    })
    .catch(() => {}); // no service worker: the app still works online
  // Reload only when the user tapped "Update", never out from under them.
  navigator.serviceWorker.addEventListener("controllerchange", () => updateRequested && location.reload());
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
provSel.innerHTML = Object.entries(AI_PROVIDERS).map(([id, p]) => `<option value="${id}">${esc(p.label)}</option>`).join("");

function fillModels(provider, selected) {
  const p = AI_PROVIDERS[provider];
  modelSel.innerHTML = p.models.map((m) => `<option value="${m.id}">${esc(m.label)}</option>`).join("");
  modelSel.value = selected || p.defaultModel;
  $("#key-hint").textContent = "(" + p.keyHint + ")";
}
provSel.addEventListener("change", () => fillModels(provSel.value));

function renderKey() {
  const m = KeyVault.masked();
  const where = { tab: "until this tab closes", device: "on this device", memory: "until the page reloads" }[KeyVault.where()];
  $("#key-state").textContent = m
    ? `Using your ${m.providerLabel} key ${m.hint} with ${m.modelLabel}, kept ${where}.`
    : "No key set. AI uses the shared tier with a daily limit.";
  $("#key-clear").hidden = !m;
  $("#key-remember").checked = KeyVault.where() === "device";
  provSel.value = m ? m.provider : provSel.value || "gemini";
  fillModels(provSel.value, m?.model);
  $("#key-input").placeholder = m && m.provider === provSel.value ? "Leave empty to keep your saved key" : "";
}
$("#open-settings").addEventListener("click", () => $("#settings").showModal());
$("#settings-close").addEventListener("click", () => $("#settings").close());
$("#key-form").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const key = $("#key-input").value.trim();
  const saved = KeyVault.masked();
  let r;
  if (key) r = KeyVault.save(provSel.value, key, { remember: $("#key-remember").checked, model: modelSel.value });
  else if (saved && saved.provider === provSel.value) r = KeyVault.setModel(modelSel.value); // just switching model
  else r = { ok: false, error: `Paste your ${AI_PROVIDERS[provSel.value].label} API key.` };
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
