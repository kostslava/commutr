// POST /api/companion/route-safety: the precomputed street-photo safety rating for a
// demo route. Reads backend/src/safety/ratings.json only; never calls Gemini or Mapillary
// at request time. See docs/api.md.

import { Hono } from 'hono';
import type { DB } from '../db.js';
import type { CurrentUserEnv } from '../currentUser.js';
import { takeUserRequest } from '../chat/usage.js';
import { validLatLng } from '../planner/places.js';
import { findRoute, loadRatings, type PlaceQuery } from '../safety/match.js';
import { MAPILLARY_ATTRIBUTION, type SavedRoute } from '../safety/rating.js';
import { bad, isObj, jsonBody } from './http.js';

const HOME_WORDS = new Set(['home', 'my home', 'my place', 'my house', 'your saved home']);

/** A place in the request: a name (1-200 chars) or {lat, lng}. undefined = invalid. */
function parsePlace(v: unknown): PlaceQuery | undefined {
  if (typeof v === 'string') return v.trim() && v.length <= 200 ? v.trim() : undefined;
  if (isObj(v) && validLatLng(v.lat, v.lng)) return { lat: v.lat as number, lng: v.lng as number };
  return undefined;
}

function homeOf(db: DB, userId: number): PlaceQuery | null {
  const home = db.prepare("SELECT lat, lng FROM saved_locations WHERE user_id = ? AND kind = 'home'").get(userId) as { lat: number; lng: number } | undefined;
  return home ? { lat: home.lat, lng: home.lng } : null;
}

const years = (r: SavedRoute) => {
  const a = r.photos.captured_from?.slice(0, 4), b = r.photos.captured_to?.slice(0, 4);
  return a && b ? (a === b ? a : `${a}–${b}`) : null;
};

export function found(r: SavedRoute) {
  const span = years(r);
  return {
    available: true,
    route: { id: r.id, from: r.from.name, to: r.to.name, km: r.km },
    rating: r.rating,
    summary: r.rating.summary,
    photos: { count: r.photos.count, captured_from: r.photos.captured_from, captured_to: r.photos.captured_to },
    note: `Based on ${r.photos.count} street photo${r.photos.count === 1 ? '' : 's'}${span ? ` from ${span}` : ''}, rated by Gemini. Conditions change; this isn't a safety guarantee.`,
    attribution: [MAPILLARY_ATTRIBUTION, ...(r.photos.creators.length ? [`Photos by: ${r.photos.creators.join(', ')}`] : [])],
    generated_at: r.generated_at,
  };
}

export function safetyRoutes(db: DB) {
  const r = new Hono<CurrentUserEnv>();
  r.post('/companion/route-safety', async (c) => {
    const body = await jsonBody(c);
    if (!isObj(body)) return bad(c, 'Send a destination (a place name or {lat, lng}) and an optional origin');
    const destination = parsePlace(body.destination);
    if (destination === undefined) return bad(c, 'destination must be a place name (1–200 characters) or {lat, lng}');
    let origin: PlaceQuery | null | undefined = body.origin === undefined ? null : parsePlace(body.origin);
    if (origin === undefined) return bad(c, 'origin must be a place name (1–200 characters) or {lat, lng}');

    const userId = c.get('userId');
    const limit = takeUserRequest('safety', userId);
    if (!limit.ok) return c.json({ error: { code: 'rate_limited', message: 'Too many route safety checks. Try again soon.' }, retry_after_sec: limit.retryAfterSec }, 429);

    if (origin === null || (typeof origin === 'string' && HOME_WORDS.has(origin.toLowerCase()))) {
      origin = homeOf(db, userId);
      if (!origin) return c.json({ error: { code: 'no_origin', message: 'Where are you starting from?' } }, 400);
    }

    const ratings = loadRatings();
    if (!ratings) {
      return c.json({ available: false, code: 'not_generated', summary: "Route safety ratings aren't available yet." });
    }
    const route = findRoute(ratings.routes, origin, destination);
    if (!route) {
      return c.json({
        available: false,
        code: 'no_route_data',
        summary: "I don't have street photo data for that route yet.",
        rated_routes: ratings.routes.map((x) => ({ from: x.from.name, to: x.to.name })),
      });
    }
    return c.json(found(route));
  });
  return r;
}
