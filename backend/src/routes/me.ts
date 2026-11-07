import { Hono } from 'hono';
import { myClubs } from '../clubs/progress.js';
import type { CurrentUserEnv } from '../currentUser.js';
import type { DB } from '../db.js';
import { userStatus } from '../status.js';
import { listLocations } from './locations.js';

export function meRoutes(db: DB) {
  const r = new Hono<CurrentUserEnv>();

  r.get('/me', (c) => {
    const userId = c.get('userId');
    const user = db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(userId) as { id: number; name: string; email: string };
    const status = userStatus(db, userId);
    return c.json({
      ...user,
      points: status.points,
      eco_score: status.eco_score,
      trust_multiplier: status.trust_multiplier,
      points_today: status.points_today,
      daily_cap: status.daily_cap,
      streak: status.streak,
      clubs: myClubs(db, userId),
      saved_locations: listLocations(db, userId),
    });
  });

  return r;
}
