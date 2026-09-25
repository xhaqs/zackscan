// Alarm and reminder rules. Shared by the page (instant alarms with sound
// while Zackscan is open) and the Worker cron (Web Push while it's closed),
// so both fire on exactly the same conditions.
//
// A rule: { id, metric, region: "any" | regionId, value, kind: "alarm" | "reminder",
//           repeatHours (reminders), enabled, builtin? }
//
// Firing is edge-triggered: a rule fires when a value CROSSES above its
// threshold, not on every refresh while it stays there. It re-arms once the
// value falls back below the threshold minus a small margin (hysteresis), so
// a value hovering at the line doesn't flap. Reminders also repeat every
// `repeatHours` while the condition lasts, until acknowledged.

export const CRITICAL_SCORE = 85;
export const MAX_RULES = 20;
export const REPEAT_HOURS = [1, 3, 6, 12, 24];

const pillarScore = (k) => (r) => r.pillars?.[k]?.score;
export const METRICS = Object.freeze({
  "overall.score": { label: "Overall risk score", unit: "", min: 0, max: 100, step: 1, score: true, get: (r) => r.overall?.score },
  "seismic.score": { label: "Seismic risk score", unit: "", min: 0, max: 100, step: 1, score: true, get: pillarScore("seismic") },
  "wildfire.score": { label: "Fire & smoke risk score", unit: "", min: 0, max: 100, step: 1, score: true, get: pillarScore("wildfire") },
  "heat.score": { label: "Extreme heat risk score", unit: "", min: 0, max: 100, step: 1, score: true, get: pillarScore("heat") },
  "seismic.maxMagnitude": { label: "Largest earthquake this week", unit: "M", min: 2, max: 10, step: 0.1, get: (r) => r.pillars?.seismic?.detail?.largest?.mag },
  "heat.zScore": { label: "Heat above normal for the date", unit: "σ", min: 0.5, max: 6, step: 0.1, get: (r) => r.pillars?.heat?.components?.anomaly?.zScore },
  "heat.peakWetBulbC": { label: "Peak wet-bulb temperature (next 48 h)", unit: "°C", min: 15, max: 40, step: 0.5, get: (r) => r.pillars?.heat?.components?.severity?.peakWetBulbC },
  "wildfire.pm25": { label: "Air pollution (PM2.5)", unit: "µg/m³", min: 5, max: 1000, step: 1, needs: "openaq", get: (r) => r.pillars?.wildfire?.components?.smoke?.pm25 },
  "wildfire.detections": { label: "Active fires detected (24 h)", unit: "fires", min: 1, max: 10000, step: 1, needs: "firms", get: (r) => r.pillars?.wildfire?.components?.activity?.detections },
});

export const BUILTIN_CRITICAL = Object.freeze({
  id: "critical",
  metric: "overall.score",
  region: "any",
  value: CRITICAL_SCORE,
  kind: "alarm",
  enabled: true,
  builtin: true,
});

export const defaultRules = () => [{ ...BUILTIN_CRITICAL }];

/** "PM2.5 above 150 µg/m³ in Delhi, India". */
export function describeRule(rule, regionName = null) {
  const m = METRICS[rule.metric];
  if (!m) return "Unknown rule";
  const v = m.unit === "σ" ? `+${rule.value}σ` : m.unit === "M" ? `M${rule.value}` : `${rule.value}${m.unit ? " " + m.unit : ""}`;
  const where = rule.region === "any" ? "any region" : regionName || rule.region;
  const how = rule.kind === "reminder" ? `, remind every ${rule.repeatHours} h` : "";
  return `${m.label} above ${v} in ${where}${how}`;
}

/**
 * Check and normalize rules coming from a user (page or API).
 * @returns {rules} or {error}
 */
