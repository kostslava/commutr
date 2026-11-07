// Shared test harness: a throwaway seeded database, the real server on its own
// port (test-only SCORING_ALLOW_BACKDATED=1), API calls as any user, trip replay
// and a table printer. Your dev database is never touched.

import Database from 'better-sqlite3';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { track, type Piece } from './gps.js';

export const BACKEND = fileURLToPath(new URL('../..', import.meta.url));

export type Api = (userId: number, method: string, path: string, body?: unknown) => Promise<{ status: number; json: any }>;

export type Harness = {
  base: string;
  db: Database.Database;
  api: Api;
  serverRunning: () => boolean;
  serverLog: () => string;
  stop: () => Promise<void>;
};

/** Fresh DB `backend/data/<dbName>`, seeded, and a server on `port`. */
export async function startHarness(opts: { dbName: string; port: number; env?: Record<string, string> }): Promise<Harness> {
  const dbPath = fileURLToPath(new URL(`../../data/${opts.dbName}`, import.meta.url));
  const base = `http://localhost:${opts.port}`;

  mkdirSync(fileURLToPath(new URL('../../data/', import.meta.url)), { recursive: true });
  for (const f of [dbPath, dbPath + '-journal']) if (existsSync(f)) rmSync(f);
  const seed = spawnSync('npx', ['tsx', 'src/seed.ts'], { cwd: BACKEND, env: { ...process.env, DB_PATH: dbPath }, encoding: 'utf8' });
  if (seed.status !== 0) throw new Error('seed failed: ' + seed.stderr);

  const server = spawn('npx', ['tsx', 'src/index.ts'], {
    cwd: BACKEND,
    // COMMUTR_ENV_FILE=none: test servers never load the real backend/.env unless a test asks for it.
    env: { ...process.env, COMMUTR_ENV_FILE: 'none', DB_PATH: dbPath, PORT: String(opts.port), SCORING_ALLOW_BACKDATED: '1', ...opts.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true, // own process group, so npx -> tsx -> node can all be stopped together
  });
  let log = '';
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));
  let exited = false;
  server.on('exit', () => (exited = true));

  const stop = async () => {
    if (exited || !server.pid) return;
    const done = new Promise((r) => server.once('exit', r));
    try {
      process.kill(-server.pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
    await Promise.race([done, new Promise((r) => setTimeout(r, 5000))]);
  };

  try {
    await waitForHealth(base, 60_000);
  } catch (err) {
    await stop();
    throw new Error(`${(err as Error).message}\n--- server log ---\n${log}`);
  }

  const api: Api = async (userId, method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Demo-User': String(userId) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };

  return { base, db: new Database(dbPath), api, serverRunning: () => !exited, serverLog: () => log, stop };
}

async function waitForHealth(base: string, timeoutMs: number) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      if ((await fetch(base + '/health')).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('server did not start');
}

/** Insert a test user directly (tests only). */
export function addUser(db: Database.Database, id: number, name: string, fields: { points?: number; eco_score?: number; trust_multiplier?: number } = {}) {
  db.prepare('INSERT INTO users (id, name, email, points, eco_score, trust_multiplier, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    id,
    `Test: ${name}`,
    `test${id}@demo.commutr.test`,
    fields.points ?? 0,
    fields.eco_score ?? 90,
    fields.trust_multiplier ?? 1.0,
    new Date().toISOString(),
  );
}

/** Replay a synthetic trip through the real endpoints, backdated so it ended 2 minutes ago. */
export async function runTrip(api: Api, userId: number, mode: string, seed: number, pieces: Piece[]) {
  const { points, durationSec } = track(seed, pieces);
  const startMs = Date.now() - (durationSec + 120) * 1000;
  const gps = points.map(({ tSec, ...p }) => ({ ...p, timestamp: new Date(startMs + tSec * 1000).toISOString() }));

  const start = await api(userId, 'POST', '/api/trips', { mode, started_at: new Date(startMs).toISOString() });
  if (start.status !== 201) throw new Error(`start failed ${start.status} ${JSON.stringify(start.json)}`);
  const id = start.json.id as number;

  let rejected = 0;
  for (let i = 0; i < gps.length; i += 100) {
    const r = await api(userId, 'POST', `/api/trips/${id}/points`, { points: gps.slice(i, i + 100) });
    if (r.status !== 200) throw new Error(`points failed ${r.status} ${JSON.stringify(r.json)}`);
    rejected += r.json.rejected;
  }
  const fin = await api(userId, 'POST', `/api/trips/${id}/finish`, {});
  if (fin.status !== 200) throw new Error(`finish failed ${fin.status} ${JSON.stringify(fin.json)}`);
  return { tripId: id, sent: gps.length, rejected, minutes: Math.round(durationSec / 60), ...fin.json };
}

export function table(rows: Record<string, string | number>[]) {
  const cols = Object.keys(rows[0]!);
  const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c]).length)));
  const line = (cells: string[]) => '| ' + cells.map((x, i) => x.padEnd(w[i]!)).join(' | ') + ' |';
  console.log(line(cols));
  console.log('|' + w.map((n) => '-'.repeat(n + 2)).join('|') + '|');
  for (const r of rows) console.log(line(cols.map((c) => String(r[c]))));
}
