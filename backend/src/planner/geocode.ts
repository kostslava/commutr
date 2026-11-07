// Place search with Nominatim (OpenStreetMap). Usage policy: a User-Agent that
// names the app, at most 1 request per second, cache results. Only the search
// text is sent, never the user's position; the search is limited to the KW box.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as P from './config.js';

export type GeoResult = { name: string; lat: number; lng: number };

const CACHE_FILE = process.env.GEOCODE_CACHE_FILE || fileURLToPath(new URL('../../data/geocode-cache.json', import.meta.url));

/** `expires` (ms): 24 h for normal searches, 30 days for warmed places. Older entries without it count as 24 h. */
type CacheEntry = { at: number; expires?: number; results: GeoResult[] };
const expiresAt = (e: CacheEntry) => e.expires ?? e.at + P.GEOCODE_CACHE_MS;
let cache: Record<string, CacheEntry> = load();

function load(): Record<string, CacheEntry> {
  try {
    return JSON.parse(readFileSync(CACHE_FILE, 'utf8')) as Record<string, CacheEntry>;
  } catch {
    return {};
  }
}

function save() {
  try {
    const now = Date.now();
    cache = Object.fromEntries(Object.entries(cache).filter(([, e]) => expiresAt(e) > now));
    mkdirSync(dirname(CACHE_FILE), { recursive: true });
    writeFileSync(CACHE_FILE + '.tmp', JSON.stringify(cache));
    renameSync(CACHE_FILE + '.tmp', CACHE_FILE);
  } catch {
    /* best effort */
  }
}

const normalise = (q: string) => q.toLowerCase().replace(/\s+/g, ' ').trim();

/** "Waterloo Public Library, 35, Albert Street, Uptown, Waterloo, ..." -> "Waterloo Public Library, Albert Street, Waterloo" */
function shortName(r: { name?: string; display_name?: string; address?: Record<string, string> }): string {
  const a = r.address ?? {};
  const street = a.road ?? a.pedestrian ?? a.footway;
  const town = a.city ?? a.town ?? a.village ?? a.suburb;
  const parts = [r.name || (r.display_name ?? '').split(',')[0], street, town].filter((x): x is string => !!x && x.trim() !== '');
  return [...new Set(parts.map((x) => x.trim()))].join(', ').slice(0, 120);
}

// One request at a time, spaced by NOMINATIM_MIN_INTERVAL_MS.
let nextSlot = 0;

export type GeocodeOutcome = { ok: true; results: GeoResult[]; cached: boolean } | { ok: false; reason: 'timeout' | 'error' | 'no_time' };

/** One Nominatim request within the KW box (waits for its 1-per-second slot). No cache. */
async function search(query: string, timeoutMs: number): Promise<{ ok: true; results: GeoResult[] } | { ok: false; reason: 'timeout' | 'error' | 'no_time' }> {
  const now = Date.now();
  const waitMs = Math.max(0, nextSlot - now);
  if (waitMs >= timeoutMs - 300) return { ok: false, reason: 'no_time' };
  nextSlot = Math.max(now, nextSlot) + P.NOMINATIM_MIN_INTERVAL_MS;
  if (waitMs) await new Promise((r) => setTimeout(r, waitMs));

  const v = P.KW_VIEWBOX;
  const url = new URL('/search', P.NOMINATIM_BASE_URL);
  url.search = new URLSearchParams({
    q: query,
    format: 'jsonv2',
    addressdetails: '1',
    limit: '3',
    countrycodes: 'ca',
    viewbox: `${v.west},${v.north},${v.east},${v.south}`,
    bounded: '1',
  }).toString();

  try {
    const res = await fetch(url, { headers: { 'User-Agent': P.NOMINATIM_USER_AGENT, Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs - waitMs) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { lat: string; lon: string; name?: string; display_name?: string; address?: Record<string, string> }[];
    const results = body
      .map((r) => ({ name: shortName(r), lat: Number(r.lat), lng: Number(r.lon) }))
      .filter((r) => r.name && Number.isFinite(r.lat) && Number.isFinite(r.lng));
    return { ok: true, results };
  } catch (err) {
    const timeout = (err as Error).name === 'TimeoutError';
    console.warn(`[planner] place search failed: ${timeout ? 'timed out' : (err as Error).message}`);
    return { ok: false, reason: timeout ? 'timeout' : 'error' };
  }
}

/** Search within the KW box, cached (24 h, or 30 days for warmed places). `timeoutMs` covers waiting for a slot plus the request. */
export async function geocode(query: string, timeoutMs: number): Promise<GeocodeOutcome> {
  const key = normalise(query);
  const hit = cache[key];
  if (hit && expiresAt(hit) > Date.now()) return { ok: true, results: hit.results, cached: true };
  const found = await search(query, timeoutMs);
  if (!found.ok) return found;
  cache[key] = { at: Date.now(), results: found.results };
  save();
  return { ok: true, results: found.results, cached: false };
}

/** Fresh search for npm run geocode:warm (no cache read). Same slot and User-Agent rules. */
export const warmSearch = (query: string) => search(query, 15_000);

/** Store a pre-loaded place under `key` (what users say) for P.GEOCODE_WARM_MS. */
export function storeWarm(key: string, results: GeoResult[]) {
  const at = Date.now();
  cache[normalise(key)] = { at, expires: at + P.GEOCODE_WARM_MS, results };
  save();
}
