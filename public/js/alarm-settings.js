// Alarm Settings: background alerts on/off with an honest status line, sound
// and vibration with tests, the built-in critical alarm, and custom
// threshold rules ("alert me if PM2.5 exceeds 150 in Delhi").

import { METRICS, REPEAT_HOURS, CRITICAL_SCORE } from "./alarm-rules.js";
import { REGION_LIST } from "./regions.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const newId = () => Math.random().toString(36).slice(2, 10).padEnd(8, "0");
const NEEDS = { openaq: "needs an OpenAQ key on the server", firms: "needs a NASA FIRMS key on the server" };

/**
 * @param root        element to render into
 * @param controller  from createAlarmController()
 * @param health      /api/health response (which server keys exist), or null
 */
export async function renderAlarmSettings(root, controller, health = null) {
  const sub = await controller.currentSubscription().catch(() => null);
  const ready = controller.readiness();
  const p = controller.platform();
  const prefs = controller.prefs;
  const pushOn = !!sub && ready.status === "ready";
  const serverPush = health?.keys?.push !== false;

  root.innerHTML = `
    <section class="alarm-sec">
      <h3>Background alerts</h3>
      <p class="alarm-status status-${esc(pushOn ? "on" : ready.status)}" role="status">${esc(
        pushOn ? "On: this device gets alerts even when Zackscan is closed." : !serverPush ? "Not available yet: the server has no push keys." : ready.message,
      )}</p>
      <div class="row">
        ${
          pushOn
            ? `<button type="button" data-act="push-off">Turn off</button>
               <button type="button" data-act="push-test">Send test alert</button>
               <button type="button" data-act="push-test-critical">Test critical alert</button>`
            : ["needs-permission", "ready"].includes(ready.status) && serverPush
              ? `<button type="button" data-act="push-on">Turn on background alerts</button>`
              : ""
        }
      </div>
    </section>

    <section class="alarm-sec">
      <h3>Sound and vibration</h3>
      <label class="check"><input type="checkbox" data-pref="sound" ${prefs.sound ? "checked" : ""}> Alarm sound while Zackscan is open</label>
      <label>Volume <input type="range" min="0.1" max="1" step="0.1" value="${prefs.volume}" data-pref="volume" aria-label="Alarm volume"></label>
      <label class="check"><input type="checkbox" data-pref="vibrate" ${prefs.vibrate ? "checked" : ""} ${p.canVibrate ? "" : "disabled"}> Vibrate${p.canVibrate ? "" : " (not supported on this device)"}</label>
      <div class="row">
        <button type="button" data-test="critical">Test critical siren</button>
        <button type="button" data-test="alarm">Test alarm</button>
        <button type="button" data-test="reminder">Test reminder</button>
      </div>
      <p class="hint">Sound plays only while Zackscan is open. When it's closed, alerts arrive as notifications with your phone's own sound.</p>
    </section>

    <section class="alarm-sec">
      <h3>Rules</h3>
      <ul class="rule-list">
        ${controller.rules
          .map(
            (r) => `<li data-id="${esc(r.id)}">
              <label class="check"><input type="checkbox" data-rule-toggle ${r.enabled ? "checked" : ""}>
                <span>${r.builtin ? `<b>Critical alarm:</b> any region's overall risk above ${CRITICAL_SCORE}` : esc(controller.describe(r))}${
                  METRICS[r.metric]?.needs && health && !health.keys?.[METRICS[r.metric].needs] ? ` <small class="warn">(${NEEDS[METRICS[r.metric].needs]}, so it can't fire yet)</small>` : ""
                }</span></label>
              ${r.builtin ? "" : `<button type="button" class="link" data-rule-delete aria-label="Delete rule">Delete</button>`}
            </li>`,
          )
          .join("")}
      </ul>
      <form class="rule-form">
        <h4>Add a rule</h4>
        <label>Measurement <select name="metric">${Object.entries(METRICS)
          .map(([k, m]) => `<option value="${k}">${esc(m.label)}${m.needs && health && !health.keys?.[m.needs] ? " (not available yet)" : ""}</option>`)
          .join("")}</select></label>
        <label>Region <select name="region"><option value="any">Any region</option>${REGION_LIST.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join("")}</select></label>
        <label>Above <span class="inline"><input name="value" type="number" required inputmode="decimal"> <span class="unit"></span></span></label>
        <label>Type <select name="kind">
          <option value="alarm">Alarm (once when it crosses)</option>
          ${REPEAT_HOURS.map((h) => `<option value="reminder:${h}">Reminder every ${h} h until acknowledged</option>`).join("")}
        </select></label>
        <button type="submit">Add rule</button>
      </form>
      <p class="err" aria-live="polite"></p>
    </section>`;

  const err = root.querySelector(".err");
  const fail = (e) => (err.textContent = e.message || String(e));
  const busy = async (btn, fn) => {
    btn.disabled = true;
    err.textContent = "";
    try {
      await fn();
    } catch (e) {
      fail(e);
    } finally {
      btn.disabled = false;
    }
  };

  // Threshold input follows the chosen measurement's range and unit.
  const form = root.querySelector(".rule-form");
  const syncMetric = () => {
    const m = METRICS[form.metric.value];
    Object.assign(form.value, { min: m.min, max: m.max, step: m.step });
    form.value.placeholder = `${m.min}–${m.max}`;
    form.querySelector(".unit").textContent = m.unit;
  };
  form.metric.addEventListener("change", syncMetric);
  syncMetric();

  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const [kind, h] = form.kind.value.split(":");
    const rule = { id: newId(), metric: form.metric.value, region: form.region.value, value: Number(form.value.value), kind, ...(h ? { repeatHours: Number(h) } : {}), enabled: true };
    busy(form.querySelector("button"), async () => {
      await controller.setRules([...controller.rules, rule]);
      await renderAlarmSettings(root, controller, health);
    });
  });

  root.querySelector(".rule-list").addEventListener("change", (ev) => {
    const id = ev.target.closest("li")?.dataset.id;
    if (!ev.target.matches("[data-rule-toggle]") || !id) return;
    controller.setRules(controller.rules.map((r) => (r.id === id ? { ...r, enabled: ev.target.checked } : r))).catch(fail);
  });
  root.querySelector(".rule-list").addEventListener("click", (ev) => {
    const id = ev.target.closest("li")?.dataset.id;
    if (!ev.target.matches("[data-rule-delete]") || !id) return;
    busy(ev.target, async () => {
      await controller.setRules(controller.rules.filter((r) => r.id !== id));
      await renderAlarmSettings(root, controller, health);
    });
  });

  for (const el of root.querySelectorAll("[data-pref]"))
    el.addEventListener("change", () => controller.setPrefs({ [el.dataset.pref]: el.type === "checkbox" ? el.checked : Number(el.value) }));
  for (const b of root.querySelectorAll("[data-test]")) b.addEventListener("click", () => controller.testLocal(b.dataset.test));

  const act = (name, fn) => root.querySelector(`[data-act="${name}"]`)?.addEventListener("click", (ev) => busy(ev.target, fn));
  act("push-on", async () => {
    await controller.enableBackground();
    await renderAlarmSettings(root, controller, health);
  });
  act("push-off", async () => {
    await controller.disableBackground();
    await renderAlarmSettings(root, controller, health);
  });
  act("push-test", () => controller.testPush("alarm"));
  act("push-test-critical", () => controller.testPush("critical"));
}
