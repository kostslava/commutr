# Commutr API contract

Owned by the backend (Shahmeer). The frontend agent must not edit this file. If the frontend needs a change, tell your human, who asks the backend owner. See AGENTS.md.

**Status: every endpoint is built.** Shapes of built endpoints only change after an announcement.

## Basics

- Base URL (local dev): `http://localhost:8787`. The port can be changed with the `PORT` env var.
- All app endpoints are under `/api`. `/health` is at the root.
- JSON in, JSON out. Send `Content-Type: application/json` on requests with a body.
- **Times:** ISO 8601 UTC strings, for example `"2026-11-07T14:05:00.000Z"`. Exception: streak dates are Toronto local dates, `"YYYY-MM-DD"`.
- **IDs** are integers.
- **Distances** are in km.
- **CORS:** any origin is allowed in development (`NODE_ENV` not `production`).

### Current user (fake auth)

There is no login yet. Every `/api` request acts as **user 1**, unless it sends the header below. (The exceptions are the public transit endpoints, which ignore it.)

```
X-Demo-User: 3
```

Seed users: 1 Alex (eco 98), 2 Sam (eco 88), 3 Jordan (eco 82), 4 Taylor (eco 60, rewards mostly locked). This header will be replaced by real auth later.

### Errors

Errors always use this shape, with a matching HTTP status:

```json
{ "error": { "code": "user_not_found", "message": "No user with id 9. Run npm run seed?" } }
```

| Status | `code` | When |
|---|---|---|
| 400 | `bad_demo_user` | `X-Demo-User` is not a positive integer *(built)* |
| 404 | `user_not_found` | `X-Demo-User` names a user that doesn't exist *(built)* |
| 400 | `validation_error` | Bad request body or params *(built)* |
| 404 | `not_found` | Trip, reward, club or location doesn't exist, or isn't yours *(built)* |

Endpoint-specific codes are listed with each endpoint.

---

## Health

### `GET /health` — **built**

```json
{ "ok": true }
```

---

## Trips

The user picks the mode **before** the trip. While the app is open in the foreground, the frontend sends GPS points in batches, then finishes the trip. The backend scores it and updates points, trust, eco score, streak and club steps.

`mode` is one of `"walk" | "bike" | "scooter" | "transit" | "car"`.

**Sparse points are fine.** Browsers pause GPS in the background, so gaps are expected. A gap alone never lowers confidence. It only counts when the position jumps impossibly far for the time that passed.

### `POST /api/trips` — start a trip — **built**

Request:
```json
{ "mode": "walk" }
```

Response `201`:
```json
{ "id": 11, "mode": "walk", "status": "active", "started_at": "2026-11-07T14:05:00.000Z" }
```

- The server sets `started_at`. Sending `started_at` returns `400`; it's only accepted in a test-only server mode.
- Errors: `400 validation_error` for an unknown mode.
- Errors: `409 trip_already_active` if the user already has an active trip. The response includes `"active_trip_id"`, so the frontend can resume or finish it.

### `POST /api/trips/:id/points` — add GPS points — **built**

Send batches, for example every 10–30 seconds and whenever the app comes back to the foreground. A batch holds 1 to 500 points, and a trip at most 10,000.

Request:
```json
{
  "points": [
    { "lat": 43.4723, "lng": -80.5449, "accuracy": 6, "timestamp": "2026-11-07T14:05:10.000Z" },
    { "lat": 43.4726, "lng": -80.5431, "accuracy": 8, "timestamp": "2026-11-07T14:05:40.000Z" }
  ]
}
```

- `accuracy` is in metres, from `GeolocationCoordinates.accuracy`. It may be `null` or left out.
- `timestamp` is the GPS fix time, from `GeolocationPosition.timestamp` converted to ISO.
- Points can arrive out of order; the backend sorts them.

Response `200`:
```json
{ "trip_id": 11, "accepted": 2, "rejected": 0, "total_points": 14 }
```

`rejected` counts points that were well-formed but not stored, either because they're timestamped outside the trip or because the trip is full. A point is outside the trip if its time is before the trip start or after the current time, allowing 60 s for clock drift.

Errors:
- `400 validation_error`: malformed points (bad lat or lng, a non-ISO timestamp, a negative accuracy) or too many points.
- `404 not_found`: not your trip.
- `409 trip_not_active`: the trip is already finished.

### `POST /api/trips/:id/finish` — finish and score a trip — **built**

Request: an empty body `{}`.

