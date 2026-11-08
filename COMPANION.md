# Muta

Muta is mounted once outside the app's page transitions, so a live call survives navigation. He peeks from the right edge, low on screen, with only his head visible at roughly 43 degrees. Opening him blurs the app behind the character and exposes two controls: Let’s type and Let’s talk. The name uses the existing Commutr mark followed by “ta”. The supplied sprite sheets show idle, listening, thinking and speaking; reduced-motion mode uses a still frame.

## Conversation and actions

Typed messages go to `POST /api/companion/chat`. Gemini reads current account tools and returns structured, allow-listed app actions. Only the last six messages of the current session are sent for follow-ups. Closing text chat clears it; reopening starts fresh. Voice transcripts are neither rendered nor accumulated in text-chat state.

Voice starts through `POST /api/companion/session`: the backend uses its private ElevenLabs API key to obtain a signed WebSocket URL. The official browser SDK handles the call. The existing agent is named Muta and has ten browser tools: status, rewards, clubs, discovery, navigation, route planning, start trip, finish trip, redeem reward and route-safety availability. Minimize preserves the call; ending it, switching to typing or leaving releases it. Every new call starts a new session.

Both modes share the same app action boundary. Explicit requests execute directly without a second confirmation card. Muta asks a short conversational question only when the requested place, mode or reward is unclear; points are spent only for an explicit redemption request. The backend remains authoritative for eligibility and balances. Trip actions use the existing foreground GPS tracker, preserving its upload/retry/scoring lifecycle. Browser microphone and location permissions still apply. Planning a route does not start tracking.

`POST /api/companion/plan` resolves the named origin and destination, computes the real trip options and preloads the map with the same coordinates. `GET /api/companion/account` reads current account/reward/club data. `POST /api/companion/discover` searches bounded, rate-limited Nominatim results throughout KW, beyond the preset map destinations. Muta recommends one or two returned places, then offers a route after the user chooses. Current hours, prices and events are not invented. Route safety remains unavailable.

The shared personality lives in backend `src/chat/muta.ts`: relaxed, useful replies, normally one or two sentences and about 15–40 words. More detail is reserved for explicit requests or a necessary explanation.

## Configuration

Set `GEMINI_API_KEY` and `ELEVENLABS_API_KEY` only in backend `.env`. The existing agent ID is in `backend/elevenlabs/state.json`; `ELEVENLABS_AGENT_ID` can override it. No frontend provider key is needed. Calls use the app's existing demo user 1.

Run `npm run companion:setup` from the backend to configure the existing agent. It retains the current voice and model, attaches the browser tools, sets Muta's name and concise prompt, enables signed-session authentication and verifies the provider response. The original configuration is backed up in ignored `backend/data/companion-agent-backup.json`; browser tool IDs are in ignored `backend/data/companion-tools.json`. Keep that tool-ID file for idempotent setup. No Cloudflare tunnel or agent tool secret is required for these browser tools. Existing webhook APIs remain intact.

The legacy `agent:setup` script configures webhook tools and should not be run against Muta afterward. To restore the original remote configuration, PATCH the backed-up conversation_config and platform_settings to the same agent ID; do not put keys or backups in the frontend.

## Verification

Frontend tests cover fresh chat context, no voice transcript, call persistence, mute/end, canceled and timed-out startup, microphone denial, valid app actions, ineligible rewards, direct requested redemption and shared trip tracking. Backend companion tests cover Gemini function calls, bounded history, actual account tools, discovery results, privacy, partial-failure handling and unavailable voice configuration. Both production builds and the existing backend suites are also checked.

Real-provider checks exercised Gemini recommendations and ElevenLabs speech recognition, audio output, navigation and place-discovery client tools. Human microphone permission is device-specific; an unanswered prompt times out with a text fallback.

Provider documentation: [ElevenLabs client tools](https://elevenlabs.io/docs/eleven-agents/customization/tools/client-tools), [signed sessions](https://elevenlabs.io/docs/eleven-agents/customization/authentication).

## App updates

Online navigations use network-first HTML, with a cached page available offline. Only the outer page registers the PWA update handler, so updating it replaces the phone preview as well. Service-worker activation and client claiming are explicit; the app refreshes to a new version when idle, deferring while a Muta call or foreground GPS recording is active. This prevents obsolete confirmation handlers from remaining in a stale phone iframe.
