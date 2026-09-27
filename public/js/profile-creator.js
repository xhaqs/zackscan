// Creator sheet for custom mission profiles.
// Wires up #profile-creator dialog: description → AI interpret → preview → save.

import { api } from "./api.js";
import {
  PALETTE_PRESETS,
  FEED_LABELS,
  buildProfileFromInterpret,
  saveCustomProfile,
  newCustomId,
} from "./custom-profiles.js";

const POLL_LABELS = {
  30000: "30 s",
  60000: "1 min",
  120000: "2 min",
  300000: "5 min",
};

const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

function renderPreview(container, interpreted) {
  const palette =
    PALETTE_PRESETS[interpreted.paletteKey] ?? PALETTE_PRESETS.green;
  const poll = POLL_LABELS[interpreted.pollMs] ?? interpreted.pollMs + " ms";
  const feeds = (interpreted.feedCategories || [])
    .map((k) => FEED_LABELS[k] ?? k)
    .join(", ");

  container.innerHTML = `
    <div class="cp-preview" style="border-left: 4px solid ${esc(palette.accent)}; padding-left: 12px; margin: 12px 0;">
      <div style="display:flex; align-items:center; gap:10px; margin-bottom:6px;">
        <span style="width:14px;height:14px;border-radius:50%;background:${esc(palette.accent)};flex-shrink:0"></span>
        <strong style="font-size:1.05rem">${esc(interpreted.name)}</strong>
        <span class="cp-pill">${esc(interpreted.audience)}</span>
        <span class="cp-pill">↻ ${esc(poll)}</span>
      </div>
      <p class="hint" style="margin:0 0 8px">Data feeds: ${esc(feeds)}</p>
      <p style="margin:6px 0 4px;font-weight:600;font-size:0.9rem">AI will assess:</p>
      <ol style="margin:0;padding-left:18px">
        ${(interpreted.metrics || []).map((m) => `<li style="font-size:0.9rem;margin:3px 0">${esc(m)}</li>`).join("")}
      </ol>
    </div>`;
}

export function initProfileCreator({ onSaved }) {
  const dialog = document.querySelector("#profile-creator");
  if (!dialog) return;

  const descEl = dialog.querySelector("#creator-desc");
  const interpretBtn = dialog.querySelector("#creator-interpret");
  const editBtn = dialog.querySelector("#creator-edit");
  const saveBtn = dialog.querySelector("#creator-save");
  const errorEl = dialog.querySelector("#creator-error");
  const previewEl = dialog.querySelector("#creator-preview");
  const saveRow = dialog.querySelector("#creator-save-row");
  const inputRow = dialog.querySelector("#creator-input-row");

  let pending = null; // last interpreted result

  function reset() {
    pending = null;
    previewEl.hidden = true;
    saveRow.hidden = true;
    inputRow.hidden = false;
    descEl.disabled = false;
    interpretBtn.disabled = false;
    interpretBtn.textContent = "Interpret with AI →";
    errorEl.textContent = "";
    previewEl.innerHTML = "";
  }

  dialog.addEventListener("close", reset);

  interpretBtn.addEventListener("click", async () => {
    const description = descEl.value.trim();
    errorEl.textContent = "";
    if (description.length < 10) {
      errorEl.textContent =
        "Please write at least a sentence describing what you're monitoring.";
      descEl.focus();
      return;
    }
    if (description.length > 500) {
      errorEl.textContent = "Keep it under 500 characters.";
      return;
    }

    interpretBtn.disabled = true;
    interpretBtn.textContent = "Interpreting…";
    descEl.disabled = true;

    try {
      const result = await api.interpretProfile(description);
      pending = { interpreted: result, description };
      renderPreview(previewEl, result);
      previewEl.hidden = false;
      saveRow.hidden = false;
      inputRow.hidden = true;
    } catch (e) {
      errorEl.textContent =
        e.message || "The AI couldn't interpret that. Try rephrasing.";
      descEl.disabled = false;
      interpretBtn.disabled = false;
      interpretBtn.textContent = "Interpret with AI →";
      if (
        e.code === "platform_rate_limited" ||
        e.code === "platform_unavailable"
      ) {
        document.querySelector("#settings")?.showModal();
      }
    }
  });

  editBtn.addEventListener("click", () => {
    previewEl.hidden = true;
    saveRow.hidden = true;
    inputRow.hidden = false;
    descEl.disabled = false;
    interpretBtn.disabled = false;
    interpretBtn.textContent = "Interpret with AI →";
    errorEl.textContent = "";
    descEl.focus();
  });

  saveBtn.addEventListener("click", () => {
    if (!pending) return;
    const id = newCustomId();
    const profile = buildProfileFromInterpret(
      pending.interpreted,
      id,
      pending.description,
    );
    saveCustomProfile(profile);
    dialog.close();
    onSaved(profile);
  });
}
