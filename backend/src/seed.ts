// Demo data for Commutr. Everything here is FAKE: people, merchants, rewards and clubs.
// No real businesses, sponsors or government bodies are involved.
//
// `npm run seed` wipes every table and refills it. It is deterministic: fixed IDs,
// fixed timestamps, no randomness, so running it twice gives identical data.
//
// Values like distance_km, confidence and points_awarded are hand-picked to look
// plausible. They are NOT produced by scoring logic (that does not exist yet), and
// user point balances are hand-set, not summed from trips.

import { openDb } from './db.js';

type Mode = 'walk' | 'bike' | 'scooter' | 'transit' | 'car';
type LatLng = [lat: number, lng: number];

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

const users = [
  // id, name, email, points, eco_score, trust_multiplier
  // Spread of eco scores so every reward tier shows both locked and unlocked.
  { id: 1, name: 'Alex Demo', email: 'alex@demo.commutr.test', points: 3200, eco_score: 98, trust_multiplier: 1.0 },
  { id: 2, name: 'Sam Rivera', email: 'sam@demo.commutr.test', points: 1450, eco_score: 88, trust_multiplier: 1.0 },
  { id: 3, name: 'Jordan Lee', email: 'jordan@demo.commutr.test', points: 700, eco_score: 82, trust_multiplier: 1.0 },
  // Plenty of points but a low eco score: rewards stay locked. Has a flagged trip, so lower trust.
  { id: 4, name: 'Taylor Kim', email: 'taylor@demo.commutr.test', points: 2600, eco_score: 60, trust_multiplier: 0.8 },
].map((u) => ({ ...u, created_at: '2026-10-15T16:00:00.000Z' }));

// Fictional merchants placed in real KW neighbourhoods.
const merchants = [
  { id: 1, name: 'Maple Loop Coffee', category: 'coffee', address: 'King St N, Uptown Waterloo (demo location)', lat: 43.4651, lng: -80.5225 },
  { id: 2, name: 'Grand River Dumplings', category: 'restaurant', address: 'King St W, Downtown Kitchener (demo location)', lat: 43.451, lng: -80.4915 },
  { id: 3, name: 'Uptown Shawarma House', category: 'restaurant', address: 'Erb St W, Uptown Waterloo (demo location)', lat: 43.4668, lng: -80.5232 },
  { id: 4, name: 'Belmont Bakehouse', category: 'bakery', address: 'Belmont Village, Kitchener (demo location)', lat: 43.4436, lng: -80.5047 },
  { id: 5, name: 'Commutr Demo Gift Card', category: 'gift_card', address: null, lat: null, lng: null },
];

// Coffee card tiers follow AGENTS.md: $5 needs eco 80, $10 needs 85, $25 needs 95.
const rewards = [
  { id: 1, merchant_id: 1, title: '$5 Maple Loop Coffee card', points_cost: 500, min_eco_score: 80 },
  { id: 2, merchant_id: 1, title: '$10 Maple Loop Coffee card', points_cost: 1000, min_eco_score: 85 },
  { id: 3, merchant_id: 1, title: '$25 Maple Loop Coffee card', points_cost: 2500, min_eco_score: 95 },
  { id: 4, merchant_id: 2, title: 'Free order of 6 dumplings', points_cost: 700, min_eco_score: 75 },
  { id: 5, merchant_id: 3, title: '15% off any wrap or plate', points_cost: 400, min_eco_score: 70 },
  { id: 6, merchant_id: 4, title: 'Free coffee and pastry', points_cost: 300, min_eco_score: 60 },
  { id: 7, merchant_id: 5, title: '$20 demo gift card', points_cost: 2000, min_eco_score: 90 },
];

const redemptions = [
  { id: 1, user_id: 1, reward_id: 6, points_spent: 300, code: 'DEMO-0001', redeemed_at: '2026-11-04T17:20:00.000Z' },
  { id: 2, user_id: 2, reward_id: 1, points_spent: 500, code: 'DEMO-0002', redeemed_at: '2026-11-05T13:00:00.000Z' },
];

const clubs = [
  {
    id: 1,
    name: 'UW Walkers',
    description: 'Students walking to campus instead of driving.',
    weekly_goal_steps: 150000,
    group_reward: 'Free medium coffee for every member at Maple Loop Coffee (demo)',
  },
  {
    id: 2,
    name: 'Kitchener Commuters',
    description: 'Downtown Kitchener folks swapping the car for the bus and the bike.',
    weekly_goal_steps: 100000,
    group_reward: '15% off at Grand River Dumplings for every member (demo)',
  },
];

