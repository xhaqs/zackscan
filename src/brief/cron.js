// Daily brief cron handler: collect data, generate brief, store in KV, optionally send to Telegram.

import { collectBriefData } from "./builder.js";
import { generateBrief } from "./generator.js";
import { makeStore } from "../risk/store.js";

const BRIEF_KEY = "daily-brief:v1:latest";

/**
 * Run the daily brief job. Called by the cron handler at 04:00 UTC.
 * - Collects current data from all sources
 * - Calls Gemini to generate the brief
 * - Stores in KV with sources and generation time
 * - If Gemini fails or key is missing, keeps the previous brief and records error
 * - Never overwrites a good brief with an error
 * - Optionally sends to Telegram if TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID exist
 */
export async function runDailyBrief(env, deps = {}) {
  const store = deps.store || makeStore(env);
  const log = [];

  try {
    // Collect data
    log.push("Collecting data...");
    const { data, sources } = await collectBriefData(env, deps);
    log.push(`Collected data from ${sources.length} sources`);

    // Generate brief
    if (!env.GEMINI_API_KEY) {
      log.push("ERROR: GEMINI_API_KEY not set, skipping brief generation");
      const prev = await store.get(BRIEF_KEY);
      return {
        ok: false,
        error: "GEMINI_API_KEY not set",
        kept: prev ? "previous brief" : "none",
        log,
      };
    }

    log.push("Generating brief with Gemini...");
    const { text, model, generatedAt } = await generateBrief(
      data,
      sources,
      env.GEMINI_API_KEY,
      deps,
    );
    log.push(`Brief generated using ${model}`);

    // Store in KV
    const brief = {
      text,
      generatedAt,
      sources,
      model,
    };
    await store.put(BRIEF_KEY, brief, 7 * 86_400); // keep for 7 days
    log.push("Stored in KV");

    // Optional Telegram delivery
    if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
      try {
        await sendToTelegram(text, env, deps);
        log.push("Sent to Telegram");
      } catch (e) {
        log.push(`Telegram send failed: ${e.message}`);
      }
    }

    return { ok: true, generatedAt, model, log };
  } catch (error) {
    log.push(`ERROR: ${error.message}`);
    const prev = await store.get(BRIEF_KEY);
    // Keep the previous brief, don't overwrite with error
    return {
      ok: false,
      error: error.message,
      kept: prev ? "previous brief" : "none",
      log,
    };
  }
}

/**
 * Send the brief to a Telegram chat. Never logs the token.
 */
async function sendToTelegram(text, env, deps = {}) {
  const fetchImpl = deps.fetch || fetch;
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;

  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text: `🌍 *Daily Environmental Brief*\n\n${text}`,
      parse_mode: "Markdown",
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`Telegram API error ${res.status}: ${err.slice(0, 100)}`);
  }
}
