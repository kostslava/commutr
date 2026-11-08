// One-off: rate the demo routes (src/safety/routes.ts) from Mapillary street photos with
// Gemini vision, and save the ratings to src/safety/ratings.json (committed).
//
//   npm run safety:generate -- --dry-run          path + photo counts only: no photo lookups, no Gemini
//   npm run safety:generate -- --only <route_id>  rate one route (others in ratings.json are kept)
//   npm run safety:generate                       rate all routes
//
// Per route: 1 Valhalla walking route, Mapillary coverage tiles (z14, shared across
// routes), up to 6 per-photo lookups, up to 6 thumbnail downloads (in memory only,
// never written to disk), 1 Gemini call. Keys come from backend/.env (MAPILLARY_ACCESS_TOKEN,
// GEMINI_API_KEY) and are never printed; URLs are never logged.

import '../src/env.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { ai, take } from '../src/chat/gemini.js';
import { GEMINI_CHAT_MODEL } from '../src/chat/config.js';
import { DEMO_ROUTES, type DemoRoute } from '../src/safety/routes.js';
import { ratingsPath } from '../src/safety/match.js';
import {
  adjustConfidence, decodePolyline6, parseRating, pathKm, RATING_PROMPT, RATING_SCHEMA, selectPhotos, yearMonth,
  type LatLng, type PhotoCandidate, type RatingsFile, type SavedRoute,
} from '../src/safety/rating.js';
import { imagesFromTile, tileFor } from './lib/mvt.js';

const DRY = process.argv.includes('--dry-run');
const onlyArg = process.argv.indexOf('--only');
const ONLY = onlyArg > 0 ? process.argv[onlyArg + 1] : undefined;
const TOKEN = process.env.MAPILLARY_ACCESS_TOKEN ?? '';
const VALHALLA = 'https://valhalla1.openstreetmap.de/route';
const Z = 14;

const fail = (msg: string): never => {
  console.error(`\nFAILED: ${msg}`);
  process.exit(1);
};
if (!TOKEN) fail('MAPILLARY_ACCESS_TOKEN is not set in backend/.env');
if (ONLY && !DEMO_ROUTES.some((r) => r.id === ONLY)) fail(`--only: unknown route. Routes: ${DEMO_ROUTES.map((r) => r.id).join(', ')}`);

async function get(url: string, init: RequestInit = {}, what: string): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  } catch (err) {
    return fail(`${what}: ${(err as Error).name}`); // never the URL: it may carry the token
  }
  if (!res.ok) fail(`${what}: HTTP ${res.status}`);
  return res;
}

async function walkingPath(r: DemoRoute): Promise<LatLng[]> {
  const json = JSON.stringify({ locations: [{ lat: r.from.lat, lon: r.from.lng }, { lat: r.to.lat, lon: r.to.lng }], costing: 'pedestrian', units: 'kilometers' });
  const res = await get(`${VALHALLA}?${new URLSearchParams({ json })}`, { headers: { 'User-Agent': 'Commutr-hackathon-route-safety/1.0' } }, `Valhalla route ${r.id}`);
  const d = (await res.json()) as { trip?: { legs?: { shape: string }[] } };
  const legs = d.trip?.legs;
  if (!legs?.length) return fail(`Valhalla route ${r.id}: no path`);
  return legs.flatMap((l) => decodePolyline6(l.shape));
}

const tiles = new Map<string, PhotoCandidate[]>();
async function candidatesNear(path: LatLng[]): Promise<PhotoCandidate[]> {
  const keys = new Set<string>();
  for (const [lat, lng] of path) {
    for (const [dl, dg] of [[0, 0], [0.0003, 0.0003], [-0.0003, -0.0003]]) keys.add(tileFor(lat + dl!, lng + dg!, Z).join('/'));
  }
  const out: PhotoCandidate[] = [];
  for (const key of keys) {
    if (!tiles.has(key)) {
      const [x, y] = key.split('/').map(Number) as [number, number];
      const res = await get(`https://tiles.mapillary.com/maps/vtp/mly1_public/2/${Z}/${x}/${y}?access_token=${encodeURIComponent(TOKEN)}`, {}, `Mapillary tile ${key}`);
      tiles.set(key, imagesFromTile(new Uint8Array(await res.arrayBuffer()), Z, x, y));
    }
    out.push(...tiles.get(key)!);
  }
  return out;
}

