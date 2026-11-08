// Short in-memory cache of Gemini plan decisions (5 minutes).
//
// Kept: which place, Gemini's recommendation, order, summary and eco notes. NOT kept:
// the numbers. On a hit the options are recomputed from current live data and the
// user's current status, and the cached text is re-checked against the fresh numbers.
//
// In memory only: never written to disk, never logged (neither keys nor values).
// Keyed per user, so one user's plan is never served to another.

import type { PlanMode } from './routes.js';
import * as P from './config.js';
import type { Origin, Place } from './places.js';

export type CachedPlan = {
  place: Omit<Place, 'id'>;
  usedSearch: boolean;
  recommendation: PlanMode;
  order: PlanMode[];
  summary: string;
  optionNumbers: string;
  eco_notes: [PlanMode, string][];
};

const entries = new Map<string, { at: number; plan: CachedPlan }>();

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
/** 3 decimals of latitude/longitude is about 100 m (latitude) / 80 m (longitude) here. */
const r3 = (n: number) => n.toFixed(3);

export function planCacheKey(userId: number, dest: string | { name: string; lat: number; lng: number }, origin: Origin): string {
  const d = typeof dest === 'string' ? `t:${norm(dest)}` : `p:${norm(dest.name)}@${dest.lat.toFixed(5)},${dest.lng.toFixed(5)}`;
  return `${userId}|${d}|${origin.kind}|${r3(origin.at[0])},${r3(origin.at[1])}`;
}

export function getCachedPlan(key: string): CachedPlan | null {
  if (P.PLAN_CACHE_MS <= 0) return null;
  const e = entries.get(key);
  if (!e) return null;
  if (Date.now() - e.at > P.PLAN_CACHE_MS) {
    entries.delete(key);
    return null;
  }
  return e.plan;
}

export function putCachedPlan(key: string, plan: CachedPlan) {
  if (P.PLAN_CACHE_MS <= 0) return;
  entries.delete(key); // re-insert so Map order is oldest first
  entries.set(key, { at: Date.now(), plan });
  while (entries.size > P.PLAN_CACHE_MAX) entries.delete(entries.keys().next().value!);
}
