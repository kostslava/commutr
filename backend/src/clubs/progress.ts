// Club weekly progress. A member's steps only count if their week_start is the
// current Toronto week (Monday). Older rows count as 0: the weekly reset happens
// on read, without rewriting data. (Trip scoring resets the row on the next walk.)

import type { DB } from '../db.js';
import { torontoWeekStart } from '../time.js';

export type ClubSummary = {
  id: number;
  name: string;
  description: string | null;
  weekly_goal_steps: number;
  steps_this_week: number;
  progress: number; // 0..1, capped at 1
  goal_reached: boolean;
  week_start: string;
  member_count: number;
  is_member: boolean;
  group_reward: string | null;
};

export type ClubMember = { user_id: number; name: string; steps_this_week: number; joined_at: string };

type Row = Omit<ClubSummary, 'progress' | 'goal_reached' | 'week_start' | 'is_member'> & { is_member: number };

export function clubSummaries(db: DB, userId: number, clubId?: number): ClubSummary[] {
  const week = torontoWeekStart();
  const rows = db
    .prepare(
      `SELECT c.id, c.name, c.description, c.weekly_goal_steps, c.group_reward,
              COUNT(m.user_id) AS member_count,
              COALESCE(SUM(CASE WHEN m.week_start = @week THEN m.steps_this_week ELSE 0 END), 0) AS steps_this_week,
              COALESCE(MAX(m.user_id = @userId), 0) AS is_member
       FROM clubs c LEFT JOIN club_members m ON m.club_id = c.id
       WHERE @clubId IS NULL OR c.id = @clubId
       GROUP BY c.id ORDER BY c.id`,
    )
    .all({ week, userId, clubId: clubId ?? null }) as Row[];

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    weekly_goal_steps: r.weekly_goal_steps,
    steps_this_week: r.steps_this_week,
    progress: Math.min(1, Math.round((r.steps_this_week / r.weekly_goal_steps) * 1000) / 1000),
    goal_reached: r.steps_this_week >= r.weekly_goal_steps,
    week_start: week,
    member_count: r.member_count,
    is_member: r.is_member === 1,
    group_reward: r.group_reward,
  }));
}

export function clubMembers(db: DB, clubId: number): ClubMember[] {
  return db
    .prepare(
      `SELECT u.id AS user_id, u.name, m.joined_at,
              CASE WHEN m.week_start = ? THEN m.steps_this_week ELSE 0 END AS steps_this_week
       FROM club_members m JOIN users u ON u.id = m.user_id
       WHERE m.club_id = ? ORDER BY steps_this_week DESC, u.name`,
    )
    .all(torontoWeekStart(), clubId) as ClubMember[];
}

/** The user's own steps this week in each club they belong to, plus the club's progress. */
export function myClubs(db: DB, userId: number) {
  const week = torontoWeekStart();
  const mine = new Map(
    (db.prepare('SELECT club_id, CASE WHEN week_start = ? THEN steps_this_week ELSE 0 END AS steps FROM club_members WHERE user_id = ?').all(week, userId) as {
      club_id: number;
      steps: number;
    }[]).map((r) => [r.club_id, r.steps]),
  );
  return clubSummaries(db, userId)
    .filter((c) => c.is_member)
    .map((c) => ({
      id: c.id,
      name: c.name,
      my_steps_this_week: mine.get(c.id) ?? 0,
      steps_this_week: c.steps_this_week,
      weekly_goal_steps: c.weekly_goal_steps,
      progress: c.progress,
      goal_reached: c.goal_reached,
    }));
}
