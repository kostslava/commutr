# ElevenLabs live agent: tool setup

The Commutr mascot is an ElevenLabs live voice agent. Its tools are **server tools (webhooks)**: ElevenLabs' servers call our backend over HTTPS. This file has everything needed to set them up in the ElevenLabs dashboard (Agent → Tools → Add tool → Webhook). Paste each field as written.

The backend side is described in [`docs/api.md`](api.md) under "Live voice agent tools".

For the full click-by-click setup (creating the agent, the system prompt, voice, LLM, testing and the React integration), see [`docs/elevenlabs-agent-setup.md`](elevenlabs-agent-setup.md).

## 1. Set the shared secret

1. Make a long random secret: `openssl rand -hex 32`
2. Put it in `backend/.env` as `AGENT_TOOL_SECRET=<the secret>`, then restart the backend. Without it, every agent endpoint returns `503`.
3. In ElevenLabs, create the secret from the first tool's header: add the header `X-Agent-Secret`, set its type to **Secret**, click **Create New Secret**, name it `commutr_agent_secret` and paste the value there (a human does this in the dashboard). Every other tool then picks the same saved secret. (A workspace-level secrets page may also exist; that is UNVERIFIED.)
4. Each tool then sends it as a header:

   | Header | Value |
   |---|---|
   | `X-Agent-Secret` | the secret `commutr_agent_secret` (choose "Secret", not "Value") |

Never paste the secret into the agent's prompt, a tool description or a URL.

**Optional: picking the user.** There's no login yet. Without a header, the agent acts as **user 1**, the demo user. To act as another seed user, add the header `X-Demo-User` to every tool. Its value is either:
- a fixed number, like `2`;
- or a dynamic variable `{{demo_user}}`, which the frontend passes when it starts the conversation.

## 2. Make the backend public: Cloudflare quick tunnel

ElevenLabs can't reach `localhost`, so it needs a public HTTPS URL. A Cloudflare quick tunnel gives one, with no account needed.

1. **Install cloudflared:**
   - macOS: `brew install cloudflared`
   - Windows: `winget install --id Cloudflare.cloudflared`
   - Debian or Ubuntu:
     ```
     curl -L -o cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
     sudo dpkg -i cloudflared.deb
     ```
2. **Start the backend** (port 8787 by default): `cd backend && npm run dev`
3. **Start the tunnel** in another terminal: `cloudflared tunnel --url http://localhost:8787`
4. **Copy the URL it prints**, like `https://random-words-here.trycloudflare.com`. That's the `BASE` in the tool URLs below.
5. **Check it works:** `curl https://random-words-here.trycloudflare.com/health` should print `{"ok":true}`.

**The URL changes every time cloudflared restarts.** After each restart, update the URL in **every** tool's settings in ElevenLabs. Keep the tunnel running during the demo. Quick tunnels are for testing, and come with no uptime guarantee.

## 3. Tool settings shared by all tools

