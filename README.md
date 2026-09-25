# Zackscan

Global environmental intelligence and disaster anomaly platform, for citizens and for response and research teams. It runs as a Cloudflare Worker, and the static front end is served by Workers Assets.

## Layout

```
public/                 front end (no build step, no third-party scripts)
  index.html
  css/app.css           palette comes from CSS variables set per Mission Profile
  js/profiles.js        Mission Profiles (shared with the Worker)
  js/ai-catalog.js      providers, key formats and allowed models (shared with the Worker)
  js/keyvault.js        BYOK key + model storage in the browser
  js/api.js             same-origin API client (attaches the user's key)
  js/state.js           app state: profile -> polling interval, palette, feeds
  js/app.js             UI wiring
  _headers              strict CSP and security headers
src/
  worker.js             /api/* router
  middleware/ai-key.js  BYOK routing: user's key, or the rate-limited platform tier
  middleware/rate-limit.js  per-IP daily allowance (KV, hashed IPs)
  ai/providers.js       Anthropic (SDK), Gemini, OpenAI, fixed official hosts, one output schema
  routes/analyze.js     POST /api/analyze: server fetches feeds, AI assesses them
  feeds.js              NASA EONET + USGS, normalized
test/                   node --test
```

## Bring your own key (BYOK)

- The browser keeps the user's key in `sessionStorage` (cleared when the tab closes). It uses `localStorage` only if the user ticks "Remember on this device".
- Users pick a provider and a model in Settings. AI requests send `X-Custom-AI-Key`, `X-Custom-AI-Provider` (`anthropic`, `gemini` or `openai`) and optionally `X-Custom-AI-Model`. The model must be in `public/js/ai-catalog.js`, and the Worker rejects anything else.
- The Worker uses the key for that one request, sends it only to that provider's official host, and never logs it, stores it or echoes it back.
- With no key, requests use the **platform tier**: Gemini on `PLATFORM_GEMINI_KEY`, with `PLATFORM_DAILY_LIMIT` calls per IP per day.
- A malformed or rejected user key returns an error. It never falls back to the platform key.
- The API sends no CORS headers, so other sites can't call it with a user's key.

| Provider | Models (default first) |
|---|---|
| Anthropic | claude-sonnet-5, claude-opus-5 |
| Gemini | gemini-3.6-flash, gemini-3.8-flash, gemini-3.5-flash-lite |
| OpenAI | gpt-6-luna, gpt-6-sol, gpt-6-astra |

Every call asks for the same JSON-schema output. Refusals come back as a 422 `ai_refused`. To add a model, add it to `ai-catalog.js` after checking the provider supports JSON-schema output for it.

## Mission Profiles

| Profile | Polls every | Feeds | Evaluates |
|---|---|---|---|
| General Awareness | 5 min | EONET mixed, USGS significant | danger to people, plain advice |
| Wildfire Operations | 1 min | EONET wildfires | spread, proximity, evacuation window |
| Glacial / Flood Monitoring | 2 min | EONET floods, storms, lake ice, snow, landslides | GLOF signs, catchment rain, cut-off areas |
| Seismic Tracking | 30 s | USGS past hour, EONET volcanoes | magnitude/depth, swarms, tsunami potential |

To add a profile, add an entry in `public/js/profiles.js`. The tests check that it's complete and only uses the allowed feed hosts.

## Deploy

GitHub Actions (`.github/workflows/deploy.yml`) runs the tests on every push and PR. Pushes to `main` then deploy, set `PLATFORM_GEMINI_KEY` when that secret exists, and smoke-test the live URL. It needs the repo secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`; without them the deploy job fails on purpose.

## Run

```
npm install
npm test
npm run dev          # http://localhost:8787
```

## Before going public

1. Create the rate-limit KV namespace (`wrangler kv namespace create RATE_LIMIT`) and uncomment it in `wrangler.toml`. Without it, the limit is kept per isolate and is easy to get around.
2. Set `PLATFORM_GEMINI_KEY` with `wrangler secret put`. Give Zackscan its own key, not one shared with other apps.
3. Zackscan uses public NASA and USGS data. Don't use agency names or logos in a way that suggests they endorse it.

## Risk matrix (`GET /api/risk`)

Each watchlist region (`src/risk/regions.js`) gets a 0–100 **Anomaly Risk Score** for four hazard types, plus an overall score (the highest live one). `?region=<id>` returns one region. The schema is `zackscan.risk-matrix/v1`.

| Pillar | Status | Sources | Score |
|---|---|---|---|
| Seismic & Geological | live | USGS FDSN (no key) | max of: clustering (Poisson surprise of the 1-day and 7-day counts vs a 10-year baseline), magnitude anomaly (Gutenberg–Richter, b=1), severity (largest magnitude) |
| Thermal & Wildfire | live | NASA FIRMS (**key**), Open-Meteo (no key), OpenAQ (**key**) | fire activity (detections, FRP) raised by fire weather (VPD, humidity, 24 h humidity drop, wind). With no fire detected, weather alone counts as potential and is capped at 40. PM2.5 AQI counts at half weight unless a fire is nearby |
| Extreme Heat | live | Open-Meteo forecast + archive (no key) | max of: severity (hourly peak wet-bulb over the next 48 h, Stull 2011) and anomaly (z-score of daily Stull(Tmax, RHmin) vs the same ±7-day window over 10 years) |
| Cryospheric & Hydrological (GLOF) | **stub** | none | never scored. Static reference lakes, labelled **Preliminary / Non-Real-Time** |

Bands: 0–19 low, 20–39 guarded, 40–59 elevated, 60–79 high, 80–100 severe. Each pillar reports its components and a `status`: `live`, `partial` (some inputs missing), `stale` (a refresh failed, so it shows the last good data for up to 6 h), `error` or `stub`.

**Caching:** region results are kept in KV for 20 minutes, and baselines for 7 days. A cron runs every 10 minutes and refreshes the 3 stalest regions. A request computes at most 2 missing regions and shows the rest as `pending`.

**Setup (free keys, optional):**
- `FIRMS_MAP_KEY`: from https://firms.modaps.eosdis.nasa.gov/api/map_key/ (limit: 5000 transactions per 10 min)
- `OPENAQ_API_KEY`: from https://explore.openaq.org/register. OpenAQ v3 **requires** a key (limits: 60/min, 2000/h).

Add them as GitHub repo secrets and CI pushes them to the Worker. Without them, those inputs show as off instead of being made up.

**Licensing:** Open-Meteo's free API is for non-commercial use only. Commercial use, such as paid agency contracts, needs their paid plan.
