// Live GRT vehicle positions (GTFS-realtime protobuf) as plain JSON.
// Cached for 10 s. Falls back to fake vehicles when the feed fails, times out,
// is stale (header older than 5 min) or has zero vehicles. Never throws.

import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import { transitConfig as cfg } from './config.js';
import { fakeVehicles } from './fakeBuses.js';
import { getStaticFeeds } from './staticGtfs.js';

const { transit_realtime } = GtfsRealtimeBindings;

export type Vehicle = {
  id: string;
  route_id: string | null;
  route_short_name: string | null;
  headsign: string | null;
  lat: number;
  lng: number;
  bearing: number | null; // degrees, 0 = north
  speed: number | null; // km/h
  timestamp: string; // ISO 8601 UTC
};

export type LiveResult = {
  source: 'live' | 'fake';
  updated_at: string;
  vehicles: Vehicle[];
};

// protobufjs gives 64-bit ints as numbers or Long objects.
type LongLike = number | { toNumber(): number } | null | undefined;
const toNum = (v: LongLike) => (v == null ? null : typeof v === 'number' ? v : v.toNumber());

// protobufjs fills unset optional fields with defaults (0) on the prototype, so
// "not sent" looks like 0. Only own properties were actually in the feed.
// (GRT currently sends no bearing or speed at all.)
const sent = (obj: object, key: string) => Object.prototype.hasOwnProperty.call(obj, key);

async function fetchFeed(url: string, index: number): Promise<{ vehicles: Vehicle[]; headerMs: number }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(cfg.feedTimeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const msg = transit_realtime.FeedMessage.decode(new Uint8Array(await res.arrayBuffer()));

  const headerSec = toNum(msg.header.timestamp as LongLike);
  if (!headerSec) throw new Error('feed has no header timestamp');
  const headerMs = headerSec * 1000;
  const ageMs = Date.now() - headerMs;
  if (ageMs > cfg.staleAfterMs) throw new Error(`stale feed: header is ${Math.round(ageMs / 60_000)} min old`);

  const statics = getStaticFeeds()[index] ?? null;
  const vehicles: Vehicle[] = [];
  for (const e of msg.entity) {
    const v = e.vehicle;
    const pos = v?.position;
    if (!v || !pos || !Number.isFinite(pos.latitude) || !Number.isFinite(pos.longitude)) continue;

    const tripId = v.trip?.tripId || null;
    const trip = tripId ? statics?.trips.get(tripId) : undefined;
    const routeId = v.trip?.routeId || trip?.route_id || null;
    const route = routeId ? statics?.routes.get(routeId) : undefined;
    const vehicleSec = toNum(v.timestamp as LongLike);

    vehicles.push({
      id: v.vehicle?.id || e.id,
      route_id: routeId,
      route_short_name: route?.short_name ?? null,
      headsign: trip?.headsign ?? null,
      lat: Math.round(pos.latitude * 1e6) / 1e6,
      lng: Math.round(pos.longitude * 1e6) / 1e6,
      bearing: sent(pos, 'bearing') ? Math.round(pos.bearing!) : null,
      speed: sent(pos, 'speed') ? Math.round(pos.speed! * 3.6 * 10) / 10 : null, // m/s -> km/h
      timestamp: new Date((vehicleSec || headerSec) * 1000).toISOString(),
    });
  }
  return { vehicles, headerMs };
}

// Log only when the feed state changes, not on every 10 s refresh.
let lastState: string | null = null;
function logState(state: string, message: () => string, level: 'log' | 'warn' = 'warn') {
  if (state === lastState) return;
  lastState = state;
  console[level](`[buses] ${message()}`);
}

async function build(): Promise<LiveResult> {
  try {
    const results = await Promise.allSettled(cfg.vehicleUrls.map((url, i) => fetchFeed(url, i)));
    const ok = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
    const failures = results.flatMap((r, i) => (r.status === 'rejected' ? [`${cfg.vehicleUrls[i]}: ${errMsg(r.reason)}`] : []));
    const reason = failures.join('; ');

    const vehicles = ok.flatMap((r) => r.vehicles);
    // Live if at least one feed works (e.g. buses up, ION down).
    if (vehicles.length > 0) {
      if (failures.length) logState(`partial:${reason}`, () => `live, but some feeds failed: ${reason}`);
      else logState('live', () => 'live feed OK', 'log');
      return { source: 'live', updated_at: new Date(Math.max(...ok.map((r) => r.headerMs))).toISOString(), vehicles };
    }
    const why = failures.length ? reason : 'feeds returned zero vehicles';
    logState(`fake:${why}`, () => `using fake vehicles: ${why}`);
  } catch (err) {
    logState('fake:unexpected', () => `using fake vehicles, unexpected error: ${errMsg(err)}`);
  }

  try {
    return { source: 'fake', updated_at: new Date().toISOString(), vehicles: fakeVehicles() };
  } catch (err) {
    console.error('[buses] fake vehicles failed:', err);
    return { source: 'fake', updated_at: new Date().toISOString(), vehicles: [] };
  }
}

const errMsg = (e: unknown) =>
  e instanceof Error ? (e.name === 'TimeoutError' ? `timed out after ${cfg.feedTimeoutMs} ms` : e.cause instanceof Error ? `${e.message} (${e.cause.message})` : e.message) : String(e);

let cache: { at: number; value: LiveResult } | null = null;
let inflight: Promise<LiveResult> | null = null;

// Concurrent callers share one fetch; results (live or fake) are cached for 10 s.
export function getLiveVehicles(): Promise<LiveResult> {
  if (cache && Date.now() - cache.at < cfg.liveCacheMs) return Promise.resolve(cache.value);
  inflight ??= build()
    .then((value) => {
      cache = { at: Date.now(), value };
      return value;
    })
    .finally(() => (inflight = null));
  return inflight;
}
