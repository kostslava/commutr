// Trip options, computed in code. Every number the planner returns comes from here.
//
//   walk / bike: straight line x detour factor, at a fixed speed
//   transit:     direct GRT routes only. A stop near each end, on the same route
//                shape, in the right order. Ride length is measured along the shape.
//                Next bus: live trip-updates prediction, else an estimate from live
//                vehicle positions, else unknown (a default wait is assumed).
//   points:      the real scoring formula (scoring/apply.ts) with confidence 1.0,
//                the user's trust multiplier and what's left of today's cap.

import { haversineKm, haversineM, bearingDeg, type LatLng } from '../geo.js';
import { capToDaily, tripPoints } from '../scoring/apply.js';
import type { Mode } from '../scoring/config.js';
import type { UserStatus } from '../status.js';
import { getLiveVehicles, type LiveResult } from '../transit/liveVehicles.js';
import { getStaticFeeds, onStaticReload, type Stop } from '../transit/staticGtfs.js';
import { getArrivals, type ArrivalIndex } from '../transit/tripUpdates.js';
import * as P from './config.js';
import type { Origin, Place } from './places.js';

export type PlanMode = 'walk' | 'bike' | 'transit';
export const PLAN_MODES: readonly PlanMode[] = ['walk', 'bike', 'transit'];

export type NextBus = {
  route: string;
  headsign: string | null;
  stop_name: string;
  stop_code: string | null;
  minutes: number;
  arrives_at: string;
  source: 'live' | 'estimate';
};

export type PlanOption = {
  mode: PlanMode;
  minutes: number;
  km: number;
  /** The km the points estimate is based on (transit: the ride only; track it from the stop). */
  points_km: number;
  points_estimate: number;
  /** True when today's daily cap cuts the estimate. */
  points_capped: boolean;
  eco_note: string;
  steps: string[];
  next_bus: NextBus | null;
};

const round1 = (n: number) => Math.round(n * 10) / 10;
const minutesAt = (km: number, kmh: number) => (km / kmh) * 60;

const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
const compass = (a: LatLng, b: LatLng) => COMPASS[Math.round(bearingDeg(a, b) / 45) % 8]!;
/** GRT headsigns repeat the route number ("301 Fairway"): show just "Fairway". */
const towardName = (route: string, headsign: string | null) => (headsign?.startsWith(`${route} `) ? headsign.slice(route.length + 1) : headsign);
const distText = (km: number) => (km < 1 ? `${Math.max(50, Math.round((km * 1000) / 50) * 50)} m` : `${round1(km)} km`);

export function pointsEstimate(mode: Mode, km: number, status: UserStatus) {
  const raw = tripPoints(km, mode, 1.0, status.trust_multiplier);
  const points = capToDaily(raw, status.points_today);
  return { points_estimate: points, points_capped: points < raw };
}

function ecoNote(mode: PlanMode, km: number): string {
  const kg = round1(km * P.CAR_KG_CO2_PER_KM);
  const saved = kg >= 0.1 ? `Saves about ${kg} kg of CO2 compared with driving.` : 'Zero tailpipe emissions.';
  if (mode === 'walk') return `${saved} Walking also counts toward your club's weekly steps.`;
  if (mode === 'bike') return `${saved} No emissions at all on a bike.`;
  return `${saved} A shared bus ride is far greener than driving alone.`;
}

// --- Route shapes, indexed once per static GTFS load -----------------------------

type ShapeInfo = {
  feed: number;
  shape_id: string;
  route_id: string;
  route_name: string;
  headsign: string | null;
  pts: LatLng[];
  /** Cumulative km at each point. */
  cum: number[];
};

let shapeIndex: ShapeInfo[] | null = null;
onStaticReload(() => (shapeIndex = null));

function shapes(): ShapeInfo[] {
  if (shapeIndex) return shapeIndex;
  const out: ShapeInfo[] = [];
  getStaticFeeds().forEach((feed, i) => {
    if (!feed) return;
    const seen = new Set<string>();
    for (const t of feed.trips.values()) {
      if (!t.shape_id || seen.has(t.shape_id)) continue;
      const pts = feed.shapes.get(t.shape_id);
      if (!pts || pts.length < 2) continue;
      seen.add(t.shape_id);
      const route = feed.routes.get(t.route_id);
      const cum = [0];
      for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1]! + haversineKm(pts[k - 1]!, pts[k]!));
      out.push({ feed: i, shape_id: t.shape_id, route_id: t.route_id, route_name: route?.short_name ?? route?.long_name ?? t.route_id, headsign: t.headsign, pts, cum });
    }
  });
  shapeIndex = out;
  return out;
}

