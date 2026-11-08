// Distance parsing for place discovery (src/chat/distance.ts) and the box around the start.
// Pure, mocked-only checks: no network, no keys, no files. Part of npm test.
//   npm run test:discover

import { parseDistanceQuery } from '../src/chat/distance.js';

let failures = 0, total = 0;
function check(label: string, ok: boolean, detail = '') {
  total++;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
}

const cases: [string, number | null, Partial<{ atMost: boolean; mode: 'walk' | 'bike'; search: string }>][] = [
  ['I want a walk of about 2 km, where can I go?', 2, { mode: 'walk', search: 'park', atMost: false }],
  ['2k walk', 2, { search: 'park' }],
  ['1.5 kilometres', 1.5, { search: 'park' }],
  ['a walk of 1,5 km', 1.5, {}],
  ['parks about 3km', 3, { search: 'parks' }],
  ['parks in Waterloo around 2 km', 2, { search: 'parks in Waterloo' }],
  ['cafe two kilometers away', 2, { search: 'cafe' }],
  ['half a mile walk', 0.8, {}],
  ['a mile', 1.6, {}],
  ['a 20 minute walk', 1.7, { mode: 'walk' }],
  ['a 20-minute bike ride', 5, { mode: 'bike' }],
  ['within a 10 minute walk', 0.8, { atMost: true }],
  ['under 3 km', 3, { atMost: true }],
  ['up to 1 km walk', 1, { atMost: true }],
  ['a 500 m walk', 0.5, {}],
  ['800 metres', 0.8, {}],
  ['bike ride about 5 km', 5, { mode: 'bike' }],
  ['a 5k run', 5, { search: 'park' }],
  ['a 10 km walk', 10, { mode: 'walk' }],
  // No distance: the query is unchanged apart from filler.
  ['K-W parks', null, {}],
  ['King St', null, {}],
  ['route 7', null, {}],
  ['a 2-4-1 deal', null, {}],
  ['museums in Kitchener', null, { search: 'museums in Kitchener' }],
  ['Kitchener Public Library', null, { search: 'Kitchener Public Library' }],
  ['2 m', null, {}],
];
for (const [q, km, extra] of cases) {
  const r = parseDistanceQuery(q);
  const kmOk = km === null ? r.km === null : r.km !== null && Math.abs(r.km - km) < 0.05;
  const extraOk = Object.entries(extra).every(([k, v]) => (r as Record<string, unknown>)[k] === v);
  check(`"${q}" -> ${km === null ? 'no distance' : `${km} km`}${Object.keys(extra).length ? ' ' + JSON.stringify(extra) : ''}`, kmOk && extraOk, JSON.stringify(r));
}
// Without a distance the search text keeps the real words (only filler removed).
check('no distance: "where can I go for a walk?" searches "park"', parseDistanceQuery('where can I go for a walk?').search === 'park');
check('no distance: "K-W parks" is searched as written', parseDistanceQuery('K-W parks').search === 'K-W parks', parseDistanceQuery('K-W parks').search);

console.log(`\n${total - failures}/${total} checks passed`);
if (failures) process.exit(1);
