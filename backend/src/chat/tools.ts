// Gemini function-calling tools. They read the real database for the CURRENT user,
// who is fixed on the server side: the model never sees or passes a user ID.
//
// Privacy rule (checked by the tests): no name, email, coordinates or user ID in any
// tool result. Results are built field by field from allow-listed values.

import { Type, type FunctionDeclaration } from '@google/genai';
import { myClubs } from '../clubs/progress.js';
import type { DB } from '../db.js';
import { listRewards } from '../rewards/redeem.js';
import { DAILY_POINTS_CAP } from '../scoring/config.js';
import { displayStreak, type StoredStreak } from '../streak.js';
import { torontoDate, torontoDayRangeUtc } from '../time.js';

const noParams = { type: Type.OBJECT, properties: {} };

export const TOOL_DECLARATIONS: FunctionDeclaration[] = [
  {
    name: 'get_my_status',
    description: "The user's points balance, eco score (0-100), streak, points earned today and the daily points cap.",
    parameters: noParams,
  },
  {
    name: 'get_affordable_rewards',
    description: 'Rewards the user can redeem right now: unlocked by eco score AND affordable with their points.',
    parameters: noParams,
  },
  {
    name: 'get_locked_rewards',
    description: 'Rewards the user cannot redeem yet, with how much eco score and how many points are missing for each.',
    parameters: noParams,
  },
  {
    name: 'get_clubs',
    description: "The clubs the user belongs to: weekly step goal, the club's steps this week, the user's own steps, progress.",
    parameters: noParams,
  },
];

export type ToolName = 'get_my_status' | 'get_affordable_rewards' | 'get_locked_rewards' | 'get_clubs';

export function runTool(db: DB, userId: number, name: string): Record<string, unknown> {
  switch (name as ToolName) {
    case 'get_my_status': {
      const u = db.prepare('SELECT points, eco_score FROM users WHERE id = ?').get(userId) as { points: number; eco_score: number };
      const streak = displayStreak(db.prepare('SELECT current_days, longest_days, last_active_date FROM streaks WHERE user_id = ?').get(userId) as StoredStreak | undefined);
      const [from, to] = torontoDayRangeUtc(torontoDate());
      const { today } = db
        .prepare("SELECT COALESCE(SUM(points_awarded), 0) AS today FROM trips WHERE user_id = ? AND status = 'finished' AND ended_at >= ? AND ended_at < ?")
        .get(userId, from, to) as { today: number };
      return {
        points: u.points,
        eco_score: u.eco_score,
        streak_days: streak.current_days,
        longest_streak_days: streak.longest_days,
        active_today: streak.active_today,
        points_today: today,
        daily_cap: DAILY_POINTS_CAP,
      };
    }
    case 'get_affordable_rewards':
      return {
        rewards: listRewards(db, userId)
          .filter((r) => !r.locked && r.affordable)
          .map((r) => ({ title: r.title, points_cost: r.points_cost, merchant: r.merchant.name, category: r.merchant.category, redeemed_today: r.redeemed_today })),
      };
    case 'get_locked_rewards':
      return {
        rewards: listRewards(db, userId)
          .filter((r) => r.locked || !r.affordable)
          .map((r) => ({
            title: r.title,
            merchant: r.merchant.name,
            points_cost: r.points_cost,
            min_eco_score: r.min_eco_score,
            reason: r.lock_reason,
            eco_needed: r.eco_needed,
            points_needed: r.points_needed,
          })),
      };
    case 'get_clubs':
      return {
        clubs: myClubs(db, userId).map((c) => ({
          club: c.name,
          weekly_goal_steps: c.weekly_goal_steps,
          club_steps_this_week: c.steps_this_week,
          my_steps_this_week: c.my_steps_this_week,
          progress_percent: Math.round(c.progress * 100),
          goal_reached: c.goal_reached,
        })),
      };
    default:
      return { error: `unknown tool ${name}` };
  }
}
