// Background start-up work, run AFTER the server is listening so /health answers at once:
//   1. GRT static GTFS (disk cache or download, ~2 MB; up to ~30 s on a slow host)
//   2. the planner's warmed places (src/planner/places-warm.ts): GRT stops and fixed demo
//      places offline, the rest from Nominatim at 1 request per 1.1 s. Only places not
//      already cached are searched. On by default in production (the host's disk is wiped
//      on every restart), off otherwise; PLACE_WARM_ON_BOOT=1 / 0 forces it.
// Until GTFS is ready, live buses fall back to fake ones and plans have no transit option,
// exactly as when the GTFS download fails. Never throws.

import { hasFreshCache } from './planner/geocode.js';
import { WARM_PLACES } from './planner/places-warm.js';
import { warmOne } from './planner/warm.js';
import { getStaticFeeds, initStaticGtfs } from './transit/staticGtfs.js';

const isProduction = process.env.NODE_ENV === 'production';
const warmSetting = process.env.PLACE_WARM_ON_BOOT;
const warmOnBoot = warmSetting === '1' || (warmSetting !== '0' && isProduction);

export async function bootInBackground(): Promise<void> {
  const t0 = Date.now();
  try {
    await initStaticGtfs();
    const stops = getStaticFeeds().reduce((n, f) => n + (f?.stops.length ?? 0), 0);
    console.log(`[boot] GTFS ready after ${Date.now() - t0} ms (${stops} stops)`);
  } catch (err) {
    console.warn(`[boot] GTFS start-up failed: ${(err as Error).message}`);
  }
  if (!warmOnBoot) return;

  const t1 = Date.now();
  const feeds = getStaticFeeds();
  const stopsByFeed = [feeds[1]?.stops ?? [], feeds[0]?.stops ?? []];
  let done = 0, skipped = 0, failed = 0;
  for (const p of WARM_PLACES) {
    if (hasFreshCache(p.key)) {
      skipped++;
      continue;
    }
    const r = await warmOne(p, stopsByFeed).catch(() => ({ ok: false }) as const);
    if (r.ok) done++;
    else failed++;
  }
  // Counts only: no place names, coordinates or keys.
  console.log(`[boot] place warm-up done after ${Date.now() - t1} ms: ${done} stored, ${skipped} already cached, ${failed} not resolved`);
}
