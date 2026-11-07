// Rewards: lock state for the list, and redemption in one transaction.
// A reward is LOCKED when the eco score is below min_eco_score (even with enough
// points), and AFFORDABLE when points >= points_cost.

import { randomInt } from 'node:crypto';
import type { DB } from '../db.js';
import * as R from '../rules.js';
import { torontoDate, torontoDayRangeUtc } from '../time.js';

export type LockReason = 'eco_score_too_low' | 'not_enough_points' | null;

type RewardRow = {
  id: number;
  title: string;
  points_cost: number;
  min_eco_score: number;
  merchant_id: number;
  merchant_name: string;
  merchant_category: string;
  merchant_address: string | null;
  merchant_lat: number | null;
  merchant_lng: number | null;
};

const REWARD_SELECT = `
  SELECT r.id, r.title, r.points_cost, r.min_eco_score,
         m.id AS merchant_id, m.name AS merchant_name, m.category AS merchant_category,
         m.address AS merchant_address, m.lat AS merchant_lat, m.lng AS merchant_lng
  FROM rewards r JOIN merchants m ON m.id = r.merchant_id`;

function redeemedTodayIds(db: DB, userId: number): Set<number> {
  const [from, to] = torontoDayRangeUtc(torontoDate());
  const rows = db
    .prepare('SELECT reward_id, COUNT(*) AS n FROM redemptions WHERE user_id = ? AND redeemed_at >= ? AND redeemed_at < ? GROUP BY reward_id')
    .all(userId, from, to) as { reward_id: number; n: number }[];
  return new Set(rows.filter((r) => r.n >= R.REDEMPTIONS_PER_REWARD_PER_DAY).map((r) => r.reward_id));
}

export function listRewards(db: DB, userId: number) {
  const user = db.prepare('SELECT points, eco_score FROM users WHERE id = ?').get(userId) as { points: number; eco_score: number };
  const today = redeemedTodayIds(db, userId);
  const rows = db.prepare(`${REWARD_SELECT} ORDER BY m.id, r.points_cost, r.id`).all() as RewardRow[];

  return rows.map((r) => {
    const locked = user.eco_score < r.min_eco_score;
    const affordable = user.points >= r.points_cost;
    const lock_reason: LockReason = locked ? 'eco_score_too_low' : !affordable ? 'not_enough_points' : null;
    return {
      id: r.id,
      title: r.title,
      points_cost: r.points_cost,
      min_eco_score: r.min_eco_score,
      locked,
      affordable,
      lock_reason,
      points_needed: Math.max(0, r.points_cost - user.points),
      eco_needed: Math.max(0, r.min_eco_score - user.eco_score),
      redeemed_today: today.has(r.id),
      merchant: {
        id: r.merchant_id,
        name: r.merchant_name,
        category: r.merchant_category,
        address: r.merchant_address,
        lat: r.merchant_lat,
        lng: r.merchant_lng,
      },
    };
  });
}

export function newRedemptionCode(): string {
  const groups = Array.from({ length: R.REDEMPTION_CODE_GROUPS }, () =>
    Array.from({ length: R.REDEMPTION_CODE_GROUP_LENGTH }, () => R.REDEMPTION_CODE_ALPHABET[randomInt(R.REDEMPTION_CODE_ALPHABET.length)]).join(''),
  );
  return [R.REDEMPTION_CODE_PREFIX, ...groups].join('-');
}

export type RedeemOk = {
  redemption: { id: number; reward_id: number; title: string; merchant_name: string; points_spent: number; code: string; redeemed_at: string };
  user: { points: number };
};
export type RedeemError = { status: 403 | 404 | 409; body: { error: { code: string; message: string } } & Record<string, unknown> };

const fail = (status: RedeemError['status'], code: string, message: string, extra: Record<string, unknown> = {}): RedeemError => ({
  status,
  body: { error: { code, message }, ...extra },
});

/** Check, deduct and record, all in one transaction. Checks: unknown reward, eco lock, daily limit, points. */
export function redeemReward(db: DB, userId: number, rewardId: number): RedeemOk | RedeemError {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return db.transaction((): RedeemOk | RedeemError => {
        const reward = db.prepare(`${REWARD_SELECT} WHERE r.id = ?`).get(rewardId) as RewardRow | undefined;
        if (!reward) return fail(404, 'not_found', `No reward ${rewardId}`);

        const user = db.prepare('SELECT points, eco_score FROM users WHERE id = ?').get(userId) as { points: number; eco_score: number };
        if (user.eco_score < reward.min_eco_score) {
          return fail(403, 'eco_score_too_low', `This reward needs an eco score of ${reward.min_eco_score}; yours is ${user.eco_score}`, {
            min_eco_score: reward.min_eco_score,
            eco_score: user.eco_score,
          });
        }

        const [from, to] = torontoDayRangeUtc(torontoDate());
        const { n } = db
          .prepare('SELECT COUNT(*) AS n FROM redemptions WHERE user_id = ? AND reward_id = ? AND redeemed_at >= ? AND redeemed_at < ?')
          .get(userId, rewardId, from, to) as { n: number };
        if (n >= R.REDEMPTIONS_PER_REWARD_PER_DAY) {
          return fail(409, 'already_redeemed_today', 'You already redeemed this reward today. Try again tomorrow.');
        }

        if (user.points < reward.points_cost) {
          return fail(409, 'not_enough_points', `This reward costs ${reward.points_cost} points; you have ${user.points}`, {
            points_cost: reward.points_cost,
            points: user.points,
          });
        }

        const code = newRedemptionCode();
        const redeemedAt = new Date().toISOString();
        db.prepare('UPDATE users SET points = points - ? WHERE id = ?').run(reward.points_cost, userId);
        const { lastInsertRowid } = db
          .prepare('INSERT INTO redemptions (user_id, reward_id, points_spent, code, redeemed_at) VALUES (?, ?, ?, ?, ?)')
          .run(userId, rewardId, reward.points_cost, code, redeemedAt);

        return {
          redemption: {
            id: Number(lastInsertRowid),
            reward_id: rewardId,
            title: reward.title,
            merchant_name: reward.merchant_name,
            points_spent: reward.points_cost,
            code,
            redeemed_at: redeemedAt,
          },
          user: { points: user.points - reward.points_cost },
        };
      })();
    } catch (err) {
      // A clash on the unique code: the transaction rolled back, so just try a new code.
      if ((err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE' && String(err).includes('redemptions.code')) continue;
      throw err;
    }
  }
  throw new Error('could not generate a unique redemption code');
}

export function listRedemptions(db: DB, userId: number) {
  return db
    .prepare(
      `SELECT d.id, d.reward_id, r.title, m.name AS merchant_name, d.points_spent, d.code, d.redeemed_at
       FROM redemptions d JOIN rewards r ON r.id = d.reward_id JOIN merchants m ON m.id = r.merchant_id
       WHERE d.user_id = ? ORDER BY d.redeemed_at DESC, d.id DESC LIMIT 100`,
    )
    .all(userId);
}
