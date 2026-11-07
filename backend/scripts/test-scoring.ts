// Scoring test: replays synthetic GPS trips through the REAL endpoints and prints
// confidence and points for each.
//
//   npm run test:scoring
//
// Uses the shared harness (scripts/lib/harness.ts): a throwaway seeded DB
// (backend/data/test-scoring.db) and its own server on port 8799. One test user
// per scenario, so trust, last-trip and daily cap don't leak between them.

import type Database from 'better-sqlite3';
import { haversineKm, type LatLng } from '../src/geo.js';
import { addDays, torontoDate, torontoWeekStart } from '../src/time.js';
import { bus, cycling, driving, DTK, LAURIER, MIDTOWN, phone, UPTOWN, UW, VICTORIA, walking, type Piece } from './lib/gps.js';
import { addUser, runTrip, startHarness, table } from './lib/harness.js';

type Scenario = {
  name: string;
  mode: 'walk' | 'bike' | 'scooter' | 'transit' | 'car';
  pieces: Piece[];
  seed: number;
  setup?: (db: Database.Database, userId: number) => void;
};

async function main() {
  const torontoHour = Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', hour: '2-digit', hour12: false }).format(new Date()));
  if (torontoHour < 2) console.warn('Note: run near midnight Toronto time; backdated trips may land on the previous day.');

  const h = await startHarness({ dbName: 'test-scoring.db', port: 8799 });
  const { api, db } = h;

  try {
    // Real stops for the transit scenarios
    const stops = (await (await fetch(h.base + '/api/stops')).json()).stops as { id: string; name: string; lat: number; lng: number }[];
    if (stops.length === 0) throw new Error('no GRT stops loaded (static GTFS missing?)');
    const nearestStop = (p: LatLng) => stops.reduce((best, s) => (haversineKm(p, [s.lat, s.lng]) < haversineKm(p, [best.lat, best.lng]) ? s : best));
    const stopDistM = (p: LatLng) => Math.round(haversineKm(p, [nearestStop(p).lat, nearestStop(p).lng]) * 1000);
    const stopA = nearestStop([43.4621, -80.5233]); // Uptown, near Willis Way
    const stopB = nearestStop(DTK); // Downtown Kitchener
    const A: LatLng = [stopA.lat, stopA.lng], B: LatLng = [stopB.lat, stopB.lng];
    const RURAL_START: LatLng = [43.47, -80.65], RURAL_END: LatLng = [43.49, -80.62]; // farmland west of Waterloo

    const today = torontoDate();

    const scenarios: Scenario[] = [
      {
        name: 'Honest walk',
        mode: 'walk',
        seed: 1,
        pieces: [{ path: [UW, LAURIER, UPTOWN], speed: walking(), ...phone }],
        // Also shows streak (+1 from yesterday) and club steps.
        setup: (db, uid) => {
          db.prepare('INSERT INTO streaks (user_id, current_days, longest_days, last_active_date) VALUES (?, 3, 5, ?)').run(uid, addDays(today, -1));
          db.prepare('INSERT INTO club_members (club_id, user_id, joined_at, steps_this_week, week_start) VALUES (1, ?, ?, 1000, ?)').run(uid, new Date().toISOString(), torontoWeekStart());
        },
      },
      { name: 'Honest bike', mode: 'bike', seed: 2, pieces: [{ path: [UPTOWN, MIDTOWN, DTK], speed: cycling, intervalSec: 3, noiseM: 4, accuracy: [5, 12] }] },
      {
        name: `Honest transit (stop ${stopA.id} -> ${stopB.id})`,
        mode: 'transit',
        seed: 3,
        pieces: [{ path: [A, MIDTOWN, B], speed: bus, ...phone }],
      },
      {
        name: 'Teleporting walk',
        mode: 'walk',
        seed: 4,
        pieces: [
          { path: [UW, LAURIER], speed: walking(), ...phone },
          { path: [DTK, VICTORIA], speed: walking(), ...phone, pauseBeforeSec: 5 }, // 5 km away, 5 s later
        ],
      },
      {
        name: 'Robotic constant-speed walk',
        mode: 'walk',
        seed: 5,
        pieces: [{ path: [UPTOWN, [43.469, -80.5345]], speed: () => 5, intervalSec: 5, noiseM: 0, accuracy: [5, 5] }],
      },
      {
        name: 'Walk that is really a car',
        mode: 'walk',
        seed: 6,
        pieces: [
          { path: [UPTOWN, [43.4625, -80.516]], speed: walking(), ...phone },
          { path: [[43.4625, -80.516], [43.453, -80.497]], speed: driving, ...phone },
          { path: [[43.453, -80.497], DTK], speed: walking(), ...phone },
        ],
      },
      {
        name: `Transit, no stops nearby (${stopDistM(RURAL_START)} m / ${stopDistM(RURAL_END)} m)`,
        mode: 'transit',
        seed: 7,
        pieces: [{ path: [RURAL_START, RURAL_END], speed: bus, ...phone }],
      },
      {
        name: 'Walk with 9 min GPS gap, no jump',
        mode: 'walk',
        seed: 8,
        pieces: [
          { path: [DTK, [43.448, -80.4975]], speed: walking(), ...phone },
          { path: [[43.448, -80.4975], [43.444, -80.504]], speed: walking(), ...phone, silent: true }, // phone in pocket
          { path: [[43.444, -80.504], [43.442, -80.511]], speed: walking(), ...phone },
        ],
      },
      // Extras: side effects
      { name: 'Car trip (eco penalty)', mode: 'car', seed: 9, pieces: [{ path: [[43.4985, -80.528], UPTOWN, [43.4245, -80.4386]], speed: driving, ...phone }] },
      {
        name: 'Daily cap (190 pts already today)',
        mode: 'bike',
        seed: 10,
        pieces: [{ path: [UPTOWN, MIDTOWN, DTK], speed: cycling, intervalSec: 3, noiseM: 4, accuracy: [5, 12] }],
        setup: (db, uid) => {
          // An earlier trip today worth 190 points (3 h ago if that's still today, else now).
          // It has no GPS points, so it doesn't trigger the "far from last trip" check.
          const threeHoursAgo = new Date(Date.now() - 3 * 3600_000).toISOString();
          const at = torontoDate(threeHoursAgo) === today ? threeHoursAgo : new Date().toISOString();
          db.prepare("INSERT INTO trips (user_id, mode, status, started_at, ended_at, distance_km, confidence, points_awarded) VALUES (?, 'walk', 'finished', ?, ?, 19, 1, 190)").run(uid, at, at);
          db.prepare('UPDATE users SET points = 190 WHERE id = ?').run(uid);
        },
      },
    ];

    // One fresh user per scenario: 0 points, eco 90, trust 1.0
    scenarios.forEach((s, i) => {
      addUser(db, 101 + i, s.name);
      s.setup?.(db, 101 + i);
    });

    const rows: Record<string, string | number>[] = [];
    const effects: Record<string, string | number>[] = [];
    for (const [i, s] of scenarios.entries()) {
      const uid = 101 + i;
      const r = await runTrip(api, uid, s.mode, s.seed, s.pieces);
      const u = db.prepare('SELECT points, eco_score, trust_multiplier FROM users WHERE id = ?').get(uid) as any;
      const club = db.prepare('SELECT steps_this_week FROM club_members WHERE user_id = ? AND club_id = 1').get(uid) as any;
      rows.push({
        Scenario: s.name,
        Mode: s.mode,
        Min: r.minutes,
        'GPS pts': r.sent,
        'Verified km': r.trip.distance_km,
        Confidence: r.trip.confidence ?? 'n/a (car)',
        Flags: r.trip.flags.length ? r.trip.flags.join(', ') : '-',
        Points: r.trip.points_awarded + (r.trip.capped ? ' (capped)' : ''),
      });
      effects.push({
        Scenario: s.name,
        'User points': u.points,
        Trust: u.trust_multiplier.toFixed(2),
        'Eco (was 90)': u.eco_score,
        Streak: `${r.streak.current_days} (last ${r.streak.last_active_date ?? '-'})`,
        'Steps added': r.steps_added + (club ? ` (club total ${club.steps_this_week})` : ''),
      });
    }

    console.log('\nSCORING RESULTS');
    table(rows);
    console.log('\nSIDE EFFECTS (each scenario has its own fresh user: 0 points, eco 90, trust 1.00)');
    table(effects);

    // Error cases
    console.log('\nERROR CASES');
    const uid = 101;
    const finished = (await api(uid, 'GET', '/api/trips?limit=1')).json.trips[0];
    const checks: [string, Promise<{ status: number; json: any }>, number][] = [
      ['finish an already finished trip', api(uid, 'POST', `/api/trips/${finished.id}/finish`, {}), 409],
      ['add points to a finished trip', api(uid, 'POST', `/api/trips/${finished.id}/points`, { points: [{ lat: 43.46, lng: -80.52, accuracy: 5, timestamp: new Date().toISOString() }] }), 409],
      ["read another user's trip", api(102, 'GET', `/api/trips/${finished.id}`), 404],
      ['bad mode', api(uid, 'POST', '/api/trips', { mode: 'jetpack' }), 400],
      ['malformed point on a finished trip (trip state is checked first)', api(uid, 'POST', `/api/trips/${finished.id}/points`, { points: [{ lat: 'x' }] }), 409],
    ];
    const t2 = await api(uid, 'POST', '/api/trips', { mode: 'walk' });
    checks.push(['start a second trip while one is active', api(uid, 'POST', '/api/trips', { mode: 'bike' }), 409]);
    checks.push(['malformed point on active trip', api(uid, 'POST', `/api/trips/${t2.json.id}/points`, { points: [{ lat: 'x', lng: 1, timestamp: 'now' }] }), 400]);
    checks.push([
      'point timestamped in the future (rejected, not stored)',
      api(uid, 'POST', `/api/trips/${t2.json.id}/points`, { points: [{ lat: 43.46, lng: -80.52, accuracy: 5, timestamp: new Date(Date.now() + 3600_000).toISOString() }] }),
      200,
    ]);
    let failures = 0;
    for (const [label, p, expected] of checks) {
      const r = await p;
      const extra = r.status === 200 ? ` accepted=${r.json.accepted} rejected=${r.json.rejected}` : ` ${r.json.error?.code}`;
      if (r.status !== expected) failures++;
      console.log(`  ${r.status === expected ? 'PASS' : 'FAIL'}  ${label}: HTTP ${r.status}${extra}`);
    }
    const detail = await api(uid, 'GET', `/api/trips/${finished.id}`);
    const detailOk = detail.status === 200 && detail.json.points.length > 0;
    if (!detailOk) failures++;
    console.log(`  ${detailOk ? 'PASS' : 'FAIL'}  GET /api/trips/:id returns the path: ${detail.json.points.length} points`);

    const health = await fetch(h.base + '/health').then((r) => r.json());
    console.log(`\nSERVER: /health -> ${JSON.stringify(health)}, process ${h.serverRunning() ? 'still running' : 'EXITED (bad)'}`);
    if (failures || !h.serverRunning()) process.exitCode = 1;
  } catch (err) {
    console.error('TEST FAILED:', err);
    console.error('--- server log ---\n' + h.serverLog());
    process.exitCode = 1;
  } finally {
    db.close();
    await h.stop();
  }
}

await main();
