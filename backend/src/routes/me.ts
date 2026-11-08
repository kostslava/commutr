import { Hono } from 'hono';
import { myClubs } from '../clubs/progress.js';
import type { CurrentUserEnv } from '../currentUser.js';
import type { DB } from '../db.js';
import { userStatus } from '../status.js';
import { listRewards } from '../rewards/redeem.js';
import { listLocations } from './locations.js';

export function meRoutes(db: DB) {
  const r = new Hono<CurrentUserEnv>();

  function account(userId: number) {
    const user = db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(userId) as { id: number; name: string; email: string };
    const status = userStatus(db, userId);
    return {
      ...user,
      points: status.points,
      eco_score: status.eco_score,
      trust_multiplier: status.trust_multiplier,
      points_today: status.points_today,
      daily_cap: status.daily_cap,
      streak: status.streak,
      clubs: myClubs(db, userId),
      saved_locations: listLocations(db, userId),
    };
  }

  r.get('/me', (c) => c.json(account(c.get('userId'))));

  r.post('/me/reset', (c) => {
    const userId = c.get('userId');
    // This public app shares one seeded demo account. Never reset other users.
    if (userId !== 1) return c.json({ error: { code: 'demo_only', message: 'Only the shared demo account can be reset.' } }, 403);
    db.transaction(() => {
      db.prepare('DELETE FROM redemptions WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM trips WHERE user_id = ?').run(userId);
      db.prepare('UPDATE users SET points = 3200, eco_score = 98, trust_multiplier = 1 WHERE id = ?').run(userId);
    })();
    return c.json({ ok: true, me: account(userId), rewards: listRewards(db, userId), redemptions: [], trips: [], clubs: myClubs(db, userId) });
  });

  return r;
}
