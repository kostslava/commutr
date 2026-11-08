# Commutr: Best use of the Gemini API

Commutr rewards people in Kitchener-Waterloo for walking, cycling and taking transit instead of driving. We use Gemini where a language model helps: choosing and explaining trip options, answering questions about the user's own account, turning a typed request into actions in the app, and rating how comfortable a walking route looks from street-level photos. **Every number a user sees (minutes, km, points, next bus) is computed by our backend.** Gemini decides, orders and explains; it never invents a figure.

All calls go through the official `@google/genai` SDK on the backend (`backend/src/chat/gemini.ts`). The key lives only in the server's environment and is never sent to the browser or logged.

## Models (from `backend/src/chat/config.ts`)

| Use | Model |
|---|---|
| Trip planner, chat, Muta text chat | `gemini-3.5-flash-lite` |
| Voice message transcription | `gemini-3.5-flash-lite` |
| Route safety ratings (offline script, image input) | `gemini-3.5-flash-lite` |
| Fallback speech (text to speech) | `gemini-3.8-flash-lite-tts`, voice `Kore` |

## 1. Trip planner: function calling over live GRT data and our scoring rules

**Endpoints:** `POST /api/plan` (the Map screen) and `POST /api/companion/plan` (when Muta plans a trip). **Code:** `backend/src/planner/`.

1. The backend resolves the origin (saved home, a named place or coordinates) and the destination (saved place, demo merchant or Nominatim search). It computes the walk, bike and transit options in code. That computed answer is also the fallback.
2. **Gemini runs with function calling** over four tools that read our real data:
   - `find_destination`: up to 3 matching places, with a `place_id` and straight-line distance.
   - `get_route_options`: walk, bike and transit minutes and km for a place.
   - `get_live_buses_near`: the next live GRT arrivals near the start (route, direction, minutes away), from the GTFS-realtime trip updates.
   - `get_points_estimate`: the points the user would earn for a mode, from the real scoring formula, their trust multiplier and what's left of the daily cap.
