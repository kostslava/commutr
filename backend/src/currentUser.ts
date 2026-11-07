import type { MiddlewareHandler } from 'hono';
import type { DB } from './db.js';

// Fake auth for the hackathon: user 1 by default, switchable per request with
// the header `X-Demo-User: <id>`. Replace with real auth later.
export type CurrentUserEnv = { Variables: { userId: number } };

const DEFAULT_USER_ID = 1;

export function currentUser(db: DB): MiddlewareHandler<CurrentUserEnv> {
  const exists = db.prepare('SELECT 1 FROM users WHERE id = ?');

  return async (c, next) => {
    const header = c.req.header('X-Demo-User');
    const userId = header === undefined ? DEFAULT_USER_ID : Number(header);

    if (!Number.isInteger(userId) || userId <= 0) {
      return c.json(
        { error: { code: 'bad_demo_user', message: 'X-Demo-User must be a positive integer user id' } },
        400,
      );
    }
    if (!exists.get(userId)) {
      return c.json(
        { error: { code: 'user_not_found', message: `No user with id ${userId}. Run npm run seed?` } },
        404,
      );
    }

    c.set('userId', userId);
    await next();
  };
}
