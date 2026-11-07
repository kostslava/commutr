// Scoring test: replays synthetic GPS trips through the REAL endpoints and prints
// confidence and points for each.
//
//   npm run test:scoring
//
// It never touches your dev database. It:
//   1. creates a throwaway DB (backend/data/test-scoring.db) and seeds it,
//   2. adds one test user per scenario (so trust, last-trip and daily cap don't leak between them),
//   3. starts its own server on port 8799 with SCORING_ALLOW_BACKDATED=1 (test-only flag),
//   4. runs every scenario, prints a table, checks a few error cases, stops the server.
//
// GPS tracks are generated deterministically (seeded random), with realistic noise.

import Database from 'better-sqlite3';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { haversineKm, type LatLng } from '../src/geo.js';
import { addDays, torontoDate, torontoWeekStart } from '../src/time.js';

const BACKEND = fileURLToPath(new URL('..', import.meta.url));
const DB_PATH = fileURLToPath(new URL('../data/test-scoring.db', import.meta.url));
const PORT = 8799;
const BASE = `http://localhost:${PORT}`;

// ---------------------------------------------------------------------------
// Deterministic GPS track generator
// ---------------------------------------------------------------------------

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
type Rng = () => number;
const gauss = (rng: Rng) => Math.sqrt(-2 * Math.log(rng() || 1e-9)) * Math.cos(2 * Math.PI * rng());

type GpsPoint = { lat: number; lng: number; accuracy: number; timestamp: string };

type Piece = {
  path: LatLng[];
  /** km/h at a given second into this piece */
  speed: (tSec: number, rng: Rng) => number;
  intervalSec: number;
  noiseM: number;
  accuracy: [min: number, max: number];
  /** Move without recording points (GPS gap). */
  silent?: boolean;
  /** Extra seconds before this piece starts (e.g. a teleport 5 s later). */
  pauseBeforeSec?: number;
};

function pointAt(path: LatLng[], cum: number[], d: number): LatLng {
  let i = cum.findIndex((c) => c >= d);
  if (i <= 0) i = i === 0 ? 1 : path.length - 1;
  const a = path[i - 1]!, b = path[i]!;
  const len = cum[i]! - cum[i - 1]!;
  const t = len > 0 ? Math.min(1, (d - cum[i - 1]!) / len) : 0;
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/** Returns points plus the total duration in seconds. */
type TimedPoint = Omit<GpsPoint, 'timestamp'> & { tSec: number };

function track(seed: number, pieces: Piece[]): { points: TimedPoint[]; durationSec: number } {
  const rng = mulberry32(seed);
  const out: TimedPoint[] = [];
  let clock = 0;
  for (const piece of pieces) {
    clock += piece.pauseBeforeSec ?? 0;
    const cum = [0];
    for (let i = 1; i < piece.path.length; i++) cum.push(cum[i - 1]! + haversineKm(piece.path[i - 1]!, piece.path[i]!));
    const total = cum[cum.length - 1]!;
    let d = 0, t = 0;
    for (;;) {
      const [lat, lng] = pointAt(piece.path, cum, Math.min(d, total));
      if (!piece.silent) {
        const nLat = (gauss(rng) * piece.noiseM) / 111_320;
        const nLng = (gauss(rng) * piece.noiseM) / (111_320 * Math.cos((lat * Math.PI) / 180));
        const [lo, hi] = piece.accuracy;
        out.push({ lat: lat + nLat, lng: lng + nLng, accuracy: Math.round(lo + rng() * (hi - lo)), tSec: clock + t });
      }
      if (d >= total) break;
      d += (Math.max(0, piece.speed(t, rng)) * piece.intervalSec) / 3600;
      t += piece.intervalSec;
    }
    clock += t;
  }
  return { points: out, durationSec: clock };
}

// Speed profiles (km/h)
const walking = (base = 5) => (t: number, rng: Rng) => base + 0.6 * Math.sin(t / 47) + (rng() - 0.5) * 1.2;
const cycling = (t: number, rng: Rng) => (t % 300 < 25 ? 0 : 18 + 3 * Math.sin(t / 61) + (rng() - 0.5) * 4); // red lights
const driving = (t: number, rng: Rng) => (t % 240 < 20 ? 5 : 50 + 6 * Math.sin(t / 37) + (rng() - 0.5) * 8);
const bus = (t: number, rng: Rng) => (t < 30 || t % 120 < 20 ? 0 : 32 + 8 * Math.sin(t / 29) + (rng() - 0.5) * 6); // stops

const phone = { intervalSec: 5, noiseM: 4, accuracy: [5, 14] as [number, number] };

// ---------------------------------------------------------------------------
// Places (real KW coordinates)
// ---------------------------------------------------------------------------

const UW: LatLng = [43.4723, -80.5449], LAURIER: LatLng = [43.4738, -80.5275], UPTOWN: LatLng = [43.4655, -80.5228];
const MIDTOWN: LatLng = [43.4585, -80.507], DTK: LatLng = [43.4508, -80.4925], VICTORIA: LatLng = [43.4466, -80.5];

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

async function api(userId: number, method: string, path: string, body?: unknown) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Demo-User': String(userId) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any };
}

