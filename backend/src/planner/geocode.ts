// Place search with Nominatim (OpenStreetMap). Usage policy: a User-Agent that
// names the app, at most 1 request per second, cache results. Only the search
// text is sent, never the user's position; the search is limited to the KW box.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as P from './config.js';

/** `town` is the city or town from the address (for checks and printing), when known. */
export type GeoResult = { name: string; lat: number; lng: number; town?: string | null };

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
const townOf = (a: Record<string, string> = {}) => a.city ?? a.town ?? a.village ?? a.municipality ?? null;

function shortName(r: { name?: string; display_name?: string; address?: Record<string, string> }): string {
  const a = r.address ?? {};
  const street = a.road ?? a.pedestrian ?? a.footway;
  const town = a.city ?? a.town ?? a.village ?? a.suburb;
  const parts = [r.name || (r.display_name ?? '').split(',')[0], street, town].filter((x): x is string => !!x && x.trim() !== '');
  return [...new Set(parts.map((x) => x.trim()))].join(', ').slice(0, 120);
}

// One request at a time, spaced by NOMINATIM_MIN_INTERVAL_MS. User searches book the next
// slot. Background searches (the boot warm-up) never book ahead of users: they start only
// when no user search is queued and none started recently, so a user waits at most for
// one background request that already started.
let nextSlot = 0;
let lastUserSearch = 0;
let lastBackground = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait for a background slot. After P.BACKGROUND_MAX_WAIT_MS it goes ahead anyway, so the warm-up always finishes. */
async function backgroundSlot(): Promise<void> {
  const giveUpAt = Date.now() + P.BACKGROUND_MAX_WAIT_MS;
  for (;;) {
    const now = Date.now();
    const free = now >= nextSlot && now - lastUserSearch >= P.BACKGROUND_QUIET_MS && now - lastBackground >= P.BACKGROUND_INTERVAL_MS;
    if (free || now >= giveUpAt) {
      const start = Math.max(now, nextSlot);
      nextSlot = start + P.NOMINATIM_MIN_INTERVAL_MS;
      lastBackground = start;
      if (start > now) await sleep(start - now);
      return;
    }
    await sleep(P.BACKGROUND_POLL_MS);
  }
}

export type GeocodeOutcome = { ok: true; results: GeoResult[]; cached: boolean } | { ok: false; reason: 'timeout' | 'error' | 'no_time' };

/**
 * One Nominatim request within the KW box (waits for its 1-per-second slot). No cache.
 * `background`: lower priority (see backgroundSlot); `timeoutMs` then covers only the request.
 */
/** A search box (degrees). Must lie inside P.KW_VIEWBOX; results outside the KW area are dropped regardless. */
export type Box = { west: number; north: number; east: number; south: number };
/** Search options for callers other than the planner. The defaults are the planner's: 3 results, the whole KW box. */
export type SearchOptions = { limit?: number; box?: Box };
const DEFAULT_LIMIT = 3;

