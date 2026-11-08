// POST /api/plan and /api/agent/plan.
//
//   1. Parse the request; resolve the origin (given or saved home) and the destination
//      (saved place, demo merchant, or Nominatim). All on the server.
//   2. Compute the options in code (routes.ts). This is also the fallback answer.
//   3. Gemini (function calling): find_destination -> get_route_options (-> live buses,
//      points), then ONE final call with a response schema: which place, which
//      recommendation, the order, eco notes and a 1-2 sentence spoken summary.
//   4. Validate that answer in code. Numbers always come from step 2; a summary with a
//      number that isn't in the tool results is replaced by the computed summary.
//   5. Anything fails, times out (8 s budget) or the Gemini ceiling has no room for a
//      whole plan: the computed answer, source "computed".

import type { Content, GenerateContentResponse } from '@google/genai';
import * as C from '../chat/config.js';
import { ai, GeminiUnavailable, noteError, take, withTimeout } from '../chat/gemini.js';
import { log } from '../chat/redact.js';
import { providerRoom } from '../chat/usage.js';
import type { DB } from '../db.js';
import { haversineKm } from '../geo.js';
import { userStatus } from '../status.js';
import { ATTRIBUTION as GRT_ATTRIBUTION } from '../transit/config.js';
import * as P from './config.js';
import { getCachedPlan, planCacheKey, putCachedPlan } from './cache.js';
import { parseDestination, PlaceBook, resolveDestination, resolveOrigin, type DestinationInput, type Origin, type Place, type PlaceKind } from './places.js';
import { computedRecommendation, liveData, PLAN_MODES, type PlanMode, type PlanOption } from './routes.js';
import { optionJson, optionsFor, PLANNER_TOOLS, runPlannerTool, type ToolCtx } from './tools.js';

export type PlanResponse = {
  source: 'gemini' | 'computed';
  /** True when Gemini's decision came from the 5-minute cache (the numbers are always fresh). */
  cached: boolean;
  destination: { name: string; kind: PlaceKind };
  origin: Origin['kind'];
  /** The starting point in words: "your saved home", "your current location" or a place name. Never coordinates. */
  origin_name: string;
  options: PlanOption[];
  recommendation: PlanMode | null;
  summary: string;
  attribution: string[];
};

export type PlanError = { status: 400 | 404 | 503; code: string; message: string; summary: string };

const fail = (status: PlanError['status'], code: string, message: string, summary: string): PlanError => ({ status, code, message, summary });

// --- Summaries --------------------------------------------------------------------

const MODE_WORD: Record<PlanMode, string> = { walk: 'walking', bike: 'biking', transit: 'taking the bus' };

/** Every summary starts by saying where the trip starts: "From your saved home, ...". */
function computedSummary(start: string, destName: string, options: PlanOption[], rec: PlanMode | null): string {
  const best = options.find((o) => o.mode === rec);
  if (!best) return `From ${start}, I couldn't find a walking, biking or direct bus option to ${destName}.`;
  const bus = best.mode === 'transit' && best.next_bus ? ` on route ${best.next_bus.route}` : '';
  const first = `From ${start}, ${MODE_WORD[best.mode]}${bus} to ${destName} takes about ${best.minutes} minutes and earns about ${best.points_estimate} points.`;
  const others = options.filter((o) => o !== best).map((o) => `${o.mode} ${o.minutes} min`);
  return others.length ? `${first} Other options: ${others.join(', ')}.` : first;
}

const orderOptions = (options: PlanOption[], first: PlanMode | null, order: PlanMode[] = []) => {
  const rank = (m: PlanMode) => (m === first ? -1 : order.includes(m) ? order.indexOf(m) : 10);
  return [...options].sort((a, b) => rank(a.mode) - rank(b.mode) || a.minutes - b.minutes);
};

// --- Gemini -------------------------------------------------------------------------

const SYSTEM = [
  'You are the Commutr mascot, planning a green trip in Kitchener-Waterloo, Ontario, by walking, biking or GRT transit.',
  'First call find_destination with the destination, then get_route_options with the best matching place_id. You may also call get_live_buses_near or get_points_estimate.',
  'Never invent numbers. Only use minutes, km, points and bus times that appear in tool results.',
  'Choose the recommendation: prefer the greener choice and more points when times are similar; avoid walks longer than about 40 minutes when another option exists; prefer the bus when it is much faster.',
  'The summary is read aloud: 1 or 2 short sentences, plain text, no markdown, no lists, no emoji. Begin it with "From <starting point>, " exactly as the request names the starting point, then the recommended mode, its minutes and its points.',
  'Never ask for or mention personal details. Merchants are demo data. Commutr is not affiliated with GRT; for fares say to check grt.ca.',
].join('\n');