// steps_this_week: fake totals until club progress is computed (walk km x 1300).
// A user's steps are the same in every club they belong to.
const clubMembers = [
  { club_id: 1, user_id: 1, joined_at: '2026-10-16T14:00:00.000Z', steps_this_week: 42300 },
  { club_id: 1, user_id: 2, joined_at: '2026-10-17T15:30:00.000Z', steps_this_week: 31850 },
  { club_id: 1, user_id: 3, joined_at: '2026-10-20T18:10:00.000Z', steps_this_week: 18200 },
  { club_id: 2, user_id: 2, joined_at: '2026-10-18T12:00:00.000Z', steps_this_week: 31850 },
  { club_id: 2, user_id: 4, joined_at: '2026-10-21T21:45:00.000Z', steps_this_week: 12400 },
].map((m) => ({ ...m, week_start: '2026-11-02' })); // the Toronto week the fake totals belong to

// last_active_date is a Toronto local date.
const streaks = [
  { user_id: 1, current_days: 5, longest_days: 12, last_active_date: '2026-11-05' },
  { user_id: 2, current_days: 2, longest_days: 7, last_active_date: '2026-11-04' },
  { user_id: 3, current_days: 1, longest_days: 3, last_active_date: '2026-11-06' },
  { user_id: 4, current_days: 1, longest_days: 1, last_active_date: '2026-11-06' },
];

const savedLocations = [
  { id: 1, user_id: 1, label: 'Home', lat: 43.4762, lng: -80.5371 },
  { id: 2, user_id: 1, label: 'Campus', lat: 43.4723, lng: -80.5449 },
  { id: 3, user_id: 2, label: 'Home', lat: 43.4598, lng: -80.5162 },
  { id: 4, user_id: 2, label: 'Work', lat: 43.4253, lng: -80.4392 },
  { id: 5, user_id: 3, label: 'Home', lat: 43.4441, lng: -80.5068 },
  { id: 6, user_id: 4, label: 'Home', lat: 43.4975, lng: -80.5262 },
];

// Named KW places used to draw fake GPS paths.
const P = {
  uwCampus: [43.4723, -80.5449],
  laurier: [43.4738, -80.5275],
  uptown: [43.4655, -80.5228],
  waterlooPark: [43.4660, -80.5300],
  waterlooParkWest: [43.4690, -80.5345],
  midtownKing: [43.4585, -80.5070],
  downtownKitchener: [43.4508, -80.4925],
  victoriaPark: [43.4466, -80.5000],
  victoriaParkSouth: [43.4440, -80.4960],
  belmont: [43.4436, -80.5047],
  conestoga: [43.4985, -80.5280],
  fairview: [43.4245, -80.4386],
  ionRoute: [43.4540, -80.4990],
  shawarma: [43.4668, -80.5232],
} satisfies Record<string, LatLng>;

type TripSeed = {
  id: number;
  user_id: number;
  mode: Mode;
  started_at: string;
  duration_min: number;
  path: LatLng[];
  point_count: number;
  distance_km: number;
  confidence: number | null;
  points_awarded: number;
  flags?: string[];
};

const trips: TripSeed[] = [
  { id: 1, user_id: 1, mode: 'walk', started_at: '2026-11-02T13:10:00.000Z', duration_min: 28, path: [P.uwCampus, P.laurier, P.uptown], point_count: 15, distance_km: 2.3, confidence: 0.95, points_awarded: 22 },
  { id: 2, user_id: 1, mode: 'bike', started_at: '2026-11-03T12:30:00.000Z', duration_min: 18, path: [P.uptown, P.midtownKing, P.downtownKitchener], point_count: 14, distance_km: 4.6, confidence: 1.0, points_awarded: 28 },
  { id: 3, user_id: 1, mode: 'walk', started_at: '2026-11-05T13:00:00.000Z', duration_min: 22, path: [P.uptown, P.waterlooPark, P.waterlooParkWest, P.uptown], point_count: 12, distance_km: 1.8, confidence: 1.0, points_awarded: 18 },
  { id: 4, user_id: 2, mode: 'transit', started_at: '2026-11-02T12:15:00.000Z', duration_min: 32, path: [P.uwCampus, P.uptown, P.ionRoute, P.fairview], point_count: 16, distance_km: 10.5, confidence: 0.9, points_awarded: 28 },
  { id: 5, user_id: 2, mode: 'walk', started_at: '2026-11-04T21:40:00.000Z', duration_min: 15, path: [P.victoriaPark, P.victoriaParkSouth, P.victoriaPark], point_count: 8, distance_km: 1.2, confidence: 0.85, points_awarded: 10 },
  { id: 6, user_id: 3, mode: 'bike', started_at: '2026-11-03T22:05:00.000Z', duration_min: 13, path: [P.belmont, P.midtownKing, P.uptown], point_count: 10, distance_km: 3.0, confidence: 0.9, points_awarded: 16 },
  { id: 7, user_id: 3, mode: 'walk', started_at: '2026-11-06T17:30:00.000Z', duration_min: 8, path: [P.uptown, P.shawarma], point_count: 6, distance_km: 0.6, confidence: 1.0, points_awarded: 6 },
  // Car trip: allowed, earns nothing, lowers eco score (no scoring logic yet).
  { id: 8, user_id: 4, mode: 'car', started_at: '2026-11-02T14:00:00.000Z', duration_min: 20, path: [P.conestoga, P.uptown, P.fairview], point_count: 12, distance_km: 11.8, confidence: null, points_awarded: 0 },
  // Flagged trip: "bike" at car speed. Confidence below 0.3 earns 0 points (AGENTS.md).
  { id: 9, user_id: 4, mode: 'bike', started_at: '2026-11-04T15:00:00.000Z', duration_min: 11, path: [P.conestoga, P.uptown, P.midtownKing], point_count: 9, distance_km: 9.0, confidence: 0.2, points_awarded: 0, flags: ['speed_too_high', 'car_like_burst'] },
  { id: 10, user_id: 4, mode: 'walk', started_at: '2026-11-06T20:15:00.000Z', duration_min: 12, path: [P.downtownKitchener, P.victoriaPark], point_count: 8, distance_km: 0.9, confidence: 0.9, points_awarded: 8 },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

function addMinutes(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) + Math.round(minutes * 60_000)).toISOString();
}

