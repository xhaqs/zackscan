// Generate the daily brief using Gemini API with the collected data.

import { getBriefModel } from "./gemini-models.js";

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models/";

const SYSTEM_PROMPT = `You are generating a daily environmental intelligence brief from real-time satellite, seismic, weather, and sea ice monitoring data.

CRITICAL RULES:
- Use ONLY the data provided in the prompt. Do not invent events, numbers, places, dates, or facts.
- If a data source is missing or old, explicitly state that.
- Do not make up hazard facts, scores, events, or times. Every statement must come from the provided data.
- Write for a general reader (citizens and response teams), not technical jargon.

OUTPUT FORMAT:
Write 3 short paragraphs summarizing the current global environmental situation, followed by the top 3 items to watch today.

End with exactly this line:
"AI-generated from the data shown. Not an official warning."`;

/**
 * Generate the daily brief from collected data using Gemini.
 * Returns { text, model, generatedAt } or throws if the API fails.
 */
export async function generateBrief(data, sources, apiKey, deps = {}) {
  const fetchImpl = deps.fetch || fetch;

  // Get a valid model name from the list-models endpoint
  const model = await getBriefModel(apiKey, deps);

  // Build the prompt with the data
  const prompt = buildPrompt(data, sources);

  // Call Gemini
  const res = await fetchImpl(
    GEMINI_BASE + encodeURIComponent(model) + ":generateContent",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 2048 },
      }),
      signal: AbortSignal.timeout(30_000),
    },
  );

  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`Gemini API failed (${res.status}): ${err.slice(0, 200)}`);
  }

  const result = await res.json();
  const text =
    result?.candidates?.[0]?.content?.parts
      ?.map((p) => p.text || "")
      .join("") || "";

  if (!text) throw new Error("Gemini returned no text");

  return {
    text: text.trim(),
    model,
    generatedAt: new Date().toISOString(),
  };
}

function buildPrompt(data, sources) {
  const parts = [];

  parts.push("# Data sources");
  for (const s of sources) {
    parts.push(`- ${s.name}: fetched at ${s.fetchedAt}`);
  }

  parts.push("\n# Risk Matrix (6 watchlist regions)");
  const { matrix } = data;
  if (matrix?.regions) {
    for (const r of matrix.regions) {
      if (!r.pillars) continue;
      parts.push(`\n## ${r.name} (${r.id})`);
      parts.push(`Updated: ${r.updatedAt}`);
      parts.push(
        `Overall risk: ${r.overall?.score ?? "N/A"}/100 (${r.overall?.level ?? "unknown"})`,
      );

      for (const [key, p] of Object.entries(r.pillars)) {
        if (!p.realtime) continue; // skip GLOF stub
        const status = p.status === "live" ? "" : ` [${p.status}]`;
        parts.push(
          `- ${key}: ${p.score ?? "N/A"}/100 (${p.level})${status}, as of ${p.asOf || "N/A"}`,
        );
      }
    }
  } else {
    parts.push("Risk matrix data not available.");
  }

  parts.push("\n# Live Events (most recent 30)");
  const { events } = data;
  if (events?.length) {
    for (const e of events) {
      const mag = e.magnitude
        ? ` (magnitude ${e.magnitude}${e.magnitudeUnit || ""})`
        : "";
      const depth = e.depthKm != null ? `, depth ${e.depthKm} km` : "";
      const tsunami = e.tsunami ? ", TSUNAMI" : "";
      const time = new Date(e.time).toISOString();
      parts.push(`- ${e.title}${mag}${depth}${tsunami} at ${time}`);
    }
  } else {
    parts.push("No live events available.");
  }

  parts.push("\n# Arctic Sea Ice");
  const { seaIce } = data;
  if (seaIce?.north) {
    const n = seaIce.north;
    parts.push(
      `Extent: ${n.extentMkm2?.toFixed(2) ?? "N/A"} million km² (as of ${seaIce.asOf || "N/A"})`,
    );
    if (n.anomalyMkm2 != null) {
      parts.push(
        `Anomaly vs 1981-2010: ${n.anomalyMkm2 > 0 ? "+" : ""}${n.anomalyMkm2.toFixed(2)} million km²`,
      );
    }
  } else {
    parts.push("Sea ice data not available.");
  }

  parts.push("\n---\n");
  parts.push(
    "Write a 3-paragraph brief for a general reader, followed by the top 3 watch items.",
  );

  return parts.join("\n");
}
