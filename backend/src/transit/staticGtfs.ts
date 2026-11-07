// Static GTFS: download once, cache on disk under backend/data/gtfs/, refresh when
// older than 24 hours. Only the files we need are unzipped and parsed
// (stop_times.txt is ~10 MB and skipped).

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'csv-parse/sync';
import { strFromU8, unzipSync } from 'fflate';
import { transitConfig as cfg } from './config.js';

export type LatLng = [lat: number, lng: number];

export type Route = { short_name: string | null; long_name: string | null; type: number };
export type Trip = { route_id: string; headsign: string | null; shape_id: string | null; direction_id: string | null };
export type Stop = { id: string; code: string | null; name: string; lat: number; lng: number };

export type StaticFeed = {
  url: string;
  downloaded_at: string;
  routes: Map<string, Route>;
  trips: Map<string, Trip>;
  stops: Stop[];
  shapes: Map<string, LatLng[]>;
};

const REQUIRED = ['routes.txt', 'trips.txt', 'stops.txt'];
const WANTED = new Set([...REQUIRED, 'shapes.txt']);

// One slot per configured static URL (null = never loaded).
let feeds: (StaticFeed | null)[] = cfg.staticUrls.map(() => null);
const listeners: (() => void)[] = [];

export const getStaticFeeds = (): readonly (StaticFeed | null)[] => feeds;
export const onStaticReload = (fn: () => void) => listeners.push(fn);

export function allStops(): Stop[] {
  return feeds.flatMap((f) => f?.stops ?? []);
}

/**
 * Distance in metres from a point to the nearest GRT stop (bus or ION), or null
 * when no static data is loaded. A plain scan: ~2,300 stops is fast enough.
 */
