# Commutr

**A little greener, every journey.** Commutr is a mobile-first web app for Kitchener-Waterloo that rewards people for replacing car trips with walking, cycling, scooting or transit. You record a trip, the backend verifies it, and you earn points to spend on rewards at local businesses. Streaks, clubs and an eco score make it a habit. Muta, the app's mascot, can be typed to or talked to and can drive the app for you.

All merchants and rewards are **demo data**. Commutr has no real sponsor, partner or government affiliation.

Hackathon tracks: [Best use of the Gemini API](docs/track-gemini.md) · [Best use of ElevenLabs](docs/track-elevenlabs.md)

## How scoring works

```
points = verified_km × mode_rate × confidence × trust_multiplier   (rounded, max 200 per day, Toronto date)
```

| Mode | Points per verified km |
|---|---|
| Walk | 10 |
| Bike | 6 |
| Scooter | 4 |
| Transit | 12 |
| Car | 0 (allowed, lowers the eco score) |

You pick the mode before the trip. While the app is open, it uploads GPS points to the backend. The backend scores the trip when you finish. All values are in [`backend/src/scoring/config.ts`](backend/src/scoring/config.ts).

- **Verified km:** points with accuracy worse than 50 m are dropped, movements under 10 m count as GPS jitter, and impossible jumps or stretches faster than the mode allows don't count.
- **Sparse GPS is fine.** Browsers pause GPS in the background, so a gap alone never lowers confidence.

### Anti-cheat: confidence checks

Confidence starts at 1.0 and each failed check subtracts from it (floor 0):

| Check | Rule | Penalty |
|---|---|---|
| Speed too high | Average moving speed above the mode's limit (walk 12, bike 30, scooter 28, transit 70 km/h) | −0.5 |
| Car-like burst | Any 60 s window above 20 / 45 / 40 km/h on a walk / bike / scooter trip | −0.6 |
| Impossible jump | A jump of at least 500 m faster than 25 / 70 / 60 / 130 km/h (walk / bike / scooter / transit) | −0.5 |
| Too few points | Fewer than 5 usable points | −0.5 |
| Poor accuracy | Over half the points dropped, or median accuracy worse than 30 m | −0.2 |
| Constant speed | Speed varies less than 5% over 10 or more segments (looks simulated) | −0.5 |
| Far from last trip | Starts over 2 km from where the previous trip ended less than 60 min ago | −0.2 |
| Transit start / end | A transit trip starting or ending more than 200 m from a GRT stop | −0.4 each |

- **Trust multiplier** (per user, 0.4 to 1.0): a trip with confidence below **0.3** earns 0 points and lowers trust by 0.15. Each clean trip (confidence ≥ 0.8, ≥ 0.5 km) adds 0.02 back.
- **Eco score** (0 to 100): car trips cost 0.5 per km (min 1, max 10 per trip). Green trips of at least 1 km add 1, up to 3 a day. A low-confidence trip doesn't count as a car trip.
- **Rewards are gated by eco score as well as points.** For example, the demo Maple Loop Coffee $5, $10 and $25 cards need eco 80, 85 and 95, and stay locked below that even with enough points.
- **Streaks:** one green trip of at least 0.5 km per day.
- **Clubs:** weekly shared step goals, from walk km × 1,300.

## Live GRT transit data

The backend reads the real Grand River Transit feeds from the Region of Waterloo open data API:
- GTFS-realtime vehicle positions and trip updates for buses (feed 1) and ION light rail (feed 2);
- the static GTFS schedule and stops.

It parses the protobuf and serves plain JSON. Live buses show on the map, the trip planner uses the next live departure, and transit trips are checked against real stop locations. If a feed fails, it falls back to clearly marked fake bus data. On the Map screen, the transit option for the 6 suggested destinations is labelled demo data ("Demo transit · illustrative timing"), not a live timetable.

## Features

- **Map:** search KW places, see walk, bike and transit options with minutes, km and estimated points, and start, record and finish a trip. Live buses show in transit mode. You can attach a trip photo (JPG, PNG or WebP, up to 5 MB). It's stored as supporting evidence only: no AI looks at it, and normal trips are still scored from GPS.
- **Demo trips (no GPS):** a labelled rehearsal mode for the 6 suggested destinations. The server fixes the distance, a photo is required to finish, and the trip earns points but never changes the eco score, trust, streaks or clubs. Off by default on a production server.
- **Shop:** eco-gated demo rewards, with a redemption code on redeem. An "Around KW" tab previews real local places with a link to their websites; these are previews, not partners.
- **Wallet:** eco score, points, redeemed codes and recent trips.
- **Community:** clubs with a weekly goal, and a help chat.
- **Muta:** type ("Let's type") or talk ("Let's talk"). Muta answers about points, rewards and clubs, finds places, plans trips onto the map, starts and finishes trips, opens screens, redeems demo rewards and reads out route safety ratings. By voice, finishing a trip or redeeming a reward asks a question first and only runs after you say yes. The voice call stays connected while you move around the app.
- **Route safety:** Gemini rated 4 demo walking routes from Mapillary street-level photos (taken 2016 to 2024). Ask Muta about one and the rating shows on the map with its notes and attribution. Other routes get an honest "no data" answer. It's an estimate from old photos, not a safety guarantee.
- **Installable PWA**, mobile first. GPS records only while the app is open in the foreground.

