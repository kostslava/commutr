// Route safety: the saved rating format, the Gemini prompt and schema, validation of
// Gemini's answer, and photo selection along a path. Pure functions only (no network),
// shared by the generation script and the tests. Photos are never stored: only their
// Mapillary IDs, capture dates and creator names, for attribution.

import type { Endpoint } from './routes.js';

export type FactorRating = 'good' | 'fair' | 'poor' | 'unknown';
export type Factor = { rating: FactorRating; note: string };
export type Overall = 'good' | 'fair' | 'poor';
export type Confidence = 'high' | 'medium' | 'low';
export const FACTORS = ['lighting', 'sidewalks', 'traffic', 'crossings'] as const;
export type FactorName = (typeof FACTORS)[number];

export type Rating = {
  overall: Overall;
  score: number; // 1-5
  summary: string;
  factors: Record<FactorName, Factor>;
  confidence: Confidence;
};

export type SavedRoute = {
  id: string;
  from: Endpoint;
  to: Endpoint;
  /** Walking path length from the routing engine. */
  km: number;
  rating: Rating;
  photos: {
    count: number;
    /** How many evenly spaced points along the path had a photo within the search radius. */
    sample_points_covered: number;
    sample_points: number;
    captured_from: string | null; // YYYY-MM
    captured_to: string | null;
    mapillary_image_ids: string[];
    creators: string[];
  };
  model: string;
  generated_at: string;
};

export type RatingsFile = { version: 1; routes: SavedRoute[] };

export const MAPILLARY_ATTRIBUTION = 'Street imagery: Mapillary contributors, CC BY-SA 4.0 (mapillary.com)';

// --- Gemini prompt and schema ------------------------------------------------------------

export const RATING_PROMPT = (from: string, to: string, km: number, photoCount: number) =>
  [
    `You are rating how safe and comfortable a walking and cycling route in Kitchener-Waterloo, Ontario looks, from ${from} to ${to} (about ${km.toFixed(1)} km).`,
    `${photoCount} street-level photos are attached, in order from the start of the route to the end.`,
    'Judge only what is visible in the photos:',
    '- lighting: street lights along the way (not the time of day the photo was taken);',
    '- sidewalks: present or missing, width, condition, separation from the road;',
    '- traffic: number of lanes, likely speed, bike lanes or separation for cyclists;',
    '- crossings: marked crosswalks, signals, refuge islands.',
    'If a factor cannot be seen in the photos, rate it "unknown". Do not guess about crime, people or anything not visible.',
    'overall is good, fair or poor; score is 1 (poor) to 5 (very good). summary is one or two short plain sentences that can be read aloud, no markdown.',
    'Each note is one short sentence. confidence is how sure you are given the photos (few, blurry or inconsistent photos mean low).',
  ].join('\n');

const FACTOR_SCHEMA = {
  type: 'object',
  properties: { rating: { type: 'string', enum: ['good', 'fair', 'poor', 'unknown'] }, note: { type: 'string' } },
  required: ['rating', 'note'],
};

export const RATING_SCHEMA = {
  type: 'object',
  properties: {
    overall: { type: 'string', enum: ['good', 'fair', 'poor'] },
    score: { type: 'integer', minimum: 1, maximum: 5 },
    summary: { type: 'string' },
    factors: {
      type: 'object',
      properties: Object.fromEntries(FACTORS.map((f) => [f, FACTOR_SCHEMA])),
      required: [...FACTORS],
    },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
  required: ['overall', 'score', 'summary', 'factors', 'confidence'],
};

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): T | null => (typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : null);

/** Validate Gemini's JSON answer. Returns null if it doesn't match the schema. */
export function parseRating(raw: unknown): Rating | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const overall = oneOf(r.overall, ['good', 'fair', 'poor'] as const);
  const confidence = oneOf(r.confidence, ['high', 'medium', 'low'] as const);
  const score = typeof r.score === 'number' && Number.isFinite(r.score) ? Math.min(5, Math.max(1, Math.round(r.score))) : null;
  const summary = typeof r.summary === 'string' && r.summary.trim() ? clip(r.summary.trim(), 240) : null;
  if (!overall || !confidence || score === null || !summary || !r.factors || typeof r.factors !== 'object') return null;
  const factors = {} as Record<FactorName, Factor>;
  for (const f of FACTORS) {
    const v = (r.factors as Record<string, unknown>)[f] as Record<string, unknown> | undefined;
    const rating = oneOf(v?.rating, ['good', 'fair', 'poor', 'unknown'] as const);
    if (!rating || typeof v?.note !== 'string') return null;
    factors[f] = { rating, note: clip(v.note.trim(), 140) };
  }
  return { overall, score, summary, factors, confidence };
}

