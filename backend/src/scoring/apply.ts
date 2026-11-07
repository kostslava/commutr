// Finishing a trip: score it, then apply every side effect in ONE transaction:
// trip row, user points (with the daily cap), trust multiplier, eco score,
// streak and club steps. Numbers come from ./config.ts.

import type { DB } from '../db.js';
import { addDays, torontoDate, torontoDayRangeUtc, torontoWeekStart } from '../time.js';
import { nearestStopMeters } from '../transit/staticGtfs.js';
import * as C from './config.js';
import type { Mode } from './config.js';
import { scoreTrip, type Flag, type GpsPoint } from './score.js';

export type FinishResult = {
  trip: {
    id: number;
    mode: Mode;
    status: 'finished';
    started_at: string;
    ended_at: string;
    distance_km: number;
    confidence: number | null;
    points_awarded: number;
    capped: boolean;
    flags: Flag[];
  };
  user: { points: number; eco_score: number };
  streak: { current_days: number; longest_days: number; last_active_date: string | null };
  steps_added: number;
};

export type FinishError = { status: 404 | 409; code: 'not_found' | 'trip_not_active'; message: string };

type TripRow = { id: number; user_id: number; mode: Mode; status: string; started_at: string };
type UserRow = { points: number; eco_score: number; trust_multiplier: number };
type StreakRow = { current_days: number; longest_days: number; last_active_date: string | null };

