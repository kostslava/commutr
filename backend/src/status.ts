// A user's numbers in one place: points, eco score, trust, streak, points today.
// Used by GET /api/me, the chat's get_my_status tool, the agent and the planner.

import type { DB } from './db.js';
import { DAILY_POINTS_CAP } from './scoring/config.js';
import { displayStreak, type DisplayStreak, type StoredStreak } from './streak.js';
import { torontoDate, torontoDayRangeUtc } from './time.js';

export type UserStatus = {
  points: number;
  eco_score: number;
  trust_multiplier: number;
  points_today: number;
  daily_cap: number;
  streak: DisplayStreak;
};

export function userStatus(db: DB, userId: number): UserStatus {
  const u = db.prepare('SELECT points, eco_score, trust_multiplier FROM users WHERE id = ?').get(userId) as {
    points: number;
    eco_score: number;
    trust_multiplier: number;
  };
  const streak = db.prepare('SELECT current_days, longest_days, last_active_date FROM streaks WHERE user_id = ?').get(userId) as StoredStreak | undefined;
  const [from, to] = torontoDayRangeUtc(torontoDate());
  const { today } = db
    .prepare("SELECT COALESCE(SUM(points_awarded), 0) AS today FROM trips WHERE user_id = ? AND status = 'finished' AND ended_at >= ? AND ended_at < ?")
    .get(userId, from, to) as { today: number };
  return { ...u, points_today: today, daily_cap: DAILY_POINTS_CAP, streak: displayStreak(streak) };
}
