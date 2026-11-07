import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// backend/data/commutr.db, resolved the same way from src/ (tsx) and dist/ (node).
const DEFAULT_DB_PATH = fileURLToPath(new URL('../data/commutr.db', import.meta.url));

// Conventions: integer IDs, times as ISO 8601 UTC text (e.g. 2026-11-07T14:05:00.000Z).
// Tables are created only if missing. Changing a table here does NOT update an
// existing database: delete backend/data/commutr.db and run `npm run seed`.
const NOW = "(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id               INTEGER PRIMARY KEY,
  name             TEXT    NOT NULL,
  email            TEXT    NOT NULL UNIQUE,
  points           INTEGER NOT NULL DEFAULT 0   CHECK (points >= 0),
  eco_score        INTEGER NOT NULL DEFAULT 100 CHECK (eco_score BETWEEN 0 AND 100),
  trust_multiplier REAL    NOT NULL DEFAULT 1.0,
  created_at       TEXT    NOT NULL DEFAULT ${NOW}
);

CREATE TABLE IF NOT EXISTS trips (
  id             INTEGER PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mode           TEXT    NOT NULL CHECK (mode IN ('walk', 'bike', 'scooter', 'transit', 'car')),
  status         TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'finished')),
  distance_km    REAL,
  confidence     REAL,
  points_awarded INTEGER,
  started_at     TEXT    NOT NULL DEFAULT ${NOW},
  ended_at       TEXT,
  flags          TEXT    NOT NULL DEFAULT '[]', -- JSON array of scoring flag codes
  eco_delta      INTEGER NOT NULL DEFAULT 0,    -- eco score change this trip caused
  trust_delta    REAL    NOT NULL DEFAULT 0     -- trust multiplier change this trip caused
);
CREATE INDEX IF NOT EXISTS idx_trips_user ON trips(user_id, started_at);
CREATE INDEX IF NOT EXISTS idx_trips_user_status ON trips(user_id, status);

CREATE TABLE IF NOT EXISTS trip_points (
  id        INTEGER PRIMARY KEY,
  trip_id   INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  lat       REAL    NOT NULL,
  lng       REAL    NOT NULL,
  accuracy  REAL,
  timestamp TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trip_points_trip ON trip_points(trip_id, timestamp);

CREATE TABLE IF NOT EXISTS merchants (
  id       INTEGER PRIMARY KEY,
  name     TEXT NOT NULL,
  category TEXT NOT NULL,
  address  TEXT,
  lat      REAL,
  lng      REAL
);

CREATE TABLE IF NOT EXISTS rewards (
  id            INTEGER PRIMARY KEY,
  merchant_id   INTEGER NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  title         TEXT    NOT NULL,
  points_cost   INTEGER NOT NULL CHECK (points_cost > 0),
  min_eco_score INTEGER NOT NULL DEFAULT 0 CHECK (min_eco_score BETWEEN 0 AND 100)
);

CREATE TABLE IF NOT EXISTS redemptions (
  id           INTEGER PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reward_id    INTEGER NOT NULL REFERENCES rewards(id),
  points_spent INTEGER NOT NULL,
  code         TEXT    NOT NULL UNIQUE,
  redeemed_at  TEXT    NOT NULL DEFAULT ${NOW}
);
CREATE INDEX IF NOT EXISTS idx_redemptions_user ON redemptions(user_id);

CREATE TABLE IF NOT EXISTS clubs (
  id                INTEGER PRIMARY KEY,
  name              TEXT    NOT NULL,
  description       TEXT,
  weekly_goal_steps INTEGER NOT NULL CHECK (weekly_goal_steps > 0),
  group_reward      TEXT
);

-- steps_this_week is a placeholder filled by the seed. Real progress will come
-- from walk km x 1300 steps/km (see AGENTS.md / docs/api.md).
CREATE TABLE IF NOT EXISTS club_members (
  club_id         INTEGER NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at       TEXT    NOT NULL DEFAULT ${NOW},
  steps_this_week INTEGER NOT NULL DEFAULT 0,
  week_start      TEXT, -- Toronto Monday (YYYY-MM-DD) that steps_this_week belongs to
  PRIMARY KEY (club_id, user_id)
);

-- last_active_date is a Toronto local date (YYYY-MM-DD), not a UTC timestamp.
CREATE TABLE IF NOT EXISTS streaks (
  user_id          INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  current_days     INTEGER NOT NULL DEFAULT 0,
  longest_days     INTEGER NOT NULL DEFAULT 0,
  last_active_date TEXT
);

CREATE TABLE IF NOT EXISTS saved_locations (
  id      INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label   TEXT    NOT NULL,
  lat     REAL    NOT NULL,
  lng     REAL    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_saved_locations_user ON saved_locations(user_id);
`;

export type DB = Database.Database;

export function openDb(path = process.env.DB_PATH ?? DEFAULT_DB_PATH): DB {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  // Default rollback journal (not WAL): the repo may sit on NTFS/FUSE, where WAL's shared memory is unreliable.
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);
  addMissingColumns(db);
  return db;
}

// CREATE TABLE IF NOT EXISTS doesn't add columns to tables that already exist.
// Columns added after the first release are listed here and added on startup,
// so existing databases keep working without a wipe. Add-only; never drops.
const ADDED_COLUMNS: Record<string, Record<string, string>> = {
  trips: {
    flags: "TEXT NOT NULL DEFAULT '[]'",
    eco_delta: 'INTEGER NOT NULL DEFAULT 0',
    trust_delta: 'REAL NOT NULL DEFAULT 0',
  },
  club_members: {
    week_start: 'TEXT',
  },
};

function addMissingColumns(db: Database.Database) {
  for (const [table, columns] of Object.entries(ADDED_COLUMNS)) {
    const existing = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
    for (const [name, ddl] of Object.entries(columns)) {
      if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
    }
  }
}
