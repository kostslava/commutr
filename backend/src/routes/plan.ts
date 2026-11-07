import { Hono } from 'hono';
import { takeUserRequest } from '../chat/usage.js';
import type { CurrentUserEnv } from '../currentUser.js';
import type { DB } from '../db.js';
import { isPlanError, plan } from '../planner/plan.js';
import { isObj, jsonBody } from './http.js';

export function planRoutes(db: DB) {
  const r = new Hono<CurrentUserEnv>();

  // Trip planner. See docs/api.md.
  r.post('/plan', async (c) => {
    const body = await jsonBody(c);
    if (!isObj(body)) return c.json({ error: { code: 'validation_error', message: 'Send a JSON object with destination' } }, 400);
    const limit = takeUserRequest('plan', c.get('userId'));
    if (!limit.ok) {
      c.header('Retry-After', String(limit.retryAfterSec));
      return c.json({ error: { code: 'rate_limited', message: 'Too many trip plans. Try again soon.' }, retry_after_sec: limit.retryAfterSec }, 429);
    }
    const result = await plan(db, c.get('userId'), body);
    if (isPlanError(result)) return c.json({ error: { code: result.code, message: result.message } }, result.status);
    return c.json(result);
  });

  return r;
}