async function search(query: string, timeoutMs: number, background = false, opts: SearchOptions = {}): Promise<{ ok: true; results: GeoResult[]; outside: number } | { ok: false; reason: 'timeout' | 'error' | 'no_time' }> {
  let waitMs = 0;
  if (background) {
    await backgroundSlot();
  } else {
    const now = Date.now();
    lastUserSearch = now;
    waitMs = Math.max(0, nextSlot - now);
    if (waitMs >= timeoutMs - 300) return { ok: false, reason: 'no_time' };
    nextSlot = Math.max(now, nextSlot) + P.NOMINATIM_MIN_INTERVAL_MS;
    if (waitMs) await sleep(waitMs);
  }

  const v = opts.box ?? P.KW_VIEWBOX;
  const url = new URL('/search', P.nominatimBaseUrl());
  url.search = new URLSearchParams({
    q: query,
    format: 'jsonv2',
    addressdetails: '1',
    limit: String(opts.limit ?? DEFAULT_LIMIT),
    countrycodes: 'ca',
    viewbox: `${v.west},${v.north},${v.east},${v.south}`,
    bounded: '1',
  }).toString();

  try {
    const res = await fetch(url, { headers: { 'User-Agent': P.NOMINATIM_USER_AGENT, Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs - waitMs) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { lat: string; lon: string; name?: string; display_name?: string; address?: Record<string, string> }[];
    const results = body
      .map((r) => ({ name: shortName(r), lat: Number(r.lat), lng: Number(r.lon), town: townOf(r.address) }))
      .filter((r) => r.name && Number.isFinite(r.lat) && Number.isFinite(r.lng));
    // bounded=1 should already do this; drop anything outside the KW area regardless.
    const inside = results.filter((r) => P.inKwArea(r.lat, r.lng));
    return { ok: true, results: inside, outside: results.length - inside.length };
  } catch (err) {
    const timeout = (err as Error).name === 'TimeoutError';
    console.warn(`[planner] place search failed: ${timeout ? 'timed out' : (err as Error).message}`);
    return { ok: false, reason: timeout ? 'timeout' : 'error' };
  }
}

/** Search within the KW box, cached (24 h, or 30 days for warmed places). `timeoutMs` covers waiting for a slot plus the request. */
export async function geocode(query: string, timeoutMs: number, opts: SearchOptions = {}): Promise<GeocodeOutcome> {
  const key = searchKey(query, opts);
  const hit = cache[key];
  if (hit && expiresAt(hit) > Date.now()) return { ok: true, results: hit.results, cached: true };
  const found = await search(query, timeoutMs, false, opts);
  if (!found.ok) return found;
  cache[key] = { at: Date.now(), results: found.results };
  save();
  return { ok: true, results: found.results, cached: false };
}

/**
 * Cache key: the normalised query for the planner's default search (so warmed places and
 * existing entries keep working); other limits or boxes get their own key.
 */
function searchKey(query: string, opts: SearchOptions): string {
  const key = normalise(query);
  const limit = opts.limit ?? DEFAULT_LIMIT;
  if (limit === DEFAULT_LIMIT && !opts.box) return key;
  const b = opts.box;
  return `${key}|limit=${limit}` + (b ? `|box=${b.west},${b.north},${b.east},${b.south}` : '');
}

/**
 * Remember places a search showed the user under their own names (24 h, the normal
 * expiry), so a later plan for the same name resolves to the same place with no new
 * request. Never replaces a fresh entry (a warmed place keeps its checked result).
 */
export function rememberPlaces(places: GeoResult[]) {
  let changed = false;
  for (const p of places) {
    const keys = new Set([normalise(p.name)]);
    const first = p.name.split(', ')[0]!.trim();
    // The short name too ("Victoria Park"), when it is specific enough (two words or more).
    if (first.split(/\s+/).length >= 2) keys.add(normalise(first));
    for (const k of keys) {
      if (hasFreshCache(k)) continue;
      cache[k] = { at: Date.now(), results: [p] };
      changed = true;
    }
  }
  if (changed) save();
}

/** Fresh search for npm run geocode:warm (no cache read). Same slot and User-Agent rules. */
export const warmSearch = (query: string) => search(query, 15_000);
/** The same at low priority, for the warm-up at server boot: never delays a user search. */
export const backgroundWarmSearch = (query: string) => search(query, 15_000, true);

/** Store a pre-loaded place under `key` (what users say) for P.GEOCODE_WARM_MS. */
export function storeWarm(key: string, results: GeoResult[]) {
  const at = Date.now();
  cache[normalise(key)] = { at, expires: at + P.GEOCODE_WARM_MS, results };
  save();
}

/** Remove cache entries by key (case and spacing ignored). Returns how many were removed. */
export function deleteCached(keys: string[]): number {
  let n = 0;
  for (const k of keys) {
    const key = normalise(k);
    if (key in cache) {
      delete cache[key];
      n++;
    }
  }
  save();
  return n;
}

/** Remove every cache entry with a result outside the KW area. Returns how many were removed. */
export function pruneOutsideArea(): number {
  let n = 0;
  for (const [k, e] of Object.entries(cache)) {
    if (e.results.some((r) => !P.inKwArea(r.lat, r.lng))) {
      delete cache[k];
      n++;
    }
  }
  save();
  return n;
}

export const cachedKeys = () => Object.keys(cache);

/** True when `key` has an unexpired cache entry. */
export function hasFreshCache(key: string): boolean {
  const e = cache[normalise(key)];
  return !!e && expiresAt(e) > Date.now();
}