3. **One final call with structured output** (a response schema): which `place_id`, the `recommendation`, the `order` of the modes, a short eco note per mode, and a 1–2 sentence spoken `summary`.
4. **The backend validates the answer.** The minutes, km, points and next bus in the response always come from step 1. If Gemini's summary contains a number that isn't in the tool results, the computed summary replaces it.
5. **Computed fallback.** If Gemini fails, takes longer than the budget (8 s for the Map screen, 6 s from arrival for Muta's `POST /api/companion/plan`, look-ups included), or the quota has no room for a whole plan, the response is the computed answer with `source: "computed"`. The app works the same either way.
6. Gemini's decision is cached for 5 minutes; the numbers are always recomputed.

## 2. Muta text chat: function calling over the user's real data, returning app actions

**Endpoint:** `POST /api/companion/chat` (Muta's "Let's type"). **Code:** `backend/src/chat/companion.ts`, `backend/src/chat/muta.ts`.

- Gemini gets the message, the last 6 turns and the current screen. It can call tools in up to 3 rounds, within 12 s.
- **Account tools:** `get_my_status` (points, eco score, streak, today's points and cap), `get_affordable_rewards`, `get_locked_rewards` (with what's missing), `get_clubs`, and `get_reward_catalogue` (real reward IDs and eligibility).
- **Place discovery:** `discover_places` searches real KW places through Nominatim on the server, for "I'm bored, where should I go?" requests.
- **App actions:** `navigate`, `plan_trip`, `start_trip`, `finish_trip` and `redeem_reward`. Gemini doesn't run these. It requests them, the backend checks their arguments and returns at most 3 as `actions`, and the browser validates and runs them through the app's own navigation, map and GPS tracker. The backend stays the authority for points, eligibility and balances.
- **If Gemini fails,** the reply comes from the Community chat logic below, with no actions. A Gemini problem never becomes an error for the user.

## 3. Community help chat: FAQ first, Gemini for personal questions

**Endpoint:** `POST /api/chat` (the Community tab's help channel). **Code:** `backend/src/chat/chat.ts`, `backend/src/chat/tools.ts`, `backend/src/chat/faq.ts`.

- **General questions** are answered from a built-in FAQ of 88 entries, matched on the server with no AI call.
- **Personal questions** ("how many points do I have?", "why is my reward locked?") go to **Gemini with function calling** over the four account tools above. Gemini sees points, eco score, streak, rewards and clubs, never the user's name, email, location or ID.
- **"Where should I eat?"** builds suggestions on the server from the demo merchants and rewards: affordable first, otherwise the cheapest one plus how far to walk or bike to earn the difference. Gemini words the reply.
- **If Gemini is slow** (over 5 s), down or over its limits, the reply is a canned message.

## 4. Route safety: Gemini vision over Mapillary street photos

**Endpoint:** `POST /api/companion/route-safety`. **Code:** `backend/scripts/route-safety-generate.ts` (makes the ratings), `backend/src/safety/`, `backend/src/routes/safety.ts`.

1. **Made once, offline.** `npm run safety:generate` gets a walking path for each of 4 demo routes from the public Valhalla server, then picks up to 6 Mapillary street-level photos along it (within 25 m of the path, no panoramas, 2022 or later preferred, at most 2 from one photo sequence).
2. **One Gemini vision call per route** (`gemini-3.5-flash-lite`): the photos go in as images, in memory only, with a response schema. Gemini rates lighting, sidewalks, traffic and crossings (`good`, `fair`, `poor` or `unknown` when not visible), gives an overall rating and a 1–5 score, and writes a short summary to be read aloud. The code validates the answer, and lowers the confidence when fewer than 4 photos were used or the newest photo is older than 2022.
3. **Saved to `backend/src/safety/ratings.json`.** The endpoint only reads that file. It never calls Gemini or Mapillary when a user asks, so it answers instantly and uses no quota. The photos themselves aren't stored; only the rating, photo counts and dates, and the photo creators' names are.
4. **In the app:** Muta's `get_route_safety` tool calls the endpoint (with the map's planned start and end when there is one). A rated route shows on the map as a card with the four factor notes, the source note and the Mapillary attribution. Any other route gets an honest "I don't have street photo data for that route yet."

**Honest limits:**
- Only 4 rated routes: Builders Club (the demo home) to Central Station and to Victoria Park, Waterloo Park to Waterloo Public Square Station, and University of Waterloo to Waterloo Public Square Station.
- 4 to 6 photos per route, taken between 2016 and 2024. Streets change, so every answer says: "Conditions change; this isn't a safety guarantee."
- It's a model's estimate from photos, not an audit or official data.
- Imagery is Mapillary's, CC BY-SA 4.0. The attribution and photo creators are shown with every rating.

## 5. Voice input and speech output (built in the backend, not in the current UI)

These are built and tested in the backend, but **the current frontend doesn't use them**: the Community chat is text only, and Muta's voice runs on ElevenLabs.

- **Voice messages:** `POST /api/chat/voice` takes an audio file (up to 5 MB). Gemini `gemini-3.5-flash-lite` transcribes it (10 s timeout), then it's answered like a typed message.
- **Gemini TTS fallback:** every `/api/chat` reply has an `audio_url`. ElevenLabs is used first. If ElevenLabs fails, is slow (4 s) or has used its daily character budget, `gemini-3.8-flash-lite-tts` generates the audio instead.

## Guardrails and limits

- **Provider ceilings per model**, per minute and per day, persisted across restarts, so we never burn the free quota.
- **Per-user limits:**
  - chat: 10 a minute, 100 a day;
  - voice: 4 a minute, 30 a day;
  - planning: 10 a minute, 300 a day;
  - place discovery: 10 a minute, 300 a day, a separate limit from planning;
  - every 429 says when to retry (`retry_after_sec` and a `Retry-After` header).
- **The per-user limits don't guard the Gemini quota; the provider ceilings do.** Every visitor to the public demo is demo user 1, so the per-user limits are sized for a crowd. A plan uses Gemini only when the ceiling has room for all of its calls, and is computed otherwise.
- **Numbers come from code, not from the model.** Answers are checked for numbers that aren't in the tool results.
- **Tests run against a mocked Gemini.** The planner suite has 182 checks (all passed on 2026-11-08), chat 62, route safety 15, and the companion suite covers function calls, history, account reads, action validation and privacy.

## Not built

- Route safety for routes other than the 4 demo routes, and live (on-request) photo rating. Ratings are generated ahead of time.
- Trip photos (the optional photo evidence on a trip) aren't analysed by Gemini or any other vision service. They're stored as supporting evidence only.
- Voice input and Gemini speech in the current UI (they exist in the backend only, see section 5).
- Muta's live voice conversation doesn't use our Gemini calls. It runs on the ElevenLabs agent, whose LLM is configured on ElevenLabs, not by our code.
