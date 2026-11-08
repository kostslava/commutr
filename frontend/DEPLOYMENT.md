# Vercel frontend / Render backend

Vercel project `kostslavas-projects/commutr` is connected to `kostslava/commutr` on GitHub. Its **Root Directory** is `frontend`; the project uses Vite on Node 24, runs `npm ci` and `npm run build`, and publishes `dist`. Pushes to `main` deploy production automatically. The root `.vercelignore` excludes backend source, docs and filming files from manual CLI uploads.

`vercel.json` forwards `/api/*` and `/health` to `https://commutr-backend.onrender.com` without changing the browser's paths. `/routing/*` forwards street-path requests to the existing Valhalla provider. Other app navigations fall back to `index.html`; API failures are not rewritten to HTML. Leave `VITE_API_URL` unset so API calls use this same-origin proxy. Keep all Gemini and ElevenLabs keys on Render, with no provider credentials in Vercel's frontend environment.

The Render service currently returns 200 from `/health` and `/api/me`. The backend owner confirmed that demo data reseeds on boot and does not require persistent storage for this demo.

## Voice confirmations

Finishing a trip and redeeming a reward require spoken confirmation. The frontend tool first returns a question (including the actual reward and point cost). It only executes after a new affirmative user transcript and a repeated matching tool call. A model-supplied confirm flag cannot bypass it. A changed reward/price, changed trip, negative answer, unrelated reply or two-minute timeout requires a fresh question. Starting trips remains direct. Text and manual controls are unchanged; voice transcripts are not rendered or accumulated in chat history.

This is enforced entirely in `frontend/`; no backend files or live-agent configuration were changed. The voice session sends the confirmation instructions as a contextual update and the tool response repeats the required question.

After Vercel authorization, verify the deployed `/health` and `/api/me`, a route request, and a short Muta call before sharing the URL.

## Route safety

Muta's `get_route_safety` client tool calls `POST /api/companion/route-safety`. It sends the planned map's origin and destination coordinates when both exist; otherwise it sends the tool's destination name. The tool receives the unchanged JSON. Available ratings appear in a scrollable map card with all four factor notes, the source note and every Mapillary attribution line. Changing the planned route clears the card, and late responses for an old route are ignored. Unavailable results are left for Muta to summarize. No backend or live-agent settings were changed.

## Photo trips

The map's photo button runs a simulated 1.4-second upload with a spinner and progress bar, then shows “Photo uploaded”. No image is sent to the backend. The explicit “Photo trip · no GPS” flow starts and finishes in the browser. Attaching a photo to an existing GPS trip also opts that trip into browser completion. Both require a photo confirmation and a selected route distance, and calculate points from distance and mode (walk 10/km, bike 6/km, transit 12/km). A localStorage ledger credits each trip ID once and caps the combined browser and current server daily total at 200, using Toronto dates. The header, wallet and recent trips include these browser points and retain them across reloads.

This ledger is temporary: it does not modify backend balances, reward affordability or redemption rules. Server redemption continues to use server-owned points until the real photo integration is connected. Previously loaded server rehearsal trips can complete locally and are suppressed for the rest of that browser session. GPS trips completed without a photo still use backend scoring; the tracker retains its real multipart upload path for non-demo callers.
