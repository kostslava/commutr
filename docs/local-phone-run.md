# Run Commutr locally and open it on a phone

Backend (port 8787) and frontend (Vite, port 5173) on a laptop, opened on a phone through a free HTTPS tunnel. Voice is Muta: the browser gets a signed link from `POST /api/companion/session` and runs the voice tools in the app. No `/api/agent/*` webhooks, no `AGENT_TOOL_SECRET` and no tunnel to the backend are needed for this.

Do **not** run `agent:setup` or `companion:setup` for this. Neither is needed to run the app, and both change the live ElevenLabs agent.

## 1. One-time setup

```bash
cd commutr                      # repo root
npm --prefix backend ci
npm --prefix frontend ci
cp backend/.env.example backend/.env   # only if backend/.env doesn't exist yet; then fill it in
```

`frontend/.env` is not needed. Leave `VITE_API_URL` unset so the app calls `/api` on its own origin and Vite forwards it.

### Variables in `backend/.env` (names only; never commit or share the values)

| Feature | Needs | Without it |
|---|---|---|
| Muta text chat (`/api/companion/chat`), Community chat (`/api/chat`) | `GEMINI_API_KEY` | FAQ-style fallback replies |
| Trip planning (`/api/plan`, `/api/companion/plan`) | `GEMINI_API_KEY` | Still works, with computed options and no Gemini explanation |
| Muta voice (`/api/companion/session`) | `ELEVENLABS_API_KEY`, plus the agent ID from `backend/elevenlabs/state.json` (or `ELEVENLABS_AGENT_ID`) | 503 "Voice isn't connected yet" |
| Spoken replies in `/api/chat` | `ELEVENLABS_VOICE_ID` (optional) | Gemini voice |

Leave `PORT` unset (the Vite proxy expects 8787) and don't set `NODE_ENV=production` locally (it locks CORS). `AGENT_TOOL_SECRET` isn't needed.

`backend/data/companion-agent-backup.json` and `companion-tools.json` are only used by `companion:setup`. You don't need them to run the app.

## 2. Run it (3 terminals, from the repo root)

**Terminal 1: backend and frontend together** (Ctrl+C stops both)
```bash
(trap 'kill 0' EXIT; npm --prefix backend run dev & npm --prefix frontend run dev -- --strictPort & wait)
```
You should see:
- `Commutr backend listening on http://0.0.0.0:8787`
- `[config] Gemini key: yes, ElevenLabs key: yes, …` (yes/no only, never values)
- Vite: `Local: http://localhost:5173/`

**Terminal 2: checks**
```bash
curl -s localhost:8787/health                  # {"ok":true}
curl -s localhost:5173/api/me | head -c 200    # user 1's profile JSON, through the Vite proxy
```

**Terminal 3: HTTPS link for the phone**
```bash
cloudflared tunnel --url http://localhost:5173 --http-host-header localhost
```
It prints `https://<random-words>.trycloudflare.com`. Open that link on the phone.

`--http-host-header localhost` is needed because Vite 6 refuses requests whose host it doesn't know ("Blocked request. This host is not allowed"). If that still appears, the frontend needs `server.allowedHosts: ['.trycloudflare.com']` in `frontend/vite.config.js` (a frontend owner change).

## 3. How it connects in dev

- The phone talks only to Vite (through the tunnel). Vite forwards `/api` and `/health` to `localhost:8787`, and `/routing` to the public Valhalla server for street route lines.
- Everything is same-origin, so CORS doesn't come into play. In dev the backend allows any origin anyway.
- No service worker in dev, so there's no stale cache.
- Voice audio goes straight from the phone to ElevenLabs; only the signed link comes from the backend.

## 4. Same wifi or tunnel

| | Same wifi `http://<laptop-ip>:5173` | cloudflared (https) |
|---|---|---|
| Browse, map, buses, plan, rewards, clubs | Work | Work |
| Trip recording (GPS) | Broken (needs https) | Works |
| Muta voice (microphone) | Broken (needs https) | Works |
| Muta text chat | Broken (`crypto.randomUUID` needs https) | Works |
| Notes | Firewall must allow 5173. Campus or hotel wifi may block phone-to-laptop traffic. | The URL changes on every restart. Anyone with the link uses the app as user 1 and spends the Gemini/ElevenLabs quota. Stop it when done. Vite live reload may not work through the tunnel. |

## 5. Known limits while testing

- GPS only records while the app is open in the foreground with the screen on.
- Transit trips must start and end near a GRT stop. Test with a walk first.
- The first GPS fix of a trip is rejected (it's taken before the trip starts), so move a bit before finishing.
- If user 1 has an old active trip, the map shows "Resume recording". `npm --prefix backend run seed` resets all demo data, so only use it if needed.
- Voice uses ElevenLabs free-plan minutes. Keep test calls short. Rate limits can return 429 if you test fast.
