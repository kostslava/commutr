# Commutr: project context for AI agents

## What this is
Hackathon web app (Kitchener-Waterloo region). Rewards people for replacing car trips with walking, cycling, or transit. Users earn points and exchange them for discounts and meals at local businesses and gift cards. Gamified (streaks, clubs). All merchants and sponsors are DEMO data. Do not claim any real government affiliation or real sponsor partnership in the code or UI copy.

## Team split (read this first)
Two humans, two AI agents. Each agent works only in its own human's folders.
- frontend/ belongs only to the frontend teammate (Codex). Includes the UI, map, PWA manifest and service worker, and frontend docs (for example frontend/DEPLOYMENT.md).
- backend/ and docs/ belong only to the backend teammate, Shahmeer (Claude Code). Includes the API, scoring, database, GTFS-RT, seed data, and docs/api.md, the contract between the two sides.
- Never edit the other side's folder. Anything needed from the other side goes through a message between the two humans; the owner makes the change.
- Root files (AGENTS.md, CLAUDE.md, README.md, COMPANION.md, questions.md, package.json) are edited only when your human explicitly asks. Either human may ask, after telling the other.
- Nobody runs `npm run agent:setup` or `npm run companion:setup`, and nobody changes the live ElevenLabs agent (Muta), unless both humans agree first. `agent:setup` overwrites Muta.
- Never make architecture, scope or design decisions on your own. Ask your human.
- Git: pull `main` before starting. One branch per change (`backend/<topic>`, `frontend/<topic>`, `docs/<topic>`). Run the relevant checks. Merge to `main` by pull request (regular merge commit, keep the branch). Never force push. Push only when your human asks.
- Tooling: npm, Node 22+.

