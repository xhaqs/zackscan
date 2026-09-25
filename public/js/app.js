import { createMissionState } from "./state.js";
import { KeyVault } from "./keyvault.js";
import { api } from "./api.js";
import { AI_PROVIDERS } from "./ai-catalog.js";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const mission = createMissionState({ onChange: render });

// Profile picker
const picker = $("#profile");
picker.innerHTML = mission.profiles.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("");
picker.value = mission.state.profile.id;
picker.addEventListener("change", () => {
  mission.setProfile(picker.value);
  $("#assessment").innerHTML = "";
});

function render(s) {
  const p = s.profile;
  $("#poll").textContent = `Refreshes every ${p.pollMs >= 60000 ? p.pollMs / 60000 + " min" : p.pollMs / 1000 + " s"}`;
  $("#status").textContent = s.loading ? "Updating…" : s.error ? "Couldn't update: " + s.error : `${s.events.length} open events` + (s.lastFetch ? " · " + new Date(s.lastFetch).toLocaleTimeString() : "");
  $("#feed-warn").textContent = s.feedErrors.length ? "Some sources didn't answer: " + s.feedErrors.join(", ") : "";
  $("#events").innerHTML = s.events
    .slice(0, 50)
    .map(
      (e) => `<li><span class="cat">${esc(e.category)}</span> ${esc(e.title)}
        <small>${e.magnitude != null ? esc(e.magnitude + " " + (e.magnitudeUnit || "")) + " · " : ""}${e.time ? new Date(e.time).toLocaleString() : ""}</small></li>`,
    )
    .join("");
}

// AI assessment
$("#analyze").addEventListener("click", async () => {
  const out = $("#assessment");
  const btn = $("#analyze");
  btn.disabled = true;
  out.innerHTML = "<p>Assessing…</p>";
  try {
    const r = await api.analyze(mission.state.profile.id);
    if (!r.assessment) {
      out.innerHTML = `<p>${esc(r.note)}</p>`;
      return;
    }
    const a = r.assessment;
    out.innerHTML = `
      <p class="risk risk-${esc(a.riskLevel)}">Risk: ${esc(a.riskLevel)}</p>
      <p>${esc(a.summary)}</p>
      <ul>${a.findings.map((f) => `<li><b>${esc(f.metric)}</b>: ${esc(f.observation)} <small>(${esc(f.confidence)} confidence)</small></li>`).join("")}</ul>
      ${a.actions.length ? `<h3>Actions</h3><ul>${a.actions.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
      <p class="meta">${r.tier === "byok" ? "Your key" : "Shared tier" + (r.allowance ? ` (${r.allowance.used}/${r.allowance.max} today)` : "")} · ${esc(r.model)} · ${r.eventCount} events</p>`;
  } catch (e) {
    out.innerHTML = `<p class="err">${esc(e.message)}</p>`;
    if (e.code === "byok_key_rejected" || e.code === "platform_rate_limited" || e.code === "platform_unavailable") $("#settings").showModal();
  } finally {
    btn.disabled = false;
  }
});

// Settings: bring your own key (any listed provider and model)
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