Response `200`:
```json
{
  "trip": {
    "id": 11,
    "mode": "walk",
    "status": "finished",
    "started_at": "2026-11-07T14:05:00.000Z",
    "ended_at": "2026-11-07T14:31:00.000Z",
    "distance_km": 2.71,
    "confidence": 1,
    "points_awarded": 27,
    "capped": false,
    "flags": []
  },
  "user": { "points": 3227, "eco_score": 99 },
  "streak": { "current_days": 6, "longest_days": 12, "last_active_date": "2026-11-07", "active_today": true },
  "steps_added": 3526
}
```

Errors: `404 not_found` · `409 trip_not_active` (already finished).

**How a trip is scored.** Every number below can be tuned in `backend/src/scoring/config.ts`.

- **`distance_km`** is the *verified* distance. It counts no impossible jumps and nothing faster than the mode allows, so a "walk" doesn't earn for a car stretch. Points with accuracy worse than 50 m are dropped, and movements under 10 m are treated as GPS jitter.
- **`points_awarded`** = verified km × mode rate × confidence × the user's trust multiplier, rounded, then limited by the daily cap.
  - Mode rates per km: walk 10, bike 6, scooter 4, transit 3, car 0.
  - **Daily cap: 200 points per Toronto calendar day.** `capped: true` means the cap cut this trip's points.
- **`confidence`** is between 0 and 1, or `null` for car trips, which aren't checked. It starts at 1, and each check that fails subtracts its penalty and adds a flag:

| Flag | Meaning | Penalty |
|---|---|---|
| `speed_too_high` | Average moving speed is too high for the mode (walk 12, bike 30, scooter 28, transit 70 km/h) | 0.5 |
| `car_like_burst` | Walk, bike or scooter going car-speed for a minute or more (over 20 / 45 / 40 km/h) | 0.6 |
| `impossible_jump` | The position jumped 500 m or more faster than possible (walk 25, bike 70, scooter 60, transit 130 km/h) | 0.5 |
| `too_few_points` | Fewer than 5 usable GPS points | 0.5 |
| `poor_accuracy` | More than half the points dropped, or median accuracy worse than 30 m | 0.2 |
| `constant_speed` | Suspiciously constant speed: less than 5% variation over 10+ segments | 0.5 |
| `far_from_last_trip` | Starts more than 2 km from where the previous trip ended, less than 60 min later | 0.2 |
| `transit_start_not_near_stop` | Transit trip doesn't start within 200 m of a GRT stop | 0.4 |
| `transit_end_not_near_stop` | Transit trip doesn't end within 200 m of a GRT stop | 0.4 |
| `stop_check_unavailable` | Stop data wasn't loaded, so the transit check was skipped | 0 (info only) |

**Side effects of finishing:**

| Case | Points | Trust multiplier | Eco score | Streak and club steps |
|---|---|---|---|---|
| Confidence ≥ 0.8 and ≥ 0.5 km | Yes | +0.02 (max 1.0) | +1 if ≥ 1 km (max +3 a day, max 100) | Yes |
| Confidence 0.3 to under 0.8 | Yes | No change | +1 if ≥ 1 km (same limits) | Yes |
| **Confidence below 0.3** | **0** | **−0.15** (min 0.4) | No change (not a car penalty) | No |
| **Car trip** | **0** | No change | **−0.5 per km**, rounded, between −1 and −10 per trip | No |

- **Streak:** a day counts with one finished non-car trip with confidence ≥ 0.3 and at least 0.5 verified km, by Toronto date. A trip the day after the last active day adds +1; a later trip restarts the streak at 1. Car trips never break a streak.
- **Club steps:** walk trips only (confidence ≥ 0.3) add verified km × 1,300 steps to every club the user is in. Club totals reset when a new Toronto week starts (Monday).

### `GET /api/trips?limit=20` — my trips, newest first — **built**

`limit` is between 1 and 100, and defaults to 20.

Response `200`:
```json
{
  "trips": [
    {
      "id": 3,
      "mode": "walk",
      "status": "finished",
      "started_at": "2026-11-05T13:00:00.000Z",
      "ended_at": "2026-11-05T13:22:00.000Z",
      "distance_km": 1.8,
      "confidence": 1,
      "points_awarded": 18,
      "flags": []
    }
  ]
}
```

Active trips appear too, with `ended_at`, `distance_km`, `confidence` and `points_awarded` set to `null`.

### `GET /api/trips/:id` — one trip with its GPS path — **built**

