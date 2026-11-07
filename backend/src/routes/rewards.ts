import { Hono } from 'hono';
import type { CurrentUserEnv } from '../currentUser.js';
import type { DB } from '../db.js';
import { listRedemptions, listRewards, redeemReward } from '../rewards/redeem.js';
import { idParam, notFound } from './http.js';

export function rewardRoutes(db: DB) {
  const r = new Hono<CurrentUserEnv>();

  r.get('/rewards', (c) => c.json({ rewards: listRewards(db, c.get('userId')) }));

  r.post('/rewards/:id/redeem', (c) => {
    const rewardId = idParam(c);
    if (rewardId === null) return notFound(c, 'reward', c.req.param('id'));
    const result = redeemReward(db, c.get('userId'), rewardId);
    if ('status' in result) return c.json(result.body, result.status);
    return c.json(result, 201);
  });

  r.get('/redemptions', (c) => c.json({ redemptions: listRedemptions(db, c.get('userId')) }));

  return r;
}