/** Nearest position on the shape: distance to it (m) and how far along the shape (km). */
function project(s: ShapeInfo, p: LatLng): { distM: number; alongKm: number } {
  const kx = 111_320 * Math.cos((p[0] * Math.PI) / 180), ky = 110_574;
  let best = { distM: Infinity, alongKm: 0 };
  for (let k = 1; k < s.pts.length; k++) {
    const a = s.pts[k - 1]!, b = s.pts[k]!;
    const ax = (a[1] - p[1]) * kx, ay = (a[0] - p[0]) * ky;
    const bx = (b[1] - p[1]) * kx, by = (b[0] - p[0]) * ky;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, -(ax * dx + ay * dy) / len2));
    const d = Math.hypot(ax + t * dx, ay + t * dy);
    if (d < best.distM) best = { distM: d, alongKm: s.cum[k - 1]! + t * (s.cum[k]! - s.cum[k - 1]!) };
  }
  return best;
}

function stopsNear(at: LatLng, radiusM: number): { stop: Stop; feed: number; m: number }[] {
  return getStaticFeeds()
    .flatMap((f, feed) => (f?.stops ?? []).map((stop) => ({ stop, feed, m: haversineM(at, [stop.lat, stop.lng]) })))
    .filter((x) => x.m <= radiusM);
}

type TransitCandidate = {
  shape: ShapeInfo;
  board: Stop;
  alight: Stop;
  walkToKm: number;
  walkFromKm: number;
  rideKm: number;
  boardAlongKm: number;
};

export function transitCandidates(origin: LatLng, dest: LatLng): TransitCandidate[] {
  const near1 = stopsNear(origin, P.STOP_SEARCH_M);
  const near2 = stopsNear(dest, P.STOP_SEARCH_M);
  if (!near1.length || !near2.length) return [];

  const best = new Map<string, TransitCandidate & { score: number }>();
  for (const s of shapes()) {
    // Only stops from the route's own feed (a bus platform next to the ION track isn't an ION stop).
    const on1 = near1.filter((x) => x.feed === s.feed).map((x) => ({ ...x, pr: project(s, [x.stop.lat, x.stop.lng]) })).filter((x) => x.pr.distM <= P.STOP_ON_SHAPE_M);
    if (!on1.length) continue;
    const on2 = near2.filter((x) => x.feed === s.feed).map((x) => ({ ...x, pr: project(s, [x.stop.lat, x.stop.lng]) })).filter((x) => x.pr.distM <= P.STOP_ON_SHAPE_M);
    for (const a of on1) {
      for (const b of on2) {
        const rideKm = b.pr.alongKm - a.pr.alongKm;
        if (rideKm < P.MIN_RIDE_KM) continue; // wrong direction, or not worth it
        const walkToKm = (a.m / 1000) * P.DETOUR.walk;
        const walkFromKm = (b.m / 1000) * P.DETOUR.walk;
        const score = minutesAt(walkToKm + walkFromKm, P.SPEED_KMH.walk) + minutesAt(rideKm, P.SPEED_KMH.bus);
        // One candidate per route + direction + boarding stop: the fastest. Keeping each
        // boarding stop lets one with live arrivals win over a nearer one without.
        const key = `${s.route_id}|${s.headsign ?? ''}|${a.stop.id}`;
        const prev = best.get(key);
        if (!prev || score < prev.score) best.set(key, { shape: s, board: a.stop, alight: b.stop, walkToKm, walkFromKm, rideKm, boardAlongKm: a.pr.alongKm, score });
      }
    }
  }
  return [...best.values()].sort((x, y) => x.score - y.score).slice(0, P.MAX_TRANSIT_CANDIDATES);
}

function nextBus(c: TransitCandidate, walkMin: number, arrivals: ArrivalIndex, live: LiveResult | null, now: number): NextBus | null {
  const earliest = now + walkMin * 60_000;
  const latest = now + P.MAX_WAIT_MIN * 60_000;
  const trips = getStaticFeeds()[c.shape.feed]?.trips;
  const base = { route: c.shape.route_name, headsign: towardName(c.shape.route_name, c.shape.headsign), stop_name: c.board.name, stop_code: c.board.code };

  const predicted = (arrivals.byStop.get(c.board.id) ?? []).find((a) => {
    if (a.at_ms < earliest || a.at_ms > latest) return false;
    const trip = trips?.get(a.trip_id);
    return trip ? trip.shape_id === c.shape.shape_id || (trip.route_id === c.shape.route_id && trip.headsign === c.shape.headsign) : a.route_id === c.shape.route_id;
  });
  if (predicted) {
    return { ...base, minutes: Math.max(0, Math.round((predicted.at_ms - now) / 60_000)), arrives_at: new Date(predicted.at_ms).toISOString(), source: 'live' };
  }

  // Estimate from live vehicle positions (never from the fake buses).
  if (live?.source === 'live') {
    let bestMin = Infinity;
    for (const v of live.vehicles) {
      if (v.route_id !== c.shape.route_id || (v.headsign && c.shape.headsign && v.headsign !== c.shape.headsign)) continue;
      const pr = project(c.shape, [v.lat, v.lng]);
      if (pr.distM > 150 || pr.alongKm > c.boardAlongKm) continue;
      const eta = minutesAt(c.boardAlongKm - pr.alongKm, P.SPEED_KMH.bus);
      if (eta >= walkMin && eta < bestMin && eta <= P.MAX_WAIT_MIN) bestMin = eta;
    }
    if (Number.isFinite(bestMin)) {
      const at = now + bestMin * 60_000;
      return { ...base, minutes: Math.round(bestMin), arrives_at: new Date(at).toISOString(), source: 'estimate' };
    }
  }
  return null;
}

