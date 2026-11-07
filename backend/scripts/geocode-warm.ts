// Pre-load common Kitchener-Waterloo destinations into the planner's geocode cache
// (backend/data/geocode-cache.json, 30-day expiry). Uses the real Nominatim with the
// app's User-Agent, 1 request per second. Prints which places resolved.
//
//   npm run geocode:warm
//
// Exit 0 even when some places don't resolve (this is a report, not a test).

import '../src/env.js';
import { storeWarm, warmSearch } from '../src/planner/geocode.js';
import { rankResults } from '../src/planner/places.js';
import { WARM_PLACES } from '../src/planner/places-warm.js';

console.log(`Geocode warm-up: ${WARM_PLACES.length} places (about ${Math.ceil(WARM_PLACES.length * 1.1)} s at 1 request per second)\n`);
const resolved: string[] = [];
const unresolved: string[] = [];
for (const p of WARM_PLACES) {
  const query = p.query ?? p.key;
  const found = await warmSearch(query);
  if (!found.ok || found.results.length === 0) {
    unresolved.push(`${p.key}${found.ok ? ' (no match in the KW area)' : ` (${found.reason})`}`);
    console.log(`  -  ${p.key}: not resolved`);
    continue;
  }
  // Best name match first, so the short aliases get the right place.
  const ranked = rankResults(query, found.results, null);
  storeWarm(p.key, ranked);
  for (const a of p.aliases ?? []) storeWarm(a, [ranked[0]!]);
  const aliases = p.aliases?.length ? ` [also: ${p.aliases.join(', ')}]` : '';
  resolved.push(p.key);
  console.log(`  ok ${p.key} -> ${ranked[0]!.name}${aliases}`);
}
console.log(`\nResolved ${resolved.length}/${WARM_PLACES.length}.`);
if (unresolved.length) console.log(`Not resolved:\n  ${unresolved.join('\n  ')}`);
