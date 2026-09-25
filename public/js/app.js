import { createMissionState } from "./state.js";
import { KeyVault } from "./keyvault.js";
import { api } from "./api.js";

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

// Settings: bring your own key
function renderKey() {
  const m = KeyVault.masked();
  const where = { tab: "until this tab closes", device: "on this device", memory: "until the page reloads" }[KeyVault.where()];
  $("#key-state").textContent = m ? `Using your ${m.provider} key ${m.hint}, kept ${where}.` : "No key set. AI uses the shared tier with a daily limit.";
  $("#key-clear").hidden = !m;
}
$("#open-settings").addEventListener("click", () => $("#settings").showModal());
$("#key-form").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const r = KeyVault.save($("#key-provider").value, $("#key-input").value, { remember: $("#key-remember").checked });
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
