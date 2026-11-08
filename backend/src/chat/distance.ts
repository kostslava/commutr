// Reads a requested distance out of a free-text place search ("a walk of about 2 km",
// "2k walk", "1.5 kilometres", "20 minute walk") and cleans the query for Nominatim.
// Pure: no network, no imports, so it is easy to test (scripts/test-discover.ts).

export type DistanceQuery = {
  /** Requested distance in km along the route (walk or bike), or null. */
  km: number | null;
  /** "under 3 km", "within 2 km", "up to 1 km": the distance is a maximum, not a target. */
  atMost: boolean;
  /** 'bike' when the query is about cycling, else 'walk' (also the default). */
  mode: 'walk' | 'bike';
  /** True when the query names walking explicitly. */
  saysWalk: boolean;
  /** The text to send to Nominatim: the distance words removed; "park" for a generic walk. */
  search: string;
};

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  'a couple of': 2, 'a couple': 2, couple: 2, half: 0.5, 'half a': 0.5, a: 1, an: 1,
};
const KM_PER_MILE = 1.609;
const WALK_KMH = 5;
const BIKE_KMH = 15;

const NUM = String.raw`(\d+(?:[.,]\d+)?|a couple of|a couple|couple|half a|half|one|two|three|four|five|six|seven|eight|nine|ten|an|a)`;
const QUAL = String.raw`(?:(about|around|roughly|approximately|approx\.?|~|under|within|up to|less than|at most|no more than)\s*(?:an?\s+)?)?`;
const UNIT = String.raw`(km|kms|k|kilometres?|kilometers?|klicks?|miles?|mi|minutes?|mins?|min|metres?|meters?|m)`;
// "about 2 km", "2k", "1.5 kilometres", "a 20-minute walk", "half a mile", "~3km".
const DISTANCE = new RegExp(String.raw`(?:^|[\s(,])${QUAL}${NUM}\s*-?\s*${UNIT}(?=$|[\s.,!?)])`, 'i');

const BIKE_WORDS = /\b(bike|biking|cycle|cycling|ride|riding)\b/i;
const WALK_WORDS = /\b(walk|walking|stroll|hike|hiking|wander)\b/i;

/** Words that carry no place meaning for Nominatim. */
const FILLER = new Set([
  'i', 'im', "i'm", 'want', 'wanna', 'would', 'like', 'to', 'go', 'going', 'for', 'a', 'an', 'the', 'of', 'can', 'could', 'where', 'what',
  'somewhere', 'something', 'some', 'place', 'places', 'spot', 'spots', 'me', 'my', 'from', 'home', 'here', 'nearby', 'near', 'around',
  'about', 'roughly', 'approximately', 'walk', 'walking', 'stroll', 'hike', 'hiking', 'wander', 'bike', 'biking', 'cycle', 'cycling',
  'ride', 'riding', 'trip', 'take', 'do', 'is', 'there', 'any', 'good', 'nice', 'with', 'that', 'this', 'and', 'or', 'please', 'suggest',
  'ideas', 'idea', 'away', 'long', 'distance', 'one', 'way', 'in', 'on', 'at', 'by', 'kw', 'run', 'running', 'jog', 'jogging',
]);
/** Kept inside a query ("parks in Waterloo"), dropped only at the ends. */
const LINKS = new Set(['in', 'near', 'around', 'at', 'by', 'on']);

function numberOf(raw: string): number {
  const v = raw.toLowerCase();
  if (v in NUMBER_WORDS) return NUMBER_WORDS[v]!;
  return Number(v.replace(',', '.'));
}

function clean(text: string): string {
  const words = text.replace(/[?!.,;:()"]/g, ' ').split(/\s+/).filter(Boolean);
  if (!words.some((w) => !FILLER.has(w.toLowerCase()))) return 'park';
  // Drop filler, but keep linking words between meaningful ones ("parks in Waterloo").
  const kept = words.filter((w, i) => {
    const l = w.toLowerCase();
    if (!FILLER.has(l)) return true;
    if (!LINKS.has(l)) return false;
    const before = words.slice(0, i).some((x) => !FILLER.has(x.toLowerCase()));
    const after = words.slice(i + 1).some((x) => !FILLER.has(x.toLowerCase()));
    return before && after;
  });
  return kept.join(' ');
}

export function parseDistanceQuery(query: string): DistanceQuery {
  const text = query.trim();
  const mode: 'walk' | 'bike' = BIKE_WORDS.test(text) && !WALK_WORDS.test(text) ? 'bike' : 'walk';
  const saysWalk = WALK_WORDS.test(text);
  const m = DISTANCE.exec(text);
  if (!m) return { km: null, atMost: false, mode, saysWalk, search: clean(text) || text };

  const qualifier = (m[1] ?? '').toLowerCase();
  const n = numberOf(m[2]!);
  const unit = m[3]!.toLowerCase();
  let km: number;
  if (/^(mi|miles?)$/.test(unit)) km = n * KM_PER_MILE;
  else if (/^min/.test(unit)) km = (n / 60) * (mode === 'bike' ? BIKE_KMH : WALK_KMH);
  // Metres only from 50 up ("500 m", "800 metres"); "2 m" is not a walk.
  else if (/^(m|metres?|meters?)$/.test(unit)) km = n >= 50 ? n / 1000 : NaN;
  else km = n;
  // A lone "a k" or "an mi" is not a distance; numbers must be positive.
  if (!Number.isFinite(km) || km <= 0 || (/^(a|an)$/i.test(m[2]!) && /^(k|mi)$/.test(unit))) {
    return { km: null, atMost: false, mode, saysWalk, search: clean(text) || text };
  }
  const rest = (text.slice(0, m.index) + ' ' + text.slice(m.index + m[0].length)).trim();
  return {
    km: Math.round(km * 10) / 10,
    atMost: /^(under|within|up to|less than|at most|no more than)$/.test(qualifier),
    mode,
    saysWalk,
    search: clean(rest) || 'park',
  };
}
