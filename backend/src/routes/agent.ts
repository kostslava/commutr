// Tool endpoints for the ElevenLabs live voice agent: /api/agent/*.
// Mounted behind agentAuth (X-Agent-Secret) and the normal current-user middleware
// (X-Demo-User, default user 1). See docs/agent-tools.md.
//
// Every response has `ok` and a short spoken `summary`. Expected refusals (no
// confirm, can't afford, trip already running, place not found) are 200 with
// ok: false, so the agent always has something to say. Malformed input is 400.

import { Hono, type Context } from 'hono';
import { finishSummary, rewardsSummary, statusSummary } from '../agent/summaries.js';
import { takeUserRequest } from '../chat/usage.js';
import type { CurrentUserEnv } from '../currentUser.js';
import type { DB } from '../db.js';
import { isPlanError, plan } from '../planner/plan.js';
import { listRewards, redeemReward } from '../rewards/redeem.js';
import { finishTrip } from '../scoring/apply.js';
import * as S from '../scoring/config.js';
import type { Mode } from '../scoring/config.js';
import { userStatus } from '../status.js';
import { isObj, jsonBody } from './http.js';
import { ALLOW_BACKDATED } from './trips.js';

type Ctx = Context<CurrentUserEnv>;
const refuse = (c: Ctx, code: string, summary: string, extra: Record<string, unknown> = {}) => c.json({ ok: false, code, summary, ...extra });
const badInput = (c: Ctx, message: string, summary: string) => c.json({ ok: false, error: { code: 'validation_error', message }, summary }, 400);

