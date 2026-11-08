// Fixed demo places, shared by the seed and the planner's warmed place list, so both
// use the same coordinates and neither needs the network.
//
// Builders Club, 165 King St W, Kitchener, ON N2G 1A7: user 1's saved home. Coordinates
// from a one-time Nominatim search by street address on 2026-11-07 (result: "165, King
// Street West, Kitchener"), rounded to 6 decimals.

export const BUILDERS_CLUB = {
  name: 'Builders Club',
  address: '165 King St W, Kitchener, ON N2G 1A7',
  town: 'Kitchener',
  lat: 43.450696,
  lng: -80.492268,
} as const;
