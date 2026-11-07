import './env.js'; // must be first: loads backend/.env before other modules read process.env
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { currentUser, type CurrentUserEnv } from './currentUser.js';
import { openDb } from './db.js';
import { chatAudioRoutes, chatRoutes } from './routes/chat.js';
import { clubRoutes } from './routes/clubs.js';
import { locationRoutes } from './routes/locations.js';
import { meRoutes } from './routes/me.js';
import { rewardRoutes } from './routes/rewards.js';
import { ALLOW_BACKDATED, tripRoutes } from './routes/trips.js';
import { transitRoutes } from './routes/transit.js';
import { initStaticGtfs } from './transit/staticGtfs.js';

const isProduction = process.env.NODE_ENV === 'production';
if (ALLOW_BACKDATED && isProduction) {
  throw new Error('SCORING_ALLOW_BACKDATED=1 is a test-only flag and must not be used with NODE_ENV=production');
}
if (ALLOW_BACKDATED) console.warn('[trips] TEST MODE: backdated trips allowed (SCORING_ALLOW_BACKDATED=1)');

const db = openDb(); // creates the schema on startup if missing
await initStaticGtfs(); // GRT static GTFS: disk cache or download (max ~30 s); never throws
const port = Number(process.env.PORT ?? 8787);

const app = new Hono();

// Development only: allow the frontend dev server (any origin) to call the API.
if (!isProduction) app.use('*', cors());

app.get('/health', (c) => c.json({ ok: true }));

// Public transit endpoints. Mounted BEFORE the current-user middleware below so
// they answer without it (they don't depend on the user or the database).
app.route('/api', transitRoutes);
// Chat audio is public too: <audio src> can't send X-Demo-User (file names are unguessable hashes).
app.route('/api', chatAudioRoutes);

// All other app endpoints live under /api and see a (fake) current user. See docs/api.md.
const api = new Hono<CurrentUserEnv>();
api.use('*', currentUser(db));
api.route('/', tripRoutes(db));
api.route('/', meRoutes(db));
api.route('/', rewardRoutes(db));
api.route('/', clubRoutes(db));
api.route('/', locationRoutes(db));
api.route('/', chatRoutes(db));
app.route('/api', api);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Commutr backend listening on http://localhost:${info.port}`);
});
