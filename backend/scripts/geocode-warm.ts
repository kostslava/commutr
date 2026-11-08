// Pre-load common Kitchener-Waterloo destinations into the planner's geocode cache
// (backend/data/geocode-cache.json, 30-day expiry).
//   - GRT stops and ION stations come from the local stops file (no network).
//   - Everything else: real Nominatim, the app's User-Agent, 1 request per second,
//     limited to the KW area; results outside it, or failing an entry's checks, are
//     reported unresolved, never stored.
// First removes every warm-list key, retired keys and any cached result outside the
// KW area, so old wrong entries can't linger. Prints requested name, resolved name and
// town only (no coordinates).
//
//   npm run geocode:warm                          every place on the list
//   npm run geocode:warm -- --only "Builders Club"  just one entry (by key, case ignored)
//
// Exit 0 even when some places don't resolve (this is a report, not a test).

import '../src/env.js';
import { deleteCached, pruneOutsideArea } from '../src/planner/geocode.js';
import { RETIRED_KEYS, WARM_PLACES } from '../src/planner/places-warm.js';
import { warmOne } from '../src/planner/warm.js';
import { getStaticFeeds, loadStaticFromDisk } from '../src/transit/staticGtfs.js';

const onlyArg = process.argv.indexOf('--only');
const only = onlyArg > 0 ? process.argv[onlyArg + 1] : undefined;
const places = only ? WARM_PLACES.filter((p) => p.key.toLowerCase() === only.toLowerCase()) : WARM_PLACES;
if (only && !places.length) {
  console.log(`No warm-list entry named "${only}". Keys: ${WARM_PLACES.map((p) => p.key).join(', ')}`);
  process.exit(1);
}
const removed = deleteCached([...places.flatMap((p) => [p.key, ...(p.aliases ?? [])]), ...(only ? [] : RETIRED_KEYS)]);
const outside = pruneOutsideArea();
console.log(`Cache clean-up: removed ${removed} warm-list entries and ${outside} entries outside the KW area.`);

await loadStaticFromDisk();
// ION feed (2) first so stations use the rail platforms, then buses (1).
const feeds = getStaticFeeds();
const stopsByFeed = [feeds[1]?.stops ?? [], feeds[0]?.stops ?? []];
if (!stopsByFeed.some((s) => s.length)) console.log('Note: no cached GRT stops data (run the backend once to download it); stop entries will be unresolved.');

const searches = places.filter((p) => !p.stop && !p.fixed).length;
const offline = places.length - searches;
console.log(`Geocode warm-up: ${places.length} place(s) (${offline} without network: GRT stops or fixed demo places; ${searches} searches, about ${Math.ceil(searches * 1.1)} s)\n`);

const unresolved: string[] = [];
let ok = 0;
for (const p of places) {
  const r = await warmOne(p, stopsByFeed);
  const via = r.via === 'gtfs' ? 'GRT stops' : r.via === 'fixed' ? 'fixed demo place' : 'Nominatim';
  if (!r.ok) {
    unresolved.push(`${p.key}: ${r.reason}`);
    console.log(`  -  ${p.key}  ->  not resolved (${via}: ${r.reason})`);
    continue;
  }
  ok++;
  const town = (r.result.town ?? (r.via === 'gtfs' ? 'GRT stops data' : 'town unknown')) + (r.via === 'fixed' ? ', fixed demo place, no network' : '');
  console.log(`  ok ${p.key}  ->  ${r.result.name}  [${town}]${p.aliases?.length ? `  (also: ${p.aliases.join(', ')})` : ''}`);
}
console.log(`\nResolved ${ok}/${places.length}.`);
if (unresolved.length) console.log(`Not resolved:\n  ${unresolved.join('\n  ')}`);
