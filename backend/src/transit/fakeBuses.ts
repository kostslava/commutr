// Fake vehicles for when the live feed is down: a handful of buses (and ION trains)
// running back and forth along real GRT route shapes from the static GTFS.
// Positions are a function of the current time, so they move between requests.

import { bearingDeg, haversineKm, type LatLng } from '../geo.js';
import { getStaticFeeds, onStaticReload, type StaticFeed } from './staticGtfs.js';
import type { Vehicle } from './liveVehicles.js';

// Route short names to simulate. A route listed twice gets two vehicles.
const FAKE_ROUTES = ['7', '7', '8', '12', '201', '202', '301', '301'];

type FakeLine = {
  route_id: string;
  route_short_name: string | null;
  headsigns: [forward: string | null, backward: string | null];
  path: LatLng[];
  cumKm: number[]; // cumulative distance at each path point
  speedKmh: number;
};

function buildLine(feed: StaticFeed, shortName: string): FakeLine | null {
  const routeEntry = [...feed.routes].find(([, r]) => r.short_name === shortName);
  if (!routeEntry) return null;
  const [routeId, route] = routeEntry;

  const trips = [...feed.trips.values()].filter((t) => t.route_id === routeId && t.shape_id && feed.shapes.has(t.shape_id));
  // Longest shape = the full route rather than a short-turn variant.
  const main = trips.sort((a, b) => feed.shapes.get(b.shape_id!)!.length - feed.shapes.get(a.shape_id!)!.length)[0];
  if (!main) return null;
  const back = trips.find((t) => t.direction_id !== main.direction_id);

  const path = feed.shapes.get(main.shape_id!)!;
  if (path.length < 2) return null;
  const cumKm = [0];
  for (let i = 1; i < path.length; i++) cumKm.push(cumKm[i - 1]! + haversineKm(path[i - 1]!, path[i]!));

  return {
    route_id: routeId,
    route_short_name: route.short_name,
    headsigns: [main.headsign, back?.headsign ?? main.headsign],
    path,
    cumKm,
    speedKmh: route.type === 0 ? 30 : 20, // light rail a bit faster than buses
  };
}

let lines: (FakeLine | null)[] | null = null;
onStaticReload(() => (lines = null));

function getLines(): (FakeLine | null)[] {
  if (lines) return lines;
  const feeds = getStaticFeeds().filter((f): f is StaticFeed => f !== null);
  const byName = new Map<string, FakeLine | null>();
  lines = FAKE_ROUTES.map((name) => {
    if (!byName.has(name)) byName.set(name, feeds.map((f) => buildLine(f, name)).find(Boolean) ?? null);
    return byName.get(name)!;
  });
  return lines;
}

export function fakeVehicles(now = Date.now()): Vehicle[] {
  const timestamp = new Date(now).toISOString();
  const out: Vehicle[] = [];

  getLines().forEach((line, i) => {
    if (!line) return;
    const total = line.cumKm[line.cumKm.length - 1]!;
    if (total <= 0) return;

    // Ping-pong along the shape; each vehicle starts at a different offset.
    const travelled = (now / 3_600_000) * line.speedKmh + (i * 0.37 % 1) * 2 * total;
    const lap = travelled % (2 * total);
    const forward = lap <= total;
    const d = forward ? lap : 2 * total - lap;

    let seg = line.cumKm.findIndex((c) => c >= d);
    if (seg <= 0) seg = 1;
    const a = line.path[seg - 1]!, b = line.path[seg]!;
    const segLen = line.cumKm[seg]! - line.cumKm[seg - 1]!;
    const t = segLen > 0 ? (d - line.cumKm[seg - 1]!) / segLen : 0;

    out.push({
      id: `fake-${i + 1}`,
      route_id: line.route_id,
      route_short_name: line.route_short_name,
      headsign: forward ? line.headsigns[0] : line.headsigns[1],
      lat: Math.round((a[0] + (b[0] - a[0]) * t) * 1e6) / 1e6,
      lng: Math.round((a[1] + (b[1] - a[1]) * t) * 1e6) / 1e6,
      bearing: forward ? bearingDeg(a, b) : bearingDeg(b, a),
      speed: line.speedKmh,
      timestamp,
    });
  });

  return out;
}