// Evenly spaced points along a polyline (by vertex-to-vertex length), with fixed
// timestamps and a repeating accuracy pattern. Pure function of its inputs.
function fakeGpsPoints(trip: TripSeed) {
  const legs = trip.path.slice(1).map((to, i) => {
    const from = trip.path[i]!;
    return { from, to, len: Math.hypot(to[0] - from[0], to[1] - from[1]) };
  });
  const total = legs.reduce((sum, l) => sum + l.len, 0);
  const accuracies = [5, 8, 6, 12, 7];

  return Array.from({ length: trip.point_count }, (_, i) => {
    const f = i / (trip.point_count - 1);
    let along = f * total;
    let leg = legs[legs.length - 1]!;
    for (const l of legs) {
      if (along <= l.len) { leg = l; break; }
      along -= l.len;
    }
    const t = leg.len === 0 ? 0 : Math.min(along / leg.len, 1);
    return {
      lat: round6(leg.from[0] + (leg.to[0] - leg.from[0]) * t),
      lng: round6(leg.from[1] + (leg.to[1] - leg.from[1]) * t),
      accuracy: accuracies[i % accuracies.length]!,
      timestamp: addMinutes(trip.started_at, f * trip.duration_min),
    };
  });
}

// ---------------------------------------------------------------------------
// Wipe and refill
// ---------------------------------------------------------------------------

const db = openDb();

// Children before parents so foreign keys stay satisfied.
const TABLES_IN_DELETE_ORDER = [
  'redemptions',
  'club_members',
  'trip_points',
  'trips',
  'rewards',
  'merchants',
  'clubs',
  'streaks',
  'saved_locations',
  'users',
];

const insert = (table: string, row: Record<string, unknown>) => {
  const cols = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => '@' + c).join(', ')})`).run(row);
};

let tripPointId = 0;

db.transaction(() => {
  for (const table of TABLES_IN_DELETE_ORDER) db.prepare(`DELETE FROM ${table}`).run();

  users.forEach((u) => insert('users', u));
  merchants.forEach((m) => insert('merchants', m));
  rewards.forEach((r) => insert('rewards', r));
  redemptions.forEach((r) => insert('redemptions', r));
  clubs.forEach((c) => insert('clubs', c));
  clubMembers.forEach((m) => insert('club_members', m));
  streaks.forEach((s) => insert('streaks', s));
  savedLocations.forEach((l) => insert('saved_locations', l));

  for (const trip of trips) {
    insert('trips', {
      id: trip.id,
      user_id: trip.user_id,
      mode: trip.mode,
      status: 'finished',
      distance_km: trip.distance_km,
      confidence: trip.confidence,
      points_awarded: trip.points_awarded,
      started_at: trip.started_at,
      ended_at: addMinutes(trip.started_at, trip.duration_min),
      flags: JSON.stringify(trip.flags ?? []),
    });
    for (const p of fakeGpsPoints(trip)) insert('trip_points', { id: ++tripPointId, trip_id: trip.id, ...p });
  }
})();

const counts = Object.fromEntries(
  [...TABLES_IN_DELETE_ORDER].reverse().map((t) => [t, (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n]),
);
db.close();

console.log('Seeded demo data:', counts);
