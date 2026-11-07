# Commutr API contract

Owned by the backend (Shahmeer). The frontend agent must not edit this file. If the frontend needs a change, tell your human, who asks the backend owner. See AGENTS.md.

**Status: first draft.** Every endpoint is marked **planned** until it is built. Shapes may still change while an endpoint is planned. Once it is **built**, changes are announced first.

## Basics

- Base URL (local dev): `http://localhost:8787`. The port can be changed with the `PORT` env var.
- All app endpoints are under `/api`. `/health` is at the root.
- JSON in, JSON out. Send `Content-Type: application/json` on requests with a body.
- **Times:** ISO 8601 UTC strings, for example `"2026-11-07T14:05:00.000Z"`. Exception: streak dates are Toronto local dates, `"YYYY-MM-DD"`.
- **IDs** are integers.
- **Distances** are in km.
- **CORS:** any origin is allowed in development (`NODE_ENV` not `production`).

### Current user (fake auth)

There is no login yet. Every `/api` request acts as **user 1**, unless it sends:

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
| 400 | `validation_error` | Bad request body or params *(planned)* |
| 404 | `not_found` | Trip, reward or club doesn't exist, or isn't yours *(planned)* |

Endpoint-specific codes are listed with each endpoint.

---

## Health

### `GET /health` — **built**

```json
{ "ok": true }
```

---

## Trips

The user picks the mode **before** the trip. While the app is open in the foreground, the frontend sends GPS points in batches. It then finishes the trip, and the backend scores it.

Browsers pause GPS in the background, so points can be sparse. Gaps alone do not reduce confidence. They only count when they come with an impossible position jump.

`mode` is one of `"walk" | "bike" | "scooter" | "transit" | "car"`.

### `POST /api/trips` — start a trip — **planned**

Request:
```json
{ "mode": "walk" }
```

Response `201`:
```json
{
  "id": 11,
  "mode": "walk",
  "status": "active",
  "started_at": "2026-11-07T14:05:00.000Z"
}
```

Errors: `409 trip_already_active` if the user already has an active trip. The response includes `"active_trip_id"`.

### `POST /api/trips/:id/points` — add GPS points — **planned**

Send points in batches, for example every 10–30 seconds, or whenever the app comes back to the foreground. The array can hold 1 or more points. Points with an older timestamp than ones already stored are still accepted.

Request:
```json
{
  "points": [
    { "lat": 43.4723, "lng": -80.5449, "accuracy": 6, "timestamp": "2026-11-07T14:05:10.000Z" },
    { "lat": 43.4726, "lng": -80.5431, "accuracy": 8, "timestamp": "2026-11-07T14:05:40.000Z" }
  ]
}
```

`accuracy` is in metres, as given by the browser's `GeolocationCoordinates.accuracy`. It may be `null`.

Response `200`:
```json
{ "trip_id": 11, "accepted": 2, "total_points": 14 }
```

Errors: `409 trip_not_active` if the trip is already finished.

### `POST /api/trips/:id/finish` — finish and score a trip — **planned**

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
    "distance_km": 2.1,
    "confidence": 0.95,
    "points_awarded": 20,
    "flags": []
  },
  "user": { "points": 3220, "eco_score": 98 },
  "streak": { "current_days": 6, "longest_days": 12, "last_active_date": "2026-11-07" }
}
```

- `confidence` is between 0 and 1. A trip below 0.3 earns 0 points.
- Car trips earn 0 points and lower the eco score.
- `flags` lists short codes for the checks that lowered confidence, for example `"speed_too_high"`. The full list will be defined with the scoring logic.

Errors: `409 trip_not_active`.

### `GET /api/trips?limit=20` — my trips, newest first — **planned**

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
      "confidence": 1.0,
      "points_awarded": 18
    }
  ]
}
```

### `GET /api/trips/:id` — one trip with its GPS path — **planned**

Response `200`: the same fields as a list item, plus
```json
{ "points": [ { "lat": 43.4655, "lng": -80.5228, "accuracy": 5, "timestamp": "2026-11-05T13:00:00.000Z" } ] }
```

---

## Me (profile, points, eco score)

### `GET /api/me` — **planned**

Response `200`:
```json
{
  "id": 1,
  "name": "Alex Demo",
  "email": "alex@demo.commutr.test",
  "points": 3200,
  "eco_score": 98,
  "streak": { "current_days": 5, "longest_days": 12, "last_active_date": "2026-11-05" },
  "saved_locations": [
    { "id": 1, "label": "Home", "lat": 43.4762, "lng": -80.5371 },
    { "id": 2, "label": "Campus", "lat": 43.4723, "lng": -80.5449 }
  ]
}
```