Response `200`: the same fields as a list item, plus
```json
{ "points": [ { "lat": 43.4655, "lng": -80.5228, "accuracy": 5, "timestamp": "2026-11-05T13:00:00.000Z" } ] }
```

The points are every stored point, sorted by time, including ones that scoring dropped. Errors: `404 not_found`.

---

## Me (profile, points, eco score)

### `GET /api/me` — **built**

Response `200`:
```json
{
  "id": 1,
  "name": "Alex Demo",
  "email": "alex@demo.commutr.test",
  "points": 3200,
  "eco_score": 98,
  "trust_multiplier": 1,
  "points_today": 40,
  "daily_cap": 200,
  "streak": { "current_days": 5, "longest_days": 12, "last_active_date": "2026-11-06", "active_today": false },
  "clubs": [
    {
      "id": 1,
      "name": "UW Walkers",
      "my_steps_this_week": 42300,
      "steps_this_week": 92350,
      "weekly_goal_steps": 150000,
      "progress": 0.616,
      "goal_reached": false
    }
  ],
  "saved_locations": [
    { "id": 1, "kind": "home", "label": "Home", "lat": 43.4762, "lng": -80.5371 },
    { "id": 2, "kind": "favourite", "label": "Campus", "lat": 43.4723, "lng": -80.5449 }
  ]
}
```

| Field | Notes |
|---|---|
| `eco_score` | 0–100. Car trips lower it; green trips of 1 km or more raise it by 1 (at most +3 a day). See Trips. |
| `trust_multiplier` | 0.4–1.0. It multiplies trip points. It drops after a trip with confidence below 0.3, and recovers slowly with clean trips. |
| `points_today`, `daily_cap` | Trip points earned today (Toronto time) and the daily cap, for example "40 / 200 today" |
| `streak.current_days` | **Shows 0 if the last active day was before yesterday** (Toronto time); the streak is broken. `longest_days` is always kept. |
| `streak.active_today` | `true` if today already counts toward the streak |
| `clubs` | The clubs I'm in. `my_steps_this_week` is my share; `steps_this_week` is the club's total. Both follow the weekly reset. |
| `saved_locations` | The home comes first, then favourites. Same as `GET /api/locations`. |

A streak day is one finished non-car trip with confidence of at least 0.3 and at least 0.5 verified km, counted by Toronto date.

---

## Rewards

A reward is **locked** when the user's eco score is below `min_eco_score`, **even if they have enough points**. It is **affordable** when `points >= points_cost`. Each reward can be redeemed **once per day** (Toronto time) per user. All merchants and rewards are demo data, and redemption codes are demo codes.

### `GET /api/rewards` — **built**

Response `200`:
```json
{
  "rewards": [
    {
      "id": 3,
      "title": "$25 Maple Loop Coffee card",
      "points_cost": 2500,
      "min_eco_score": 95,
      "locked": true,
      "affordable": true,
      "lock_reason": "eco_score_too_low",
      "points_needed": 0,
      "eco_needed": 13,
      "redeemed_today": false,
      "merchant": {
        "id": 1,
        "name": "Maple Loop Coffee",
        "category": "coffee",
        "address": "King St N, Uptown Waterloo (demo location)",
        "lat": 43.4651,
        "lng": -80.5225
      }
    }
  ]
}
```

| Field | Notes |
|---|---|
| `lock_reason` | `"eco_score_too_low"` when locked by eco score. `"not_enough_points"` when unlocked but not affordable. Otherwise `null`. Eco takes priority when both apply. |
| `points_needed` | How many more points are needed. 0 if affordable. |
| `eco_needed` | How much more eco score is needed. 0 if unlocked. |
| `redeemed_today` | Already redeemed today, so a redeem now would return `409 already_redeemed_today` |

Gift card merchants have `address`, `lat` and `lng` set to `null`. Rewards are sorted by merchant, then cost.

### `POST /api/rewards/:id/redeem` — **built**

Request: an empty body `{}`.

The checks, the point deduction and the new redemption all happen in one transaction, so points can't be spent twice.

Response `201`:
```json
{
  "redemption": {
    "id": 3,
    "reward_id": 2,
    "title": "$10 Maple Loop Coffee card",
    "merchant_name": "Maple Loop Coffee",
    "points_spent": 1000,
    "code": "CMTR-7F3K-Q2PX",
    "redeemed_at": "2026-11-07T15:00:00.000Z"
  },
  "user": { "points": 2200 }
}
```