## Tech stack

- **Backend:** Node 22+, TypeScript, Hono, SQLite (better-sqlite3), `@google/genai` (Gemini), ElevenLabs REST (speech and agent sessions), `gtfs-realtime-bindings`.
- **Frontend:** React 18, Vite 6, vite-plugin-pwa, Leaflet with OpenStreetMap tiles, walk and bike route lines from Valhalla, `@elevenlabs/client`.
- **Data:** GRT open data, Nominatim (OpenStreetMap) place search, Mapillary street photos (used only by the script that generated the route safety ratings).

## Architecture

```
Phone (PWA, React)
  ├─ /api/* (JSON) ──────────────▶ Hono backend ──▶ SQLite (users, trips, rewards, clubs)
  │                                     ├─▶ GRT GTFS + GTFS-realtime (buses, ION)
  │                                     ├─▶ Nominatim (place search)
  │                                     ├─▶ Gemini (trip planner, chat, Muta text)
  │                                     ├─▶ ElevenLabs (signed session links, speech)
  │                                     └─▶ route safety ratings file (made once, offline,
  │                                          by Gemini vision over Mapillary photos)
  │
  └─ WebSocket (signed URL) ─────▶ ElevenLabs agent "Muta"
                                        └─ tool calls ─▶ browser tools in the app ─▶ /api/*
```

The browser never holds a provider key. The ElevenLabs agent is private: the backend hands the browser a short-lived signed link from `POST /api/companion/session`.

## Run it

```sh
npm run setup                          # installs backend and frontend packages
cp backend/.env.example backend/.env   # then fill in GEMINI_API_KEY and ELEVENLABS_API_KEY
```

Then follow [`docs/local-phone-run.md`](docs/local-phone-run.md): start the backend and frontend, check them, and open the app on a phone through an HTTPS tunnel. Phones need HTTPS for GPS and the microphone.

**Checks:** `npm test` runs the mocked test suites (no real provider calls). Last run, 2026-11-08 (about 00:30 Toronto time): frontend 50/50, backend rewards 41/41, chat 62/62, route safety 15/15, and scoring, companion and trip evidence passed. Planner was 166/167: the one failure was the "daily cap flagged" check. Because the backend suites are chained, that failure stops `npm test` before the companion, evidence and safety suites, so those were run on their own.

## Deployment

- **Backend:** Render, https://commutr-backend.onrender.com (free tier: the first request after idle can be slow).
- **Frontend:** Vercel setup is on main ([`frontend/vercel.json`](frontend/vercel.json) forwards `/api` to Render; see [`frontend/DEPLOYMENT.md`](frontend/DEPLOYMENT.md)). No public frontend URL yet.

## Docs

- [`docs/api.md`](docs/api.md): the API contract between frontend and backend
- [`docs/local-phone-run.md`](docs/local-phone-run.md): run locally and open on a phone
- [`docs/agent-tools.md`](docs/agent-tools.md): Muta's browser tools
- [`docs/elevenlabs-agent-setup.md`](docs/elevenlabs-agent-setup.md): the ElevenLabs agent and the frontend voice integration (section 7)
- [`docs/track-gemini.md`](docs/track-gemini.md), [`docs/track-elevenlabs.md`](docs/track-elevenlabs.md): track write-ups
- [`COMPANION.md`](COMPANION.md): Muta's design notes

## Team

- Backend (API, scoring, transit, planner, chat): Shahmeer
- Frontend (UI, map, PWA, Muta interface): kostslava

## Attribution

- Transit data: Grand River Transit, Region of Waterloo Open Data
- Map tiles and place search: © OpenStreetMap contributors (Nominatim)
- Route lines: Valhalla (public server at valhalla1.openstreetmap.de)
- Street imagery for route safety: Mapillary contributors, CC BY-SA 4.0 (photo creators are listed with each rating)
- Voice: ElevenLabs. AI: Google Gemini
- Merchants, rewards, users and clubs are demo data
