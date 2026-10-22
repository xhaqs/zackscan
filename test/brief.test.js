import { test } from "node:test";
import assert from "node:assert/strict";
import { collectBriefData } from "../src/brief/builder.js";
import { generateBrief } from "../src/brief/generator.js";
import { runDailyBrief } from "../src/brief/cron.js";
import { getBriefModel } from "../src/brief/gemini-models.js";

// Stub KV store
function makeTestStore() {
  const data = new Map();
  return {
    get: async (k) => data.get(k) ?? null,
    put: async (k, v) => data.set(k, v),
  };
}

// Stub fetch for brief data collection
function makeBriefFetch() {
  return async (url) => {
    if (url.includes("/api/risk")) {
      return {
        status: 200,
        ok: true,
        json: async () => ({
          schema: "zackscan.risk-matrix/v1",
          generatedAt: new Date().toISOString(),
          regions: [
            {
              id: "nairobi",
              name: "Nairobi, Kenya",
              updatedAt: new Date().toISOString(),
              overall: { score: 45, level: "elevated" },
              pillars: {
                seismic: {
                  score: 20,
                  level: "low",
                  status: "live",
                  asOf: new Date().toISOString(),
                  realtime: true,
                },
                wildfire: {
                  score: 60,
                  level: "high",
                  status: "live",
                  asOf: new Date().toISOString(),
                  realtime: true,
                },
                heat: {
                  score: 40,
                  level: "elevated",
                  status: "live",
                  asOf: new Date().toISOString(),
                  realtime: true,
                },
                glof: {
                  score: null,
                  level: "unknown",
                  status: "stub",
                  realtime: false,
                },
              },
            },
          ],
        }),
      };
    }
    if (
      url.includes("eonet.gsfc.nasa.gov") ||
      url.includes("earthquake.usgs.gov")
    ) {
      return {
        status: 200,
        ok: true,
        json: async () =>
          url.includes("eonet") ? { events: [] } : { features: [] },
      };
    }
    // Sea ice (optional)
    return { status: 404, ok: false };
  };
}

test("brief: data collection gathers matrix, events, and sources", async () => {
  const env = {};
  const deps = { fetch: makeBriefFetch(), store: makeTestStore() };

  const { data, sources } = await collectBriefData(env, deps);

  assert.ok(data.matrix, "matrix collected");
  assert.ok(data.matrix.regions, "matrix has regions");
  assert.ok(Array.isArray(data.events), "events collected");
  assert.ok(Array.isArray(sources), "sources recorded");
  assert.ok(sources.length >= 2, "at least matrix and events sources");
  assert.ok(
    sources.every((s) => s.name && s.fetchedAt),
    "each source has name and time",
  );
});

test("brief: Gemini model fetcher picks a Flash model", async () => {
  const deps = {
    fetch: async (url) => ({
      ok: true,
      status: 200,
      json: async () => ({
        models: [
          {
            name: "models/gemini-3.8-flash",
            supportedGenerationMethods: ["generateContent"],
          },
          {
            name: "models/gemini-4.0-pro",
            supportedGenerationMethods: ["generateContent"],
          },
        ],
      }),
    }),
  };

  const model = await getBriefModel("test-key", deps);
  assert.match(model, /flash/i, "prefers Flash models");
});

test("brief: generator builds prompt with data", async () => {
  const data = {
    matrix: {
      regions: [
        {
          id: "test",
          name: "Test Region",
          updatedAt: "2026-10-22T00:00:00Z",
          overall: { score: 50, level: "elevated" },
          pillars: {
            seismic: {
              score: 30,
              level: "guarded",
              status: "live",
              asOf: "2026-10-22T00:00:00Z",
              realtime: true,
            },
          },
        },
      ],
    },
    events: [
      {
        title: "Test Event",
        time: Date.now(),
        magnitude: 4.5,
        magnitudeUnit: "M",
      },
    ],
    seaIce: null,
  };
  const sources = [{ name: "Test Source", fetchedAt: "2026-10-22T00:00:00Z" }];

  const deps = {
    fetch: async (url) => {
      if (url.includes("models?key=")) {
        return {
          ok: true,
          json: async () => ({
            models: [
              {
                name: "models/test-flash",
                supportedGenerationMethods: ["generateContent"],
              },
            ],
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: "Test brief text.\n\nAI-generated from the data shown. Not an official warning.",
                  },
                ],
              },
            },
          ],
        }),
      };
    },
  };

  const brief = await generateBrief(data, sources, "test-key", deps);
  assert.ok(brief.text, "brief has text");
  assert.ok(brief.model, "brief has model name");
  assert.ok(brief.generatedAt, "brief has timestamp");
  assert.match(
    brief.text,
    /AI-generated/,
    "brief contains required disclaimer",
  );
});

test("brief: cron handler with missing key keeps previous brief", async () => {
  const store = makeTestStore();
  const old = {
    text: "Old brief",
    generatedAt: "2026-10-21T04:00:00Z",
    sources: [],
  };
  await store.put("daily-brief:v1:latest", old);

  const env = {}; // No GEMINI_API_KEY
  const deps = { fetch: makeBriefFetch(), store };

  const result = await runDailyBrief(env, deps);
  assert.equal(result.ok, false, "job fails without key");
  assert.equal(result.error, "GEMINI_API_KEY not set");

  const kept = await store.get("daily-brief:v1:latest");
  assert.deepEqual(kept, old, "old brief is kept");
});

test("brief: cron handler with Gemini failure keeps previous brief", async () => {
  const store = makeTestStore();
  const old = {
    text: "Old brief",
    generatedAt: "2026-10-21T04:00:00Z",
    sources: [],
  };
  await store.put("daily-brief:v1:latest", old);

  const env = { GEMINI_API_KEY: "test-key" };
  const deps = {
    fetch: async (url) => {
      if (url.includes("models?key=")) {
        return {
          ok: true,
          json: async () => ({
            models: [
              {
                name: "models/test",
                supportedGenerationMethods: ["generateContent"],
              },
            ],
          }),
        };
      }
      if (url.includes("generateContent")) {
        return {
          ok: false,
          status: 500,
          text: async () => "Gemini overloaded",
        };
      }
      return makeBriefFetch()(url);
    },
    store,
  };

  const result = await runDailyBrief(env, deps);
  assert.equal(result.ok, false, "job fails on Gemini error");
  assert.match(result.error, /Gemini/, "error mentions Gemini");

  const kept = await store.get("daily-brief:v1:latest");
  assert.deepEqual(kept, old, "old brief is kept, not overwritten");
});

test("brief: successful generation stores new brief", async () => {
  const store = makeTestStore();
  const env = { GEMINI_API_KEY: "test-key" };
  const deps = {
    fetch: async (url) => {
      if (url.includes("models?key=")) {
        return {
          ok: true,
          json: async () => ({
            models: [
              {
                name: "models/test-flash",
                supportedGenerationMethods: ["generateContent"],
              },
            ],
          }),
        };
      }
      if (url.includes("generateContent")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: "New brief.\n\nWatch items.\n\nAI-generated from the data shown. Not an official warning.",
                    },
                  ],
                },
              },
            ],
          }),
        };
      }
      return makeBriefFetch()(url);
    },
    store,
  };

  const result = await runDailyBrief(env, deps);
  assert.equal(result.ok, true, "job succeeds");
  assert.ok(result.generatedAt, "result has timestamp");

  const brief = await store.get("daily-brief:v1:latest");
  assert.ok(brief, "brief stored");
  assert.match(brief.text, /New brief/, "new brief text stored");
  assert.ok(brief.sources.length > 0, "sources recorded");
});