Codes look like `CMTR-XXXX-XXXX`. They use letters and digits but never 0, O, 1 or I, so they're easy to read out.

Errors (checked in this order):

| Status | `code` | Extra fields |
|---|---|---|
| 404 | `not_found` | Unknown reward |
| 403 | `eco_score_too_low` | `min_eco_score`, `eco_score` |
| 409 | `already_redeemed_today` | (none) |
| 409 | `not_enough_points` | `points_cost`, `points` |

```json
{ "error": { "code": "eco_score_too_low", "message": "This reward needs an eco score of 95; yours is 82" }, "min_eco_score": 95, "eco_score": 82 }
```

### `GET /api/redemptions` — my redeemed rewards — **built**

Newest first, at most 100.

Response `200`:
```json
{
  "redemptions": [
    { "id": 1, "reward_id": 6, "title": "Free coffee and pastry", "merchant_name": "Belmont Bakehouse", "points_spent": 300, "code": "DEMO-0001", "redeemed_at": "2026-11-04T17:20:00.000Z" }
  ]
}
```

---

## Clubs

Each club has a weekly shared step goal and a group reward.
- **Progress counts walking only:** verified walk km × 1,300 steps, from trips with confidence of at least 0.3.
- **Weekly reset:** weeks start on Monday, Toronto time. Steps from an earlier week count as 0.
- **New members start at 0 steps.** Walks from earlier in the week don't count.
- **Leaving removes your steps** from the club total.

### `GET /api/clubs` — **built**

Response `200`:
```json
{
  "clubs": [
    {
      "id": 1,
      "name": "UW Walkers",
      "description": "Students walking to campus instead of driving.",
      "weekly_goal_steps": 150000,
      "steps_this_week": 92350,
      "progress": 0.616,
      "goal_reached": false,
      "week_start": "2026-11-02",
      "member_count": 3,
      "is_member": true,
      "group_reward": "Free medium coffee for every member at Maple Loop Coffee (demo)"
    }
  ]
}
```

- `progress` runs from 0 to 1 and is capped at 1.
- `goal_reached` is `true` once `steps_this_week >= weekly_goal_steps`.
- `week_start` is the Monday of the current week. The group reward is shown as text only; claiming it isn't built yet.

### `GET /api/clubs/:id` — **built**

Response `200`: the same fields as a list item, plus the members, sorted by steps:
```json
{
  "members": [
    { "user_id": 1, "name": "Alex Demo", "steps_this_week": 42300, "joined_at": "2026-10-16T14:00:00.000Z" },
    { "user_id": 2, "name": "Sam Rivera", "steps_this_week": 31850, "joined_at": "2026-10-17T15:30:00.000Z" }
  ]
}
```

Errors: `404 not_found`.

### `POST /api/clubs/:id/join` — **built**
### `POST /api/clubs/:id/leave` — **built**

Request: an empty body `{}`.

Both can safely be repeated. Joining a club you're already in, or leaving one you're not in, still returns `200`.

Response `200`:
```json
{ "club_id": 1, "joined": true, "club": { "id": 1, "member_count": 4, "is_member": true, "steps_this_week": 92350, "…": "same fields as GET /api/clubs" } }
```

`leave` returns `"left": true` instead of `"joined": true`. Errors: `404 not_found` for an unknown club.

---

## Saved locations

Each user has **at most one home**, and adding a new home replaces the old one. Users can have up to **20 favourites**.

### `GET /api/locations` — **built**

Response `200`:
```json
{
  "locations": [
    { "id": 1, "kind": "home", "label": "Home", "lat": 43.4762, "lng": -80.5371 },
    { "id": 2, "kind": "favourite", "label": "Campus", "lat": 43.4723, "lng": -80.5449 }
  ]
}
```

The home comes first, then favourites in the order they were added.

### `POST /api/locations` — **built**

Request:
```json
{ "kind": "favourite", "label": "Gym", "lat": 43.46, "lng": -80.52 }
```

`kind` is `"home"` or `"favourite"`. `label` is 1–50 characters.

Response `201`:
```json
{ "location": { "id": 7, "kind": "favourite", "label": "Gym", "lat": 43.46, "lng": -80.52 }, "replaced_id": null }
```

When a new home replaces the old one, `replaced_id` is the old home's id.

Errors: `400 validation_error` · `409 too_many_favourites`.

### `DELETE /api/locations/:id` — **built**

Response `204` with no body. Errors: `404 not_found` if the location doesn't exist or isn't yours.

---

## Transit (GRT buses and ION light rail)

