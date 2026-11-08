// Resolving one entry of the warm list (src/planner/places-warm.ts), for
// npm run geocode:warm. Three sources:
//   fixed:     known coordinates from src/demoPlaces.ts (no network).
//   gtfs:      a GRT stop or ION station from the local stops file (no network,
//              exact names). ION platforms ("- Northbound"/"- Southbound") are merged
//              into one station at their midpoint.
//   nominatim: a fresh search (1 per second, the app's User-Agent), limited to the KW
//              area. A result must pass the entry's checks (expected name / town),
//              otherwise the place is reported unresolved instead of guessed.

import { haversineM } from '../geo.js';
import type { Stop } from '../transit/staticGtfs.js';
import * as P from './config.js';
import { storeWarm, warmSearch, type GeoResult } from './geocode.js';
import { rankResults } from './places.js';
import type { WarmPlace } from './places-warm.js';

export type WarmOutcome =
  | { ok: true; via: 'fixed' | 'gtfs' | 'nominatim'; result: GeoResult }
  | { ok: false; via: 'fixed' | 'gtfs' | 'nominatim'; reason: string };

/** Station platforms more than this far apart are treated as different places. */
const MAX_STATION_SPREAD_M = 500;

const baseName = (n: string) => n.replace(/\s*-\s*(North|South|East|West)bound$/i, '').trim();
const lower = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * A stop or station by exact name (case and direction suffix ignored). `feeds` is the
 * stops per feed, preferred first (ION before buses, so stations use rail platforms).
 */
export function stationFromStops(name: string, feeds: Stop[][]): GeoResult | { error: string } {
  for (const stops of feeds) {
    const matches = stops.filter((s) => lower(baseName(s.name)) === lower(name));
    if (!matches.length) continue;
    const lat = matches.reduce((n, s) => n + s.lat, 0) / matches.length;
    const lng = matches.reduce((n, s) => n + s.lng, 0) / matches.length;
    if (matches.some((s) => haversineM([lat, lng], [s.lat, s.lng]) > MAX_STATION_SPREAD_M)) return { error: 'several far-apart stops share that name' };
    if (!P.inKwArea(lat, lng)) return { error: 'outside the KW area' };
    return { name: baseName(matches[0]!.name), lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6, town: null };
  }
  return { error: 'not in the GRT stops data' };
}

function passes(entry: WarmPlace, r: GeoResult): boolean {
  const x = entry.expect;
  if (!x) return true;
  if (x.name && !x.name.test(r.name)) return false;
  if (x.town && lower(r.town ?? '') !== lower(x.town)) return false;
  return true;
}

/** Resolve one entry and store it (under its key and aliases, 30 days). Never throws. */
export async function warmOne(entry: WarmPlace, stopsByFeed: Stop[][]): Promise<WarmOutcome> {
  if (entry.fixed) {
    const result: GeoResult = { ...entry.fixed };
    if (!P.inKwArea(result.lat, result.lng)) return { ok: false, via: 'fixed', reason: 'outside the KW area' };
    storeWarm(entry.key, [result]);
    for (const a of entry.aliases ?? []) storeWarm(a, [result]);
    return { ok: true, via: 'fixed', result };
  }
  if (entry.stop) {
    const r = stationFromStops(entry.stop, stopsByFeed);
    if ('error' in r) return { ok: false, via: 'gtfs', reason: r.error };
    const result = entry.label ? { ...r, name: entry.label } : r;
    storeWarm(entry.key, [result]);
    for (const a of entry.aliases ?? []) storeWarm(a, [result]);
    return { ok: true, via: 'gtfs', result };
  }

  const query = entry.query ?? entry.key;
  const found = await warmSearch(query);
  if (!found.ok) return { ok: false, via: 'nominatim', reason: found.reason };
  if (!found.results.length) return { ok: false, via: 'nominatim', reason: found.outside ? 'only results outside the KW area' : 'no match in the KW area' };
  const ranked = rankResults(query, found.results, null);
  let good = ranked.filter((r) => passes(entry, r));
  if (!good.length) {
    const got = ranked[0]!;
    return { ok: false, via: 'nominatim', reason: `no result passed the checks (top result: ${got.name}${got.town ? `, ${got.town}` : ''})` };
  }
  // An address search has no place name: show the place's own name instead of "151".
  if (entry.label) good = good.map((r) => ({ ...r, name: [entry.label, ...r.name.split(', ').slice(1)].join(', ') }));
  storeWarm(entry.key, good);
  for (const a of entry.aliases ?? []) storeWarm(a, [good[0]!]); // best match only: an alias shares no words with the name
  return { ok: true, via: 'nominatim', result: good[0]! };
}
