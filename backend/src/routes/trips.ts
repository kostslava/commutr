import { Hono } from 'hono';
import type { CurrentUserEnv } from '../currentUser.js';
import type { DB } from '../db.js';
import { finishTrip } from '../scoring/apply.js';
import * as C from '../scoring/config.js';
import type { Mode } from '../scoring/config.js';
import { bad, idParam, isObj, jsonBody, notFound as notFoundOf } from './http.js';
import {demoDistances,evidenceRoutes,finishDemoTrip} from './tripEvidence.js';

// Test-only: lets POST /api/trips take a past `started_at`, so scripts can replay
// realistic trips through the real endpoints. Refused in production (see index.ts).
export const ALLOW_BACKDATED = process.env.SCORING_ALLOW_BACKDATED === '1';

type TripRow = {
  id: number;
  mode: Mode;
  status: 'active' | 'finished';
  started_at: string;
  ended_at: string | null;
  distance_km: number | null;
  confidence: number | null;
  points_awarded: number | null;
  flags: string;
  demo?: number;
  evidence_submitted?: number;
};

const TRIP_COLUMNS = 'id, mode, status, started_at, ended_at, distance_km, confidence, points_awarded, flags, demo, demo_destination, (SELECT COUNT(*) FROM trip_evidence WHERE trip_id=trips.id) AS evidence_submitted';
const tripJson = (t: TripRow) => ({ ...t, demo:Boolean(t.demo),evidence_status:t.evidence_submitted?'submitted':'none',flags: JSON.parse(t.flags) as string[] });

const notFound = (c: Parameters<typeof notFoundOf>[0], id: unknown) => notFoundOf(c, 'trip', id);