export function nearestStopMeters(lat: number, lng: number): number | null {
  const stops = allStops();
  if (stops.length === 0) return null;
  // Cheap equirectangular distance; accurate to well under 1% at stop-radius scale.
  const kx = 111_320 * Math.cos((lat * Math.PI) / 180), ky = 110_574;
  let best = Infinity;
  for (const s of stops) {
    const dx = (s.lng - lng) * kx, dy = (s.lat - lat) * ky;
    const d = dx * dx + dy * dy;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

const cachePath = (url: string) =>
  join(cfg.cacheDir, `feed-${createHash('sha1').update(url).digest('hex').slice(0, 10)}.zip`);

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

const blank = (s: string | undefined) => (s === undefined || s.trim() === '' ? null : s.trim());

type Row = Record<string, string>;

function readCsv(files: Record<string, Uint8Array>, name: string): Row[] {
  const data = files[name];
  if (!data) return [];
  return parse(strFromU8(data), { columns: true, bom: true, skip_empty_lines: true, relax_column_count: true, trim: true });
}

// Throws if the zip is not a usable GTFS feed.
function parseZip(zip: Uint8Array, url: string, downloadedAt: Date): StaticFeed {
  const files = unzipSync(zip, { filter: (f) => WANTED.has(f.name) });
  const missing = REQUIRED.filter((f) => !files[f]);
  if (missing.length) throw new Error(`GTFS zip missing ${missing.join(', ')}`);

  const routes = new Map<string, Route>();
  for (const r of readCsv(files, 'routes.txt')) {
    routes.set(r.route_id!, { short_name: blank(r.route_short_name), long_name: blank(r.route_long_name), type: Number(r.route_type ?? 3) });
  }

  const trips = new Map<string, Trip>();
  for (const t of readCsv(files, 'trips.txt')) {
    trips.set(t.trip_id!, { route_id: t.route_id!, headsign: blank(t.trip_headsign), shape_id: blank(t.shape_id), direction_id: blank(t.direction_id) });
  }

  // Only boardable stops (location_type 0 or empty), not parent stations.
  const stops: Stop[] = [];
  for (const s of readCsv(files, 'stops.txt')) {
    if ((s.location_type ?? '0') !== '0' && s.location_type !== '') continue;
    const lat = Number(s.stop_lat), lng = Number(s.stop_lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    stops.push({ id: s.stop_id!, code: blank(s.stop_code), name: s.stop_name ?? '', lat: round6(lat), lng: round6(lng) });
  }

  const shapePts = new Map<string, { seq: number; p: LatLng }[]>();
  for (const s of readCsv(files, 'shapes.txt')) {
    const list = shapePts.get(s.shape_id!) ?? [];
    list.push({ seq: Number(s.shape_pt_sequence), p: [Number(s.shape_pt_lat), Number(s.shape_pt_lon)] });
    shapePts.set(s.shape_id!, list);
  }
  const shapes = new Map<string, LatLng[]>();
  for (const [id, pts] of shapePts) shapes.set(id, pts.sort((a, b) => a.seq - b.seq).map((x) => x.p));

  if (routes.size === 0 || stops.length === 0) throw new Error('GTFS zip has no routes or stops');
  return { url, downloaded_at: downloadedAt.toISOString(), routes, trips, stops, shapes };
}

async function download(url: string): Promise<Uint8Array> {
  const res = await fetch(url, { signal: AbortSignal.timeout(cfg.staticTimeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function cachedAge(path: string): Promise<{ mtime: Date; ageMs: number } | null> {
  try {
    const s = await stat(path);
    return { mtime: s.mtime, ageMs: Date.now() - s.mtimeMs };
  } catch {
    return null;
  }
}

// Load one feed: fresh cache → use it; otherwise download, validate, then swap
// the file in atomically. A failed download falls back to an older cache.
async function loadFeed(url: string, current: StaticFeed | null, force: boolean): Promise<StaticFeed | null> {
  const path = cachePath(url);
  const cached = await cachedAge(path);

  if (cached && cached.ageMs < cfg.staticMaxAgeMs && !force) {
    if (current) return current; // already in memory and still fresh
    try {
      return parseZip(await readFile(path), url, cached.mtime);
    } catch (err) {
      console.warn(`[gtfs] cached ${path} unreadable, re-downloading:`, (err as Error).message);
    }
  }

  try {
    const zip = await download(url);
    const feed = parseZip(zip, url, new Date()); // validate before touching the cache
    await mkdir(cfg.cacheDir, { recursive: true });
    await writeFile(path + '.tmp', zip);
    await rename(path + '.tmp', path);
    console.log(`[gtfs] downloaded ${url}: ${feed.routes.size} routes, ${feed.trips.size} trips, ${feed.stops.length} stops`);
    return feed;
  } catch (err) {
    console.warn(`[gtfs] download failed for ${url}:`, (err as Error).message);
  }

  if (current) return current;
  if (cached) {
    try {
      console.warn(`[gtfs] using stale cache for ${url}`);
      return parseZip(await readFile(path), url, cached.mtime);
    } catch {
      /* fall through */
    }
  }
  console.warn(`[gtfs] no static data for ${url}; stops and fake buses will be incomplete`);
  return null;
}

let loading: Promise<void> | null = null;

async function loadAll(force = false) {
  const next = await Promise.all(cfg.staticUrls.map((url, i) => loadFeed(url, feeds[i] ?? null, force).catch(() => feeds[i] ?? null)));
  const changed = next.some((f, i) => f !== feeds[i]);
  feeds = next;
  if (changed) for (const fn of listeners) fn();
}

export function refreshStaticGtfs(force = false): Promise<void> {
  loading ??= loadAll(force).finally(() => (loading = null));
  return loading;
}

// Call once at startup. Loads (or downloads) the static data, then re-checks hourly.
export async function initStaticGtfs(): Promise<void> {
  await refreshStaticGtfs();
  // Also retries hourly if the first download failed.
  setInterval(() => {
    refreshStaticGtfs().catch((err) => console.warn('[gtfs] refresh error:', err));
  }, cfg.staticCheckIntervalMs).unref();
}