These endpoints use real Grand River Transit open data: GTFS-realtime vehicle positions and the static GTFS schedule, for both buses (feed 1) and ION light rail (feed 2, route `301`).

- **No fake user needed.** They don't depend on the user, so they ignore `X-Demo-User` and work without a seeded database.
- **Attribution:** both responses include an `attribution` string. Show it on the map, for example in a corner: `"Transit data: Grand River Transit, Region of Waterloo Open Data"`.
- **Bounding box (optional, both endpoints):** `?bbox=west,south,east,north`, in degrees. That's lng,lat,lng,lat, the same order as MapLibre's `map.getBounds().toArray().flat()`. For example: `?bbox=-80.530,43.460,-80.515,43.472`. A malformed box returns `400 validation_error`.

### `GET /api/buses/live` — **built**

Response `200`:
```json
{
  "source": "live",
  "updated_at": "2026-11-07T19:35:07.000Z",
  "attribution": "Transit data: Grand River Transit, Region of Waterloo Open Data",
  "vehicles": [
    {
      "id": "20913",
      "route_id": "7",
      "route_short_name": "7",
      "headsign": "Fairway Station",
      "lat": 43.46545,
      "lng": -80.522453,
      "bearing": null,
      "speed": null,
      "timestamp": "2026-11-07T19:35:34.000Z"
    }
  ]
}
```

| Field | Notes |
|---|---|
| `source` | `"live"` = real GRT positions. `"fake"` = simulated vehicles, because the feed failed. **Show a small "simulated" label when it's `"fake"`.** |
| `updated_at` | Live: the feed's own timestamp. Fake: when the fake positions were generated. |
| `id` | Vehicle id (string). Fake vehicles use `"fake-1"`, `"fake-2"`, and so on. |
| `route_id`, `route_short_name` | For example `"7"`. ION is `"301"`. Can be `null` if the vehicle isn't on a known trip. |
| `headsign` | Where it's going, for example `"Fairway Station"` or `"301 Fairway"`. Can be `null`. |
| `bearing` | Degrees, 0 = north, clockwise. **GRT currently doesn't send it, so it's `null` for live vehicles.** Fake vehicles have it. |
| `speed` | km/h. **GRT currently doesn't send it, so it's `null` for live vehicles.** Fake vehicles have it. |
| `timestamp` | When this vehicle's position was reported. |

**Behaviour:**
- The backend caches results for 10 seconds, so polling every 10–15 s is plenty.
- It returns `"live"` if at least one feed (buses or ION) returned vehicles.
- It returns `"fake"` (about 8 vehicles moving along real GRT and ION routes) when every feed:
  - fails,
  - times out (5 s),
  - is stale (its timestamp is more than 5 minutes old), or
  - returns zero vehicles.

  GRT also stops running overnight, so expect `"fake"` then.

### `GET /api/stops` — **built**

Returns every boardable stop: about 2,250 bus stops and 32 ION platforms. Parent "station" entries are left out. The response is about 200 KB without a `bbox`.

Response `200`:
```json
{
  "attribution": "Transit data: Grand River Transit, Region of Waterloo Open Data",
  "stops": [
    { "id": "1270", "code": "1270", "name": "Willis Way Station", "lat": 43.46211, "lng": -80.523307 },
    { "id": "6001", "code": null, "name": "Conestoga Station - Southbound", "lat": 43.498292, "lng": -80.529516 }
  ]
}
```

| Field | Notes |
|---|---|
| `id` | GTFS stop id (string) |
| `code` | The stop number printed on the sign, which riders use. ION platforms have none, so it's `null`. |
| `name`, `lat`, `lng` | Stop name and position |

The schedule data refreshes automatically every 24 hours.

---

## Chatbot (the Commutr mascot)

The mascot answers questions about Commutr and getting around Kitchener-Waterloo, in text and voice.

**How a message is answered:**
- **General questions** ("how do points work") come from a built-in FAQ of about 90 entries, matched on the server with no AI call. These are instant, with `source: "faq"`.
- **Personal questions** ("how many points do I have", "what can I afford", "why is my reward locked") go to **Gemini with function calling**. Gemini reads the user's points, eco score, streak, rewards and clubs through tools. Gemini never sees the user's name, email, location or ID.
- **"What should I eat / where should I go"** builds `suggestions` on the server from the demo merchants and rewards:
  - affordable ones first;
  - if nothing is affordable, the cheapest one, with how far to walk or bike to earn the difference.

  Gemini words the reply.