## Stack
- Backend: Node + TypeScript + Hono, SQLite (better-sqlite3), JSON REST
- Frontend: React 18 + Vite 6, installable PWA via vite-plugin-pwa, Leaflet map, `@elevenlabs/client` for voice
- Map: Leaflet with OpenStreetMap tiles (tile.openstreetmap.org). Walk and bike route lines come from the public Valhalla server through the Vite dev proxy `/routing`, which only exists in dev.
- Place search: Nominatim (OSM), at most 1 request per second. The backend sets a User-Agent. The frontend map search calls Nominatim directly from the browser (which can't set a User-Agent).
- Street view: Mapillary (MapillaryJS, free token, must show Mapillary attribution). Planned for route safety, not built. Crowdsourced, coverage in KW untested.
- Chatbot: Gemini API (gemini-3.5-flash-lite) for chat with function calling and for voice transcription. Speech: ElevenLabs (eleven_flash_v2_5) first, Gemini TTS as the fallback. Keys in backend/.env (see backend/.env.example), never committed or logged.
- Live voice agent (the mascot, Muta): an ElevenLabs agent. The browser gets a signed link from `POST /api/companion/session` (the backend holds ELEVENLABS_API_KEY; the agent ID comes from ELEVENLABS_AGENT_ID or backend/elevenlabs/state.json) and runs Muta's voice tools in the app as browser (client) tools. No tunnel and no AGENT_TOOL_SECRET are needed. Details: docs/agent-tools.md and docs/elevenlabs-agent-setup.md section 7.
- Legacy, unused by the frontend: the webhook agent design (`/api/agent/*`, `npm run agent:setup`, a Cloudflare tunnel, AGENT_TOOL_SECRET). The endpoints are still built.
- Trip planner: `POST /api/plan`, and `POST /api/companion/plan` (used by Muta). `/api/agent/plan` is legacy. Gemini (gemini-3.5-flash-lite, function calling and structured output) chooses, orders and explains the options. Every number (minutes, km, points estimates, next bus) is computed by the backend from the live GRT data, the stops, the scoring config and Nominatim.
- Route safety: Gemini rating routes from Mapillary photos. Not built yet; Muta answers that it isn't available, and the legacy `/api/agent/route-safety` is a stub.
- Everything must be free or open source.

## How the frontend reaches the backend
- Dev: the frontend calls `/api` on its own origin and the Vite dev server forwards it to the backend on port 8787. The backend allows any origin when NODE_ENV isn't production. Running both and opening the app on a phone: docs/local-phone-run.md.
- Production: the frontend needs VITE_API_URL set to the backend URL, and the backend needs the frontend's exact origin in FRONTEND_ORIGINS.

## Live transit (real data, GRT)
- Base: https://webapps.regionofwaterloo.ca/api/grt-routes/api/ (HTTPS only). Feed 1 = buses, feed 2 = ION light rail.
- Vehicle positions: vehiclepositions/1 and vehiclepositions/2
- Trip updates: tripupdates/1 and tripupdates/2
- Alerts: alerts (no number)
- Static schedule and stops (GTFS zip): staticfeeds/1 and staticfeeds/2
- The old URLs are dead: unnumbered /vehiclepositions and /tripupdates are frozen since 2026-02-17, and opendatadownloads/GRT_GTFS.zip returns 404.
- Feeds are GTFS-realtime (protobuf). Backend parses them and exposes plain JSON to the frontend.
- Fallback to fake bus data if the feed fails.
- Shared bike and scooter data (GBFS) is linked at grt.ca/about-grt/open-data.

## Scoring
points = verified_km x mode_rate x confidence x trust_multiplier, rounded, capped at 200 points a day (Toronto date).
- User picks the mode before a trip.
- Rates per km (tunable, in backend/src/scoring/config.ts): walk 10, bike 6, scooter 4, transit 12, car 0.
- Confidence starts at 1.0 and checks subtract from it (hardcoded rules, keep them simple):
  - speed too high for the chosen mode
  - a short burst at car speed on a walk, bike or scooter trip
  - impossible jumps between GPS points
  - too few points or poor accuracy
  - suspiciously constant speed
  - new trip starting far from the last trip's end
  - transit trips must start and end near a GRT stop
  - gaps in GPS points do not reduce confidence by themselves, only when they come with an impossible position jump
- Per-user trust multiplier drops on flagged trips and recovers slowly.
- A trip with confidence below 0.3 earns 0 points and lowers the user's trust multiplier. It does not count as a car trip for the eco score.

## Eco score
- 0 to 100 per user. Car trips reduce it.
- Rewards are gated by eco score and cost points. Example (demo seed): the $5, $10 and $25 Maple Loop Coffee cards need eco 80, 85 and 95. Below the threshold the reward is locked even with enough points.

## Features
- Modes: walk, bike, scooter, transit, car (car allowed, lowers eco score)
- Streaks (Duolingo style)
- Clubs with a weekly shared goal (example: 150,000 steps) and a shared group reward
- Rewards store (demo merchants, gift cards, local meals)
- Assistants: Muta is the main in-app assistant (typed: `POST /api/companion/chat`; voice: see Stack). `POST /api/chat` is the Community tab's help chat. Both suggest places to eat that the user can afford with their current points and eco score, and real KW places to walk, bike or ride to.
- Saved locations (home, favourites)
- Bike routes with a safety rating from Gemini vision over Mapillary street-level photos (coming later)
- Live bus locations on the map

## Deployment
- Backend: Render, https://commutr-backend.onrender.com
- Frontend: not deployed yet; the frontend owner decides (Vercel in progress).
- Local: docs/local-phone-run.md

## Demo data
Seed fake users, trips, merchants and clubs. Keep seed data in one file (backend/src/seed.ts) so it is easy to reset.

## Delivery
- Installable PWA (web app manifest + service worker), mobile first. Must be served over HTTPS (needed for install and geolocation).
- Frontend owner handles the manifest and service worker. Backend must not assume a native app.
- Known limit: browsers pause GPS when the screen is off or the tab is in the background. Trip tracking only records while the app is open in the foreground. Backend should accept sparse points and not penalize gaps by themselves.
