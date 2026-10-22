// Daily brief card: shows the latest AI-generated brief from the Worker.

import { api } from "./api.js";
import { ageLabel } from "./offline-logic.js";

let currentBrief = null;
let lastRefreshTime = 0;
const REFRESH_COOLDOWN_MS = 5 * 60_000; // 5 minutes client-side cooldown

/**
 * Render the daily brief card. If no brief is available, shows a placeholder.
 */
export async function renderDailyBrief(container) {
  try {
    const res = await api("GET", "/api/brief");
    const data = await res.json();

    if (!data.brief) {
      renderPlaceholder(container, data.message || "No brief available yet.");
      return;
    }

    currentBrief = data.brief;
    renderBrief(container, data.brief);
  } catch (e) {
    console.error("Failed to load daily brief:", e);
    if (currentBrief) {
      renderBrief(container, currentBrief, { offline: true });
    } else {
      renderPlaceholder(container, "Unable to load brief. Try again later.");
    }
  }
}

function renderPlaceholder(container, message) {
  container.replaceChildren();
  const card = document.createElement("div");
  card.className = "brief-card brief-placeholder";

  const msg = document.createElement("p");
  msg.className = "meta";
  msg.textContent = message;
  card.append(msg);

  container.append(card);
}

function renderBrief(container, brief, { offline = false } = {}) {
  container.replaceChildren();

  const card = document.createElement("div");
  card.className = "brief-card";

  // Header with age and sources
  const header = document.createElement("div");
  header.className = "brief-header";

  const timestamp = document.createElement("div");
  timestamp.className = "brief-meta";
  const age = ageLabel(Date.parse(brief.generatedAt), Date.now());
  timestamp.textContent = offline
    ? `Saved on this device · ${age}`
    : `Generated ${age}`;
  header.append(timestamp);

  const sources = document.createElement("div");
  sources.className = "brief-sources";
  const sourceNames = brief.sources.map((s) => s.name).join(", ");
  sources.textContent = `Sources: ${sourceNames}`;
  header.append(sources);

  card.append(header);

  // Brief text (use textContent, never innerHTML)
  const text = document.createElement("div");
  text.className = "brief-text";
  // Split paragraphs on double newlines and render each
  const paragraphs = brief.text.split(/\n\n+/);
  for (const p of paragraphs) {
    const para = document.createElement("p");
    para.textContent = p.trim();
    text.append(para);
  }
  card.append(text);

  // Footer with AI label and refresh button
  const footer = document.createElement("div");
  footer.className = "brief-footer";

  const label = document.createElement("p");
  label.className = "brief-label";
  label.textContent = "AI-generated from the data below";
  footer.append(label);

  const refreshBtn = document.createElement("button");
  refreshBtn.type = "button";
  refreshBtn.className = "brief-refresh";
  refreshBtn.textContent = "Refresh now";

  const now = Date.now();
  const canRefresh = now - lastRefreshTime > REFRESH_COOLDOWN_MS;
  refreshBtn.disabled = !canRefresh;

  if (!canRefresh) {
    const remaining = Math.ceil(
      (REFRESH_COOLDOWN_MS - (now - lastRefreshTime)) / 60_000,
    );
    refreshBtn.textContent = `Refresh (wait ${remaining} min)`;
  }

  refreshBtn.addEventListener("click", async () => {
    refreshBtn.disabled = true;
    refreshBtn.textContent = "Refreshing...";

    try {
      const res = await api("POST", "/api/brief");
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Refresh failed");
      }

      const data = await res.json();
      lastRefreshTime = Date.now();
      currentBrief = data.brief;
      renderBrief(container, data.brief);
    } catch (e) {
      alert(`Failed to refresh brief: ${e.message}`);
      refreshBtn.disabled = false;
      refreshBtn.textContent = "Refresh now";
    }
  });

  footer.append(refreshBtn);
  card.append(footer);

  container.append(card);
}
