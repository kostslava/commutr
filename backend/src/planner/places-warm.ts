// Common Kitchener-Waterloo destinations, pre-loaded into the geocode cache by
// `npm run geocode:warm` (30-day expiry) so the planner doesn't wait for Nominatim.
//
//   key:     what a user would say (the cache is looked up by this, case and
//            spacing ignored)
//   query:   what is sent to Nominatim (defaults to key)
//   aliases: short names that reuse the key's best result

export type WarmPlace = { key: string; query?: string; aliases?: string[] };

export const WARM_PLACES: WarmPlace[] = [
  { key: 'University of Waterloo', aliases: ['UW', 'UWaterloo'] },
  { key: 'Wilfrid Laurier University', aliases: ['Laurier', 'WLU'] },
  { key: 'Conestoga Mall' },
  { key: 'Waterloo Public Library' },
  { key: 'Kitchener Public Library' },
  { key: 'Kitchener City Hall' },
  { key: 'Waterloo Park' },
  { key: 'Grand River Hospital' },
  { key: "St. Mary's General Hospital" },
  { key: 'Kitchener GO station' },
  { key: 'Waterloo ION station' },
  { key: 'Fairway Station' },
  { key: 'Conestoga Station' },
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
  { key: 'Communitech Hub' },
  { key: 'THEMUSEUM' },
  { key: 'Centre In The Square' },
  { key: 'Kitchener Memorial Auditorium' },
  { key: 'Waterloo Memorial Recreation Complex', aliases: ['Waterloo Rec Centre'] },
  { key: 'Columbia Lake Waterloo' },
  { key: 'Laurel Creek Conservation Area' },
  { key: "St. Jacobs Farmers' Market" },
  { key: 'University Plaza' },
  { key: 'Bingemans' },
];
