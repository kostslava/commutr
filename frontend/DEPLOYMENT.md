# Vercel frontend / Render backend

Import `kostslava/commutr` into Vercel and set the **Root Directory** to `frontend`. The project uses Vite, runs `npm ci` and `npm run build`, and publishes `dist`.

`vercel.json` forwards `/api/*` and `/health` to `https://commutr-backend.onrender.com` without changing the browser's paths. `/routing/*` forwards street-path requests to the existing Valhalla provider. Other app navigations fall back to `index.html`; API failures are not rewritten to HTML. Leave `VITE_API_URL` unset so API calls use this same-origin proxy. Keep all Gemini and ElevenLabs keys on Render, with no provider credentials in Vercel's frontend environment.

The Render service currently returns 200 from `/health` and `/api/me`. The backend owner confirmed that demo data reseeds on boot and does not require persistent storage for this demo.

## Voice confirmations

Finishing a trip and redeeming a reward require spoken confirmation. The frontend tool first returns a question (including the actual reward and point cost). It only executes after a new affirmative user transcript and a repeated matching tool call. A model-supplied confirm flag cannot bypass it. A changed reward/price, changed trip, negative answer, unrelated reply or two-minute timeout requires a fresh question. Starting trips remains direct. Text and manual controls are unchanged; voice transcripts are not rendered or accumulated in chat history.

This is enforced entirely in `frontend/`; no backend files or live-agent configuration were changed. The voice session sends the confirmation instructions as a contextual update and the tool response repeats the required question.

After Vercel authorization, verify the deployed `/health` and `/api/me`, a route request, and a short Muta call before sharing the URL.
