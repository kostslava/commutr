import { Hono } from 'hono';
import { myClubs } from '../clubs/progress.js';
import type { CurrentUserEnv } from '../currentUser.js';
import type { DB } from '../db.js';
import { DAILY_POINTS_CAP } from '../scoring/config.js';
import { displayStreak, type StoredStreak } from '../streak.js';
import { torontoDate, torontoDayRangeUtc } from '../time.js';
import { listLocations } from './locations.js';

export function meRoutes(db: DB) {
  const r = new Hono<CurrentUserEnv>();

  r.get('/me', (c) => {
    const userId = c.get('userId');
    const user = db.prepare('SELECT id, name, email, points, eco_score, trust_multiplier FROM users WHERE id = ?').get(userId) as {
      id: number;
      name: string;
      email: string;
      points: number;
      eco_score: number;
      trust_multiplier: number;
    };
    const streak = db.prepare('SELECT current_days, longest_days, last_active_date FROM streaks WHERE user_id = ?').get(userId) as StoredStreak | undefined;
    const [from, to] = torontoDayRangeUtc(torontoDate());
    const { today } = db
      .prepare("SELECT COALESCE(SUM(points_awarded), 0) AS today FROM trips WHERE user_id = ? AND status = 'finished' AND ended_at >= ? AND ended_at < ?")
      .get(userId, from, to) as { today: number };

    return c.json({
      ...user,
      points_today: today,
      daily_cap: DAILY_POINTS_CAP,
      streak: displayStreak(streak),
      clubs: myClubs(db, userId),
      saved_locations: listLocations(db, userId),
    });
  });

  return r;
}
