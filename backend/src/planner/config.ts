// Every trip-planner number lives here. The planner's per-user limit and its share
// of the Gemini ceilings are in ../chat/config.ts (USER_LIMITS.plan,
// PLANNER_MAX_GEMINI_CALLS), next to the other Gemini limits.

const env = process.env;

/** Whole request, from arrival to response (geocoding, Gemini, fallback). */
export const PLAN_BUDGET_MS = 8_000;
/** Kept back from the budget so the computed fallback always has time to run. */
export const FALLBACK_RESERVE_MS = 400;
/** Max wait for Nominatim inside one plan. */
export const GEOCODE_TIMEOUT_MS = 2_500;

// --- Plan cache (in memory only: never written to disk or logged) ----------------

/** How long a Gemini plan is reused for the same user, destination and origin (~100 m). 0 = off. */
export const PLAN_CACHE_MS = env.PLAN_CACHE_OFF === '1' ? 0 : 5 * 60_000;
/** Most plans kept; the oldest is dropped first. */
export const PLAN_CACHE_MAX = 200;

// --- Distance and time: straight line x detour factor -------------------------

/** Real streets are longer than the straight line. */
export const DETOUR = { walk: 1.3, bike: 1.25 } as const;
/** km/h */
export const SPEED_KMH = { walk: 5, bike: 15, bus: 20 } as const;

/** Options offered only up to these route lengths (km). */
export const WALK_MAX_KM = 6;
export const BIKE_MAX_KM = 25;
/** Below this, only walking is offered. */
export const WALK_ONLY_BELOW_KM = 0.4;
/** Destinations farther than this (straight line) are refused: outside the planner's area. */
export const MAX_TRIP_KM = 40;

// --- Transit (direct routes only, no transfers) --------------------------------

/** Stops this close (straight line) to the origin or destination are candidates. */
export const STOP_SEARCH_M = 800;
/** A stop counts as served by a route when it is this close to the route's shape. */
export const STOP_ON_SHAPE_M = 60;
/** Route + direction + boarding stop candidates checked for the next bus (fastest by walk + ride time first). */
export const MAX_TRANSIT_CANDIDATES = 20;
/** Ride must be at least this long, or transit isn't worth offering. */
export const MIN_RIDE_KM = 0.8;
/** Wait assumed when there's no live prediction (minutes). */
export const DEFAULT_WAIT_MIN = 10;
/** Predictions further out than this are ignored (minutes). */
export const MAX_WAIT_MIN = 60;

// --- Computed recommendation (used when Gemini is not) --------------------------

/** walk if <= this km, else bike if <= BIKE_RECOMMEND_MAX_KM, else transit if offered, else bike. */
export const WALK_RECOMMEND_MAX_KM = 2;
export const BIKE_RECOMMEND_MAX_KM = 8;

/**
 * Rough CO2 of an average petrol car, kg per km, for the eco notes only (an
 * approximation; never used for points or the eco score).
 */
export const CAR_KG_CO2_PER_KM = 0.17;

// --- Gemini's final answer --------------------------------------------------------

export const SUMMARY_MAX_CHARS = 300;
export const ECO_NOTE_MAX_CHARS = 160;

// --- Nominatim (OpenStreetMap search) -------------------------------------------

export const NOMINATIM_BASE_URL = env.NOMINATIM_BASE_URL || 'https://nominatim.openstreetmap.org';
export const NOMINATIM_USER_AGENT = 'Commutr/0.1 (hackathon demo)';
/** Nominatim's usage policy: at most 1 request per second. A little margin on top. */
export const NOMINATIM_MIN_INTERVAL_MS = 1_100;
export const GEOCODE_CACHE_MS = 24 * 60 * 60_000;
/** Places pre-loaded by npm run geocode:warm (src/planner/places-warm.ts) stay this long. */
export const GEOCODE_WARM_MS = 30 * 24 * 60 * 60_000;
/** Searches are limited to this box around Kitchener-Waterloo-Cambridge (west, north, east, south). */
export const KW_VIEWBOX = { west: -80.75, north: 43.56, east: -80.2, south: 43.3 };
export const OSM_ATTRIBUTION = 'Search: © OpenStreetMap contributors (Nominatim)';
