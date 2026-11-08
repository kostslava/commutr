import './env.js'; // must be first: loads backend/.env before other modules read process.env
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { agentAuth } from './agent/auth.js';
import { currentUser, type CurrentUserEnv } from './currentUser.js';
import { openDb } from './db.js';
import { agentRoutes } from './routes/agent.js';
import { chatAudioRoutes, chatRoutes } from './routes/chat.js';
import { companionRoutes } from './routes/companion.js';
import { clubRoutes } from './routes/clubs.js';
import { locationRoutes } from './routes/locations.js';
import { meRoutes } from './routes/me.js';
import { planRoutes } from './routes/plan.js';
import { rewardRoutes } from './routes/rewards.js';
import { safetyRoutes } from './routes/safety.js';
import { ALLOW_BACKDATED, tripRoutes } from './routes/trips.js';
import { transitRoutes } from './routes/transit.js';
import { bootInBackground } from './boot.js';

const isProduction = process.env.NODE_ENV === 'production';
// Test-only flag: in production any value other than unset or "0" refuses to start.
const backdated = process.env.SCORING_ALLOW_BACKDATED;
if (isProduction && backdated !== undefined && backdated !== '' && backdated !== '0') {
  throw new Error('SCORING_ALLOW_BACKDATED is a test-only flag and must be unset (or 0) with NODE_ENV=production');
}
if (ALLOW_BACKDATED) console.warn('[trips] TEST MODE: backdated trips allowed (SCORING_ALLOW_BACKDATED=1)');

const db = openDb(); // creates the schema on startup if missing
const port = Number(process.env.PORT ?? 8787);
// Render and similar hosts need 0.0.0.0; HOST overrides it.
const hostname = process.env.HOST || '0.0.0.0';

// CORS. Development: any origin (the frontend dev server). Production: only the origins in
// FRONTEND_ORIGINS (comma separated, e.g. https://commutr.example.app); unset = no
// cross-origin access. The ElevenLabs agent calls server to server, so it needs no CORS.
export const frontendOrigins = (process.env.FRONTEND_ORIGINS ?? '')
  .split(',')
  .map((o) => o.trim().replace(/\/+$/, ''))
  .filter(Boolean);

const app = new Hono();

if (!isProduction) app.use('*', cors());
else if (frontendOrigins.length) app.use('*', cors({ origin: frontendOrigins }));

app.get('/health', (c) => c.json({ ok: true }));

// Public transit endpoints. Mounted BEFORE the current-user middleware below so
// they answer without it (they don't depend on the user or the database).
app.route('/api', transitRoutes);
// Chat audio is public too: <audio src> can't send X-Demo-User (file names are unguessable hashes).
app.route('/api', chatAudioRoutes);

// Tool endpoints for the ElevenLabs live voice agent. The X-Agent-Secret check runs
// first, then the same (fake) current user as the app. Mounted before the /api group
// below so the secret is checked before anything else.
const agent = new Hono<CurrentUserEnv>();
agent.use('*', agentAuth());
agent.use('*', currentUser(db));
agent.route('/', agentRoutes(db));
app.route('/api/agent', agent);

// All other app endpoints live under /api and see a (fake) current user. See docs/api.md.
const api = new Hono<CurrentUserEnv>();
api.use('*', currentUser(db));
api.route('/', tripRoutes(db));
api.route('/', meRoutes(db));
api.route('/', rewardRoutes(db));
api.route('/', clubRoutes(db));
api.route('/', locationRoutes(db));
api.route('/', chatRoutes(db));
api.route('/', companionRoutes(db));
api.route('/', safetyRoutes(db));
api.route('/', planRoutes(db));
app.route('/api', api);

serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(`Commutr backend listening on http://${hostname}:${info.port}${isProduction ? ' (production)' : ''}`);
  // Which optional features are configured: yes/no only, never values.
  const yes = (v: string | undefined) => (v ? 'yes' : 'no');
  const e = process.env;
  console.log(
    `[config] Gemini key: ${yes(e.GEMINI_API_KEY)}, ElevenLabs key: ${yes(e.ELEVENLABS_API_KEY)}, ElevenLabs voice: ${yes(e.ELEVENLABS_VOICE_ID)}, agent secret: ${yes(e.AGENT_TOOL_SECRET)}, ` +
      `CORS: ${isProduction ? `${frontendOrigins.length} allowed origin(s)` : 'any origin (development)'}`,
  );
  if (isProduction && !frontendOrigins.length) console.warn('[config] FRONTEND_ORIGINS is not set: browsers on other origins cannot call this API');
  void bootInBackground(); // GTFS + place warm-up after /health is up
});
