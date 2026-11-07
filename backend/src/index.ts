import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { currentUser, type CurrentUserEnv } from './currentUser.js';
import { openDb } from './db.js';
import { transitRoutes } from './routes/transit.js';
import { initStaticGtfs } from './transit/staticGtfs.js';

const db = openDb(); // creates the schema on startup if missing
await initStaticGtfs(); // GRT static GTFS: disk cache or download (max ~30 s); never throws
const isProduction = process.env.NODE_ENV === 'production';
const port = Number(process.env.PORT ?? 8787);

const app = new Hono();

// Development only: allow the frontend dev server (any origin) to call the API.
if (!isProduction) app.use('*', cors());

app.get('/health', (c) => c.json({ ok: true }));

// Public transit endpoints. Mounted BEFORE the current-user middleware below so
// they answer without it (they don't depend on the user or the database).
app.route('/api', transitRoutes);

// All other app endpoints live under /api and see a (fake) current user. See docs/api.md.
const api = new Hono<CurrentUserEnv>();
api.use('*', currentUser(db));
app.route('/api', api);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Commutr backend listening on http://localhost:${info.port}`);
});
