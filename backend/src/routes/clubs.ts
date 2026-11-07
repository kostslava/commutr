import { Hono } from 'hono';
import { clubMembers, clubSummaries } from '../clubs/progress.js';
import type { CurrentUserEnv } from '../currentUser.js';
import type { DB } from '../db.js';
import { torontoWeekStart } from '../time.js';
import { idParam, notFound } from './http.js';

export function clubRoutes(db: DB) {
  const r = new Hono<CurrentUserEnv>();

  r.get('/clubs', (c) => c.json({ clubs: clubSummaries(db, c.get('userId')) }));

  r.get('/clubs/:id', (c) => {
    const clubId = idParam(c);
    const club = clubId === null ? undefined : clubSummaries(db, c.get('userId'), clubId)[0];
    if (!club) return notFound(c, 'club', c.req.param('id'));
    return c.json({ ...club, members: clubMembers(db, club.id) });
  });

  // Join: idempotent. A new member starts at 0 steps this week (earlier walks don't count).
  r.post('/clubs/:id/join', (c) => {
    const clubId = idParam(c);
    if (clubId === null || !db.prepare('SELECT 1 FROM clubs WHERE id = ?').get(clubId)) return notFound(c, 'club', c.req.param('id'));
    db.prepare('INSERT OR IGNORE INTO club_members (club_id, user_id, joined_at, steps_this_week, week_start) VALUES (?, ?, ?, 0, ?)').run(
      clubId,
      c.get('userId'),
      new Date().toISOString(),
      torontoWeekStart(),
    );
    return c.json({ club_id: clubId, joined: true, club: clubSummaries(db, c.get('userId'), clubId)[0] });
  });

  // Leave: idempotent. The member's steps leave the club total.
  r.post('/clubs/:id/leave', (c) => {
    const clubId = idParam(c);
    if (clubId === null || !db.prepare('SELECT 1 FROM clubs WHERE id = ?').get(clubId)) return notFound(c, 'club', c.req.param('id'));
    db.prepare('DELETE FROM club_members WHERE club_id = ? AND user_id = ?').run(clubId, c.get('userId'));
    return c.json({ club_id: clubId, left: true, club: clubSummaries(db, c.get('userId'), clubId)[0] });
  });

  return r;
}
