# Commutr: project context for AI agents

## What this is
Hackathon web app (Kitchener-Waterloo region). Rewards people for replacing car trips with walking, cycling, or transit. Users earn points and exchange them for discounts and meals at local businesses and gift cards. Gamified (streaks, clubs). All merchants and sponsors are DEMO data. Do not claim any real government affiliation or real sponsor partnership in the code or UI copy.

## Ownership (read this first)
Two humans, two AI agents (Claude Code and Codex). Each agent works only in its human's area.
- Backend (API, scoring, database, GTFS-RT, seed data): Shahmeer, using Claude Code. Folder: backend/
- Frontend (UI, maps, PWA manifest and service worker, pages): teammate, using Codex. Folder: frontend/
- docs/ is shared. docs/api.md is the contract between the two sides and is owned by the backend. The frontend agent must not edit it. If it needs a change, it tells its human, who asks the backend owner.
- Never edit files outside your own folder. If a task needs that, stop and ask your human.
- Root files (AGENTS.md, CLAUDE.md) may only be edited when your human explicitly asks you to.
- Never make architecture, scope or design decisions on your own. Ask your human.
- Git: one branch per person (backend/<topic>, frontend/<topic>). Merge to main by pull request only. No force pushes. Pull before you start.
- Tooling: npm, Node 22+.

## Stack
- Backend: Node + TypeScript + Hono, SQLite (better-sqlite3), JSON REST
- Frontend: decided by the frontend owner (Next.js or React/Vite)
- Map: MapLibre GL JS + OpenFreeMap tiles
- Place search: Nominatim (OSM). Set a User-Agent, max 1 request per second.
- Street view: Mapillary (MapillaryJS, free token, must show Mapillary attribution). Crowdsourced, coverage in KW untested.
- Chatbot: Gemini API (gemini-3.5-flash-lite) for chat with function calling and for voice transcription. Speech: ElevenLabs (eleven_flash_v2_5) first, Gemini TTS as the fallback. Keys in backend/.env (see backend/.env.example), never committed or logged.
- Everything must be free or open source.

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
points = verified_km x mode_rate x confidence, with a daily cap.
- User picks the mode before a trip.
- Starting rates per km (tunable): walk 10, bike 6, transit 3.
- Confidence starts at 1.0 and checks subtract from it (hardcoded rules, keep them simple):
  - speed too high for the chosen mode
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
- Rewards are gated by eco score and cost points. Example: Tim Hortons $5 needs 80, $10 needs 85, $25 needs 95. Below the threshold the reward is locked even with enough points.

## Features
- Modes: walk, bike, scooter, transit, car (car allowed, lowers eco score)
- Streaks (Duolingo style)
- Clubs with a weekly shared goal (example: 150,000 steps) and a shared group reward
- Rewards store (demo merchants, gift cards, local meals)
- In-app chatbot: suggests places to eat that the user can afford with their current points and eco score; if they cannot afford one, suggests a place to walk, bike or ride to
- Saved locations (home, favourites)
- Bike routes with a safety rating (data source not decided yet)
- Live bus locations on the map

## Not decided yet
- Bike safety rating data source
- Deployment (local first, Cloudflare optional)

## Demo data
Seed fake users, trips, merchants and clubs. Keep seed data in one file so it is easy to reset.

## Delivery
- Installable PWA (web app manifest + service worker), mobile first. Must be served over HTTPS (needed for install and geolocation).
- Frontend owner handles the manifest and service worker. Backend must not assume a native app.
- Known limit: browsers pause GPS when the screen is off or the tab is in the background. Trip tracking only records while the app is open in the foreground. Backend should accept sparse points and not penalize gaps by themselves.