export function tripRoutes(db: DB) {
  const r = new Hono<CurrentUserEnv>();
  r.route('/',evidenceRoutes(db));

  // Start a trip. The user picks the mode first.
  r.post('/trips', async (c) => {
    const body = await jsonBody(c);
    if (!isObj(body) || typeof body.mode !== 'string' || !C.MODES.includes(body.mode as Mode)) {
      return bad(c, `mode must be one of: ${C.MODES.join(', ')}`);
    }
    const userId = c.get('userId');
    const demo=body.demo===true;
    const distance=typeof body.demo_destination==='string'?demoDistances[body.demo_destination]:undefined;
    if(demo){
      if(process.env.NODE_ENV==='production'&&process.env.DEMO_TRIPS_ENABLED!=='1')return c.json({error:{code:'demo_disabled',message:'Demo trips are disabled on this server.'}},403);
      if(!['walk','bike','transit'].includes(body.mode)||distance===undefined)return bad(c,'Choose a suggested destination and walk, bike, or transit for a demo trip.');
    }

    let startedAt = new Date().toISOString();
    if (body.started_at !== undefined) {
      if (!ALLOW_BACKDATED) return bad(c, 'started_at is not accepted (the server sets it)');
      const t = typeof body.started_at === 'string' ? Date.parse(body.started_at) : NaN;
      if (!Number.isFinite(t) || t > Date.now()) return bad(c, 'started_at must be a past ISO 8601 time');
      startedAt = new Date(t).toISOString();
    }

    const active = db.prepare("SELECT id FROM trips WHERE user_id = ? AND status = 'active'").get(userId) as { id: number } | undefined;
    if (active) {
      return c.json({ error: { code: 'trip_already_active', message: 'Finish the active trip first' }, active_trip_id: active.id }, 409);
    }

    const { lastInsertRowid } = db.prepare("INSERT INTO trips (user_id, mode, status, started_at, demo, demo_destination, demo_distance) VALUES (?, ?, 'active', ?, ?, ?, ?)").run(userId, body.mode, startedAt,demo?1:0,demo?body.demo_destination:null,demo?distance:null);
    return c.json({ id: Number(lastInsertRowid), mode: body.mode, status: 'active', started_at: startedAt,demo,demo_destination:demo?body.demo_destination:null }, 201);
  });

  // Add a batch of GPS points. Malformed points fail the request (400); points
  // outside the trip's time window are skipped and counted as `rejected`.
  r.post('/trips/:id/points', async (c) => {
    const tripId = idParam(c);
    if (tripId === null) return notFound(c, c.req.param('id'));
    const demo=db.prepare('SELECT demo FROM trips WHERE id=? AND user_id=?').get(tripId,c.get('userId')) as {demo:number}|undefined;
    if(demo?.demo)return bad(c,'Demo trips use photo evidence, not GPS samples.');
    const trip = db.prepare('SELECT status, started_at FROM trips WHERE id = ? AND user_id = ?').get(tripId, c.get('userId')) as
      | { status: string; started_at: string }
      | undefined;
    if (!trip) return notFound(c, tripId);
    if (trip.status !== 'active') return c.json({ error: { code: 'trip_not_active', message: `Trip ${tripId} is already finished` } }, 409);

    const body = await jsonBody(c);
    if (!isObj(body) || !Array.isArray(body.points) || body.points.length === 0) return bad(c, 'points must be a non-empty array');
    if (body.points.length > C.MAX_POINTS_PER_BATCH) return bad(c, `at most ${C.MAX_POINTS_PER_BATCH} points per request`);

    const parsed: { lat: number; lng: number; accuracy: number | null; t: number }[] = [];
    for (const [i, p] of body.points.entries()) {
      if (!isObj(p)) return bad(c, `points[${i}] must be an object`);
      const { lat, lng, accuracy, timestamp } = p;
      if (typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90) return bad(c, `points[${i}].lat must be a number between -90 and 90`);
      if (typeof lng !== 'number' || !Number.isFinite(lng) || lng < -180 || lng > 180) return bad(c, `points[${i}].lng must be a number between -180 and 180`);
      if (accuracy !== undefined && accuracy !== null && (typeof accuracy !== 'number' || !Number.isFinite(accuracy) || accuracy < 0)) {
        return bad(c, `points[${i}].accuracy must be a non-negative number or null`);
      }
      const t = typeof timestamp === 'string' ? Date.parse(timestamp) : NaN;
      if (!Number.isFinite(t)) return bad(c, `points[${i}].timestamp must be an ISO 8601 time`);
      parsed.push({ lat, lng, accuracy: (accuracy as number | null | undefined) ?? null, t });
    }

    const slackMs = C.CLOCK_SLACK_SEC * 1000;
    const earliest = Date.parse(trip.started_at) - slackMs;
    const latest = Date.now() + slackMs;
    const { n: stored } = db.prepare('SELECT COUNT(*) AS n FROM trip_points WHERE trip_id = ?').get(tripId) as { n: number };
    const room = Math.max(0, C.MAX_POINTS_PER_TRIP - stored);

    const inWindow = parsed.filter((p) => p.t >= earliest && p.t <= latest);
    const toStore = inWindow.slice(0, room);
    const insert = db.prepare('INSERT INTO trip_points (trip_id, lat, lng, accuracy, timestamp) VALUES (?, ?, ?, ?, ?)');
    db.transaction(() => {
      for (const p of toStore) insert.run(tripId, p.lat, p.lng, p.accuracy, new Date(p.t).toISOString());
    })();

    return c.json({ trip_id: tripId, accepted: toStore.length, rejected: parsed.length - toStore.length, total_points: stored + toStore.length });
  });

  // Finish and score.
  r.post('/trips/:id/finish', (c) => {
    const tripId = idParam(c);
    if (tripId === null) return notFound(c, c.req.param('id'));
    const demo=db.prepare('SELECT demo FROM trips WHERE id=? AND user_id=?').get(tripId,c.get('userId')) as {demo:number}|undefined;
    if(demo?.demo){const result=finishDemoTrip(db,c.get('userId'),tripId);if('error' in result)return c.json({error:result.error},result.status);return c.json(result)}
    // Normally the trip ends now. In test mode (backdated trips) it ends at its last point.
    const endedAt = (points: { timestamp: string }[]) =>
      ALLOW_BACKDATED && points.length ? points[points.length - 1]!.timestamp : new Date().toISOString();

    const result = finishTrip(db, c.get('userId'), tripId, endedAt);
    if ('code' in result) return c.json({ error: { code: result.code, message: result.message } }, result.status);
    return c.json(result);
  });

  // My trips, newest first.
  r.get('/trips', (c) => {
    const raw = c.req.query('limit');
    const limit = raw === undefined ? 20 : Number(raw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return bad(c, 'limit must be an integer from 1 to 100');
    const rows = db.prepare(`SELECT ${TRIP_COLUMNS} FROM trips WHERE user_id = ? ORDER BY started_at DESC, id DESC LIMIT ?`).all(c.get('userId'), limit) as TripRow[];
    return c.json({ trips: rows.map(tripJson) });
  });

  // One trip with its GPS path.
  r.get('/trips/:id', (c) => {
    const tripId = idParam(c);
    if (tripId === null) return notFound(c, c.req.param('id'));
    const trip = db.prepare(`SELECT ${TRIP_COLUMNS} FROM trips WHERE id = ? AND user_id = ?`).get(tripId, c.get('userId')) as TripRow | undefined;
    if (!trip) return notFound(c, tripId);
    const points = db.prepare('SELECT lat, lng, accuracy, timestamp FROM trip_points WHERE trip_id = ? ORDER BY timestamp, id').all(tripId);
    const evidence=db.prepare('SELECT submitted_at FROM trip_evidence WHERE trip_id=?').get(tripId);
    return c.json({ ...tripJson(trip), points,evidence_status:evidence?'submitted':'none' });
  });

  return r;
}