/** Lower confidence when the photos are few or old. */
export function adjustConfidence(c: Confidence, photoCount: number, newestYear: number | null): Confidence {
  const order: Confidence[] = ['low', 'medium', 'high'];
  let i = order.indexOf(c);
  if (photoCount < 4) i = 0;
  if (newestYear === null || newestYear < 2022) i = Math.max(0, i - 1);
  return order[i]!;
}

// --- Geometry -----------------------------------------------------------------------------

export type LatLng = [number, number];

export function metres(a: LatLng, b: LatLng): number {
  const dy = (a[0] - b[0]) * 111_320;
  const dx = (a[1] - b[1]) * 111_320 * Math.cos((((a[0] + b[0]) / 2) * Math.PI) / 180);
  return Math.hypot(dx, dy);
}

/** Decode a Valhalla shape (Google polyline, precision 6). */
export function decodePolyline6(str: string): LatLng[] {
  let i = 0, lat = 0, lng = 0;
  const out: LatLng[] = [];
  while (i < str.length) {
    for (const k of [0, 1]) {
      let b, shift = 0, result = 0;
      do {
        b = str.charCodeAt(i++) - 63;
        result |= (b & 31) << shift;
        shift += 5;
      } while (b >= 32 && i < str.length);
      const d = result & 1 ? ~(result >> 1) : result >> 1;
      if (k === 0) lat += d;
      else lng += d;
    }
    out.push([lat / 1e6, lng / 1e6]);
  }
  return out;
}

export function pathKm(path: LatLng[]): number {
  let m = 0;
  for (let i = 1; i < path.length; i++) m += metres(path[i - 1]!, path[i]!);
  return m / 1000;
}

/** `n` points evenly spaced along the path (n >= 2), including both ends. */
export function sampleAlong(path: LatLng[], n: number): LatLng[] {
  if (path.length < 2) return [...path];
  const seg = path.slice(1).map((p, i) => metres(path[i]!, p));
  const total = seg.reduce((a, b) => a + b, 0);
  const out: LatLng[] = [];
  for (let k = 0; k < n; k++) {
    let target = (total * k) / (n - 1), i = 0;
    while (i < seg.length - 1 && target > seg[i]!) target -= seg[i++]!;
    const f = seg[i]! ? Math.min(1, target / seg[i]!) : 0;
    const a = path[i]!, b = path[i + 1]!;
    out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
  }
  return out;
}

// --- Photo selection ------------------------------------------------------------------------

export type PhotoCandidate = { id: string; lat: number; lng: number; captured_at: number; is_pano: boolean; sequence_id: string };

export type Selection = { chosen: PhotoCandidate[]; covered: number; samples: number; nearby: number };

/**
 * Pick up to `max` photos spread along the path: for each of `max` evenly spaced points,
 * the best photo within `radiusM` (not panoramic, newer first, at most `perSequence`
 * from the same Mapillary sequence, no photo twice). Photos from 2022 or later are
 * preferred; older ones are used only where nothing newer is close.
 */
export function selectPhotos(path: LatLng[], candidates: PhotoCandidate[], opts = { max: 6, radiusM: 25, perSequence: 2, preferFrom: Date.UTC(2022, 0, 1) }): Selection {
  const points = sampleAlong(path, opts.max);
  const usable = candidates.filter((c) => !c.is_pano);
  const used = new Set<string>();
  const perSeq = new Map<string, number>();
  const chosen: PhotoCandidate[] = [];
  let covered = 0;
  const nearbyIds = new Set<string>();
  for (const p of points) {
    const near = usable.filter((c) => metres([c.lat, c.lng], p) <= opts.radiusM);
    near.forEach((c) => nearbyIds.add(c.id));
    if (near.length) covered++;
    const pick = near
      .filter((c) => !used.has(c.id) && (perSeq.get(c.sequence_id) ?? 0) < opts.perSequence)
      .sort((a, b) => Number(b.captured_at >= opts.preferFrom) - Number(a.captured_at >= opts.preferFrom) || metres([a.lat, a.lng], p) - metres([b.lat, b.lng], p) || b.captured_at - a.captured_at)[0];
    if (pick) {
      chosen.push(pick);
      used.add(pick.id);
      perSeq.set(pick.sequence_id, (perSeq.get(pick.sequence_id) ?? 0) + 1);
    }
  }
  return { chosen, covered, samples: points.length, nearby: nearbyIds.size };
}

export const yearMonth = (ms: number) => new Date(ms).toISOString().slice(0, 7);
