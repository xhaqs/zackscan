# Zackscan

Global environmental intelligence and disaster anomaly platform, for citizens and for response and research teams. It runs as a Cloudflare Worker, and the static front end is served by Workers Assets.

## Layout

```
public/                 front end (no build step, no third-party scripts)
  index.html
  css/app.css           palette comes from CSS variables set per Mission Profile
  js/profiles.js        Mission Profiles (shared with the Worker)
  js/keyvault.js        BYOK key storage in the browser
  js/api.js             same-origin API client (attaches the user's key)
  js/state.js           app state: profile -> polling interval, palette, feeds
  js/app.js             UI wiring
  _headers              strict CSP and security headers
src/
  worker.js             /api/* router
  middleware/ai-key.js  BYOK routing: user's key, or the rate-limited platform tier
  middleware/rate-limit.js  per-IP daily allowance (KV, hashed IPs)
  ai/providers.js       Anthropic (SDK) + Gemini, fixed official hosts, one output schema
  routes/analyze.js     POST /api/analyze: server fetches feeds, AI assesses them
  feeds.js              NASA EONET + USGS, normalized
test/                   node --test
```

## Bring your own key (BYOK)

- The browser keeps the user's key in `sessionStorage` (cleared when the tab closes). It uses `localStorage` only if the user ticks "Remember on this device".
- AI requests send `X-Custom-AI-Key` and `X-Custom-AI-Provider` (`anthropic` or `gemini`).
- The Worker uses the key for that one request, sends it only to that provider's official host, and never logs it, stores it or echoes it back.
- With no key, requests use the **platform tier**: Gemini on `PLATFORM_GEMINI_KEY`, with `PLATFORM_DAILY_LIMIT` calls per IP per day.
- A malformed or rejected user key returns an error. It never falls back to the platform key.
- The API sends no CORS headers, so other sites can't call it with a user's key.

Anthropic calls use `claude-sonnet-5` with structured JSON output. A refusal comes back as a 422 `ai_refused`. Gemini calls use `gemini-3.6-flash`.

## Mission Profiles

| Profile | Polls every | Feeds | Evaluates |
|---|---|---|---|
| General Awareness | 5 min | EONET mixed, USGS significant | danger to people, plain advice |
| Wildfire Operations | 1 min | EONET wildfires | spread, proximity, evacuation window |
| Glacial / Flood Monitoring | 2 min | EONET floods, storms, lake ice, snow, landslides | GLOF signs, catchment rain, cut-off areas |
| Seismic Tracking | 30 s | USGS past hour, EONET volcanoes | magnitude/depth, swarms, tsunami potential |

To add a profile, add an entry in `public/js/profiles.js`. The tests check that it's complete and only uses the allowed feed hosts.

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
