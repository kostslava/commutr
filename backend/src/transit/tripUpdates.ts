// Live GRT trip updates (GTFS-realtime): predicted arrival times per stop.
// Used by the trip planner for "next bus". Cached 30 s; concurrent callers share
// one fetch. Never throws: a dead or stale feed just means no predictions (the
// planner then estimates from vehicle positions, or says nothing about the next bus).

import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import { transitConfig as cfg } from './config.js';

const { transit_realtime } = GtfsRealtimeBindings;

export type Arrival = { trip_id: string; route_id: string | null; stop_id: string; stop_sequence: number | null; at_ms: number };

/** stop_id -> upcoming arrivals at that stop, soonest first. */
export type ArrivalIndex = { ok: boolean; byStop: Map<string, Arrival[]> };

type LongLike = number | { toNumber(): number } | null | undefined;
const toNum = (v: LongLike) => (v == null ? null : typeof v === 'number' ? v : v.toNumber());

async function fetchFeed(url: string): Promise<Arrival[]> {
  const res = await fetch(url, { signal: AbortSignal.timeout(cfg.feedTimeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const msg = transit_realtime.FeedMessage.decode(new Uint8Array(await res.arrayBuffer()));
  const headerSec = toNum(msg.header.timestamp as LongLike);
  if (!headerSec || Date.now() - headerSec * 1000 > cfg.staleAfterMs) throw new Error('stale or undated feed');

  const out: Arrival[] = [];
  for (const e of msg.entity) {
    const tu = e.tripUpdate;
    if (!tu?.trip?.tripId) continue;
    for (const s of tu.stopTimeUpdate ?? []) {
      if (!s.stopId) continue;
      const sec = toNum((s.arrival?.time ?? s.departure?.time) as LongLike);
      if (!sec) continue;
      out.push({ trip_id: tu.trip.tripId, route_id: tu.trip.routeId || null, stop_id: s.stopId, stop_sequence: s.stopSequence ?? null, at_ms: sec * 1000 });
    }
  }
  return out;
}

let lastWarn = '';
async function build(): Promise<ArrivalIndex> {
  const results = await Promise.allSettled(cfg.tripUpdatesUrls.map(fetchFeed));
  const arrivals = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  const failed = results.flatMap((r, i) => (r.status === 'rejected' ? [`${cfg.tripUpdatesUrls[i]}: ${(r.reason as Error).message}`] : [])).join('; ');
  if (failed && failed !== lastWarn) console.warn(`[trip-updates] ${failed}`);
  lastWarn = failed;

  const byStop = new Map<string, Arrival[]>();
  for (const a of arrivals) {
    const list = byStop.get(a.stop_id) ?? [];
    list.push(a);
    byStop.set(a.stop_id, list);
  }
  for (const list of byStop.values()) list.sort((a, b) => a.at_ms - b.at_ms);
  return { ok: arrivals.length > 0, byStop };
}

let cache: { at: number; value: ArrivalIndex } | null = null;
let inflight: Promise<ArrivalIndex> | null = null;

export function getArrivals(): Promise<ArrivalIndex> {
  if (cache && Date.now() - cache.at < cfg.tripUpdatesCacheMs) return Promise.resolve(cache.value);
  inflight ??= build()
    .catch(() => ({ ok: false, byStop: new Map() }))
    .then((value) => {
      cache = { at: Date.now(), value };
      return value;
    })
    .finally(() => (inflight = null));
  return inflight;
}
