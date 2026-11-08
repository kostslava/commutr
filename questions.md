# Backend handoff

No missing agent ID or API credentials remain for the local integration. Explicit user requests now execute directly, without an extra confirmation card. The existing agent (now named **Muta**) was found in the ElevenLabs account, and its ID already existed in `backend/elevenlabs/state.json`. Gemini and ElevenLabs keys remain only in the ignored backend `.env`.

## Decisions the backend owner should know

- The existing mascot is now private and uses backend-issued signed sessions. Its original provider configuration is backed up in ignored `backend/data/companion-agent-backup.json`.
- The mascot now uses ten browser tools. Browser tools call the normal backend APIs and the existing frontend GPS tracker, keeping the live call alive during navigation. A Cloudflare tunnel and `AGENT_TOOL_SECRET` are no longer required for this app's voice mode. Existing `/api/agent/*` webhook endpoints remain intact for other callers.
- Additive endpoints live in `backend/src/routes/companion.ts`: `POST /api/companion/chat`, `POST /api/companion/plan`, `GET /api/companion/account`, and `POST /api/companion/session`. The existing API contract file was preserved.
- Run `npm run companion:setup` inside the backend after transferring the checkout to another machine (with its existing agent ID and API key configured). Do not run the old `agent:setup` script afterward: it restores the older webhook-only configuration.

## Device check

The in-app browser left its microphone permission request pending during UI QA. Allow microphone access in your browser and try a human conversation. The app now times out unanswered permissions and keeps typing available. The real speech pipeline was separately verified with a synthetic spoken request: ElevenLabs recognized it, produced agent audio and called the correct navigation tool.

## Before deployment

- Replace the existing demo-user selection with real authentication. The current app intentionally operates on demo user 1. Enforce the authenticated identity on all account and session endpoints.
- Keep Gemini and ElevenLabs credentials in the server's environment, never in `VITE_*` variables. Preserve `/api` proxying, use HTTPS for microphone/location access, and allow those capabilities if the app is embedded.
- The mascot can explain actual demo rewards and their eco thresholds. Wallet fare discounts and memberships remain proposed previews, not real partnerships.

See `COMPANION.md` for architecture, testing and restoration instructions.