export type LiveData = { arrivals: ArrivalIndex; vehicles: LiveResult | null };

/** Fetch live data within `timeoutMs` (whatever isn't ready in time is treated as missing). */
export async function liveData(timeoutMs: number): Promise<LiveData> {
  const timeout = <T>(p: Promise<T>, fallback: T) => Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), Math.max(0, timeoutMs)).unref())]);
  const [arrivals, vehicles] = await Promise.all([
    timeout(getArrivals(), { ok: false, byStop: new Map() } as ArrivalIndex),
    timeout(getLiveVehicles().catch(() => null), null),
  ]);
  return { arrivals, vehicles };
}

/** All options from origin to the place, fastest first. Never throws. */
export function computeOptions(origin: Origin, place: Place, status: UserStatus, live: LiveData, now = Date.now()): PlanOption[] {
  const straight = haversineKm(origin.at, place.at);
  const dir = compass(origin.at, place.at);
  const name = place.safe_name;
  const options: PlanOption[] = [];

  const walkKm = straight * P.DETOUR.walk;
  if (walkKm <= P.WALK_MAX_KM) {
    options.push({
      mode: 'walk',
      minutes: Math.max(1, Math.round(minutesAt(walkKm, P.SPEED_KMH.walk))),
      km: round1(walkKm),
      points_km: round1(walkKm),
      ...pointsEstimate('walk', round1(walkKm), status),
      eco_note: ecoNote('walk', walkKm),
      steps: [`Walk ${dir} about ${distText(walkKm)} to ${name}.`],
      next_bus: null,
    });
  }
  if (straight < P.WALK_ONLY_BELOW_KM) return options;

  const bikeKm = straight * P.DETOUR.bike;
  if (bikeKm <= P.BIKE_MAX_KM) {
    options.push({
      mode: 'bike',
      minutes: Math.max(1, Math.round(minutesAt(bikeKm, P.SPEED_KMH.bike))),
      km: round1(bikeKm),
      points_km: round1(bikeKm),
      ...pointsEstimate('bike', round1(bikeKm), status),
      eco_note: ecoNote('bike', bikeKm),
      steps: [`Ride ${dir} about ${distText(bikeKm)} to ${name}.`],
      next_bus: null,
    });
  }

  let transit: PlanOption | null = null;
  try {
    for (const c of transitCandidates(origin.at, place.at)) {
      const walkToMin = minutesAt(c.walkToKm, P.SPEED_KMH.walk);
      const bus = nextBus(c, walkToMin, live.arrivals, live.vehicles, now);
      // With working live predictions, a route with no bus in the next hour isn't running now (e.g. night-only routes).
      if (!bus && live.arrivals.ok) continue;
      const startRideMin = bus ? Math.max(walkToMin, bus.minutes) : walkToMin + P.DEFAULT_WAIT_MIN;
      const minutes = Math.max(1, Math.round(startRideMin + minutesAt(c.rideKm, P.SPEED_KMH.bus) + minutesAt(c.walkFromKm, P.SPEED_KMH.walk)));
      if (transit && minutes >= transit.minutes) continue;
      const rideKm = round1(c.rideKm);
      const stop = (s: Stop) => `${s.name}${s.code ? ` (stop ${s.code})` : ''}`;
      const headsign = towardName(c.shape.route_name, c.shape.headsign);
      const toward = headsign ? ` toward ${headsign}` : '';
      transit = {
        mode: 'transit',
        minutes,
        km: round1(c.walkToKm + c.rideKm + c.walkFromKm),
        points_km: rideKm,
        ...pointsEstimate('transit', rideKm, status),
        eco_note: ecoNote('transit', c.rideKm),
        steps: [
          `Walk about ${distText(c.walkToKm)} to ${stop(c.board)}.`,
          `Take route ${c.shape.route_name}${toward}${bus ? ` (next one in about ${bus.minutes} min)` : ''}. Start your transit trip in the app once you are at the stop.`,
          `Ride about ${distText(c.rideKm)} and get off at ${stop(c.alight)}.`,
          `Walk about ${distText(c.walkFromKm)} to ${name}.`,
        ],
        next_bus: bus,
      };
    }
  } catch (err) {
    console.warn(`[planner] transit option failed: ${(err as Error).message}`);
  }
  if (transit) options.push(transit);
  return options.sort((a, b) => a.minutes - b.minutes);
}

/** The computed recommendation (used when Gemini isn't). */
export function computedRecommendation(options: PlanOption[]): PlanMode | null {
  const has = (m: PlanMode) => options.find((o) => o.mode === m);
  const walk = has('walk'), bike = has('bike'), transit = has('transit');
  if (walk && walk.km <= P.WALK_RECOMMEND_MAX_KM) return 'walk';
  if (bike && bike.km <= P.BIKE_RECOMMEND_MAX_KM) return 'bike';
  if (transit) return 'transit';
  if (bike) return 'bike';
  return options[0]?.mode ?? null;
}