const FINAL_PROMPT =
  'Now give your final answer as JSON: place_id (the place you planned for), recommendation (one mode from the options), order (all option modes, best first), eco_notes (optional, one short sentence per mode) and summary (1-2 short spoken sentences, beginning with "From <starting point>, ").';

export const FINAL_SCHEMA = {
  type: 'object',
  properties: {
    place_id: { type: 'string' },
    recommendation: { type: 'string', enum: [...PLAN_MODES] },
    order: { type: 'array', items: { type: 'string', enum: [...PLAN_MODES] } },
    eco_notes: {
      type: 'array',
      items: { type: 'object', properties: { mode: { type: 'string', enum: [...PLAN_MODES] }, note: { type: 'string' } }, required: ['mode', 'note'] },
    },
    summary: { type: 'string' },
  },
  required: ['place_id', 'recommendation', 'order', 'summary'],
};

type GeminiAnswer = { place_id: string; recommendation: PlanMode; order: PlanMode[]; eco_notes: Map<PlanMode, string>; summary: string };

/** Every number Gemini was shown (tool results + the request). */
const optionNumbers = (options: PlanOption[]) => JSON.stringify(options.map(o => [o.mode, o.minutes, o.km, o.points_estimate, o.next_bus?.minutes ?? null]));
const numbersIn = (text: string) => new Set((text.match(/\d+(?:\.\d+)?/g) ?? []).map(Number));

async function geminiPlan(ctx: ToolCtx, request: string, allowed: Set<number>, signal: AbortSignal): Promise<GeminiAnswer> {
  const model = C.GEMINI_CHAT_MODEL;
  const genai = ai();
  const contents: Content[] = [{ role: 'user', parts: [{ text: request }] }];
  for (const n of numbersIn(request)) allowed.add(n);

  let n = 0;
  const call = async (config: Record<string, unknown>): Promise<GenerateContentResponse> => {
    take(model);
    const t0 = Date.now();
    const what = config.tools ? 'tool round' : 'final answer';
    n++;
    try {
      const res = await genai.models.generateContent({
        model,
        contents,
        config: {
          systemInstruction: SYSTEM,
          maxOutputTokens: C.PLANNER_MAX_OUTPUT_TOKENS,
          temperature: C.PLANNER_TEMPERATURE,
          thinkingConfig: { thinkingLevel: C.PLANNER_THINKING_LEVEL },
          abortSignal: signal,
          ...config,
        },
      });
      const calls = (res.functionCalls ?? []).map((f) => f.name).join('+');
      log.info(`plan: Gemini call ${n} (${what}) ${Date.now() - t0} ms${calls ? `, called ${calls}` : ''}`);
      return res;
    } catch (err) {
      log.info(`plan: Gemini call ${n} (${what}) failed after ${Date.now() - t0} ms`);
      noteError(model, err);
      throw err;
    }
  };

  let haveOptions = false;
  for (let round = 0; round < C.PLANNER_MAX_TOOL_ROUNDS && !haveOptions; round++) {
    const res = await call({ tools: [{ functionDeclarations: PLANNER_TOOLS }] });
    const calls = res.functionCalls ?? [];
    if (calls.length === 0) break; // the model answered in text: go to the final answer
    const turn = res.candidates?.[0]?.content;
    if (turn) contents.push(turn);
    const parts = [];
    for (const fc of calls) {
      const result = await runPlannerTool(ctx, fc.name ?? '', (fc.args ?? {}) as Record<string, unknown>);
      for (const n of numbersIn(JSON.stringify(result))) allowed.add(n);
      if (fc.name === 'get_route_options' && Array.isArray(result.options) && result.options.length) haveOptions = true;
      parts.push({ functionResponse: { id: fc.id, name: fc.name, response: result } });
    }
    contents.push({ role: 'user', parts });
  }
  if (!haveOptions) throw new Error('Gemini did not get route options');

  contents.push({ role: 'user', parts: [{ text: FINAL_PROMPT }] });
  const res = await call({ responseMimeType: 'application/json', responseJsonSchema: FINAL_SCHEMA });
  return parseAnswer(res.text ?? '');
}

function parseAnswer(text: string): GeminiAnswer {
  const raw = JSON.parse(text) as Record<string, unknown>;
  const isMode = (m: unknown): m is PlanMode => PLAN_MODES.includes(m as PlanMode);
  if (typeof raw.place_id !== 'string' || !isMode(raw.recommendation) || typeof raw.summary !== 'string') throw new Error('answer does not match the schema');
  const order = Array.isArray(raw.order) ? [...new Set(raw.order.filter(isMode))] : [];
  const eco_notes = new Map<PlanMode, string>();
  if (Array.isArray(raw.eco_notes)) {
    for (const e of raw.eco_notes as Record<string, unknown>[]) if (isMode(e?.mode) && typeof e.note === 'string') eco_notes.set(e.mode, e.note);
  }
  return { place_id: raw.place_id, recommendation: raw.recommendation, order, eco_notes, summary: raw.summary };
}