type Scenario = {
  name: string;
  mode: 'walk' | 'bike' | 'scooter' | 'transit' | 'car';
  pieces: Piece[];
  seed: number;
  setup?: (db: Database.Database, userId: number) => void;
};

async function runScenario(s: Scenario, userId: number) {
  const { points, durationSec } = track(s.seed, s.pieces);
  const startMs = Date.now() - (durationSec + 120) * 1000; // backdated so it ended 2 min ago
  const gps: GpsPoint[] = points.map(({ tSec, ...p }) => ({ ...p, timestamp: new Date(startMs + tSec * 1000).toISOString() }));

  const start = await api(userId, 'POST', '/api/trips', { mode: s.mode, started_at: new Date(startMs).toISOString() });
  if (start.status !== 201) throw new Error(`${s.name}: start failed ${start.status} ${JSON.stringify(start.json)}`);
  const id = start.json.id as number;

  let rejected = 0;
  for (let i = 0; i < gps.length; i += 100) {
    const r = await api(userId, 'POST', `/api/trips/${id}/points`, { points: gps.slice(i, i + 100) });
    if (r.status !== 200) throw new Error(`${s.name}: points failed ${r.status} ${JSON.stringify(r.json)}`);
    rejected += r.json.rejected;
  }
  const fin = await api(userId, 'POST', `/api/trips/${id}/finish`, {});
  if (fin.status !== 200) throw new Error(`${s.name}: finish failed ${fin.status} ${JSON.stringify(fin.json)}`);
  return { tripId: id, sent: gps.length, rejected, minutes: Math.round(durationSec / 60), ...fin.json };
}

function table(rows: Record<string, string | number>[]) {
  const cols = Object.keys(rows[0]!);
  const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c]).length)));
  const line = (cells: string[]) => '| ' + cells.map((x, i) => x.padEnd(w[i]!)).join(' | ') + ' |';
  console.log(line(cols));
  console.log('|' + w.map((n) => '-'.repeat(n + 2)).join('|') + '|');
  for (const r of rows) console.log(line(cols.map((c) => String(r[c]))));
}