- **Response timeout:** 15 seconds. `plan_trip` can take up to about 8 s; the others answer at once.
- **Request headers:** `X-Agent-Secret`, as above (and `X-Demo-User` if used).
- **Body content type** for POST tools: JSON.
- **Every response has `ok` and a `summary`.** The agent should say the `summary`, or base its answer on it.
  - With `ok: false`, the `summary` says why (for example, it's asking the user to confirm) and `code` names the reason.
  - With a missing or wrong secret, the call returns HTTP 401.

**Suggested lines for the agent's system prompt:**
- Before calling `redeem_reward` with `confirm: true`, always ask the user to confirm the reward and its cost out loud.
- For directions, call `plan_trip`, then read its `summary`.
- Only call `finish_trip` with `confirm: true` after the user agreed to finish despite the warning.

## 4. The tools

### `get_status`
- **Description:** Gets the user's Commutr points, eco score, streak and points earned today. Use it whenever they ask how they're doing or about their points or streak.
- **Method:** GET
- **URL:** `BASE/api/agent/status`
- **Parameters:** none

Example response:
```json
{
  "ok": true,
  "summary": "You have 1240 points, an eco score of 98 and a 6-day streak. You've earned 35 of today's 200 points.",
  "points": 1240,
  "eco_score": 98,
  "streak_days": 6,
  "longest_streak_days": 12,
  "active_today": true,
  "points_today": 35,
  "daily_cap": 200
}
```

### `get_rewards`
- **Description:** Lists the rewards the user can redeem now, and the locked ones with how many points or how much eco score they're missing. Each reward has a reward_id. Use it before redeeming, or when they ask what they can get.
- **Method:** GET
- **URL:** `BASE/api/agent/rewards`
- **Parameters:** none

Example response:
```json
{
  "ok": true,
  "summary": "You can redeem 4 rewards now, like Free coffee at Maple Loop Coffee, $10 coffee card at Maple Loop Coffee and Free coffee and pastry at Belmont Bakehouse. The closest one to unlock is 15% off any wrap or plate at Uptown Shawarma House: you need 60 more points.",
  "affordable": [
    { "reward_id": 1, "title": "Free coffee", "merchant": "Maple Loop Coffee", "points_cost": 150, "redeemed_today": false }
  ],
  "locked": [
    {
      "reward_id": 5,
      "title": "15% off any wrap or plate",
      "merchant": "Uptown Shawarma House",
      "points_cost": 400,
      "min_eco_score": 70,
      "reason": "not_enough_points",
      "points_needed": 60,
      "eco_needed": 0
    }
  ]
}
```

### `redeem_reward`
- **Description:** Redeems a reward with the user's points. First call it without confirm to get the cost, ask the user to confirm out loud, then call it again with confirm true. Never send confirm true without the user's clear yes.
- **Method:** POST
- **URL:** `BASE/api/agent/redeem`
- **Body parameters:**

  | Name | Type | Required | Description |
  |---|---|---|---|
  | `reward_id` | integer | yes | The reward_id from get_rewards. Never guess it. |
  | `confirm` | boolean | no | True only after the user clearly confirmed out loud. Leave it out on the first call. |

Example response without `confirm`:
```json
{
  "ok": false,
  "code": "confirm_required",
  "summary": "Free coffee at Maple Loop Coffee costs 150 points. Should I redeem it?",
  "reward": { "reward_id": 1, "title": "Free coffee", "merchant": "Maple Loop Coffee", "points_cost": 150 }
}
```

Example response with `confirm: true`:
```json
{
  "ok": true,
  "summary": "Done! You redeemed Free coffee at Maple Loop Coffee. Your code is CMTR-7KQ2-M4XD, and you have 1090 points left.",
  "redemption": { "id": 12, "reward_id": 1, "title": "Free coffee", "merchant_name": "Maple Loop Coffee", "points_spent": 150, "code": "CMTR-7KQ2-M4XD", "redeemed_at": "2026-11-07T22:10:00.000Z" },
  "points": 1090
}
```

Other `ok: false` codes:
- `not_found`
- `eco_score_too_low`
- `not_enough_points`
- `already_redeemed_today`

### `plan_trip`
- **Description:** Plans a green trip to a place in Kitchener-Waterloo by walking, biking or GRT transit, with times, points and the next bus, from the user's saved home or from a starting place they name. Use it whenever the user asks how to get somewhere.
- **Method:** POST
- **URL:** `BASE/api/agent/plan`
- **Body parameters:**

  | Name | Type | Required | Description |
  |---|---|---|---|
  | `destination` | string | yes | Where the user wants to go, as they said it, for example 'Waterloo Public Library', 'home' or 'campus'. |
  | `origin_name` | string | no | Where the user is starting from, as they said it (a place name or landmark, for example 'University of Waterloo'). Leave it out to use their saved home. |

  Without `origin_name`, the trip starts from the user's saved home. The response always says where it starts: `origin` is `home`, `named` or `given`, `origin_name` is the starting point in words ("your saved home", "University of Waterloo"), and the `summary` begins with it. The app can also send `origin_lat` and `origin_lng` (numbers, said as "your current location"), but the voice agent leaves them out, and they can't be combined with `origin_name`.

Example response (shortened; the full shape is `POST /api/plan` in `docs/api.md`):
```json
{
  "ok": true,
  "source": "gemini",
  "summary": "From your saved home, biking gets you there in about 11 minutes and earns about 17 points.",
  "recommendation": "bike",
  "origin": "home",
  "origin_name": "your saved home",
  "destination": { "name": "Waterloo Public Library, Albert Street, Waterloo", "kind": "search" },
  "options": [
    { "mode": "bike", "minutes": 11, "km": 2.8, "points_estimate": 17, "next_bus": null, "steps": ["Ride south-east about 2.8 km to Waterloo Public Library, Albert Street, Waterloo."] },
    { "mode": "transit", "minutes": 18, "km": 3.1, "points_estimate": 7, "next_bus": { "route": "301", "headsign": "Fairway", "stop_name": "University Of Waterloo Station - Southbound", "minutes": 8, "source": "live" } }
  ]
}
```

`ok: false` codes, each with a spoken `summary`:
- `destination_not_found`
- `origin_not_found`: `origin_name` matched no place in Kitchener-Waterloo; the summary asks for another place nearby
- `search_unavailable`
- `no_origin`: no `origin_name` and no saved home; the summary is "Where are you starting from?"
- `too_far`
- `rate_limited`

### `start_trip`
- **Description:** Starts tracking a trip in the chosen mode when the user says they're setting off. The Commutr app must stay open to record the route.
- **Method:** POST
- **URL:** `BASE/api/agent/trips/start`
- **Body parameters:**

  | Name | Type | Required | Description |
  |---|---|---|---|
  | `mode` | string, one of `walk`, `bike`, `scooter`, `transit`, `car` | yes | How the user is travelling: walk, bike, scooter, transit or car. Ask if it's unclear. |

Example response:
```json
{
  "ok": true,
  "summary": "Your bike trip has started. Keep the Commutr app open so it can record your route.",
  "trip": { "id": 42, "mode": "bike", "status": "active", "started_at": "2026-11-07T22:12:00.000Z" }
}
```

If a trip is already running: `ok: false`, `code: "trip_already_active"`.

### `finish_trip`
- **Description:** Finishes the user's current trip and scores it. Ask the user first. If it warns that too little GPS was recorded, read the warning and only call again with confirm true if they agree.
- **Method:** POST
- **URL:** `BASE/api/agent/trips/finish`
- **Body parameters:**

  | Name | Type | Required | Description |
  |---|---|---|---|
  | `confirm` | boolean | no | True only to finish even though too little GPS was recorded, after the user agreed. Leave it out on the first call. |

Example response:
```json
{
  "ok": true,
  "summary": "Nice! 2.6 km biking earned you 16 points. You now have 1256 points.",
  "trip": { "id": 42, "mode": "bike", "status": "finished", "distance_km": 2.6, "points_awarded": 16, "capped": false, "confidence": 1, "flags": [] },
  "user": { "points": 1256, "eco_score": 98 }
}
```

`ok: false` codes:
- `no_active_trip`;
- `few_gps_points`: the summary explains, and the trip stays active.

### `get_route_safety`
- **Description:** Gets a safety rating for the bike route to a place. Not available yet; it says so.
- **Method:** POST
- **URL:** `BASE/api/agent/route-safety`
- **Body parameters:**

  | Name | Type | Required | Description |
  |---|---|---|---|
  | `destination` | string | no | Where the user wants to go. |

Example response:
```json
{ "ok": true, "available": false, "summary": "Route safety ratings aren't available yet. They're coming soon, so for now stick to bike lanes and quieter streets." }
```

## 5. Checking a tool by hand

With the tunnel running and the secret in a shell variable:
```
curl -s https://random-words-here.trycloudflare.com/api/agent/status -H "X-Agent-Secret: $AGENT_TOOL_SECRET"
```
Without the header, the response is `401`.