type PhotoDetail = { id: string; captured_at: number; thumb: string; creator: string | null };
async function photoDetail(id: string): Promise<PhotoDetail> {
  const res = await get(`https://graph.mapillary.com/${id}?fields=id,captured_at,thumb_1024_url,creator`, { headers: { Authorization: `OAuth ${TOKEN}` } }, `Mapillary photo lookup`);
  const j = (await res.json()) as { id?: string; captured_at?: number; thumb_1024_url?: string; creator?: { username?: string } };
  if (j.id !== id || !j.thumb_1024_url) return fail('Mapillary photo lookup: no thumbnail in the answer');
  return { id, captured_at: Number(j.captured_at ?? 0), thumb: j.thumb_1024_url, creator: j.creator?.username ?? null };
}

async function rate(r: DemoRoute): Promise<SavedRoute | null> {
  const path = await walkingPath(r);
  const km = Math.round(pathKm(path) * 100) / 100;
  const cands = await candidatesNear(path);
  const sel = selectPhotos(path, cands);
  const yrs = sel.chosen.map((p) => new Date(p.captured_at).getUTCFullYear());
  console.log(
    `${r.id}: ${r.from.name} -> ${r.to.name} | walking path ${km} km | ${sel.covered}/${sel.samples} sample points have a photo within 25 m | ` +
      `${sel.nearby} candidate photos near them | ${sel.chosen.length} chosen (years ${yrs.length ? `${Math.min(...yrs)}-${Math.max(...yrs)}` : '-'})`,
  );
  if (DRY) return null;
  if (sel.chosen.length < 2) return fail(`${r.id}: only ${sel.chosen.length} usable photo(s); not rating it`);

  const details: PhotoDetail[] = [];
  const parts: { inlineData: { mimeType: string; data: string } }[] = [];
  for (const p of sel.chosen) {
    const d = await photoDetail(p.id);
    const img = await get(d.thumb, {}, 'Mapillary thumbnail download');
    const type = img.headers.get('content-type') ?? '';
    if (!type.startsWith('image/')) return fail(`thumbnail download: unexpected content type`);
    parts.push({ inlineData: { mimeType: type.split(';')[0]!, data: Buffer.from(await img.arrayBuffer()).toString('base64') } }); // memory only
    details.push(d);
  }

  take(GEMINI_CHAT_MODEL);
  let text = '';
  try {
    const res = await ai().models.generateContent({
      model: GEMINI_CHAT_MODEL,
      contents: [{ role: 'user', parts: [{ text: RATING_PROMPT(r.from.name, r.to.name, km, parts.length) }, ...parts] }],
      config: { responseMimeType: 'application/json', responseJsonSchema: RATING_SCHEMA, temperature: 0.2, maxOutputTokens: 800 },
    });
    text = res.text ?? '';
  } catch (err) {
    return fail(`Gemini: ${(err as { status?: number }).status ?? (err as Error).name}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail('Gemini: the answer was not JSON');
  }
  const rating = parseRating(parsed);
  if (!rating) return fail('Gemini: the answer did not match the rating schema');

  const times = details.map((d) => d.captured_at).filter((t) => t > 0).sort((a, b) => a - b);
  const newestYear = times.length ? new Date(times.at(-1)!).getUTCFullYear() : null;
  rating.confidence = adjustConfidence(rating.confidence, details.length, newestYear);
  console.log(`  rated: ${rating.overall} (${rating.score}/5), confidence ${rating.confidence}, ${details.length} photos`);
  return {
    id: r.id, from: r.from, to: r.to, km, rating,
    photos: {
      count: details.length, sample_points_covered: sel.covered, sample_points: sel.samples,
      captured_from: times.length ? yearMonth(times[0]!) : null, captured_to: times.length ? yearMonth(times.at(-1)!) : null,
      mapillary_image_ids: details.map((d) => d.id),
      creators: [...new Set(details.map((d) => d.creator).filter((c): c is string => !!c))],
    },
    model: GEMINI_CHAT_MODEL,
    generated_at: new Date().toISOString(),
  };
}

const path = ratingsPath();
let existing: RatingsFile = { version: 1, routes: [] };
try {
  existing = JSON.parse(readFileSync(path, 'utf8')) as RatingsFile;
} catch {
  /* first run */
}

const results = new Map(existing.routes.map((r) => [r.id, r]));
for (const r of DEMO_ROUTES) {
  if (ONLY && r.id !== ONLY) continue;
  const saved = await rate(r);
  if (saved) results.set(r.id, saved);
}
if (!DRY) {
  const file: RatingsFile = { version: 1, routes: DEMO_ROUTES.map((r) => results.get(r.id)).filter((r): r is SavedRoute => !!r) };
  writeFileSync(path, JSON.stringify(file, null, 2) + '\n');
  console.log(`\nsaved ${file.routes.length} route(s) to src/safety/ratings.json`);
}
