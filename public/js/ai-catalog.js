// AI providers and models users may bring keys for. Shared by the browser
// (settings dropdowns, key checks) and the Worker (which rejects anything
// not listed here). Each model was checked on the provider's model page,
// and each one supports JSON-schema output (checked 2026-09-25).

export const AI_PROVIDERS = Object.freeze({
  anthropic: {
    label: "Anthropic (Claude)",
    keyHint: "starts with sk-ant-",
    keyPattern: /^sk-ant-[A-Za-z0-9_-]{20,250}$/,
    defaultModel: "claude-sonnet-5",
    models: [
      { id: "claude-sonnet-5", label: "Claude Sonnet 5 (balanced)" },
      { id: "claude-opus-5", label: "Claude Opus 5 (most capable, costs more)" },
    ],
  },
  gemini: {
    label: "Google Gemini",
    keyHint: "starts with AIza",
    keyPattern: /^AIza[A-Za-z0-9_-]{30,60}$/,
    defaultModel: "gemini-3.6-flash",
    models: [
      { id: "gemini-3.6-flash", label: "Gemini 3.6 Flash" },
      { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash (newest)" },
      { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite (cheapest)" },
    ],
  },
  openai: {
    label: "OpenAI (GPT)",
    keyHint: "starts with sk- (not sk-ant-)",
    // sk-ant- is Anthropic's prefix: catch a key pasted under the wrong provider.
    keyPattern: /^sk-(?!ant-)[A-Za-z0-9_-]{20,300}$/,
    defaultModel: "gpt-6-luna",
    models: [
      { id: "gpt-6-luna", label: "GPT-6 Luna (efficient)" },
      { id: "gpt-6-sol", label: "GPT-6 Sol" },
      { id: "gpt-6-astra", label: "GPT-6 Astra (most capable, costs more)" },
    ],
  },
});

export const PROVIDER_IDS = Object.keys(AI_PROVIDERS);

export function isKnownModel(provider, model) {
  return Object.hasOwn(AI_PROVIDERS, provider) && AI_PROVIDERS[provider].models.some((m) => m.id === model);
}