- `eco_score` runs from 0 to 100.
- The trust multiplier is internal and is not exposed.
- A streak day is one finished non-car trip with confidence of at least 0.3 and at least 0.5 km, by Toronto local date.

---

## Rewards

A reward is **locked** when the user's eco score is below `min_eco_score`, even if they have enough points. It is **affordable** when `points >= points_cost`. A reward can only be redeemed when it is unlocked and affordable.

### `GET /api/rewards` — **planned**

Response `200`:
```json
{
  "rewards": [
    {
      "id": 2,
      "title": "$10 Maple Loop Coffee card",
      "points_cost": 1000,
      "min_eco_score": 85,
      "locked": false,
      "affordable": true,
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

Gift card merchants have `address`, `lat` and `lng` set to `null`. All merchants are demo data.

### `POST /api/rewards/:id/redeem` — **planned**

Request: an empty body `{}`.

Response `201`:
```json
{
  "redemption": {
    "id": 3,
    "reward_id": 2,
    "points_spent": 1000,
    "code": "DEMO-7F3K",
    "redeemed_at": "2026-11-07T15:00:00.000Z"
  },
  "user": { "points": 2200 }
}
```

Errors: `403 eco_score_too_low` · `409 not_enough_points`.

### `GET /api/redemptions` — my redeemed rewards — **planned**

Response `200`:
```json
{ "redemptions": [ { "id": 1, "reward_id": 6, "title": "Free coffee and pastry", "points_spent": 300, "code": "DEMO-0001", "redeemed_at": "2026-11-04T17:20:00.000Z" } ] }
```

---

## Clubs

Each club has a weekly shared step goal and a group reward. **Progress counts walking km only, at 1,300 steps per km.** Until trips are scored, the steps come from fake totals in the seed.

### `GET /api/clubs` — **planned**

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
      "member_count": 3,
      "is_member": true,
      "group_reward": "Free medium coffee for every member at Maple Loop Coffee (demo)"
    }
  ]
}
```

### `GET /api/clubs/:id` — **planned**

Response `200`: the same fields as a list item, plus
```json
{
  "members": [
    { "user_id": 1, "name": "Alex Demo", "steps_this_week": 42300 },
    { "user_id": 2, "name": "Sam Rivera", "steps_this_week": 31850 }
  ]
}
```

### `POST /api/clubs/:id/join` — **planned**

Request: an empty body `{}`.

Response `200`:
```json
{ "club_id": 1, "joined": true }
```

Joining a club you're already in is not an error; it also returns `joined: true`.

---

## Live buses (GRT)

The backend reads GRT's GTFS-realtime feed and returns plain JSON. If the feed fails, it returns fake buses and sets `source` to `"fake"`. The frontend should show a small "simulated" label when that happens.

### `GET /api/buses/live` — **planned**

Response `200`:
```json
{
  "source": "live",
  "updated_at": "2026-11-07T15:02:11.000Z",
  "vehicles": [
    {
      "id": "21053",
      "route_id": "7",
      "trip_id": "3561029",
      "lat": 43.4652,
      "lng": -80.5226,
      "bearing": 172,
      "timestamp": "2026-11-07T15:02:05.000Z"
    }
  ]
}
```

`bearing` (degrees) and `trip_id` may be `null`.

---

## Chatbot

Suggests places to eat that the user can afford with their current points and eco score. If they can't afford any, it suggests a place to walk, bike or ride to. **The chatbot provider is not decided yet**, so only the shape is defined here.

### `POST /api/chat` — **planned**

Request:
```json
{ "message": "Where can I get lunch?" }
```

Response `200`:
```json
{
  "reply": "You have 3200 points and an eco score of 98, so the $25 Maple Loop Coffee card is unlocked. Grand River Dumplings is a 25 minute walk away.",
  "suggestions": [
    { "type": "reward", "reward_id": 4, "merchant_id": 2, "name": "Grand River Dumplings", "lat": 43.451, "lng": -80.4915 },
    { "type": "destination", "reward_id": null, "merchant_id": null, "name": "Waterloo Park", "lat": 43.466, "lng": -80.53 }
  ]
}
```

`type` is `"reward"` for something they can redeem now, or `"destination"` for a place to walk, bike or ride to.

---

## Not in this draft (yet)

- Endpoints to add, edit or delete saved locations. For now they're returned in `GET /api/me`.
- Bike routes with a safety rating. The data source is not decided.
- Place search. The frontend may call Nominatim directly; this is undecided.
- The full list of confidence flag codes, to be defined with the scoring logic.