async function waitForHealth(timeoutMs: number) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      if ((await fetch(BASE + '/health')).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('server did not start');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const torontoHour = Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', hour: '2-digit', hour12: false }).format(new Date()));
  if (torontoHour < 2) console.warn('Note: run near midnight Toronto time; backdated trips may land on the previous day.');

  // 1. Fresh test DB + seed
  mkdirSync(fileURLToPath(new URL('../data/', import.meta.url)), { recursive: true });
  for (const f of [DB_PATH, DB_PATH + '-journal']) if (existsSync(f)) rmSync(f);
  const seed = spawnSync('npx', ['tsx', 'src/seed.ts'], { cwd: BACKEND, env: { ...process.env, DB_PATH }, encoding: 'utf8' });
  if (seed.status !== 0) throw new Error('seed failed: ' + seed.stderr);

  // 2. Server
  const server = spawn('npx', ['tsx', 'src/index.ts'], {
    cwd: BACKEND,
    env: { ...process.env, DB_PATH, PORT: String(PORT), SCORING_ALLOW_BACKDATED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true, // own process group, so npx -> tsx -> node can all be stopped together
  });
  let serverLog = '';
  server.stdout.on('data', (d) => (serverLog += d));
  server.stderr.on('data', (d) => (serverLog += d));
  let serverExited = false;
  server.on('exit', () => (serverExited = true));

  try {
    await waitForHealth(60_000);

    // Real stops for the transit scenarios
    const stops = (await (await fetch(BASE + '/api/stops')).json()).stops as { id: string; name: string; lat: number; lng: number }[];
    if (stops.length === 0) throw new Error('no GRT stops loaded (static GTFS missing?)');
    const nearestStop = (p: LatLng) => stops.reduce((best, s) => (haversineKm(p, [s.lat, s.lng]) < haversineKm(p, [best.lat, best.lng]) ? s : best));
    const stopDistM = (p: LatLng) => Math.round(haversineKm(p, [nearestStop(p).lat, nearestStop(p).lng]) * 1000);
    const stopA = nearestStop([43.4621, -80.5233]); // Uptown, near Willis Way
    const stopB = nearestStop(DTK); // Downtown Kitchener
    const A: LatLng = [stopA.lat, stopA.lng], B: LatLng = [stopB.lat, stopB.lng];
    const RURAL_START: LatLng = [43.47, -80.65], RURAL_END: LatLng = [43.49, -80.62]; // farmland west of Waterloo

    const db = new Database(DB_PATH);
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
    const insertUser = db.prepare('INSERT INTO users (id, name, email, points, eco_score, trust_multiplier, created_at) VALUES (?, ?, ?, 0, 90, 1.0, ?)');
    scenarios.forEach((s, i) => {
      const uid = 101 + i;
      insertUser.run(uid, `Test: ${s.name}`, `test${uid}@demo.commutr.test`, new Date().toISOString());
      s.setup?.(db, uid);
    });

    const rows: Record<string, string | number>[] = [];
    const effects: Record<string, string | number>[] = [];
    for (const [i, s] of scenarios.entries()) {
      const uid = 101 + i;
      const r = await runScenario(s, uid);
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
    for (const [label, p, expected] of checks) {
      const r = await p;
      const extra = r.status === 200 ? ` accepted=${r.json.accepted} rejected=${r.json.rejected}` : ` ${r.json.error?.code}`;
      console.log(`  ${r.status === expected ? 'PASS' : 'FAIL'}  ${label}: HTTP ${r.status}${extra}`);
    }
    const detail = await api(uid, 'GET', `/api/trips/${finished.id}`);
    console.log(`  ${detail.status === 200 && detail.json.points.length > 0 ? 'PASS' : 'FAIL'}  GET /api/trips/:id returns the path: ${detail.json.points.length} points`);

    const health = await fetch(BASE + '/health').then((r) => r.json());
    console.log(`\nSERVER: /health -> ${JSON.stringify(health)}, process ${serverExited ? 'EXITED (bad)' : 'still running'}`);
    db.close();
  } catch (err) {
    console.error('TEST FAILED:', err);
    console.error('--- server log ---\n' + serverLog);
    process.exitCode = 1;
  } finally {
    // Kill the whole process group (npx alone would leave the real server running).
    if (!serverExited && server.pid) {
      const exited = new Promise((r) => server.once('exit', r));
      try {
        process.kill(-server.pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
    }
  }
}

await main();
