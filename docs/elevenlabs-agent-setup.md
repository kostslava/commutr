# ElevenLabs live voice agent: full setup guide

A step-by-step guide to creating the Commutr mascot as an ElevenLabs live voice agent and connecting it to our backend. It is written so that someone with no other context (a person, or an AI agent driving a browser) can follow it from start to finish.

- The tool reference (exact fields and example responses) is [`docs/agent-tools.md`](agent-tools.md). This guide repeats everything needed, so you shouldn't need to switch files.
- The backend contract is [`docs/api.md`](api.md), under "Live voice agent tools".

> **About accuracy.** This guide follows ElevenLabs' own documentation (links at the end), checked on 2026-11-07. The ElevenLabs dashboard changes often, and the docs don't name every button. Steps that couldn't be checked against the docs are marked **UNVERIFIED**: the idea is right, but the exact label or location may differ. When a label differs, look for the nearest equivalent. Don't skip the step.

> **Secrets.** This guide contains no keys or secret values, and none should ever be added to it. Secrets are typed or pasted by a human, only into `backend/.env` and the ElevenLabs dashboard. Never paste them into chat, code, the agent's prompt, a tool description or a URL.

---

## 1. What the agent does, and why it exists

The Commutr mascot talks with the user in **live, two-way voice**: they speak, it answers out loud, and they can interrupt it like a normal conversation. ElevenLabs runs the whole voice loop: speech recognition, the LLM, the voice, and turn-taking.

What makes it useful is its **tools**: seven **server tools (webhooks)**. During a conversation, ElevenLabs' servers call our backend over HTTPS to read and change the user's real data:

| The user says… | The agent calls | Our backend |
|---|---|---|
| "How many points do I have?" | `get_status` | `GET /api/agent/status` |
| "What can I get with my points?" | `get_rewards` | `GET /api/agent/rewards` |
| "Redeem the free coffee." | `redeem_reward` (twice: ask, then confirm) | `POST /api/agent/redeem` |
| "How do I get to Waterloo Park?" | `plan_trip` | `POST /api/agent/plan` (the Gemini trip planner) |
| "I'm biking to campus now." | `start_trip` | `POST /api/agent/trips/start` |
| "I'm there, finish my trip." | `finish_trip` | `POST /api/agent/trips/finish` |
| "Is the route there safe?" | `get_route_safety` | `POST /api/agent/route-safety` (a stub for now) |

Every tool response has `ok` and a short **`summary`** sentence written for speaking. The agent's job is mostly to call the right tool and say the `summary`. All numbers come from our backend, never from the agent.

How a tool call travels:

```
User's browser (React app) ──voice──▶ ElevenLabs agent
                                        │  needs data
                                        ▼
                     HTTPS + header X-Agent-Secret
                                        │
                     Cloudflare tunnel (public URL)
                                        │
                     our backend on localhost:8787  →  /api/agent/*
```

---

## 2. Prerequisites

Do these in order before touching the ElevenLabs dashboard.

### 2.1 Backend running

```
cd backend
npm install        # first time only
npm run seed       # first time only: demo users, merchants, rewards
npm run dev        # listens on http://localhost:8787
```

Check it: `curl http://localhost:8787/health` should print `{"ok":true}`.

Optional, but recommended before a demo: `npm run geocode:warm` pre-loads common Kitchener-Waterloo places, so the planner answers faster.

### 2.2 The agent secret in `backend/.env`

