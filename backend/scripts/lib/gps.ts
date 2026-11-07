// Deterministic synthetic GPS tracks for the test scripts (seeded random, realistic noise).

import { haversineKm, type LatLng } from '../../src/geo.js';

export function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export type Rng = () => number;
const gauss = (rng: Rng) => Math.sqrt(-2 * Math.log(rng() || 1e-9)) * Math.cos(2 * Math.PI * rng());

export type Piece = {
  path: LatLng[];
  /** km/h at a given second into this piece */
  speed: (tSec: number, rng: Rng) => number;
  intervalSec: number;
  noiseM: number;
  accuracy: [min: number, max: number];
  /** Move without recording points (GPS gap). */
  silent?: boolean;
  /** Extra seconds before this piece starts (e.g. a teleport 5 s later). */
  pauseBeforeSec?: number;
};

export type TimedPoint = { lat: number; lng: number; accuracy: number; tSec: number };

function pointAt(path: LatLng[], cum: number[], d: number): LatLng {
  let i = cum.findIndex((c) => c >= d);
  if (i <= 0) i = i === 0 ? 1 : path.length - 1;
  const a = path[i - 1]!, b = path[i]!;
  const len = cum[i]! - cum[i - 1]!;
  const t = len > 0 ? Math.min(1, (d - cum[i - 1]!) / len) : 0;
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/** Points (seconds from the start) plus the total duration in seconds. */
export function track(seed: number, pieces: Piece[]): { points: TimedPoint[]; durationSec: number } {
  const rng = mulberry32(seed);
  const out: TimedPoint[] = [];
  let clock = 0;
  for (const piece of pieces) {
    clock += piece.pauseBeforeSec ?? 0;
    const cum = [0];
    for (let i = 1; i < piece.path.length; i++) cum.push(cum[i - 1]! + haversineKm(piece.path[i - 1]!, piece.path[i]!));
    const total = cum[cum.length - 1]!;
    let d = 0, t = 0;
    for (;;) {
      const [lat, lng] = pointAt(piece.path, cum, Math.min(d, total));
      if (!piece.silent) {
        const nLat = (gauss(rng) * piece.noiseM) / 111_320;
        const nLng = (gauss(rng) * piece.noiseM) / (111_320 * Math.cos((lat * Math.PI) / 180));
        const [lo, hi] = piece.accuracy;
        out.push({ lat: lat + nLat, lng: lng + nLng, accuracy: Math.round(lo + rng() * (hi - lo)), tSec: clock + t });
      }
      if (d >= total) break;
      d += (Math.max(0, piece.speed(t, rng)) * piece.intervalSec) / 3600;
      t += piece.intervalSec;
    }
    clock += t;
  }
  return { points: out, durationSec: clock };
}

// Speed profiles (km/h)
export const walking = (base = 5) => (t: number, rng: Rng) => base + 0.6 * Math.sin(t / 47) + (rng() - 0.5) * 1.2;
export const cycling = (t: number, rng: Rng) => (t % 300 < 25 ? 0 : 18 + 3 * Math.sin(t / 61) + (rng() - 0.5) * 4); // red lights
export const driving = (t: number, rng: Rng) => (t % 240 < 20 ? 5 : 50 + 6 * Math.sin(t / 37) + (rng() - 0.5) * 8);
export const bus = (t: number, rng: Rng) => (t < 30 || t % 120 < 20 ? 0 : 32 + 8 * Math.sin(t / 29) + (rng() - 0.5) * 6); // stops

export const phone = { intervalSec: 5, noiseM: 4, accuracy: [5, 14] as [number, number] };

// Real KW coordinates
export const UW: LatLng = [43.4723, -80.5449], LAURIER: LatLng = [43.4738, -80.5275], UPTOWN: LatLng = [43.4655, -80.5228];
export const MIDTOWN: LatLng = [43.4585, -80.507], DTK: LatLng = [43.4508, -80.4925], VICTORIA: LatLng = [43.4466, -80.5];
