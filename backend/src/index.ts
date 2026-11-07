import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { currentUser, type CurrentUserEnv } from './currentUser.js';
import { openDb } from './db.js';

const db = openDb(); // creates the schema on startup if missing
const isProduction = process.env.NODE_ENV === 'production';
const port = Number(process.env.PORT ?? 8787);

const app = new Hono();

// Development only: allow the frontend dev server (any origin) to call the API.
if (!isProduction) app.use('*', cors());

app.get('/health', (c) => c.json({ ok: true }));

// All app endpoints live under /api and see a (fake) current user. See docs/api.md.
const api = new Hono<CurrentUserEnv>();
api.use('*', currentUser(db));
app.route('/api', api);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Commutr backend listening on http://localhost:${info.port}`);
});