export function validateRules(input, regionIds) {
  if (!Array.isArray(input)) return { error: "Rules must be a list." };
  if (input.length > MAX_RULES + 1) return { error: `At most ${MAX_RULES} custom rules.` };
  const out = [];
  const seen = new Set();
  for (const r of input) {
    if (!r || typeof r !== "object") return { error: "Bad rule." };
    if (r.builtin || r.id === BUILTIN_CRITICAL.id) {
      out.push({ ...BUILTIN_CRITICAL, enabled: r.enabled !== false }); // only its on/off switch can change
      continue;
    }
    const id = String(r.id || "");
    if (!/^[a-z0-9]{4,16}$/.test(id) || seen.has(id)) return { error: "Bad rule id." };
    seen.add(id);
    const m = METRICS[r.metric];
    if (!m) return { error: "Unknown measurement." };
    if (r.region !== "any" && !regionIds.includes(r.region)) return { error: "Unknown region." };
    const value = Number(r.value);
    if (!Number.isFinite(value) || value < m.min || value > m.max) return { error: `${m.label}: choose a value from ${m.min} to ${m.max}.` };
    const kind = r.kind === "reminder" ? "reminder" : "alarm";
    const repeatHours = kind === "reminder" ? (REPEAT_HOURS.includes(Number(r.repeatHours)) ? Number(r.repeatHours) : 6) : undefined;
    out.push({ id, metric: r.metric, region: r.region, value, kind, ...(repeatHours ? { repeatHours } : {}), enabled: r.enabled !== false });
  }
  if (out.filter((r) => !r.builtin).length > MAX_RULES) return { error: `At most ${MAX_RULES} custom rules.` };
  if (!out.some((r) => r.builtin)) out.unshift({ ...BUILTIN_CRITICAL });
  return { rules: out };
}

export function severityOf(rule, value) {
  const m = METRICS[rule.metric];
  if (rule.builtin || (m?.score && value > CRITICAL_SCORE)) return "critical";
  return rule.kind === "reminder" ? "reminder" : "alarm";
}

const margin = (rule) => Math.max(METRICS[rule.metric]?.step || 0, Math.abs(rule.value) * 0.03);

/**
 * Evaluate rules against a risk matrix.
 * @param state { [ruleId:regionId]: { active, since, lastAt, ackAt } } (not mutated)
 * @returns { alerts, state, changed }
 */
export function evaluateRules(rules, matrix, state = {}, now = Date.now()) {
  const next = { ...state };
  const alerts = [];
  let changed = false;
  for (const rule of rules || []) {
    if (!rule.enabled) continue;
    const m = METRICS[rule.metric];
    if (!m) continue;
    for (const r of matrix?.regions || []) {
      if (!r.pillars || (rule.region !== "any" && rule.region !== r.id)) continue;
      const value = m.get(r);
      if (value == null || !Number.isFinite(value)) continue; // unknown is not "below": leave state alone
      const key = `${rule.id}:${r.id}`;
      const s = next[key];
      if (value > rule.value) {
        let reason = null;
        if (!s?.active) reason = "crossed";
        else if (rule.kind === "reminder" && !s.ackAt && now - s.lastAt >= rule.repeatHours * 3_600_000) reason = "reminder";
        if (reason) {
          next[key] = { active: true, since: s?.active ? s.since : now, lastAt: now, ...(s?.active && s.ackAt ? { ackAt: s.ackAt } : {}) };
          changed = true;
          alerts.push(makeAlert(rule, r, value, reason, now));
        }
      } else if (s?.active && value <= rule.value - margin(rule)) {
        delete next[key]; // back to normal: re-armed
        changed = true;
      }
    }
  }
  return { alerts, state: next, changed };
}

export function acknowledge(state, key, now = Date.now()) {
  if (!state[key]?.active) return state;
  return { ...state, [key]: { ...state[key], ackAt: now } };
}

function fmt(metric, v) {
  const m = METRICS[metric];
  const n = Math.round(v * 10) / 10;
  return m.unit === "σ" ? `+${n}σ` : m.unit === "M" ? `M${n}` : `${n}${m.unit ? " " + m.unit : ""}`;
}

function makeAlert(rule, region, value, reason, now) {
  const m = METRICS[rule.metric];
  const severity = severityOf(rule, value);
  const prefix = severity === "critical" ? "CRITICAL: " : reason === "reminder" ? "Reminder: " : "";
  return {
    key: `${rule.id}:${region.id}`,
    ruleId: rule.id,
    regionId: region.id,
    regionName: region.name,
    metric: rule.metric,
    value,
    threshold: rule.value,
    severity,
    reason,
    at: now,
    title: `${prefix}${region.name}: ${m.label.toLowerCase()} ${fmt(rule.metric, value)}`,
    body: `Above your threshold of ${fmt(rule.metric, rule.value)}${region.overall?.level ? ` · overall risk ${region.overall.level}` : ""}. Open to see the situation report.`,
    url: `/?focus=${encodeURIComponent(region.id)}#risk-h`,
  };
}