/** Plain spoken text only. */
const clean = (s: string) => s.replace(/[*_`#>|~]+/g, '').replace(/\p{Extended_Pictographic}/gu, '').replace(/\s+/g, ' ').trim();
const onlyKnownNumbers = (s: string, allowed: Set<number>) => [...numbersIn(s)].every((n) => allowed.has(n));

// --- The plan ---------------------------------------------------------------------------

type Decision = Pick<GeminiAnswer, 'recommendation' | 'order' | 'summary' | 'eco_notes'>;

/** Gemini's decision applied to options computed in code; its text checked against `allowed` numbers. */
/** Gemini is asked to begin with "From <start>, ". If it didn't, say the start first rather than rewriting its sentence. */
function withStart(summary: string, start: string): string {
  return summary.toLowerCase().startsWith(`from ${start.toLowerCase()}`) ? summary : `Starting from ${start}. ${summary}`;
}

function decisionResponse(place: Place, options: PlanOption[], d: Decision, allowed: Set<number>, base: { origin: Origin; attribution: string[]; cached: boolean }): PlanResponse {
  let summary = clean(d.summary);
  if (!summary || summary.length > P.SUMMARY_MAX_CHARS || !onlyKnownNumbers(summary, allowed)) {
    log.info('plan: Gemini summary failed the checks (length or an unknown number); using the computed summary');
    summary = computedSummary(base.origin.name, place.display_name, options, d.recommendation);
  }
  summary = withStart(summary, base.origin.name);
  const withNotes = options.map((o) => {
    const note = clean(d.eco_notes.get(o.mode) ?? '');
    return note && note.length <= P.ECO_NOTE_MAX_CHARS && onlyKnownNumbers(note, allowed) ? { ...o, eco_note: note } : o;
  });
  return {
    source: 'gemini',
    cached: base.cached,
    destination: { name: place.display_name, kind: place.kind },
    origin: base.origin.kind,
    origin_name: base.origin.name,
    options: orderOptions(withNotes, d.recommendation, d.order),
    recommendation: d.recommendation,
    summary,
    attribution: base.attribution,
  };
}

const attributionFor = (usedSearch: boolean) => [GRT_ATTRIBUTION, ...(usedSearch ? [P.OSM_ATTRIBUTION] : [])];

export async function plan(db: DB, userId: number, body: Record<string, unknown>): Promise<PlanResponse | PlanError> {
  const started = Date.now();
  const deadline = started + P.PLAN_BUDGET_MS;
  const left = () => deadline - Date.now();

  const dest: DestinationInput | null = parseDestination(body.destination);
  if (!dest) return fail(400, 'validation_error', 'destination must be a non-empty string (max 200 chars) or { name, lat, lng }', 'Where would you like to go?');
  const origin = await resolveOrigin(db, userId, body, Math.min(P.GEOCODE_TIMEOUT_MS, left() - P.FALLBACK_RESERVE_MS - 1_500));
  if (origin === 'invalid') return fail(400, 'validation_error', 'origin_name must be a place name (1-120 chars), or origin_lat and origin_lng both valid numbers', 'Where are you starting from?');
  if (origin === 'conflict') return fail(400, 'validation_error', 'Send one starting point: origin_name, or origin_lat and origin_lng, not both', 'Where are you starting from?');
  if (origin === 'origin_not_found') return fail(404, 'origin_not_found', 'No place in Kitchener-Waterloo matches origin_name', "I couldn't find that starting point in Kitchener-Waterloo. Can you name another place nearby?");
  if (origin === 'search_unavailable') return fail(503, 'search_unavailable', 'Place search is unavailable right now', "I can't look up places right now. Can you name a saved place, like home?");
  if (!origin) return fail(400, 'no_origin', 'No starting point: send origin_name or origin_lat and origin_lng, or save a home location.', 'Where are you starting from?');

  const livePromise = liveData(Math.min(3_000, left() - P.FALLBACK_RESERVE_MS));
  const book = new PlaceBook();
  const newCtx = async (preResolved: Place[]): Promise<ToolCtx> => ({
    db, userId, origin, book, status: userStatus(db, userId), live: await livePromise, preResolved, options: new Map(), deadline, searched: false,
  });

  // Cache hit: Gemini's earlier decision, today's numbers. No geocoding, no Gemini call.
  const cacheKey = planCacheKey(userId, dest, origin);
  const hit = getCachedPlan(cacheKey);
  if (hit) {
    const place = book.add(hit.place);
    const ctx = await newCtx([place]);
    const options = optionsFor(ctx, place);
    if (options.some((o) => o.mode === hit.recommendation)) {
      const allowed = numbersIn(JSON.stringify(options.map(optionJson)) + ' ' + place.safe_name + ' ' + (typeof dest === 'string' ? dest : dest.name));
      const d: Decision = { recommendation: hit.recommendation, order: hit.order, summary: hit.optionNumbers === optionNumbers(options) ? hit.summary : computedSummary(origin.name, place.display_name, options, hit.recommendation), eco_notes: new Map(hit.eco_notes) };
      return decisionResponse(place, options, d, allowed, { origin, attribution: attributionFor(hit.usedSearch), cached: true });
    }
    // The recommended mode is no longer offered (e.g. no bus now): plan afresh.
  }

  const resolved = await resolveDestination(db, userId, dest, book, left() - P.FALLBACK_RESERVE_MS, origin.at);
  if (!resolved.ok) {
    return resolved.code === 'destination_not_found'
      ? fail(404, 'destination_not_found', 'No place in Kitchener-Waterloo matches that destination', "I couldn't find that place in Kitchener-Waterloo. Can you say it another way?")
      : fail(503, 'search_unavailable', 'Place search is unavailable right now', "I can't look up places right now. Try a saved place like home, or try again soon.");
  }
  const candidates = resolved.candidates.filter((p) => haversineKm(origin.at, p.at) <= P.MAX_TRIP_KM);
  if (!candidates.length) return fail(400, 'too_far', `The destination is more than ${P.MAX_TRIP_KM} km away`, 'That place is too far away for walking, biking or a local bus.');

  const ctx = await newCtx(candidates);
  const attribution = attributionFor(resolved.usedSearch);

  // Computed answer: the best-matching place (candidates are ranked by name match, then distance).
  const computed = (place: Place): PlanResponse => {
    const options = optionsFor(ctx, place);
    const rec = computedRecommendation(options);
    return {
      source: 'computed',
      cached: false,
      destination: { name: place.display_name, kind: place.kind },
      origin: origin.kind,
      origin_name: origin.name,
      options: orderOptions(options, rec),
      recommendation: rec,
      summary: computedSummary(origin.name, place.display_name, options, rec),
      attribution,
    };
  };

  // Gemini only when the key is set and the ceiling has room for a whole plan.
  const model = C.GEMINI_CHAT_MODEL;
  if (!C.geminiApiKey()) return computed(candidates[0]!);
  if (providerRoom(model) < C.PLANNER_MAX_GEMINI_CALLS) {
    log.info('plan: Gemini ceiling has no room for a whole plan, using the computed answer');
    return computed(candidates[0]!);
  }

  const first = candidates[0]!;
  const destText = first.kind === 'search' || first.kind === 'merchant' ? String(dest) : first.safe_name;
  // Only the starting point's name (never coordinates) goes to Gemini.
  const request = `Plan my trip. Destination: ${destText}. I'm starting from ${origin.name}. Begin the summary with exactly "From ${origin.name}, ".`;
  const allowed = new Set<number>();
  log.info(`plan: destination and live data ready after ${Date.now() - started} ms`);
  try {
    const budget = left() - P.FALLBACK_RESERVE_MS;
    if (budget < 1_500) throw new Error('not enough time left for Gemini');
    const answer = await withTimeout(budget, (signal) => geminiPlan(ctx, request, allowed, signal));

    const place = book.get(answer.place_id);
    if (!place) throw new Error('answer names an unknown place');
    const options = optionsFor(ctx, place);
    if (!options.some((o) => o.mode === answer.recommendation)) throw new Error('recommendation is not one of the options');

    const response = decisionResponse(place, options, answer, allowed, { origin, attribution, cached: false });
    const { id: _id, ...placeData } = place;
    putCachedPlan(cacheKey, {
      place: placeData,
      usedSearch: resolved.usedSearch,
      recommendation: answer.recommendation,
      order: answer.order,
      summary: answer.summary,
      optionNumbers: optionNumbers(options),
      eco_notes: [...answer.eco_notes],
    });
    log.info(`plan: source=gemini in ${Date.now() - started} ms`);
    return response;
  } catch (err) {
    const why = err instanceof GeminiUnavailable ? err.reason : (err as Error).name === 'TimeoutError' ? 'timed out' : 'failed';
    log.warn(`plan: Gemini ${why}, using the computed answer`, err instanceof GeminiUnavailable ? undefined : err);
    return computed(first);
  }
}

export const isPlanError = (r: PlanResponse | PlanError): r is PlanError => 'code' in r;
