# Commutr: Best use of ElevenLabs

Commutr rewards people in Kitchener-Waterloo for walking, cycling and taking transit instead of driving. Its mascot, **Muta**, is an ElevenLabs agent you can talk to in a live, two-way voice call. It doesn't just answer: its tools run inside the app, so a spoken request moves the app. "Plan a trip to Waterloo Park" draws the route on the map; "start a walk" starts GPS recording.

## 1. Live two-way voice: the Muta agent

- **SDK:** `@elevenlabs/client` (`Conversation.startSession`, WebSocket connection), loaded only when a call starts. **Code:** `frontend/src/Companion.jsx`.
- **"Let's talk"** asks for the microphone first (with a 20 s timeout and a typing fallback if it's refused), then starts the session.
- **The call survives navigation.** Muta is mounted once outside the page transitions, so you can change tabs or minimize the panel mid-call. Mute and end are built in.
- **The mascot reacts to the conversation.** `onModeChange` and the tool and message events switch Muta's sprite animation between idle, listening, thinking and speaking.
- **The agent knows where you are.** `sendContextualUpdate` tells it the current screen and whether a trip is active, and keeps replies short (one or two sentences).

## 2. Private agent, signed URL from our backend

The agent is private. The browser never sees the ElevenLabs API key or the agent ID.

```
Browser ── POST /api/companion/session ──▶ backend
backend ── GET /v1/convai/conversation/get-signed-url?agent_id=… (xi-api-key) ──▶ ElevenLabs
backend ◀── { signed_url: "wss://…" } ── ElevenLabs
Browser ── Conversation.startSession({ signedUrl, connectionType: "websocket" }) ──▶ Muta
```

- **Code:** `backend/src/routes/companion.ts`.
- The response is sent with `Cache-Control: no-store`, and starting sessions is rate-limited per user (4 a minute, 30 a day), since each one uses ElevenLabs quota.
- If voice isn't configured or ElevenLabs is unreachable, the backend answers `503` and the app offers typing instead.

## 3. Browser-side tools that move the app

Muta's tools are **browser (client) tools**. ElevenLabs sends each tool call to the browser, which runs it through the same code paths the user's taps use and returns the result. No tunnel or webhook is needed. **Code:** `clientTools` in `frontend/src/Companion.jsx`, `frontend/src/useCompanionActions.js`, `frontend/src/companionActions.js`.

| Tool | What happens in the app |
|---|---|
| `get_status` | Refreshes the account and returns points, eco score and streak |
| `get_rewards` | Opens the Shop and returns the real demo rewards with prices and eco thresholds |
| `get_clubs` | Returns the user's clubs and weekly progress |
| `discover_places` | Searches real KW places (backend Nominatim search) for "somewhere new" requests |
| `navigate` | Switches to Home, Map, Shop, Wallet or Community |
| `plan_trip` | Plans with the backend trip planner, then draws the route and options on the map |
| `start_trip` | Starts the app's foreground GPS tracker for the chosen mode |
| `finish_trip` | Uploads pending GPS points, then finishes and scores the trip |
| `redeem_reward` | Re-reads the catalogue, checks eligibility, then redeems and opens the Wallet |

- **Every action passes one allow-listed check** (`validAction` in `companionActions.js`) before it runs. The backend stays the authority for points, eligibility and balances, so the agent can't invent a reward, a price or a balance.
- **Tool results also update the screen** (`onAgentToolResponse`): a planned trip appears on the map, a redemption refreshes the Wallet, a rewards question opens the Shop.

## 4. How the agent is configured

`backend/scripts/companion-setup.ts` configured the existing agent once (it is not part of normal setup, and changes the live agent):
- name **Muta**, first message "Hey, I'm Muta. What's the plan?";
- the system prompt `MUTA_VOICE_PROMPT` from `backend/src/chat/muta.ts` (shared personality with the typed chat);
- the client tools (`expects_response: true`, 120 s timeout);
- the client events the app listens to (audio, interruption, transcripts, agent responses, tool requests and responses);
- `enable_auth: true` with an empty allowlist (signed sessions only).

The script doesn't set the agent's LLM or voice; those stay as already configured on ElevenLabs.

## 5. ElevenLabs speech for chat replies (built in the backend, not in the current UI)

The `/api/chat` endpoint attaches spoken audio to each reply:
- ElevenLabs text to speech with `eleven_flash_v2_5`, output `mp3_22050_32`, with the attribution "Voice by ElevenLabs";
- a daily character budget (6,000 by default) to protect the free quota;
- if ElevenLabs fails, is slow (4 s) or is over budget, Gemini TTS is used instead.

**The current frontend doesn't play this audio:** the Community chat is text only, and voice in the app is the Muta agent.

## History

An earlier design gave the agent 7 server-side webhook tools under `/api/agent/*`, called through a public tunnel with a shared secret. Those endpoints are still built, but the app no longer uses them: browser tools replaced them, so the call can move the app directly and needs no public tunnel.

## Not built

- A transcript of the voice call. The voice view shows a status ("Listening…", "Thinking…", "Speaking…") rather than text.
- Real user accounts: every call acts as demo user 1.