const round2 = (n: number) => Math.round(n * 100) / 100;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * @param endedAt when the trip ended (normally "now"; the test mode passes the last point's time)
 */
export function finishTrip(db: DB, userId: number, tripId: number, endedAt: (points: GpsPoint[]) => string): FinishResult | FinishError {
  return db.transaction((): FinishResult | FinishError => {
    const trip = db.prepare('SELECT id, user_id, mode, status, started_at FROM trips WHERE id = ? AND user_id = ?').get(tripId, userId) as TripRow | undefined;
    if (!trip) return { status: 404, code: 'not_found', message: `No trip ${tripId}` };
    if (trip.status !== 'active') return { status: 409, code: 'trip_not_active', message: `Trip ${tripId} is already finished` };

    const points = db.prepare('SELECT lat, lng, accuracy, timestamp FROM trip_points WHERE trip_id = ? ORDER BY timestamp, id').all(tripId) as GpsPoint[];
    const ended_at = endedAt(points);

    // Previous finished trip: where (its last GPS point) and when it ended.
    const prev = db
      .prepare(
        `SELECT t.ended_at, p.lat, p.lng FROM trips t
         JOIN trip_points p ON p.trip_id = t.id
         WHERE t.user_id = ? AND t.status = 'finished' AND t.id != ?
         ORDER BY t.ended_at DESC, p.timestamp DESC LIMIT 1`,
      )
      .get(userId, tripId) as { ended_at: string; lat: number; lng: number } | undefined;

    const score = scoreTrip({ mode: trip.mode, points, previousTrip: prev ?? null, nearestStopMeters });
    const { confidence, verified_km: km } = score;
    const isCar = trip.mode === 'car';
    const lowConfidence = confidence !== null && confidence < C.LOW_CONFIDENCE;
    const green = !isCar && !lowConfidence; // counts for streaks, steps, eco recovery

    const user = db.prepare('SELECT points, eco_score, trust_multiplier FROM users WHERE id = ?').get(userId) as UserRow;
    const today = torontoDate(ended_at);
    const [dayStart, dayEnd] = torontoDayRangeUtc(today);

    // --- Points with the daily cap ---------------------------------------------
    const rawPoints = isCar || lowConfidence || confidence === null ? 0 : Math.round(km * C.MODE_RATES[trip.mode] * confidence * user.trust_multiplier);
    const { used } = db
      .prepare(`SELECT COALESCE(SUM(points_awarded), 0) AS used FROM trips WHERE user_id = ? AND status = 'finished' AND ended_at >= ? AND ended_at < ?`)
      .get(userId, dayStart, dayEnd) as { used: number };
    const pointsAwarded = Math.min(rawPoints, Math.max(0, C.DAILY_POINTS_CAP - used));

    // --- Trust multiplier -------------------------------------------------------
    let trust = user.trust_multiplier;
    if (lowConfidence) trust = Math.max(C.TRUST_FLOOR, trust - C.TRUST_DROP);
    else if (!isCar && confidence !== null && confidence >= C.CLEAN_TRIP_CONFIDENCE && km >= C.CLEAN_TRIP_MIN_KM) trust = Math.min(1, trust + C.TRUST_RECOVERY);
    trust = round2(trust);
    const trustDelta = round2(trust - user.trust_multiplier);

    // --- Eco score --------------------------------------------------------------
    let ecoDelta = 0;
    if (isCar) {
      ecoDelta = -clamp(Math.round(km * C.ECO_PENALTY_PER_CAR_KM), C.ECO_PENALTY_MIN, C.ECO_PENALTY_MAX);
    } else if (green && km >= C.ECO_RECOVERY_MIN_KM) {
      const { gained } = db
        .prepare(`SELECT COALESCE(SUM(eco_delta), 0) AS gained FROM trips WHERE user_id = ? AND eco_delta > 0 AND ended_at >= ? AND ended_at < ?`)
        .get(userId, dayStart, dayEnd) as { gained: number };
      ecoDelta = Math.min(C.ECO_RECOVERY_PER_TRIP, Math.max(0, C.ECO_RECOVERY_MAX_PER_DAY - gained));
    }
    const ecoScore = clamp(user.eco_score + ecoDelta, 0, 100);
    ecoDelta = ecoScore - user.eco_score; // what was actually applied (e.g. already at 100)

    db.prepare('UPDATE users SET points = points + ?, trust_multiplier = ?, eco_score = ? WHERE id = ?').run(pointsAwarded, trust, ecoScore, userId);

    // --- Streak -----------------------------------------------------------------
    let streak = (db.prepare('SELECT current_days, longest_days, last_active_date FROM streaks WHERE user_id = ?').get(userId) as StreakRow | undefined) ?? {
      current_days: 0,
      longest_days: 0,
      last_active_date: null,
    };
    if (green && km >= C.STREAK_MIN_KM && streak.last_active_date !== today) {
      const current = streak.last_active_date === addDays(today, -1) ? streak.current_days + 1 : 1;
      streak = { current_days: current, longest_days: Math.max(streak.longest_days, current), last_active_date: today };
      db.prepare(
        `INSERT INTO streaks (user_id, current_days, longest_days, last_active_date) VALUES (@user_id, @current_days, @longest_days, @last_active_date)
         ON CONFLICT(user_id) DO UPDATE SET current_days = excluded.current_days, longest_days = excluded.longest_days, last_active_date = excluded.last_active_date`,
      ).run({ user_id: userId, ...streak });
    }

    // --- Club steps (walk only, reset when a new Toronto week starts) -------------
    let stepsAdded = 0;
    if (trip.mode === 'walk' && green && km > 0) {
      stepsAdded = Math.round(km * C.STEPS_PER_WALK_KM);
      const week = torontoWeekStart(ended_at);
      db.prepare(
        `UPDATE club_members
         SET steps_this_week = CASE WHEN week_start IS ? THEN steps_this_week ELSE 0 END + ?, week_start = ?
         WHERE user_id = ?`,
      ).run(week, stepsAdded, week, userId);
    }

    // --- Trip row -----------------------------------------------------------------
    db.prepare(
      `UPDATE trips SET status = 'finished', ended_at = ?, distance_km = ?, confidence = ?, points_awarded = ?,
                        flags = ?, eco_delta = ?, trust_delta = ? WHERE id = ?`,
    ).run(ended_at, km, confidence, pointsAwarded, JSON.stringify(score.flags), ecoDelta, trustDelta, tripId);

    return {
      trip: {
        id: trip.id,
        mode: trip.mode,
        status: 'finished',
        started_at: trip.started_at,
        ended_at,
        distance_km: km,
        confidence,
        points_awarded: pointsAwarded,
        capped: pointsAwarded < rawPoints,
        flags: score.flags,
      },
      user: { points: user.points + pointsAwarded, eco_score: ecoScore },
      streak,
      steps_added: stepsAdded,
    };
  })();
}
