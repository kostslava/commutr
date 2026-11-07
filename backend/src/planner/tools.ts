// Gemini function-calling tools for the trip planner. They run on our server.
//
// Privacy rule (checked by the tests): results carry only place ids, safe place
// names, public GRT stop names and route numbers, and numbers computed in code.
// No coordinates, user name, email or user ID, ever. Built field by field.

import type { FunctionDeclaration } from '@google/genai';
import type { DB } from '../db.js';
import { haversineKm, haversineM } from '../geo.js';
import type { UserStatus } from '../status.js';
import { getStaticFeeds } from '../transit/staticGtfs.js';
import * as P from './config.js';
import { resolveDestination, type Origin, type Place, type PlaceBook } from './places.js';
import { computeOptions, PLAN_MODES, type LiveData, type PlanOption } from './routes.js';

export const PLANNER_TOOLS: FunctionDeclaration[] = [
  {
    name: 'find_destination',
    description: "Look up the user's destination. Returns up to 3 matching places (best first) with a place_id, a name and the straight-line distance from the user.",
    parametersJsonSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'The destination as the user said it, e.g. "Waterloo Public Library".' } },
      required: ['query'],
    },
  },
  {
    name: 'get_route_options',
    description:
      'Walk, bike and direct-bus options to a place: minutes, km, points the user would earn (from the real scoring rules), an eco note, steps, and for transit the next bus from the live GRT feed.',
    parametersJsonSchema: {
      type: 'object',
      properties: { place_id: { type: 'string', description: 'A place_id from find_destination.' } },
      required: ['place_id'],
    },
  },
  {
    name: 'get_live_buses_near',
    description: "Next live GRT arrivals at the stops near the user's starting point (route, direction, minutes away).",
    parametersJsonSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_points_estimate',
    description: 'Points the user would earn for one mode to a place, from the real scoring formula, the trust multiplier and the daily cap.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        place_id: { type: 'string' },
        mode: { type: 'string', enum: [...PLAN_MODES] },
      },
      required: ['place_id', 'mode'],
    },
  },
];

export type ToolCtx = {
  db: DB;
  userId: number;
  origin: Origin;
  book: PlaceBook;
  status: UserStatus;
  live: LiveData;
  /** The destination already resolved by the server (returned by the first find_destination). */
  preResolved: Place[];
  /** Options computed per place_id; the final answer's numbers come from here. */
  options: Map<string, PlanOption[]>;
  deadline: number;
  searched: boolean;
};

const placeJson = (ctx: ToolCtx, p: Place) => ({ place_id: p.id, name: p.safe_name, kind: p.kind, km_away: Math.round(haversineKm(ctx.origin.at, p.at) * 10) / 10 });

export function optionsFor(ctx: ToolCtx, place: Place): PlanOption[] {
  let opts = ctx.options.get(place.id);
  if (!opts) {
    opts = computeOptions(ctx.origin, place, ctx.status, ctx.live);
    ctx.options.set(place.id, opts);
  }
  return opts;
}

/** What Gemini sees of an option: everything except timestamps. */
export const optionJson = (o: PlanOption) => ({
  mode: o.mode,
  minutes: o.minutes,
  km: o.km,
  points_estimate: o.points_estimate,
  points_capped: o.points_capped,
  eco_note: o.eco_note,
  steps: o.steps,
  next_bus: o.next_bus ? { route: o.next_bus.route, headsign: o.next_bus.headsign, stop_name: o.next_bus.stop_name, minutes: o.next_bus.minutes, live: o.next_bus.source === 'live' } : null,
});

export async function runPlannerTool(ctx: ToolCtx, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  switch (name) {
    case 'find_destination': {
      if (!ctx.searched) {
        ctx.searched = true;
        return { places: ctx.preResolved.map((p) => placeJson(ctx, p)) };
      }
      const query = typeof args.query === 'string' ? args.query.slice(0, 200) : '';
      const left = ctx.deadline - Date.now();
      if (!query || left < 3_000) return { places: ctx.preResolved.map((p) => placeJson(ctx, p)), note: 'No time for another search; these are the earlier matches.' };
      const r = await resolveDestination(ctx.db, ctx.userId, query, ctx.book, Math.min(P.GEOCODE_TIMEOUT_MS, left - 2_000), ctx.origin.at);
      if (!r.ok) return { places: [], note: r.code === 'destination_not_found' ? 'No match in Kitchener-Waterloo.' : 'Place search is unavailable right now.' };
      return { places: r.candidates.filter((p) => haversineKm(ctx.origin.at, p.at) <= P.MAX_TRIP_KM).map((p) => placeJson(ctx, p)) };
    }
    case 'get_route_options': {
      const place = ctx.book.get(String(args.place_id ?? ''));
      if (!place) return { error: 'unknown place_id; call find_destination first' };
      const opts = optionsFor(ctx, place);
      return { place: place.safe_name, options: opts.map(optionJson), ...(opts.length ? {} : { note: 'No walking, biking or direct bus option.' }) };
    }
    case 'get_live_buses_near': {
      const now = Date.now();
      const feeds = getStaticFeeds();
      const stops = feeds
        .flatMap((f) => f?.stops ?? [])
        .map((s) => ({ s, m: haversineM(ctx.origin.at, [s.lat, s.lng]) }))
        .filter((x) => x.m <= 400)
        .sort((a, b) => a.m - b.m)
        .slice(0, 4);
      const routeName = (tripId: string, routeId: string | null) => {
        for (const f of feeds) {
          const t = f?.trips.get(tripId);
          const r = f?.routes.get(t?.route_id ?? routeId ?? '');
          if (r) return { route: r.short_name ?? r.long_name ?? routeId, headsign: t?.headsign ?? null };
        }
        return { route: routeId, headsign: null };
      };
      return {
        live: ctx.live.arrivals.ok,
        stops: stops.map(({ s }) => ({
          stop_name: s.name,
          stop_code: s.code,
          arrivals: (ctx.live.arrivals.byStop.get(s.id) ?? [])
            .filter((a) => a.at_ms >= now && a.at_ms <= now + P.MAX_WAIT_MIN * 60_000)
            .slice(0, 3)
            .map((a) => ({ ...routeName(a.trip_id, a.route_id), minutes: Math.round((a.at_ms - now) / 60_000) })),
        })),
      };
    }
    case 'get_points_estimate': {
      const place = ctx.book.get(String(args.place_id ?? ''));
      if (!place) return { error: 'unknown place_id' };
      const o = optionsFor(ctx, place).find((x) => x.mode === args.mode);
      if (!o) return { error: `no ${String(args.mode)} option to that place` };
      return { mode: o.mode, points_estimate: o.points_estimate, points_capped: o.points_capped, daily_cap: ctx.status.daily_cap, points_today: ctx.status.points_today };
    }
    default:
      return { error: `unknown tool ${name}` };
  }
}
