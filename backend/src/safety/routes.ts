// The precomputed demo routes for route safety. Ratings for them are generated once by
// scripts/route-safety-generate.ts and saved in ratings.json next to this file.
// Coordinates: Builders Club from demoPlaces.ts; the others from the planner's warmed
// Nominatim / GRT stop results (backend/data/geocode-cache.json, 2026-11-07).

import { BUILDERS_CLUB } from '../demoPlaces.js';

export type Endpoint = { name: string; lat: number; lng: number; aliases: string[] };
export type DemoRoute = { id: string; from: Endpoint; to: Endpoint };

const BUILDERS: Endpoint = { name: 'Builders Club', lat: BUILDERS_CLUB.lat, lng: BUILDERS_CLUB.lng, aliases: ['Builders', '165 King St W'] };
const CENTRAL: Endpoint = { name: 'Central Station', lat: 43.452969, lng: -80.498614, aliases: ['Central Station Kitchener', 'Kitchener Central Station'] };
const VICTORIA_PARK: Endpoint = { name: 'Victoria Park', lat: 43.4464, lng: -80.4936, aliases: ['Victoria Park Kitchener'] };
const WATERLOO_PARK: Endpoint = { name: 'Waterloo Park', lat: 43.4668963, lng: -80.5324772, aliases: [] };
const PUBLIC_SQUARE: Endpoint = { name: 'Waterloo Public Square Station', lat: 43.464236, lng: -80.522467, aliases: ['Waterloo Public Square', 'Public Square', 'Public Square Station', 'Uptown Waterloo'] };
const UW: Endpoint = { name: 'University of Waterloo', lat: 43.4701994, lng: -80.5452429, aliases: ['UW', 'UWaterloo', 'Waterloo University'] };

export const DEMO_ROUTES: DemoRoute[] = [
  { id: 'builders-central-station', from: BUILDERS, to: CENTRAL },
  { id: 'builders-victoria-park', from: BUILDERS, to: VICTORIA_PARK },
  { id: 'waterloo-park-public-square', from: WATERLOO_PARK, to: PUBLIC_SQUARE },
  { id: 'uw-public-square', from: UW, to: PUBLIC_SQUARE },
];