1. Make a long random secret in a terminal: `openssl rand -hex 32`. Don't paste the output into chat or anywhere but the next two steps.
2. Open `backend/.env` (copy `backend/.env.example` if it doesn't exist) and set the `AGENT_TOOL_SECRET` line to that value.
3. Restart the backend (`Ctrl+C`, then `npm run dev` again).
4. Check it:
   - `curl -i http://localhost:8787/api/agent/status` should answer **401**. That means the secret is set and the request was rejected for lacking the header.
   - If it answers **503** `agent_not_configured`, the secret isn't set or the backend wasn't restarted.

Keep the secret value handy for step 5.1, where a human pastes it into the ElevenLabs dashboard once.

### 2.3 A public HTTPS URL (Cloudflare quick tunnel)

ElevenLabs' servers can't reach `localhost`, so the backend needs a public HTTPS address.

1. Install cloudflared:
   - macOS: `brew install cloudflared`
   - Windows: `winget install --id Cloudflare.cloudflared`
   - Debian or Ubuntu:
     ```
     curl -L -o cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
     sudo dpkg -i cloudflared.deb
     ```
2. With the backend running, in a second terminal: `cloudflared tunnel --url http://localhost:8787`
3. It prints a URL like `https://random-words-here.trycloudflare.com`. That's your **tunnel base**, written `BASE` from here on.
4. Check it: `curl https://random-words-here.trycloudflare.com/health` should print `{"ok":true}`.

> **The tunnel URL changes every time cloudflared restarts.** Then you must update the URL in **all 7 tools** in the ElevenLabs dashboard (Agent → Tools → each tool → URL, step 5). Keep the tunnel running for the whole demo. Quick tunnels need no account but come with no uptime guarantee.

### 2.4 An ElevenLabs account

Sign up or sign in at [elevenlabs.io](https://elevenlabs.io). The free plan is enough to build and rehearse; see the limits in 7.7.

---

## Set it up from the command line (recommended)

The dashboard may only show a template browser, with no blank agent. Instead, a script creates or updates the whole agent through the ElevenLabs API: the name, first message, system prompt, LLM, voice, the 7 webhook tools and the allowlist. **Sections 3 to 5 then only explain what it set up**; you don't click through them.

- **Config:** [`backend/elevenlabs/agent.json`](../backend/elevenlabs/agent.json) is the source of truth for the agent. It holds the prompt and first message (copied from section 4), the LLM (`gemini-3.5-flash`; the script stops if the plan refuses it), the premade voice **Jessica** (`cgSgspJ2msm6clMCkdW9`), the tools and the secret's **name**. It contains no secret values. Change the agent there, not in the dashboard, and re-run the script.
- **State:** [`backend/elevenlabs/state.json`](../backend/elevenlabs/state.json) keeps the agent and tool ids (not secrets), so re-runs update the existing agent instead of creating duplicates.

**Once:**
1. Prerequisites 2.1–2.3: backend, `AGENT_TOOL_SECRET`, and the tunnel.
2. Make sure `ELEVENLABS_API_KEY` is set in `backend/.env`. The script reads only that line, inside its own process, and never prints it. You don't need `elevenlabs auth login`.
3. In the ElevenLabs dashboard, a human creates a workspace secret named exactly **`commutr_agent_secret`**, whose value is the `AGENT_TOOL_SECRET` from `backend/.env`.
   - On a secrets page in the agents section's settings, if there is one *(UNVERIFIED)*;
   - or from any webhook tool: Headers → type **Secret** → **Create New Secret**.

   The script only looks the secret up **by name** and references it by id. It never reads or sends the value. If the secret is missing, it stops before changing anything.

**Create or update the agent** (also after **every tunnel restart**, with the new URL):
```
cd backend
npm run agent:setup -- --tunnel https://<words>.trycloudflare.com      # or: TUNNEL_URL=https://... npm run agent:setup
```
It prints each tool (created or updated) and its URL, then the agent id, the LLM ElevenLabs accepted, the voice and the dashboard link *(link format UNVERIFIED)*. Re-running only updates; nothing is duplicated.

**Check the tools without spending agent minutes:**
```
cd backend
(set -a; . ./.env; set +a; npm run agent:verify -- --tunnel https://<words>.trycloudflare.com)
```
This calls all 7 tool endpoints through the tunnel with the secret from your shell, never printed, plus one call without it, which must return 401. Nothing in the data changes:
- redeem is called without `confirm`;
- trips/start gets an invalid mode;
- trips/finish runs only when no trip is active.

The `plan_trip` check makes about 3 real Gemini calls of our own.

**Check the agent really calls the tools (text only, no call minutes):** `npm run agent:test` runs the 5 cases in [`backend/elevenlabs/tests.json`](../backend/elevenlabs/tests.json) through ElevenLabs' agent-testing API. Each one checks that the agent's next turn makes a real, structured tool call and doesn't write it out as text. Each run costs credits (`credits_used` is printed). After the first test, it stops if that test used more than 200 credits (`--max-credits` changes the limit).

After setup, go to section 3.7 for the allowlist (the script sets `localhost`; add your frontend's hostname in `agent.json`), then section 6 to test by voice.

---

## 3. Create the agent in the dashboard

### 3.1 Find the agents product

The agents product is called **ElevenAgents** (older names: "Conversational AI", "Agents Platform"). Two ways in:
- Go straight to **https://elevenlabs.io/app/agents**, or
- In the dashboard's left sidebar, pick **ElevenAgents** or **Agents**. If the sidebar shows a product switcher, choose the agents product there. *(Sidebar wording UNVERIFIED; the URL above comes from the docs.)*

### 3.2 Create it

1. Click the button to create a new agent *(label UNVERIFIED, for example "Create agent" or "+ New agent")*.
2. Choose **Blank template** (the docs' quickstart uses it).
3. **Name:** `Commutr Mascot`.

### 3.3 Agent tab: first message, language, system prompt

Open the **Agent** tab.

- **First message** (the first thing the agent says), to paste:
  ```
  Hi, I'm the Commutr mascot! Ask me about your points, your rewards, or how to get somewhere green in Kitchener-Waterloo.
  ```
- **Language:** English. *(The language field's location is UNVERIFIED; it's usually near the top of the Agent tab.)*
- **System prompt:** paste the full prompt from section 4.

### 3.4 Voice

Open the **Voice** tab and pick a voice.

- **Use a default (premade) voice** from the list. Which voices the free plan includes isn't stated in the docs (UNVERIFIED), and premade voices are the safest bet. Voices with "live moderation" enabled can't be used in agents (from the docs).
- **TTS model:** if a model choice is shown, pick a low-latency "Flash" model (our backend's speech also uses `eleven_flash_v2_5`). *(The label and available models are UNVERIFIED.)*
- **Speed:** keep the default, 1.0 (the docs allow 0.7 to 1.2).

**Quick check that a voice ID works.** You find the voice ID in the voice's details or menu *(location UNVERIFIED)*. The command below reads your ElevenLabs API key from a shell variable, so the key is never typed into the command or pasted anywhere.

```
# In a terminal where ELEVENLABS_API_KEY is already set, for example by: set -a; . backend/.env; set +a
curl -s -o /dev/null -w "%{http_code}\n" -H "xi-api-key: $ELEVENLABS_API_KEY" https://api.elevenlabs.io/v1/voices/<VOICE_ID>
```

- `200`: the voice exists and your key can use it.
- `401`: the key is wrong or missing in this shell.
- `404`: wrong voice ID.

Optional: put the same voice ID in `backend/.env` as `ELEVENLABS_VOICE_ID`, so the text chatbot's voice matches the live agent.

### 3.5 LLM

In the **Agent** tab, find the LLM / model selector *(location UNVERIFIED)* and choose **Gemini 3.5 Flash**. (Gemini 3.5 Flash-Lite was tried first, but in testing it sometimes wrote tool calls out as text instead of making them.)

- ElevenLabs' docs list Gemini models as natively supported, including Gemini 3.5 Flash-Lite and Gemini 3.5 Flash. No Google key is needed; ElevenLabs runs the model.
- It's fast, reliable at tool calls, in the same family as our backend's Gemini, and fits our "best use of Gemini" story.
- Flash costs more per token than Flash-Lite. The docs give no per-model prices, but it should still be well within a demo budget (UNVERIFIED).
- **Cost (UNVERIFIED):** ElevenLabs' pricing FAQ is inconsistent on whether LLM use is billed on top of call minutes or deducted from credits. Flash-Lite is the cheapest Gemini option; Flash costs more per token.
- **Custom LLM:** ElevenLabs supports bringing your own LLM endpoint, but the docs don't say which plans include it (UNVERIFIED). We don't need it; don't set one up.

### 3.6 Turn-taking and interruptions

- **Keep the defaults** for turn-taking, turn timeout and interruptions. Users should be able to interrupt the mascot (barge-in) in normal conversation.
- If there's an **end-call-on-silence** or **max conversation duration** setting, set something short to protect the free minutes: for example end after about 20 s of silence, and a maximum of about 5 minutes. *(These settings' names and locations are UNVERIFIED.)*
- Per-tool interruption settings come in step 5.

### 3.7 Security tab (until the private agent exists)

See section 7.2. For now, on the **Security** tab, add your frontend's hostname(s) to the **allowlist**, for example `localhost` for development and the deployed frontend's hostname. Up to 10 hostnames, exact match; subdomains are separate entries.

### 3.8 Save, and note the agent ID

Save or publish the agent *(the button label is UNVERIFIED)*. Find the **agent ID**, which looks like `agent_…`. It's usually shown on the agent's page or in its settings or widget section *(location UNVERIFIED)*. The frontend needs it (section 7).

---

## 4. The system prompt (paste as is)

Paste everything inside the box into the **System prompt** field.

```
You are the Commutr mascot: a friendly, upbeat guide inside the Commutr app.
Commutr rewards people in Kitchener-Waterloo, Ontario, for walking, biking, scootering and taking GRT transit instead of driving. They earn points for green trips and redeem them for demo rewards at local businesses. Rewards also need a minimum eco score.

How you speak
- You are heard, not read. Answer in 1 or 2 short sentences. No lists, no markdown, no emoji, no URLs read out letter by letter.
- Be warm and encouraging, never preachy about cars.
- Stay on Commutr and getting around Kitchener-Waterloo. For anything else, say briefly that you can only help with Commutr and getting around KW, and offer something you can do.

Using tools
- Call tools only through function calling. Never write a tool name, parentheses, parameter names or code in your reply.
- Never say "tool" or "function" to the user.
- After a tool returns, speak only its "summary" (or a shorter natural version of it, keeping every number exactly).

Tools and numbers
- Never invent or guess numbers (points, eco score, streak, prices, minutes, km, bus times). Always get them from a tool.
- Every tool returns a "summary" sentence. Say that summary, or a natural, shorter version of it, keeping every number exactly as given. If "ok" is false, the summary explains why: say it kindly.
- Points, eco score, streak, points today: call get_status.
- What they can get, what's locked and what's missing: call get_rewards.
- Directions, "how do I get to", "should I bike or bus": call plan_trip with the destination as the user said it, and with origin_name if the user said where they are starting from (a place name or landmark). Leave origin_name out to use their saved home.
- Starting a trip ("I'm heading out", "start my bike trip"): ask which mode if it's unclear (walk, bike, scooter, transit or car), then call start_trip. For transit, remind them to start at the stop.
- Route safety: call get_route_safety. It is not available yet; say its summary.

Starting point
- Always say where a trip starts. plan_trip returns it in origin_name, and its summary begins with it, for example "From your saved home" or "From University of Waterloo".
- When the saved home was used (origin is "home"), say that you assumed it, for example "From your saved home, ...", so the user can correct you.
- If plan_trip answers that it doesn't know where they're starting from (code no_origin), ask "Where are you starting from?" and call it again with origin_name.
- If a starting point can't be found (code origin_not_found), ask them to name another place nearby.
- If they ask "from where?", answer with origin_name from the last plan_trip result. Never guess it.
- A place name or landmark is enough; never ask for a home address.

Confirmations (very important)
- Redeeming a reward: first call redeem_reward with the reward_id and WITHOUT confirm. Read the cost back from the summary and ask "Should I redeem it?" Only after the user clearly says yes, call redeem_reward again with confirm set to true. If they hesitate or say no, don't redeem.
- If you don't know the reward_id, call get_rewards first and use the reward_id from it. Never guess an ID.
- Finishing a trip: ask "Are you done with your trip?" before calling finish_trip. Call finish_trip WITHOUT confirm. If it answers that too little GPS was recorded, read that warning and ask whether to finish anyway. Only after a clear yes, call finish_trip again with confirm set to true.
- Never send confirm true without the user's clear yes in this conversation.

When things go wrong
- If a tool fails, times out or returns an error with no summary, say something like "Sorry, I can't reach Commutr right now. Please try again in a moment." Don't retry more than once, and don't make up an answer.
- If a place can't be found, ask the user to say it another way or name a nearby landmark.

Privacy and honesty
- Never ask for or repeat personal details such as full names, emails, phone numbers or home addresses.
- All merchants and rewards are demo data. Commutr is not affiliated with GRT or any government. For fares and schedules beyond what the tools say, suggest checking grt.ca.
```

---

## 5. The 7 tools (server / webhook tools)

Add each tool on the agent: **Agent tab → Tools → Add tool → Webhook** *(the exact path is UNVERIFIED; the docs call these "webhook tools" or "server tools")*. These match the backend code in `backend/src/routes/agent.ts`.

### 5.1 Settings shared by all 7 tools

| Setting | Value |
|---|---|
| URL | `BASE/api/agent/...`, with `BASE` your current tunnel URL from 2.3 (no trailing slash) |
| Body content type (POST tools) | **JSON** (the default) |
| Response timeout | **15 seconds**. ElevenLabs' default is 20 s, allowed range 5–300 s; the planner can take up to about 8 s. *(The field label is UNVERIFIED.)* |
| Parameter value type | **LLM Prompt** (the agent fills the value from the conversation) |

**Headers on every tool:**

| Header name | Type | Value |
|---|---|---|
| `X-Agent-Secret` | **Secret** | the ElevenLabs secret `commutr_agent_secret` |
| `X-Demo-User` (optional) | Dynamic variable | `{{demo_user}}`. Leave this header out for the demo (the backend then uses user 1). See 7.5. |

**Creating the secret (on the first tool, once):**
1. In the tool's **Headers**, add a header named `X-Agent-Secret`.
2. Set its type to **Secret**, then click **Create New Secret** (labels from ElevenLabs' docs).
3. Name it `commutr_agent_secret`, and a human pastes the `AGENT_TOOL_SECRET` value from `backend/.env`. Save.
4. On every other tool, add the same header, type **Secret**, and pick the existing `commutr_agent_secret`.

**Optional per-tool settings** *(the labels are UNVERIFIED; the API names are from ElevenLabs' tool schema)*:
- **Pre-tool speech** (`pre_tool_speech`): **`auto`** on all 7 tools, so the platform decides when to say something while a slow tool runs. Don't use `force`, and don't add prompt lines telling the agent to say a filler sentence: forced pre-tool speech made the agent write the tool call out as text instead of making it.
- **Interruptions while the tool runs** (`interruption_mode`, formerly "disable interruptions"): `disable_during_tool` for `redeem_reward` and `finish_trip`, so a stray noise can't cut them off while they run. The user can still interrupt the reply that follows.
- **Tool call sound** (`tool_call_sound`, for example `typing`): optional for `plan_trip`.
- **Execution mode**: leave it at the default (`immediate`).

### 5.2 `get_status`

| Field | Value |
|---|---|
| Name | `get_status` |
| Description | Gets the user's Commutr points, eco score, streak and points earned today. Use it whenever they ask how they're doing or about their points or streak. |
| Method | GET |
| URL | `BASE/api/agent/status` |
| Parameters | none |

### 5.3 `get_rewards`

| Field | Value |
|---|---|
| Name | `get_rewards` |
| Description | Lists the rewards the user can redeem now, and the locked ones with how many points or how much eco score they're missing. Each reward has a reward_id. Use it before redeeming, or when they ask what they can get. |
| Method | GET |
| URL | `BASE/api/agent/rewards` |
| Parameters | none |

### 5.4 `redeem_reward`

| Field | Value |
|---|---|
| Name | `redeem_reward` |
| Description | Redeems a reward with the user's points. First call it without confirm to get the cost, ask the user to confirm out loud, then call it again with confirm true. Never send confirm true without the user's clear yes. |
| Method | POST |
| URL | `BASE/api/agent/redeem` |

Body parameters:

| Identifier | Data type | Required | Description |
|---|---|---|---|
| `reward_id` | integer | yes | The reward_id from get_rewards. Never guess it. |
| `confirm` | boolean | no | True only after the user clearly confirmed out loud. Leave it out on the first call. |

### 5.5 `plan_trip`

| Field | Value |
|---|---|
| Name | `plan_trip` |
| Description | Plans a green trip to a place in Kitchener-Waterloo by walking, biking or GRT transit, with times, points and the next bus, from the user's saved home or from a starting place they name. Use it whenever the user asks how to get somewhere. |
| Method | POST |
| URL | `BASE/api/agent/plan` |

Body parameters:

| Identifier | Data type | Required | Description |
|---|---|---|---|
| `destination` | string | yes | Where the user wants to go, as they said it, for example 'Waterloo Public Library', 'home' or 'campus'. |
| `origin_name` | string | no | Where the user is starting from, as they said it (a place name or landmark, for example 'University of Waterloo'). Leave it out to use their saved home. |

Without `origin_name`, the trip starts from the user's saved home. The response's `origin_name` and the start of its `summary` always say where it starts ("From your saved home, …"). The backend also accepts `origin_lat` and `origin_lng`, but **don't add them as agent parameters**: the agent has no way to know coordinates.

### 5.6 `start_trip`

| Field | Value |
|---|---|
| Name | `start_trip` |
| Description | Starts tracking a trip in the chosen mode when the user says they're setting off. The Commutr app must stay open to record the route. |
| Method | POST |
| URL | `BASE/api/agent/trips/start` |

Body parameters:

| Identifier | Data type | Required | Description |
|---|---|---|---|
| `mode` | string (enum: `walk`, `bike`, `scooter`, `transit`, `car`) | yes | How the user is travelling: walk, bike, scooter, transit or car. Ask if it's unclear. |

If the dashboard offers an enum or "allowed values" option for strings *(UNVERIFIED)*, enter the five values. Otherwise, list them in the description.

### 5.7 `finish_trip`

| Field | Value |
|---|---|
| Name | `finish_trip` |
| Description | Finishes the user's current trip and scores it. Ask the user first. If it warns that too little GPS was recorded, read the warning and only call again with confirm true if they agree. |
| Method | POST |
| URL | `BASE/api/agent/trips/finish` |

Body parameters:

| Identifier | Data type | Required | Description |
|---|---|---|---|
| `confirm` | boolean | no | True only to finish even though too little GPS was recorded, after the user agreed. Leave it out on the first call. |

### 5.8 `get_route_safety`

| Field | Value |
|---|---|
| Name | `get_route_safety` |
| Description | Gets a safety rating for the bike route to a place. Not available yet; it says so. |
| Method | POST |
| URL | `BASE/api/agent/route-safety` |

Body parameters:

| Identifier | Data type | Required | Description |
|---|---|---|---|
| `destination` | string | no | Where the user wants to go. |

### 5.9 Check the tools before talking to the agent (costs no agent minutes)

From any terminal, with the secret in a shell variable (for example after `set -a; . backend/.env; set +a`, which loads `AGENT_TOOL_SECRET` without printing it):

```
curl -s BASE/api/agent/status -H "X-Agent-Secret: $AGENT_TOOL_SECRET"
curl -s -X POST BASE/api/agent/plan -H "X-Agent-Secret: $AGENT_TOOL_SECRET" -H "Content-Type: application/json" -d '{"destination":"Waterloo Park"}'
curl -s -o /dev/null -w "%{http_code}\n" BASE/api/agent/status    # no header: should print 401
```

---

## 6. Test checklist (dashboard test panel)

Open the agent's test conversation *(the quickstart calls it "Test AI agent"; the label is UNVERIFIED)*. It uses the real tools and your free minutes, so run through this list once, in order, rather than chatting freely.

Expected results come from the backend's templates. Numbers depend on the demo data (user 1 is the demo user "Alex", eco score 98).

| # | Say | Tool it should call | What you should hear (roughly) |
|---|---|---|---|
| 1 | "How many points do I have?" | `get_status` | "You have … points, an eco score of 98 and … streak. You've earned … of today's 200 points." (The backend currently says "a 6 days streak", a known grammar bug that will be fixed in code.) |
| 2 | "What rewards can I get?" | `get_rewards` | "You can redeem … rewards now, like … The closest one to unlock is …" |
| 3 | "Redeem the free coffee." | `get_rewards` if needed, then `redeem_reward` **without** confirm | "Free coffee at Maple Loop Coffee costs … points. Should I redeem it?" with **no** points spent yet |
| 4 | "Yes, go ahead." | `redeem_reward` with `confirm: true` | "Done! You redeemed … Your code is CMTR-…, and you have … points left." |
| 5 | "Actually, redeem it again." | `redeem_reward` | A refusal: "You already redeemed that reward today…" |
| 6 | "How do I get to Waterloo Park?" | `plan_trip` | Possibly a short filler line while it runs (the platform decides), then something like "From your saved home, biking takes about … minutes and earns about … points." It must never read out `plan_trip(…)` as text. |
| 7 | "Take me to Fake Place Nowhere." | `plan_trip` | "I couldn't find that place in Kitchener-Waterloo. Can you say it another way?" |
| 8 | "I'm biking to campus now." | `start_trip` (`mode: bike`) | "Your bike trip has started. Keep the Commutr app open so it can record your route." |
| 9 | "Start a walking trip too." | `start_trip` | "You already have a bike trip going. Finish it first." |
| 10 | "I'm there, finish my trip." | The agent asks first, then `finish_trip` **without** confirm | "Only 0 GPS points were recorded, so finishing now would earn no points…" (a test-panel trip has no GPS) |
| 11 | "Finish it anyway." | `finish_trip` with `confirm: true` | "Trip finished: … km biking, but it couldn't be verified, so it earned no points…" |
| 12 | "Is the route to Uptown safe?" | `get_route_safety` | "Route safety ratings aren't available yet…" |
| 13 | "What's the weather in Paris?" | none | A polite steer back to Commutr and getting around KW |

After the run:
- Check the agent's **call history** *(name from the docs' quickstart: "Call history")*. Each tool call should show HTTP 200.
- Check the backend terminal for errors.
- Steps 4 and 11 really changed user 1's data. Run `npm run seed` in `backend/` to reset the demo data.

**Automated tests:** ElevenLabs also has a **Tests** tab, with simulation tests and tool-call tests that check the agent calls a tool with the expected parameters. Whether running them uses credits isn't stated in the docs (UNVERIFIED), so use them sparingly.

---

## 7. Frontend integration (for the React teammate)

### 7.1 The SDK

```
npm install @elevenlabs/react
```

From ElevenLabs' React docs:
- Wrap the part of the app that talks to the agent in a **`ConversationProvider`**. All conversation hooks must be used inside it.
- Use the **`useConversation`** hook. Its callbacks are `onConnect`, `onDisconnect`, `onMessage`, `onError` and `onModeChange`. It returns `status` (`"disconnected" | "connecting" | "connected"`), `isSpeaking`, `isListening`, `mode`, `isMuted` and `setMuted`.
- **Start:** `await conversation.startSession({ ... })`, which resolves to a `conversationId`.
- **Stop:** `await conversation.endSession()`.

A minimal sketch (adjust to the docs if names differ):

```jsx
import { ConversationProvider, useConversation } from '@elevenlabs/react';

function Mascot() {
  const conversation = useConversation({
    onMessage: (m) => console.log('transcript/reply', m), // shape: see 7.4
    onModeChange: (m) => console.log('mode', m),          // speaking / listening
    onError: (e) => console.error(e),
  });

  async function start() {
    await navigator.mediaDevices.getUserMedia({ audio: true }); // ask for the mic first (7.6)
    await conversation.startSession({
      agentId: import.meta.env.VITE_ELEVENLABS_AGENT_ID, // public agent (7.2)
      // signedUrl: ... or conversationToken: ...       // private agent (7.2)
      // dynamicVariables: { demo_user: '1' },           // optional (7.5)
    });
  }

  return (
    <>
      <MascotAnimation speaking={conversation.isSpeaking} />
      <button onClick={start} disabled={conversation.status !== 'disconnected'}>Talk</button>
      <button onClick={() => conversation.endSession()}>Stop</button>
    </>
  );
}

export default function App() {
  return (
    <ConversationProvider>
      <Mascot />
    </ConversationProvider>
  );
}
```

`connectionType` can be set explicitly. The docs say it defaults to WebRTC for voice, but don't list its values (UNVERIFIED), so leave it unset.

### 7.2 Public agent or private agent (signed URL / token)

| | Public agent | Private agent (recommended) |
|---|---|---|
| How the app starts it | `startSession({ agentId })` | Our backend asks ElevenLabs for a short-lived credential with the ElevenLabs API key; the app gets only that |
| Who can start a conversation | **Anyone** who has the agent ID, and it's visible in the frontend's code | Only our app, through our backend |
| Risk | Every session uses **our** free minutes and LLM credits. A leaked ID or a reloading script can use up the month's allowance. | None beyond our own use |

**Recommendation: a private agent.** ElevenLabs offers two credentials, both fetched by a server with the ElevenLabs API key, never from the browser:
- **Conversation token (WebRTC, our pick):** `GET https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=<AGENT_ID>` returns `{ "token": "…", "conversation_id": "…" }`. Then `startSession({ conversationToken: token })`. How long the token stays valid, and whether this endpoint needs the API key header, aren't stated on its docs page (UNVERIFIED; expect `xi-api-key`, as for signed URLs).
- **Signed URL (WebSocket):** `GET https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=<AGENT_ID>` with header `xi-api-key` returns `{ "signed_url": "wss://…" }`. Then `startSession({ signedUrl })`. The URL must be used within **15 minutes**; a conversation that has started keeps going after that.

To make the agent private, turn on authentication for it *(the dashboard toggle is UNVERIFIED; in the API it's `platform_settings.auth.enable_auth = true`)*.

**Status: the backend endpoint is planned, not built.** It will be a separate backend task, for example `GET /api/agent/session`, which returns a fresh conversation token for the app. Until it exists:
- keep the agent **public**, with the **Security tab allowlist** set to the frontend's hostnames (3.7);
- don't share the agent ID;
- end sessions when the mascot screen closes.

ElevenLabs' docs say not to combine an allowlist and signed URLs on the same agent. When we switch to the private agent, remove the allowlist.

### 7.3 The agent ID

It isn't a secret, but treat it as private while the agent is public. Put it in the frontend's env file, for example `VITE_ELEVENLABS_AGENT_ID` (the teammate decides the name), not hard-coded. **Never** put the ElevenLabs API key or `AGENT_TOOL_SECRET` in the frontend.

### 7.4 Live transcript and the speaking state

- **Speaking state for the mascot animation:** use `isSpeaking` (true while the agent talks), or `onModeChange` (speaking or listening).
- **Transcript:** `onMessage` delivers the user's transcribed speech (tentative and final) and the agent's replies. The docs page doesn't describe the message object's fields (UNVERIFIED): log one message, check which field says who spoke and which holds the text, then render a chat-style list.

### 7.5 Dynamic variables (optional)

- Pass them at the start: `startSession({ agentId, dynamicVariables: { demo_user: '1' } })`. Values must be strings, numbers or booleans.
- To act as another demo user, add the `X-Demo-User` header to all 7 tools with the value `{{demo_user}}` (type: dynamic variable).
- In the dashboard, set a **test placeholder** for `demo_user` (for example `1`). Dashboard tests don't run start-up webhooks, so without a placeholder the header would be sent as the literal text `{{demo_user}}`, and the backend would answer 400.
- Never pass anything secret as a dynamic variable. (ElevenLabs' `secret__` variables exist for headers, but we use a Secret header instead.)

### 7.6 Microphone permission

- Browsers only allow the mic over **HTTPS** or on `localhost`.
- Explain why first ("so you can talk to the mascot"), then call `navigator.mediaDevices.getUserMedia({ audio: true })` before `startSession`.
- If permission is refused, show a message and keep the text chat (`POST /api/chat`) available.

### 7.7 Free-plan limits: rehearse sparingly

From ElevenLabs' agents pricing page (2026-11-07): the **Free plan includes 15 minutes of agent calls and 4 concurrent calls**. Extra minutes cost money on paid plans, and Free has no commercial licence. LLM cost is billed separately or deducted from credits (the FAQ is inconsistent, UNVERIFIED). The general free plan has 10,000 credits a month.

So:
- test tools with `curl` first (5.9), which is free;
- run the checklist in section 6 once;
- keep rehearsals short, and end sessions you're not using;
- keep the end-on-silence and max-duration limits from 3.6.

---

## 8. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Tool call returns **401** (`bad_agent_secret`; the agent says "I couldn't reach your Commutr account") | The `X-Agent-Secret` header is missing on that tool, isn't type **Secret**, or the saved secret doesn't match `AGENT_TOOL_SECRET` | Check the header on **that** tool. Re-create the secret by pasting the value from `backend/.env` again. Restart the backend if you changed `.env`. Test with the curl lines in 5.9. |
| Tool call returns **503** `agent_not_configured` | `AGENT_TOOL_SECRET` is empty, or the backend wasn't restarted after setting it | Set it in `backend/.env` and restart `npm run dev` |
| Tool call fails to connect, or returns 502 / 530 / 1033, or "tunnel not found" | The tunnel stopped, or **its URL changed** after a restart | Restart `cloudflared tunnel --url http://localhost:8787`, copy the **new** URL, and update the URL in **all 7 tools** |
| Tool times out | The backend is slow (planner), or the timeout is too short | Keep the tool timeout at 15 s. Check the backend log. Run `npm run geocode:warm` so places resolve faster. |
| The agent writes a tool call as text (for example `plan_trip(destination=…)`) instead of calling it | A weak LLM, forced pre-tool speech, or prompt lines asking for a filler sentence before tools | Use Gemini 3.5 Flash, keep `pre_tool_speech: auto`, keep the "Using tools" rules in the prompt, re-run `npm run agent:setup`, then `npm run agent:test` |
| The agent doesn't call a tool and makes up an answer | The tool description or system prompt wasn't saved, the tool isn't attached to this agent, or the LLM ignored it | Check the 7 tools appear on the agent and the prompt is saved. Make the description start with "Use it whenever…". Check the LLM is **Gemini 3.5 Flash**. Run `npm run agent:test`. |
| The agent says the literal `{{demo_user}}`, or tools return 400 `bad_demo_user` | The `X-Demo-User` header uses a dynamic variable with no value | Remove that header (the demo uses user 1), or set a test placeholder and pass `dynamicVariables` from the app |
| **No audio** from the agent | The voice isn't usable (moderated voice or wrong ID), the browser blocked autoplay, or the wrong output device | Pick another premade voice, and check its ID with the curl in 3.4 (should be 200). Start sessions from a button click. Check the system output device. |
| **Agent can't hear the user** | Mic permission denied, the page isn't HTTPS, or the wrong input device | Allow the mic in the browser's site settings, use HTTPS or `localhost`, and pick the right mic |
| Sessions won't start, or you see "quota" / "limit" errors | The free plan's 15 minutes (or the credits) are used up, or there are more than 4 concurrent calls | Check usage in the ElevenLabs account. End idle sessions. Wait for the monthly reset or upgrade. Meanwhile, use the text chat (`POST /api/chat`), which uses our own Gemini key. |
| Session refused from the frontend | The allowlist doesn't include the page's hostname, or the private agent was started with `agentId` alone | Add the exact hostname on the Security tab, or start with a `conversationToken` / `signedUrl` from the backend (7.2) |
| Redeem or finish happened without asking | The prompt's confirmation rules weren't saved, or the LLM skipped them | Re-paste section 4. The backend still refuses without `confirm: true`, so check the call history for what was sent. |

---

## Sources (ElevenLabs documentation, checked 2026-11-07)

- Docs index: https://elevenlabs.io/docs/llms.txt
- Quickstart: https://elevenlabs.io/docs/eleven-agents/quickstart
- Prompting guide: https://elevenlabs.io/docs/eleven-agents/best-practices/prompting-guide
- Voice: https://elevenlabs.io/docs/eleven-agents/customization/voice
- LLMs: https://elevenlabs.io/docs/eleven-agents/customization/llm
- Tools overview: https://elevenlabs.io/docs/eleven-agents/customization/tools
- Webhook (server) tools: https://elevenlabs.io/docs/eleven-agents/customization/tools/webhook-tools
- Tool config schema (timeouts, pre-tool speech, interruptions): https://elevenlabs.io/docs/api-reference/tools/create
- Dynamic variables: https://elevenlabs.io/docs/eleven-agents/customization/personalization/dynamic-variables
- Testing: https://elevenlabs.io/docs/eleven-agents/customization/agent-testing
- Authentication (signed URLs, allowlist): https://elevenlabs.io/docs/eleven-agents/customization/authentication
- Conversation token (WebRTC): https://elevenlabs.io/docs/api-reference/conversations/get-webrtc-token
- React SDK: https://elevenlabs.io/docs/eleven-agents/libraries/react
- Agents pricing: https://elevenlabs.io/pricing/agents
