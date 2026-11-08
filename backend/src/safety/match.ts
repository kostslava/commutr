// Route safety lookup: load the saved ratings (no network) and match a request to a
// precomputed demo route. A request matches when its origin is within MATCH_RADIUS_M of
// one end of a route and its destination within MATCH_RADIUS_M of the other (either
// direction), or when the names match an endpoint's name or alias.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Endpoint } from './routes.js';
import { metres, type RatingsFile, type SavedRoute } from './rating.js';

export const MATCH_RADIUS_M = 400;

export type PlaceQuery = string | { lat: number; lng: number };

/** ratings.json: next to this file in src/, or src/safety/ when running the build from dist/. */
export function ratingsPath(): string {
  if (process.env.SAFETY_RATINGS_FILE) return process.env.SAFETY_RATINGS_FILE;
  for (const rel of ['./ratings.json', '../../src/safety/ratings.json']) {
    const p = fileURLToPath(new URL(rel, import.meta.url));
    if (existsSync(p)) return p;
  }
  return fileURLToPath(new URL('./ratings.json', import.meta.url));
}

let cache: { path: string; mtimeMs: number; file: RatingsFile } | null = null;

/** The saved ratings, or null if the file is missing, unreadable or has no routes. */
export function loadRatings(): RatingsFile | null {
  const path = ratingsPath();
  try {
    const mtimeMs = statSync(path).mtimeMs;
    if (cache?.path === path && cache.mtimeMs === mtimeMs) return cache.file;
    const file = JSON.parse(readFileSync(path, 'utf8')) as RatingsFile;
    if (!file || !Array.isArray(file.routes) || !file.routes.length) return null;
    cache = { path, mtimeMs, file };
    return file;
  } catch {
    return null;
  }
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b(the|of)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Does the query name this endpoint? Exact name or alias, or the query contains the full name. */
export function nameMatches(query: string, e: Endpoint): boolean {
  const q = norm(query);
  if (!q) return false;
  const names = [e.name, ...e.aliases].map(norm).filter(Boolean);
  return names.some((n) => n === q) || (norm(e.name).length >= 6 && q.includes(norm(e.name)));
}

export function placeMatches(query: PlaceQuery, e: Endpoint): boolean {
  return typeof query === 'string' ? nameMatches(query, e) : metres([query.lat, query.lng], [e.lat, e.lng]) <= MATCH_RADIUS_M;
}

export function findRoute(routes: SavedRoute[], origin: PlaceQuery, destination: PlaceQuery): SavedRoute | null {
  return (
    routes.find((r) => placeMatches(origin, r.from) && placeMatches(destination, r.to)) ??
    routes.find((r) => placeMatches(origin, r.to) && placeMatches(destination, r.from)) ??
    null
  );
}