- **If Gemini is slow (over 5 s), down or over its limits,** the reply is a canned message with `source: "fallback"`. **Chat never returns an error because of Gemini.**

**Voice:**
- **Show the text at once, and play the audio when it's ready.** Every reply has an `audio_url`.
- Usually the voice is ElevenLabs (`voice: "elevenlabs"`), and the file is ready when the reply arrives.
- If ElevenLabs is unavailable, `voice` is `"gemini"`. The first request for `audio_url` then generates the audio, which can take a few seconds.
- If speech fails, that request returns `503`; the text still works. Use `<audio src={base + audio_url}>`, which doesn't need `X-Demo-User`.
- **Show `attribution` when it isn't null.** It's `"Voice by ElevenLabs"` for ElevenLabs audio.

**Limits per user:** 10 text messages a minute and 100 a day; 4 voice messages a minute and 30 a day. Over the limit returns `429`:
```json
{ "error": { "code": "rate_limited", "message": "Too many chat messages. Try again soon." }, "retry_after_sec": 42 }
```

### `POST /api/chat` — **built**

Request:
```json
{ "message": "I'm hungry, where should I eat?" }
```

`message` is 1–500 characters.

Response `200`:
```json
{
  "reply": "You can grab a coffee and pastry at Belmont Bakehouse for 300 points, or a wrap at Uptown Shawarma House!",
  "source": "gemini",
  "audio_url": "/api/chat/audio/3f2a…64 hex chars…",
  "voice": "elevenlabs",
  "attribution": "Voice by ElevenLabs",
  "suggestions": [
    {
      "type": "reward",
      "reward_id": 6,
      "merchant_id": 4,
      "name": "Belmont Bakehouse",
      "category": "bakery",
      "reward_title": "Free coffee and pastry",
      "lat": 43.4436,
      "lng": -80.5047,
      "points_cost": 300,
      "affordable": true,
      "locked": false,
      "points_short": 0,
      "eco_needed": 0,
      "earn_by_walking_km": null,
      "earn_by_biking_km": null,
      "distance_km": 4.2
    }
  ]
}
```

| Field | Notes |
|---|---|
| `source` | `"faq"` (built-in answer), `"gemini"`, or `"fallback"` (Gemini unavailable; a canned or template reply) |
| `audio_url` | Relative URL of the spoken reply, or `null` if there's nothing to say |
| `voice` | `"elevenlabs"` (ready now) or `"gemini"` (generated on the first request) |
| `attribution` | `"Voice by ElevenLabs"`, or `null` |
| `suggestions` | Only for "where to eat or go" questions, otherwise `[]`. `type: "reward"` means redeemable now. `type: "destination"` means go there and earn the rest: `points_short` points, about `earn_by_walking_km` km of walking or `earn_by_biking_km` km of biking. `distance_km` is measured from the user's saved home, and is `null` without one. |

Errors: `400 validation_error` · `429 rate_limited`.

### `POST /api/chat/voice` — **built**

Request: `multipart/form-data` with one file field, `audio`.

- **Types:** `audio/webm` (Chrome and Firefox recordings), `audio/mp4` / `audio/m4a` (Safari), `audio/wav`, `audio/mpeg`, `audio/ogg`.
- **Size:** at most **5 MB**.
- **Length:** at most **30 seconds**. The server checks this for WAV only, from the file header. For other formats it relies on the size limit, so **the frontend must stop recording at 30 s**.

Gemini transcribes the audio word for word, and the transcript is then answered like a typed message.

Response `200`: the same fields as `POST /api/chat`, plus
```json
{ "transcript": "how do i earn points" }
```

- `transcript` is `""` when no speech was heard. The reply then asks the user to try again, with `source: "fallback"`.
- `transcript` is `null` if transcription failed. The reply suggests typing instead.

Errors: `400 validation_error` (no `audio` field, empty file) · `413 too_large` (over 5 MB) · `413 too_long` (WAV over 30 s) · `415 unsupported_audio` · `429 rate_limited`.

### `GET /api/chat/audio/:id` — **built**

Serves the spoken reply: `audio/mpeg` for ElevenLabs, `audio/wav` for the Gemini voice. It's cached for a long time and is public: no `X-Demo-User` needed, and IDs are unguessable hashes.

| Status | Meaning |
|---|---|
| `200` | The audio |
| `404 not_found` | Unknown ID |
| `503 audio_unavailable` | Speech generation failed or hit a limit (`Retry-After: 30`). The text reply still works; skip the audio. |