export function agentRoutes(db: DB) {
  const r = new Hono<CurrentUserEnv>();

  r.get('/status', (c) => {
    const s = userStatus(db, c.get('userId'));
    return c.json({
      ok: true,
      summary: statusSummary(s),
      points: s.points,
      eco_score: s.eco_score,
      streak_days: s.streak.current_days,
      longest_streak_days: s.streak.longest_days,
      active_today: s.streak.active_today,
      points_today: s.points_today,
      daily_cap: s.daily_cap,
    });
  });

  r.get('/rewards', (c) => {
    const all = listRewards(db, c.get('userId'));
    const affordable = all.filter((x) => !x.locked && x.affordable);
    const locked = all.filter((x) => x.locked || !x.affordable);
    return c.json({
      ok: true,
      summary: rewardsSummary(affordable, locked),
      affordable: affordable.map((x) => ({ reward_id: x.id, title: x.title, merchant: x.merchant.name, points_cost: x.points_cost, redeemed_today: x.redeemed_today })),
      locked: locked.map((x) => ({
        reward_id: x.id,
        title: x.title,
        merchant: x.merchant.name,
        points_cost: x.points_cost,
        min_eco_score: x.min_eco_score,
        reason: x.lock_reason,
        points_needed: x.points_needed,
        eco_needed: x.eco_needed,
      })),
    });
  });

  r.post('/redeem', async (c) => {
    const body = await jsonBody(c);
    const rewardId = isObj(body) ? body.reward_id : undefined;
    if (!Number.isInteger(rewardId) || (rewardId as number) <= 0) return badInput(c, 'reward_id must be a positive integer', 'Which reward would you like?');
    const userId = c.get('userId');
    const reward = listRewards(db, userId).find((x) => x.id === rewardId);
    if (!reward) return refuse(c, 'not_found', "I couldn't find that reward.");
    const info = { reward_id: reward.id, title: reward.title, merchant: reward.merchant.name, points_cost: reward.points_cost };

    // Only a literal true counts: the agent must ask the user first.
    if ((body as Record<string, unknown>).confirm !== true) {
      return refuse(c, 'confirm_required', `${reward.title} at ${reward.merchant.name} costs ${reward.points_cost} points. Should I redeem it?`, { reward: info });
    }
    const result = redeemReward(db, userId, reward.id);
    if ('status' in result) {
      const code = result.body.error.code;
      const summary =
        code === 'eco_score_too_low'
          ? `That reward needs an eco score of ${reward.min_eco_score}, and yours is ${reward.min_eco_score - reward.eco_needed}.`
          : code === 'not_enough_points'
            ? `You need ${reward.points_needed} more points for that one.`
            : code === 'already_redeemed_today'
              ? 'You already redeemed that reward today. Try again tomorrow.'
              : "I couldn't redeem that reward.";
      return refuse(c, code, summary, { reward: info });
    }
    return c.json({
      ok: true,
      summary: `Done! You redeemed ${result.redemption.title} at ${result.redemption.merchant_name}. Your code is ${result.redemption.code}, and you have ${result.user.points} points left.`,
      redemption: result.redemption,
      points: result.user.points,
    });
  });

  r.post('/plan', async (c) => {
    const body = await jsonBody(c);
    if (!isObj(body)) return badInput(c, 'Send a JSON object with destination', 'Where would you like to go?');
    const limit = takeUserRequest('plan', c.get('userId'));
    if (!limit.ok) return refuse(c, 'rate_limited', `That's a lot of trip plans. Try again in ${limit.retryAfterSec} seconds.`, { retry_after_sec: limit.retryAfterSec });
    const result = await plan(db, c.get('userId'), body);
    if (isPlanError(result)) {
      if (result.code === 'validation_error') return badInput(c, result.message, result.summary);
      return refuse(c, result.code, result.summary);
    }
    return c.json({ ok: true, ...result });
  });

  r.post('/trips/start', async (c) => {
    const body = await jsonBody(c);
    const mode = isObj(body) ? body.mode : undefined;
    if (typeof mode !== 'string' || !S.MODES.includes(mode as Mode)) return badInput(c, `mode must be one of: ${S.MODES.join(', ')}`, 'How are you travelling: walk, bike, scooter, transit or car?');
    const userId = c.get('userId');
    const active = db.prepare("SELECT id, mode FROM trips WHERE user_id = ? AND status = 'active'").get(userId) as { id: number; mode: Mode } | undefined;
    if (active) return refuse(c, 'trip_already_active', `You already have a ${active.mode} trip going. Finish it first.`, { active_trip_id: active.id });
    const startedAt = new Date().toISOString();
    const { lastInsertRowid } = db.prepare("INSERT INTO trips (user_id, mode, status, started_at) VALUES (?, ?, 'active', ?)").run(userId, mode, startedAt);
    const tip = mode === 'transit' ? ' Start it at the stop, and keep' : ' Keep';
    return c.json({
      ok: true,
      summary: `Your ${mode} trip has started.${tip} the Commutr app open so it can record your route.`,
      trip: { id: Number(lastInsertRowid), mode, status: 'active', started_at: startedAt },
    });
  });

  r.post('/trips/finish', async (c) => {
    const body = await jsonBody(c);
    const confirm = isObj(body) && body.confirm === true;
    const userId = c.get('userId');
    const active = db.prepare("SELECT id FROM trips WHERE user_id = ? AND status = 'active'").get(userId) as { id: number } | undefined;
    if (!active) return refuse(c, 'no_active_trip', "You don't have a trip going right now.");

    const { n } = db.prepare('SELECT COUNT(*) AS n FROM trip_points WHERE trip_id = ?').get(active.id) as { n: number };
    if (n < S.MIN_POINTS && !confirm) {
      return refuse(
        c,
        'few_gps_points',
        `Only ${n} GPS ${n === 1 ? 'point was' : 'points were'} recorded, so finishing now would earn no points and lower your trust score. Keep the app open a bit longer, or tell me to finish anyway.`,
        { trip_id: active.id, gps_points: n },
      );
    }
    // Same end time rule as POST /api/trips/:id/finish.
    const endedAt = (points: { timestamp: string }[]) => (ALLOW_BACKDATED && points.length ? points[points.length - 1]!.timestamp : new Date().toISOString());
    const result = finishTrip(db, userId, active.id, endedAt);
    if ('code' in result) return refuse(c, result.code, "I couldn't finish that trip.");
    return c.json({ ok: true, summary: finishSummary(result), ...result });
  });

  // Stub until the route-safety task (Gemini rating routes from Mapillary photos).
  r.post('/route-safety', (c) =>
    c.json({ ok: true, available: false, summary: "Route safety ratings aren't available yet. They're coming soon, so for now stick to bike lanes and quieter streets." }),
  );

  return r;
}
