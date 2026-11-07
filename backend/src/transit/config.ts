import { fileURLToPath } from 'node:url';

// GRT publishes numbered feeds: 1 = buses, 2 = ION light rail.
// The old unnumbered URLs (…/api/vehiclepositions, …/opendatadownloads/GRT_GTFS.zip)
// are dead: frozen since 2026-02-17 and 404 respectively.
const BASE = 'https://webapps.regionofwaterloo.ca/api/grt-routes/api';

const urlList = (raw: string | undefined, fallback: string[]) =>
  raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : fallback;

export const ATTRIBUTION = 'Transit data: Grand River Transit, Region of Waterloo Open Data';

export const transitConfig = {
  // Realtime and static lists are paired by position: vehicle feed N is matched
  // against static feed N for route names and headsigns.
  vehicleUrls: urlList(process.env.GRT_VEHICLES_URLS, [`${BASE}/vehiclepositions/1`, `${BASE}/vehiclepositions/2`]),
  staticUrls: urlList(process.env.GRT_STATIC_URLS, [`${BASE}/staticfeeds/1`, `${BASE}/staticfeeds/2`]),

  feedTimeoutMs: Number(process.env.GRT_FEED_TIMEOUT_MS ?? 5_000),
  liveCacheMs: 10_000,
  // A feed whose header timestamp is older than this counts as failed.
  staleAfterMs: 5 * 60_000,

  staticTimeoutMs: 30_000,
  staticMaxAgeMs: 24 * 60 * 60_000,
  staticCheckIntervalMs: 60 * 60_000,
  cacheDir: fileURLToPath(new URL('../../data/gtfs/', import.meta.url)),
};
