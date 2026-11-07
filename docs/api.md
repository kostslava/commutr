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
| 400 | `validation_error` | Bad request body or params *(built for trips and `bbox`)* |
| 404 | `not_found` | Trip, reward or club doesn't exist, or isn't yours *(built for trips)* |

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
  "streak": { "current_days": 6, "longest_days": 12, "last_active_date": "2026-11-07" },
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

- Abandoned trips: a trip left active (the app was closed mid-trip) stays active until it is finished, and blocks starting a new one (`409 trip_already_active` gives its id). Auto-finishing is not built yet.
- Endpoints to add, edit or delete saved locations. For now they're returned in `GET /api/me`.
- Bike routes with a safety rating. The data source is not decided.
- Place search. The frontend may call Nominatim directly; this is undecided.
- The full list of confidence flag codes, to be defined with the scoring logic.
