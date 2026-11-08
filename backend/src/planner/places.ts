// Origin and destination for a plan.
//
// Destination: a string is matched against the user's saved locations ("home",
// "campus"), then the demo merchants, then Nominatim (KW only). An object
// { name, lat, lng } is used as given.
//
// Privacy: coordinates stay on the server. Gemini only ever sees a place id
// ("place_1") and a safe name: saved locations are "your home" / "your saved
// place", never the user's own label.

import type { DB } from '../db.js';
import { haversineKm, type LatLng } from '../geo.js';
import * as P from './config.js';
import { geocode } from './geocode.js';

export type PlaceKind = 'saved' | 'merchant' | 'search' | 'given';

export type Place = {
  id: string;
  /** What Gemini may see. */
  safe_name: string;
  /** What the user's own app shows (may be their own label for a saved place). */
  display_name: string;
  kind: PlaceKind;
  at: LatLng;
};

/**
 * Where a plan starts. `name` is how the starting point is said out loud, and the only
 * part of it Gemini ever sees: "your saved home", "your current location", or a
 * place name ("University of Waterloo"). Never coordinates.
 */
export type Origin = { at: LatLng; kind: 'home' | 'given' | 'named'; name: string };

export type OriginError = 'invalid' | 'conflict' | 'origin_not_found' | 'search_unavailable';

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
export const validLatLng = (lat: unknown, lng: unknown) => isNum(lat) && isNum(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

export const HOME_NAME = 'your saved home';
export const CURRENT_LOCATION_NAME = 'your current location';

/** The spoken name of a resolved place: its first part only ("Waterloo Public Library - Main"). */
function spokenName(p: Place): string {
  if (p.kind === 'saved') return p.safe_name; // never the user's own label
  if (p.kind === 'merchant') return p.display_name;
  return p.display_name.split(', ')[0]!.trim();
}

/**
 * The starting point, in this order: origin_name (a place, resolved like destinations,
 * KW area only), else origin_lat/origin_lng, else the saved home, else null.
 * Sending origin_name together with coordinates is a conflict.
 */
export async function resolveOrigin(db: DB, userId: number, body: Record<string, unknown>, timeoutMs: number): Promise<Origin | OriginError | null> {
  const { origin_lat: lat, origin_lng: lng, origin_name: name } = body;
  const hasCoords = lat !== undefined || lng !== undefined;
  if (name !== undefined) {
    if (hasCoords) return 'conflict';
    if (typeof name !== 'string' || !name.trim() || name.length > 120) return 'invalid';
    const found = await resolveDestination(db, userId, name.trim(), new PlaceBook(), timeoutMs);
    if (!found.ok) return found.code === 'destination_not_found' ? 'origin_not_found' : 'search_unavailable';
    const p = found.candidates[0]!;
    if (p.kind === 'saved' && p.safe_name === 'your home') return { at: p.at, kind: 'home', name: HOME_NAME };
    return { at: p.at, kind: 'named', name: spokenName(p) };
  }
  if (hasCoords) return validLatLng(lat, lng) ? { at: [lat as number, lng as number], kind: 'given', name: CURRENT_LOCATION_NAME } : 'invalid';
  const home = db.prepare("SELECT lat, lng FROM saved_locations WHERE user_id = ? AND kind = 'home'").get(userId) as { lat: number; lng: number } | undefined;
  return home ? { at: [home.lat, home.lng], kind: 'home', name: HOME_NAME } : null;
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b(my|the|to|go|get|take me|please)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export type DestinationInput = string | { name: string; lat: number; lng: number };

export function parseDestination(v: unknown): DestinationInput | null {
  if (typeof v === 'string') return v.trim().length > 0 && v.length <= 200 ? v.trim() : null;
  if (typeof v === 'object' && v !== null) {
    const o = v as Record<string, unknown>;
    if (typeof o.name === 'string' && o.name.trim() && o.name.length <= 120 && validLatLng(o.lat, o.lng)) return { name: o.name.trim(), lat: o.lat as number, lng: o.lng as number };
  }
  return null;
}

/** Places for this request, by id. Ids are only meaningful within one plan. */
export class PlaceBook {
  private places = new Map<string, Place>();
  add(p: Omit<Place, 'id'>): Place {
    const place = { ...p, id: `place_${this.places.size + 1}` };
    this.places.set(place.id, place);
    return place;
  }
  get(id: string) {
    return this.places.get(id);
  }
}

export type Resolved = { ok: true; candidates: Place[]; usedSearch: boolean } | { ok: false; code: 'destination_not_found' | 'search_unavailable' };

function localMatches(db: DB, userId: number, text: string, book: PlaceBook): Place[] {
  const q = norm(text);
  if (!q) return [];
  const saved = db.prepare('SELECT kind, label, lat, lng FROM saved_locations WHERE user_id = ? ORDER BY id').all(userId) as {
    kind: 'home' | 'favourite';
    label: string;
    lat: number;
    lng: number;
  }[];
  for (const s of saved) {
    const label = norm(s.label);
    if ((s.kind === 'home' && (q === 'home' || q === 'house')) || (label && q === label)) {
      return [book.add({ safe_name: s.kind === 'home' ? 'your home' : 'your saved place', display_name: s.label, kind: 'saved', at: [s.lat, s.lng] })];
    }
  }
  const merchants = db.prepare('SELECT name, lat, lng FROM merchants WHERE lat IS NOT NULL AND lng IS NOT NULL ORDER BY id').all() as { name: string; lat: number; lng: number }[];
  const hits = merchants.filter((m) => {
    const n = norm(m.name);
    return n === q || (q.length >= 4 && (n.includes(q) || q.includes(n)));
  });
  return hits.slice(0, 3).map((m) => book.add({ safe_name: `${m.name} (demo merchant)`, display_name: m.name, kind: 'merchant', at: [m.lat, m.lng] }));
}

const STOPWORDS = new Set(['a', 'an', 'and', 'at', 'by', 'for', 'in', 'of', 'on', 'or', 'st', 'the']);
const words = (s: string) => new Set(norm(s).split(' ').filter((w) => w && !STOPWORDS.has(w)));

/** Share of the requested words that appear in the result's name (0..1). */
export function nameMatch(requested: string, name: string): number {
  const want = words(requested);
  if (!want.size) return 0;
  const have = words(name);
  let n = 0;
  for (const w of want) if (have.has(w)) n++;
  return n / want.size;
}

/**
 * Best match first: by word overlap with the requested text, ties broken by distance
 * from the origin. (Nominatim's own order can put "Kitchener Public Library" before
 * "Waterloo Public Library" for the query "Waterloo Public Library".)
 */
export function rankResults<T extends { name: string; lat: number; lng: number }>(requested: string, results: T[], origin: LatLng | null): T[] {
  return results
    .map((r, i) => ({ r, i, score: nameMatch(requested, r.name), km: origin ? haversineKm(origin, [r.lat, r.lng]) : 0 }))
    .sort((a, b) => b.score - a.score || a.km - b.km || a.i - b.i)
    .map((x) => x.r);
}

/** Resolve the destination into up to 3 candidates, best first. */
export async function resolveDestination(db: DB, userId: number, input: DestinationInput, book: PlaceBook, timeoutMs: number, origin: LatLng | null = null): Promise<Resolved> {
  if (typeof input === 'object') {
    return { ok: true, candidates: [book.add({ safe_name: input.name, display_name: input.name, kind: 'given', at: [input.lat, input.lng] })], usedSearch: false };
  }
  const local = localMatches(db, userId, input, book);
  if (local.length) return { ok: true, candidates: local, usedSearch: false };

  const found = await geocode(input, Math.min(timeoutMs, P.GEOCODE_TIMEOUT_MS));
  if (!found.ok) return { ok: false, code: 'search_unavailable' };
  if (!found.results.length) return { ok: false, code: 'destination_not_found' };
  return {
    ok: true,
    candidates: rankResults(input, found.results, origin).map((r) => book.add({ safe_name: r.name, display_name: r.name, kind: 'search', at: [r.lat, r.lng] })),
    usedSearch: true,
  };
}

export const straightKm = (o: Origin, p: Place) => haversineKm(o.at, p.at);
