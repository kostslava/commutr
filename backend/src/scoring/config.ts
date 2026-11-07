// Every tunable scoring number lives here. Change values in this file only.
//
//   points = verified_km x MODE_RATES[mode] x confidence x trust_multiplier
//            (rounded, then limited by DAILY_POINTS_CAP)
//
// Confidence starts at 1.0; each failed check subtracts its PENALTIES entry
// (floor 0). Below LOW_CONFIDENCE the trip earns nothing and lowers trust.

export type Mode = 'walk' | 'bike' | 'scooter' | 'transit' | 'car';
export const MODES: readonly Mode[] = ['walk', 'bike', 'scooter', 'transit', 'car'];

// --- Points ------------------------------------------------------------------

/** Points per verified km. (Tripled alternative: walk 30, bike 18, scooter 12, transit 9, cap 600.) */
export const MODE_RATES: Record<Mode, number> = { walk: 10, bike: 6, scooter: 4, transit: 3, car: 0 };

/** Max points per user per Toronto calendar day (by the day the trip ended). */
export const DAILY_POINTS_CAP = 200;

/** Confidence below this: 0 points, trust drops, no eco penalty. */
export const LOW_CONFIDENCE = 0.3;

// --- Speed limits (km/h) -----------------------------------------------------

export type SpeedLimits = {
  /** Average moving speed above this flags `speed_too_high`. */
  avgMaxKmh: number;
  /** Any rolling window of BURST_WINDOW_SEC above this flags `car_like_burst`. null = no check. */
  carBurstKmh: number | null;
  /** A segment of at least JUMP_MIN_DISTANCE_M faster than this is an impossible jump. */
  jumpKmh: number;
};

export const SPEED_LIMITS: Record<Exclude<Mode, 'car'>, SpeedLimits> = {
  walk: { avgMaxKmh: 12, carBurstKmh: 20, jumpKmh: 25 }, // 12 still allows jogging
  bike: { avgMaxKmh: 30, carBurstKmh: 45, jumpKmh: 70 },
  scooter: { avgMaxKmh: 28, carBurstKmh: 40, jumpKmh: 60 },
  transit: { avgMaxKmh: 70, carBurstKmh: null, jumpKmh: 130 },
};

/** Length of the rolling window used to detect car-like bursts. */
export const BURST_WINDOW_SEC = 60;

/** A segment must cover at least this much to count as a jump (filters small GPS glitches). */
export const JUMP_MIN_DISTANCE_M = 500;

// --- Data quality ------------------------------------------------------------

/** Points with accuracy worse (larger) than this are dropped. */
export const MAX_ACCURACY_M = 50;

/** Movement smaller than this from the last counted point is treated as GPS jitter. */
export const MIN_MOVE_M = 10;

/** Fewer usable points than this flags `too_few_points`. */
export const MIN_POINTS = 5;

/** `poor_accuracy` when more than this share of points was dropped ... */
export const POOR_ACCURACY_DROPPED_SHARE = 0.5;
/** ... or the median accuracy of the kept points is worse than this. */
export const POOR_ACCURACY_MEDIAN_M = 30;

/** `constant_speed` when speed varies less than this (coefficient of variation) ... */
export const CONSTANT_SPEED_MAX_CV = 0.05;
/** ... over at least this many moving segments. */
export const CONSTANT_SPEED_MIN_SEGMENTS = 10;

// --- Context checks ----------------------------------------------------------

/** `far_from_last_trip` when the trip starts farther than this from the previous trip's end ... */
export const FAR_START_KM = 2;
/** ... and the previous trip ended less than this long before. */
export const FAR_START_WINDOW_MIN = 60;

/** Transit trips must start and end within this distance of a GRT stop. */
export const STOP_RADIUS_M = 200;

// --- Confidence penalties (subtracted from 1.0) -------------------------------

export const PENALTIES = {
  speed_too_high: 0.5,
  car_like_burst: 0.6,
  impossible_jump: 0.5, // once, however many jumps
  too_few_points: 0.5,
  poor_accuracy: 0.2,
  constant_speed: 0.5,
  far_from_last_trip: 0.2,
  transit_start_not_near_stop: 0.4,
  transit_end_not_near_stop: 0.4,
} as const;

// --- Trust multiplier --------------------------------------------------------

/** Subtracted when a trip scores below LOW_CONFIDENCE. */
export const TRUST_DROP = 0.15;
/** Trust never goes below this, so users can recover. */
export const TRUST_FLOOR = 0.4;
/** Added per clean trip (confidence >= CLEAN_TRIP_CONFIDENCE and verified km >= CLEAN_TRIP_MIN_KM), up to 1.0. */
export const TRUST_RECOVERY = 0.02;
export const CLEAN_TRIP_CONFIDENCE = 0.8;
export const CLEAN_TRIP_MIN_KM = 0.5;

// --- Eco score (0-100) -------------------------------------------------------

/** Car trips lower the eco score by this many points per km (rounded) ... */
export const ECO_PENALTY_PER_CAR_KM = 0.5;
/** ... at least this much ... */
export const ECO_PENALTY_MIN = 1;
/** ... and at most this much per trip. */
export const ECO_PENALTY_MAX = 10;

/** Green trips (non-car, confidence >= LOW_CONFIDENCE, verified km >= ECO_RECOVERY_MIN_KM) add this ... */
export const ECO_RECOVERY_PER_TRIP = 1;
export const ECO_RECOVERY_MIN_KM = 1;
/** ... up to this much per Toronto day. */
export const ECO_RECOVERY_MAX_PER_DAY = 3;

// --- Streaks and clubs -------------------------------------------------------

/** A streak day needs one finished non-car trip with confidence >= LOW_CONFIDENCE and at least this many verified km. */
export const STREAK_MIN_KM = 0.5;

/** Club progress: walk trips only, verified km x this. */
export const STEPS_PER_WALK_KM = 1300;

// --- Input limits ------------------------------------------------------------

/** Max points per POST /api/trips/:id/points request. */
export const MAX_POINTS_PER_BATCH = 500;
/** Max points stored per trip. */
export const MAX_POINTS_PER_TRIP = 10_000;
/** Allowed clock drift for point timestamps (before the trip start / after now). */
export const CLOCK_SLACK_SEC = 60;
