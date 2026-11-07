// Trip scoring: GPS points in, distance + confidence + flags out.
// Pure function, no database access. All numbers come from ./config.ts.

import { haversineKm, haversineM, type LatLng } from '../geo.js';
import * as C from './config.js';
import type { Mode } from './config.js';

export type GpsPoint = { lat: number; lng: number; accuracy: number | null; timestamp: string };

export type ScoreInput = {
  mode: Mode;
  points: GpsPoint[];
  /** Where and when the user's previous finished trip ended, if any. */
  previousTrip: { lat: number; lng: number; ended_at: string } | null;
  /** Distance to the nearest GRT stop in metres, or null if stop data is unavailable. */
  nearestStopMeters: (lat: number, lng: number) => number | null;
};

export type Flag = keyof typeof C.PENALTIES | 'stop_check_unavailable';

export type ScoreResult = {
  /** Distance that counts: no jumps, nothing faster than the mode allows. */
  verified_km: number;
  /** null for car trips (not checked). */
  confidence: number | null;
  flags: Flag[];
  stats: {
    points_received: number;
    points_used: number; // after dropping bad accuracy
    segments: number;
    jumps: number;
    avg_speed_kmh: number | null;
  };
};

type P = { ll: LatLng; t: number; acc: number | null };
type Segment = { distKm: number; dtSec: number; kmh: number; jump: boolean };