---

## Trip planner

Plans a green trip to a destination: walk, bike and direct GRT transit options, a recommendation, and a short summary the app can show or read aloud.

**How it works:**
- **The server computes every number:** minutes, km, points estimates and the next bus. Gemini (function calling, then a structured-output answer) only **chooses, orders and explains** the options. The server checks Gemini's answer. A summary that contains a number not in the computed data is replaced by a computed summary.
- **Distances** are the straight line times a detour factor (walk ×1.3 at 5 km/h, bike ×1.25 at 15 km/h). There's no street routing, so the `steps` are general directions.
- **Transit** covers direct routes only (no transfers): a stop within 800 m of each end, on the same route, in the right direction.
  - The ride length is measured along the route, at about 20 km/h.
  - `next_bus` is a live GRT prediction (`source: "live"`), else an estimate from live bus positions (`"estimate"`), else `null` (then a 10-minute wait is assumed).
  - When live predictions work, routes with no bus in the next hour are left out.
- **Points estimates** use the real scoring formula: `points_km × mode rate × 1.0 confidence × your trust`, rounded, then limited by what's left of today's 200 cap (`points_capped: true`).
  - For transit, `points_km` is the ride only, because a transit trip must start and end near a stop. **Tell the user to start the transit trip at the stop.**
- **If Gemini fails, is slow or is over its limits,** the answer is computed entirely on the server (`source: "computed"`). It has the same options, a rule-based recommendation and a template summary. The whole request takes at most about 8 s.
- **Privacy:** the origin stays on the server. Gemini sees only place ids, public place names, GRT stop names and the computed numbers. A saved location is described as "your home" or "your saved place", never by its label. Only the destination text is sent to Nominatim (the OpenStreetMap search).

- **Destination choice:** place-search results are ranked by how many of the requested words their name contains, ties broken by distance. So "Waterloo Public Library" picks Waterloo's library even when the search lists Kitchener's first. The computed answer uses the top result; Gemini sees them in that order.
- **Cache:** for 5 minutes, the same user asking for the same destination from about the same place (within about 100 m) reuses Gemini's earlier choice and summary, with no Gemini call (`cached: true`). **The numbers are always recomputed** (next bus, minutes, points). A summary whose numbers no longer match is replaced by the computed one. Computed answers aren't cached. The cache is in memory only.

**Limit per user:** 3 plans a minute and 30 a day, shared with `POST /api/agent/plan`. Cache hits count too. Over the limit returns `429 rate_limited` with `retry_after_sec`.

### `POST /api/plan` — **built**

Request:
```json
{ "destination": "Waterloo Public Library", "origin_lat": 43.4723, "origin_lng": -80.5449 }
```

- `destination`, required, is one of:
  - **a string** (max 200 characters). It's matched first against your saved locations (`"home"`, or a label like `"campus"`), then the demo merchants, then a place search limited to Kitchener-Waterloo-Cambridge;
  - **or a place** `{ "name": "...", "lat": 43.46, "lng": -80.52 }`, for example from a map tap.
- `origin_lat` and `origin_lng` are optional, and must be sent together. Without them, the origin is your saved home.

Response `200`:
```json
{
  "source": "gemini",
  "cached": false,
  "destination": { "name": "Waterloo Public Library, Albert Street, Waterloo", "kind": "search" },
  "origin": "home",
  "options": [
    {
      "mode": "bike",
      "minutes": 11,
      "km": 2.8,
      "points_km": 2.8,
      "points_estimate": 17,
      "points_capped": false,
      "eco_note": "Saves about 0.5 kg of CO2 compared with driving. No emissions at all on a bike.",
      "steps": ["Ride south-east about 2.8 km to Waterloo Public Library, Albert Street, Waterloo."],
      "next_bus": null
    },
    {
      "mode": "transit",
      "minutes": 18,
      "km": 3.1,
      "points_km": 2.2,
      "points_estimate": 7,
      "points_capped": false,
      "eco_note": "Saves about 0.4 kg of CO2 compared with driving. A shared bus ride is far greener than driving alone.",
      "steps": [
        "Walk about 600 m to University Of Waterloo Station - Southbound.",
        "Take route 301 toward Fairway (next one in about 8 min). Start your transit trip in the app once you are at the stop.",
        "Ride about 2.2 km and get off at Willis Way Station - Southbound.",
        "Walk about 300 m to Waterloo Public Library, Albert Street, Waterloo."
      ],
      "next_bus": {
        "route": "301",
        "headsign": "Fairway",
        "stop_name": "University Of Waterloo Station - Southbound",
        "stop_code": null,
        "minutes": 8,
        "arrives_at": "2026-11-07T22:31:00.000Z",
        "source": "live"
      }
    },
    { "mode": "walk", "minutes": 34, "km": 2.9, "points_km": 2.9, "points_estimate": 29, "points_capped": false, "eco_note": "…", "steps": ["…"], "next_bus": null }
  ],
  "recommendation": "bike",
  "summary": "Biking gets you there in about 11 minutes and earns about 17 points.",
  "attribution": ["Transit data: Grand River Transit, Region of Waterloo Open Data", "Search: © OpenStreetMap contributors (Nominatim)"]
}
```

