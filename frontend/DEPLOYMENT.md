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

## Photo rehearsal

The map's photo upload button now confirms a local demo submission: it never sends the chosen photo to the backend and labels the receipt as a demo. This works even if a previously active trip ID disappeared after a backend restart. The explicit “Demo trip · no GPS” flow starts and finishes entirely in browser memory, requires a photo confirmation, and awards no account points. Previously loaded server demo trips can also complete locally and are suppressed for the rest of that browser session. Real GPS recording and scoring still use the backend; the tracker retains its real multipart upload path for non-demo callers.
