// Fetch the list of Gemini models and pick a suitable one for the daily brief.
// The model is picked once and cached in a Worker variable, not hardcoded.

const GEMINI_LIST_URL =
  "https://generativelanguage.googleapis.com/v1beta/models";
const CACHE_MS = 24 * 3600_000; // re-check once a day

let cached = null;

/**
 * Get a valid Gemini model for the daily brief. Prefers Flash models (fast,
 * cheap) and caches the result for a day.
 */
export async function getBriefModel(apiKey, deps = {}) {
  const fetchImpl = deps.fetch || fetch;
  const now = Date.now();

  if (cached && now - cached.fetchedAt < CACHE_MS) return cached.model;

  const res = await fetchImpl(
    GEMINI_LIST_URL + "?key=" + encodeURIComponent(apiKey),
    {
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!res.ok) throw new Error(`Gemini list-models failed: ${res.status}`);

  const data = await res.json();
  const models = (data.models || [])
    .map((m) => m.name?.replace(/^models\//, ""))
    .filter(Boolean);

  // Pick the first Flash model that supports generateContent, or the first
  // model with generateContent if no Flash is available.
  const flash = models.find(
    (m) =>
      /flash/i.test(m) &&
      data.models
        .find((d) => d.name === "models/" + m)
        ?.supportedGenerationMethods?.includes("generateContent"),
  );
  const fallback = models.find((m) =>
    data.models
      .find((d) => d.name === "models/" + m)
      ?.supportedGenerationMethods?.includes("generateContent"),
  );
  const model = flash || fallback;

  if (!model) throw new Error("No suitable Gemini model found in list-models");

  cached = { model, fetchedAt: now };
  return model;
}