const round = (n: number, dp: number) => Math.round(n * 10 ** dp) / 10 ** dp;

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export function scoreTrip(input: ScoreInput): ScoreResult {
  const { mode } = input;
  const flags = new Set<Flag>();

  // 1. Sort, drop bad accuracy, drop duplicate timestamps.
  const sorted: P[] = input.points
    .map((p) => ({ ll: [p.lat, p.lng] as LatLng, t: Date.parse(p.timestamp), acc: p.accuracy }))
    .filter((p) => Number.isFinite(p.t))
    .sort((a, b) => a.t - b.t);
  const usable = sorted.filter((p, i) => (p.acc === null || p.acc <= C.MAX_ACCURACY_M) && (i === 0 || p.t !== sorted[i - 1]!.t));
  const dropped = sorted.length - usable.length;

  // 2. Ignore jitter: a point only counts as movement if it is MIN_MOVE_M from the last counted one.
  const moved: P[] = [];
  for (const p of usable) {
    const last = moved[moved.length - 1];
    if (!last || haversineM(last.ll, p.ll) >= C.MIN_MOVE_M) moved.push(p);
  }

  // 3. Segments. Car trips use the most generous jump limit (transit's) just to drop GPS glitches.
  const limits = mode === 'car' ? null : C.SPEED_LIMITS[mode];
  const jumpKmh = limits?.jumpKmh ?? C.SPEED_LIMITS.transit.jumpKmh;
  const segments: Segment[] = [];
  for (let i = 1; i < moved.length; i++) {
    const a = moved[i - 1]!, b = moved[i]!;
    const distKm = haversineKm(a.ll, b.ll);
    const dtSec = (b.t - a.t) / 1000;
    const kmh = dtSec > 0 ? distKm / (dtSec / 3600) : Infinity;
    // A gap alone is fine; it only counts when the position jumps impossibly far for the time.
    const jump = distKm * 1000 >= C.JUMP_MIN_DISTANCE_M && kmh > jumpKmh;
    segments.push({ distKm, dtSec, kmh, jump });
  }
  const jumps = segments.filter((s) => s.jump).length;
  const real = segments.filter((s) => !s.jump && s.dtSec > 0);
  const realKm = real.reduce((sum, s) => sum + s.distKm, 0);
  const realSec = real.reduce((sum, s) => sum + s.dtSec, 0);
  const avgKmh = realSec > 0 ? realKm / (realSec / 3600) : null;

  const stats = {
    points_received: input.points.length,
    points_used: usable.length,
    segments: segments.length,
    jumps,
    avg_speed_kmh: avgKmh === null ? null : round(avgKmh, 1),
  };

  // Car trips: measured (the eco penalty needs km) but not checked.
  if (mode === 'car' || !limits) {
    return { verified_km: round(realKm, 3), confidence: null, flags: [], stats };
  }

  // 4. Verified km: no jumps, and nothing faster than the mode's burst limit (e.g. car stretches of a "walk").
  const maxCountedKmh = limits.carBurstKmh ?? limits.jumpKmh;
  const verifiedKm = real.filter((s) => s.kmh <= maxCountedKmh).reduce((sum, s) => sum + s.distKm, 0);

  // 5. Checks.
  if (avgKmh !== null && avgKmh > limits.avgMaxKmh) flags.add('speed_too_high');

  if (limits.carBurstKmh !== null && hasCarLikeBurst(moved, segments, limits.carBurstKmh)) flags.add('car_like_burst');

  if (jumps > 0) flags.add('impossible_jump');

  if (usable.length < C.MIN_POINTS) flags.add('too_few_points');

  const medianAcc = median(usable.flatMap((p) => (p.acc === null ? [] : [p.acc])));
  if ((sorted.length > 0 && dropped / sorted.length > C.POOR_ACCURACY_DROPPED_SHARE) || (medianAcc !== null && medianAcc > C.POOR_ACCURACY_MEDIAN_M)) {
    flags.add('poor_accuracy');
  }

  const speeds = real.filter((s) => s.distKm > 0).map((s) => s.kmh);
  if (speeds.length >= C.CONSTANT_SPEED_MIN_SEGMENTS) {
    const mean = speeds.reduce((a, b) => a + b, 0) / speeds.length;
    const sd = Math.sqrt(speeds.reduce((a, b) => a + (b - mean) ** 2, 0) / speeds.length);
    if (mean > 0 && sd / mean < C.CONSTANT_SPEED_MAX_CV) flags.add('constant_speed');
  }

  const first = usable[0], last = usable[usable.length - 1];
  const prev = input.previousTrip;
  if (first && prev) {
    const minutesSince = (first.t - Date.parse(prev.ended_at)) / 60_000;
    if (minutesSince < C.FAR_START_WINDOW_MIN && haversineKm([prev.lat, prev.lng], first.ll) > C.FAR_START_KM) {
      flags.add('far_from_last_trip');
    }
  }

  if (mode === 'transit' && first && last) {
    const startM = input.nearestStopMeters(first.ll[0], first.ll[1]);
    const endM = input.nearestStopMeters(last.ll[0], last.ll[1]);
    if (startM === null || endM === null) flags.add('stop_check_unavailable'); // no penalty
    else {
      if (startM > C.STOP_RADIUS_M) flags.add('transit_start_not_near_stop');
      if (endM > C.STOP_RADIUS_M) flags.add('transit_end_not_near_stop');
    }
  }

  // 6. Confidence.
  let confidence = 1;
  for (const f of flags) if (f in C.PENALTIES) confidence -= C.PENALTIES[f as keyof typeof C.PENALTIES];
  confidence = round(Math.max(0, confidence), 2);

  return { verified_km: round(verifiedKm, 3), confidence, flags: [...flags], stats };
}

// Any rolling window of at least BURST_WINDOW_SEC whose average speed exceeds the
// threshold. Jump segments contribute no distance so a teleport isn't a "burst".
function hasCarLikeBurst(points: P[], segments: Segment[], thresholdKmh: number): boolean {
  const cumKm = [0];
  for (const s of segments) cumKm.push(cumKm[cumKm.length - 1]! + (s.jump ? 0 : s.distKm));

  let j = 0;
  for (let i = 0; i < points.length; i++) {
    if (j < i) j = i;
    while (j < points.length && (points[j]!.t - points[i]!.t) / 1000 < C.BURST_WINDOW_SEC) j++;
    if (j >= points.length) break;
    const hours = (points[j]!.t - points[i]!.t) / 3_600_000;
    if (hours > 0 && (cumKm[j]! - cumKm[i]!) / hours > thresholdKmh) return true;
  }
  return false;
}
