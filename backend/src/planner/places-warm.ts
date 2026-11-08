// Common Kitchener-Waterloo destinations, pre-loaded into the geocode cache by
// `npm run geocode:warm` (30-day expiry) so the planner doesn't wait for Nominatim.
//
//   key:     what a user would say (the cache is looked up by this, case and
//            spacing ignored)
//   query:   what is sent to Nominatim (defaults to key)
//   stop:    resolve from the local GRT stops data instead (exact stop/station name,
//            no network)
//   expect:  checks a Nominatim result must pass (name pattern, town); otherwise the
//            place is reported unresolved rather than guessed
//   label:   the name to store (for address searches, which have no place name)
//   fixed:   a place with known coordinates (src/demoPlaces.ts): stored as is, no network
//   aliases: short names that reuse the key's best result

import { BUILDERS_CLUB } from '../demoPlaces.js';

export type WarmPlace = {
  key: string;
  query?: string;
  stop?: string;
  expect?: { name?: RegExp; town?: string };
  label?: string;
  fixed?: { name: string; lat: number; lng: number; town: string };
  aliases?: string[];
};

export const WARM_PLACES: WarmPlace[] = [
  // User 1's demo home, from the same address and coordinates as the seed.
  { key: 'Builders Club', fixed: { name: `${BUILDERS_CLUB.name}, King Street West, Kitchener`, lat: BUILDERS_CLUB.lat, lng: BUILDERS_CLUB.lng, town: BUILDERS_CLUB.town }, aliases: ['Builders'] },
  { key: 'University of Waterloo', aliases: ['UW', 'UWaterloo'] },
  { key: 'Wilfrid Laurier University', aliases: ['Laurier', 'WLU'] },
  { key: 'Conestoga Mall' },
  { key: 'Waterloo Public Library' },
  // The main library downtown (Central Library, Queen Street North), not a branch.
  { key: 'Kitchener Public Library', query: 'Kitchener Public Library Central Library, Queen Street North, Kitchener', expect: { name: /Central|Queen Street/i, town: 'Kitchener' } },
  { key: 'Kitchener City Hall' },
  { key: 'Waterloo Park' },
  { key: 'Grand River Hospital' },
  { key: "St. Mary's General Hospital" },
  // The GO/VIA train station: the GRT stop right outside it.
  { key: 'Kitchener GO station', stop: 'Victoria / Kitchener Train Station', aliases: ['Kitchener train station', 'Kitchener GO'] },
  // ION stations (and their bus terminals) from the GRT stops data.
  { key: 'University of Waterloo Station', stop: 'University Of Waterloo Station', aliases: ['UW station'] },
  { key: 'Waterloo Public Square Station', stop: 'Waterloo Public Square Station' },
  { key: 'Grand River Hospital Station', stop: 'Grand River Hospital Station' },
  { key: 'Central Station', stop: 'Central Station' },
  { key: 'Kitchener City Hall Station', stop: 'Kitchener City Hall Station' },
  { key: 'Fairway Station', stop: 'Fairway Station' },
  { key: 'Conestoga Station', stop: 'Conestoga Station' },
  { key: 'Uptown Waterloo' },
  { key: 'Downtown Kitchener' },
  { key: 'The Boardwalk', aliases: ['Boardwalk'] },
  { key: 'Fairview Park Mall', aliases: ['Fairview'] },
  { key: 'Victoria Park' },
  { key: 'Kitchener Market', aliases: ['the market'] },
  { key: 'Waterloo Town Square' },
  { key: 'Conestoga College Doon campus' },
  { key: 'RIM Park' },
  { key: 'Rockway Gardens' },
  // Added: likely for a student demo.
  { key: 'Communitech Hub', query: '151 Charles Street West, Kitchener', label: 'Communitech Hub', expect: { town: 'Kitchener' } },
  { key: 'THEMUSEUM' },
  { key: 'Centre In The Square' },
  { key: 'Kitchener Memorial Auditorium' },
  { key: 'Waterloo Memorial Recreation Complex', aliases: ['Waterloo Rec Centre'] },
  { key: 'Columbia Lake Waterloo' },
  { key: 'Laurel Creek Conservation Area' },
  { key: "St. Jacobs Farmers' Market" },
  { key: 'University Plaza', query: 'University Plaza, Waterloo', expect: { town: 'Waterloo' } },
  { key: 'Bingemans' },
];

/** Keys from earlier versions of this list that were wrong; removed from the cache by geocode:warm. */
export const RETIRED_KEYS = ['Waterloo ION station'];