- `options` come **recommended first**, then in the order Gemini chose (or fastest first, when computed). The response leaves out an option that doesn't apply:
  - walking over 6 km;
  - biking over 25 km;
  - transit with no direct route;
  - only walking under 0.4 km.
- `cached`: `true` when Gemini's decision came from the 5-minute cache.
- `destination.kind`: `saved` | `merchant` | `search` | `given`.
- `origin`: `home` | `given`.
- `recommendation` is `null` only if `options` is empty.
- **Show `attribution`.** The OpenStreetMap line is there when the place search was used.

Errors:

| Status | `code` | When |
|---|---|---|
| 400 | `validation_error` | Bad `destination`, or only one of `origin_lat` and `origin_lng` |
| 400 | `no_origin` | No origin given and no saved home |
| 400 | `too_far` | Destination more than 40 km away |
| 404 | `destination_not_found` | Nothing in Kitchener-Waterloo matches |
| 503 | `search_unavailable` | The place search is down or too slow (saved places and merchants still work) |
| 429 | `rate_limited` | Over the per-user plan limit |

---

## Live voice agent tools

The mascot's live voice agent runs on ElevenLabs. ElevenLabs' servers call `/api/agent/*` over HTTPS as tools. **These endpoints aren't for the frontend.** The exact tool definitions to paste into the ElevenLabs dashboard, and the tunnel setup, are in [`docs/agent-tools.md`](agent-tools.md).

- **Auth:** the header `X-Agent-Secret` must match `AGENT_TOOL_SECRET` in `backend/.env`:
  - missing or wrong → `401 bad_agent_secret`;
  - not set on the server → `503 agent_not_configured`.
- **User:** the agent acts as user 1, or as `X-Demo-User` (the same rule as the app).
- **Every response has `ok` and a short spoken `summary`.** Expected refusals are `200` with `ok: false` and a `code`; malformed input is `400`. Expected refusals:
  - redeeming without `confirm: true`;
  - can't afford;
  - a trip is already running;
  - place not found.

| Method | Path | What |
|---|---|---|
| GET | `/api/agent/status` | Points, eco score, streak, points today *(built)* |
| GET | `/api/agent/rewards` | Affordable and locked rewards, with what's missing *(built)* |
| POST | `/api/agent/redeem` | `{ reward_id, confirm: true }`. Without `confirm: true` it only asks *(built)* |
| POST | `/api/agent/plan` | Same body and answer as `POST /api/plan`, plus `ok` *(built)* |
| POST | `/api/agent/trips/start` | `{ mode }`. The app then records GPS for this trip *(built)* |
| POST | `/api/agent/trips/finish` | `{ confirm? }`. Finishes the active trip. With fewer than 5 GPS points it warns first *(built)* |
| POST | `/api/agent/route-safety` | `{ destination }`. **Stub** for now: `available: false` *(built)* |

**For the frontend:** when the agent starts a trip, the app should find it with `GET /api/trips?limit=1` (`status: "active"`) and send GPS points to it as usual.

---

## Not in this draft (yet)

- Abandoned trips: a trip left active (the app was closed mid-trip) stays active until it is finished, and blocks starting a new one (`409 trip_already_active` gives its id). Auto-finishing is not built yet.
- Editing a saved location (`PATCH`). For now, delete it and add it again.
- Claiming or issuing a club's group reward when the weekly goal is reached. `goal_reached` is shown, but nothing is issued.
- Route safety ratings (Gemini rating routes from Mapillary photos). Coming in a later task; `POST /api/agent/route-safety` is a stub until then.
- Street-by-street routing. The planner uses straight-line distances with a detour factor, and direct transit routes only.
- A place-search endpoint for the frontend. The planner searches on the server; the frontend may still call Nominatim directly for a map search box.
