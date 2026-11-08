# Commutr

A mobile-first Kitchener–Waterloo commuting app with live transit, trip recording, eco points, demo rewards, clubs, and Muta — a mascot you can type or talk to while using the app.

## Run locally

Requires Node 22+ and npm.

```sh
npm run setup
cp backend/.env.example backend/.env
npm --prefix backend run seed
```

Add `GEMINI_API_KEY` and `ELEVENLABS_API_KEY` to `backend/.env`. The existing ElevenLabs agent ID is in `backend/elevenlabs/state.json`; `ELEVENLABS_AGENT_ID` can override it. Never put provider keys in frontend environment variables.

Configure the existing voice agent once:

```sh
npm --prefix backend run companion:setup
```

Start these in separate terminals:

```sh
npm run backend:start
npm run dev
```

The frontend proxies `/api` to the backend on port 8787. On desktop it displays an interactive phone preview; use `?phone=1` for the app without the frame. For a production preview, run `npm run build`, then `npm run preview -- --port 4173`. HTTPS or localhost is required for microphone and location access.

## Muta

Muta peeks from the edge of the app. Open him for **Let’s type** or **Let’s talk**. Typed conversations use backend Gemini function calling; live voice uses the existing ElevenLabs agent with signed sessions and ten browser tools. Calls remain connected when navigating or minimizing. Muta can plan routes, start/finish trips, navigate pages, explain account stats and rewards, redeem explicitly requested demo rewards, and discover real places beyond the preset destinations. Explicit requests execute directly; browser microphone/location permissions still apply. Voice has no transcript UI. Closing text chat clears its context.

See [COMPANION.md](COMPANION.md) for architecture and provider setup, and [questions.md](questions.md) for the backend/deployment handoff. Do not run the legacy `agent:setup` afterward: it restores the older webhook agent configuration.

## Checks

```sh
npm run build
npm test
```

Frontend code, assets, PWA configuration and tests are in `frontend/`. Backend API, scoring, planner and tests are in `backend/`. The existing API contract remains in `docs/api.md`; additive Muta endpoints are documented in `COMPANION.md`.

This is a local demo with demo-user selection. Catalogue merchants/rewards are demo data. Wallet fare discounts and memberships are proposed previews. Replace demo identity selection with real authentication and provide the API/routing proxies before deployment. GPS recording requires the app to stay open in the foreground.
