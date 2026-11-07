import { Hono } from 'hono';
import type { CurrentUserEnv } from '../currentUser.js';
import type { DB } from '../db.js';
import * as R from '../rules.js';
import { bad, idParam, isObj, jsonBody, notFound } from './http.js';

type Location = { id: number; kind: R.LocationKind; label: string; lat: number; lng: number };

/** Home first, then favourites in the order they were added. */
export function listLocations(db: DB, userId: number): Location[] {
  return db
    .prepare("SELECT id, kind, label, lat, lng FROM saved_locations WHERE user_id = ? ORDER BY kind = 'home' DESC, id")
    .all(userId) as Location[];
}

export function locationRoutes(db: DB) {
  const r = new Hono<CurrentUserEnv>();

  r.get('/locations', (c) => c.json({ locations: listLocations(db, c.get('userId')) }));

  // Add a location. A new home replaces the old one (at most one home per user).
  r.post('/locations', async (c) => {
    const body = await jsonBody(c);
    if (!isObj(body)) return bad(c, 'body must be a JSON object');
    const { kind, label, lat, lng } = body;
    if (typeof kind !== 'string' || !R.LOCATION_KINDS.includes(kind as R.LocationKind)) return bad(c, `kind must be one of: ${R.LOCATION_KINDS.join(', ')}`);
    if (typeof label !== 'string' || label.trim().length === 0 || label.trim().length > R.LOCATION_LABEL_MAX) {
      return bad(c, `label must be 1 to ${R.LOCATION_LABEL_MAX} characters`);
    }
    if (typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90) return bad(c, 'lat must be a number between -90 and 90');
    if (typeof lng !== 'number' || !Number.isFinite(lng) || lng < -180 || lng > 180) return bad(c, 'lng must be a number between -180 and 180');

    const userId = c.get('userId');
    const result = db.transaction(() => {
      let replacedId: number | null = null;
      if (kind === 'home') {
        const old = db.prepare("SELECT id FROM saved_locations WHERE user_id = ? AND kind = 'home'").get(userId) as { id: number } | undefined;
        if (old) {
          db.prepare('DELETE FROM saved_locations WHERE id = ?').run(old.id);
          replacedId = old.id;
        }
      } else {
        const { n } = db.prepare("SELECT COUNT(*) AS n FROM saved_locations WHERE user_id = ? AND kind = 'favourite'").get(userId) as { n: number };
        if (n >= R.MAX_FAVOURITES) return null;
      }
      const { lastInsertRowid } = db.prepare('INSERT INTO saved_locations (user_id, kind, label, lat, lng) VALUES (?, ?, ?, ?, ?)').run(userId, kind, label.trim(), lat, lng);
      return { location: { id: Number(lastInsertRowid), kind, label: label.trim(), lat, lng }, replaced_id: replacedId };
    })();

    if (!result) return c.json({ error: { code: 'too_many_favourites', message: `At most ${R.MAX_FAVOURITES} favourites` } }, 409);
    return c.json(result, 201);
  });

  r.delete('/locations/:id', (c) => {
    const id = idParam(c);
    const { changes } = id === null ? { changes: 0 } : db.prepare('DELETE FROM saved_locations WHERE id = ? AND user_id = ?').run(id, c.get('userId'));
    if (changes === 0) return notFound(c, 'location', c.req.param('id'));
    return c.body(null, 204);
  });

  return r;
}
