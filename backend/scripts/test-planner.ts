// Trip planner + live-agent tool endpoint tests.
//
//   npm run test:planner     mocked only (fake Gemini, Nominatim and GRT feeds, fake
//                            keys): never a real provider call. Part of npm test.
//   ... test-planner.ts --real   only one real POST /api/plan (real Gemini, Nominatim
//                            and GRT; npm run test:real). Needs GEMINI_API_KEY.
//
// Servers: 8781 (main, mocked), 8782 (no agent secret, real Gemini ceilings, trip
// updates down), 8783 (real run). Mock providers on 8789.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GEMINI_CHAT_MODEL } from '../src/chat/config.js';
import { BUILDERS_CLUB } from '../src/demoPlaces.js';
import { DEFAULT_WAIT_MIN, PLAN_BUDGET_MS } from '../src/planner/config.js';
import { DAILY_POINTS_CAP, MODE_RATES } from '../src/scoring/config.js';
import { cycling, phone, track } from './lib/gps.js';
import { addUser, BACKEND, startHarness, table, type Harness } from './lib/harness.js';
import { startMockProviders, TEST_GRT, type Mock } from './lib/mock-providers.js';

// ---------------------------------------------------------------------------
// Bookkeeping
// ---------------------------------------------------------------------------

type Row = { Case: string; Check: string; Result: string };
const rows: Row[] = [];
let failures = 0;
function check(caseName: string, label: string, ok: boolean, detail = '') {
  if (!ok) failures++;
  rows.push({ Case: caseName, Check: label + (detail ? ` (${detail})` : ''), Result: ok ? 'PASS' : 'FAIL' });
}

// Fake secrets: every log line and response body is scanned for these.
const FAKE_GEMINI_KEY = 'test-gemini-key-SECRET-9a8b7c';
const AGENT_SECRET = 'test-agent-secret-SECRET-5d6e7f';
const responseBodies: string[] = [];

// The fake GRT network (mock-providers.ts) is built around this point, so the tests move user 1's
// home here in their own test databases (the seed puts it at Builders Club, see demoPlaces.ts).
const HOME: [number, number] = [43.4762, -80.5371];
const dataDir = (name: string) => fileURLToPath(new URL(`../data/test-planner/${name}/`, import.meta.url));

function plannerEnv(name: string, mockUrl: string, extra: Record<string, string> = {}): Record<string, string> {
  const dir = dataDir(name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return {
    CHAT_TTS_DIR: dir + 'tts/',
    CHAT_USAGE_FILE: dir + 'usage.json',
    GEOCODE_CACHE_FILE: dir + 'geocode.json',
    GRT_CACHE_DIR: dir + 'gtfs/',
    CHAT_CEILING_MULTIPLIER: '100',
    GEMINI_BASE_URL: mockUrl,
    GEMINI_API_KEY: FAKE_GEMINI_KEY,
    NOMINATIM_BASE_URL: mockUrl,
    GRT_STATIC_URLS: `${mockUrl}/grt/staticfeeds/1`,
    GRT_VEHICLES_URLS: `${mockUrl}/grt/vehiclepositions/1`,
    GRT_TRIPUPDATES_URLS: `${mockUrl}/grt/tripupdates/1`,
    AGENT_TOOL_SECRET: AGENT_SECRET,
    ...extra,
  };
}

async function call(h: Harness, method: string, path: string, opts: { user?: number; body?: unknown; headers?: Record<string, string> } = {}) {
  const t0 = performance.now();
  const res = await fetch(h.base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(opts.user ? { 'X-Demo-User': String(opts.user) } : {}), ...opts.headers },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  responseBodies.push(text);
  return { status: res.status, json: text ? JSON.parse(text) : null, ms: performance.now() - t0 };
}
const planCall = (h: Harness, user: number, body: unknown) => call(h, 'POST', '/api/plan', { user, body });
const agent = (h: Harness, method: string, path: string, opts: { user?: number; body?: unknown; secret?: string | null } = {}) =>
  call(h, method, `/api/agent${path}`, {
    user: opts.user,
    body: opts.body,
    headers: opts.secret === null ? {} : { 'X-Agent-Secret': opts.secret ?? AGENT_SECRET },
  });

/** A user with a saved home at user 1's home (planner tests need an origin). */
function userWithHome(h: Harness, id: number, name: string, fields: Parameters<typeof addUser>[3] = {}) {
  addUser(h.db, id, name, fields);
  h.db.prepare("INSERT INTO saved_locations (user_id, kind, label, lat, lng) VALUES (?, 'home', 'Home', ?, ?)").run(id, HOME[0], HOME[1]);
}

function pointsToday(h: Harness, userId: number): number {
  const rows = h.db.prepare("SELECT ended_at, points_awarded FROM trips WHERE user_id = ? AND status = 'finished'").all(userId) as { ended_at: string; points_awarded: number }[];
  const day = (iso: string | number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto' }).format(new Date(iso));
  return rows.filter((r) => day(r.ended_at) === day(Date.now())).reduce((n, r) => n + r.points_awarded, 0);
}

/** Expected estimate straight from the scoring rules: km x rate x 1.0 x trust, rounded, then today's cap. */
function expectedPoints(h: Harness, userId: number, mode: keyof typeof MODE_RATES, km: number) {
  const { trust_multiplier } = h.db.prepare('SELECT trust_multiplier FROM users WHERE id = ?').get(userId) as { trust_multiplier: number };
  const raw = Math.round(km * MODE_RATES[mode] * 1.0 * trust_multiplier);
  return Math.min(raw, Math.max(0, DAILY_POINTS_CAP - pointsToday(h, userId)));
}

const optionOf = (json: any, mode: string) => (json?.options ?? []).find((o: any) => o.mode === mode);
const planRequests = (mock: Mock) => mock.gemini.filter((g) => g.kind === 'plan');

// ---------------------------------------------------------------------------
// Part 1: mocked
// ---------------------------------------------------------------------------

async function mocked() {
  const mock = await startMockProviders(8789);
  // The plan cache is off on main and second (tests repeat destinations); it's tested on its own server.
  const mainEnv = plannerEnv('main', mock.url, { PLAN_CACHE_OFF: '1' });
  // Geocode cache as npm run geocode:warm leaves it: a warmed place (30-day expiry, written
  // 3 days ago) must be used without Nominatim; an old entry with no expiry, 2 days old, is stale.
  const day = 24 * 3600_000, L = TEST_GRT.library;
  writeFileSync(
    mainEnv.GEOCODE_CACHE_FILE!,
    JSON.stringify({
      'test warm place': { at: Date.now() - 3 * day, expires: Date.now() + 27 * day, results: [{ name: 'Test Warm Place, Test Street, Kitchener', lat: L.lat, lng: L.lng }] },
      'old library': { at: Date.now() - 2 * day, results: [{ name: 'Old Cached Library', lat: L.lat, lng: L.lng }] },
      'test warm origin': { at: Date.now() - day, expires: Date.now() + 29 * day, results: [{ name: 'Test Warm Origin, Origin Street, Waterloo', lat: 43.475, lng: -80.539 }] },
    }),
  );
  const main = await startHarness({ dbName: 'test-planner.db', port: 8781, env: mainEnv });
  let prod: Harness | undefined;
  const cacheSrv = await startHarness({ dbName: 'test-planner-cache.db', port: 8784, env: plannerEnv('cache', mock.url) });
  // No agent secret, real (x1) Gemini ceilings, trip-updates feed unreachable.
  const second = await startHarness({
    dbName: 'test-planner-2.db',
    port: 8782,
    env: plannerEnv('second', mock.url, { AGENT_TOOL_SECRET: '', CHAT_CEILING_MULTIPLIER: '1', GRT_TRIPUPDATES_URLS: `${mock.url}/grt/tripupdates/missing`, PLAN_CACHE_OFF: '1' }),
  });

  try {
    // The seed's demo home for user 1 is Builders Club; then move it to the test network's point.
    let c = 'demo home';
    const seededHome = main.db.prepare("SELECT label, lat, lng FROM saved_locations WHERE user_id = 1 AND kind = 'home'").get() as { label: string; lat: number; lng: number };
    check(c, 'seed: user 1 home is "Builders Club" at the shared demo coordinates', seededHome.label === BUILDERS_CLUB.name && seededHome.lat === BUILDERS_CLUB.lat && seededHome.lng === BUILDERS_CLUB.lng, seededHome.label);
    const otherHomes = main.db.prepare("SELECT user_id, label FROM saved_locations WHERE kind = 'home' AND user_id IN (2, 3, 4) ORDER BY user_id").all() as { user_id: number; label: string }[];
    check(c, 'seed: users 2-4 keep their homes', otherHomes.length === 3 && otherHomes.every((h) => h.label === 'Home'));
    for (const h of [main, second, cacheSrv]) h.db.prepare("UPDATE saved_locations SET lat = ?, lng = ? WHERE user_id = 1 AND kind = 'home'").run(HOME[0], HOME[1]);

    const u1 = main.db.prepare('SELECT name, email FROM users WHERE id = 1').get() as { name: string; email: string };

    // --- Happy path ------------------------------------------------------------------
    c = 'happy path';
    const before = planRequests(mock).length;
    let r = await planCall(main, 1, { destination: 'Test Library' });
    const happy = r.json;
    check(c, '200 with source "gemini"', r.status === 200 && happy?.source === 'gemini', `${r.status} ${happy?.source}`);
    check(c, 'within the 8 s budget', r.ms < PLAN_BUDGET_MS, `${Math.round(r.ms)} ms`);
    check(c, 'walk, bike and transit offered', ['walk', 'bike', 'transit'].every((m) => optionOf(happy, m)), (happy?.options ?? []).map((o: any) => o.mode).join(','));
    check(c, "Gemini's recommendation is used and listed first", happy?.recommendation === 'transit' && happy?.options?.[0]?.mode === 'transit');
    const tr = optionOf(happy, 'transit');
    check(c, 'next bus from the live trip-updates feed', tr?.next_bus?.source === 'live' && tr.next_bus.route === '7' && tr.next_bus.stop_name === TEST_GRT.stopA.name && Math.abs(tr.next_bus.minutes - TEST_GRT.arrivalsMin[0]!) <= 1, JSON.stringify(tr?.next_bus));
    check(c, 'headsign without the route number', tr?.next_bus?.headsign === 'Test Mall', String(tr?.next_bus?.headsign));
    check(c, 'summary from Gemini, using real option numbers', happy?.summary === `From your saved home, Mock plan: transit takes about ${tr?.minutes} minutes and earns about ${tr?.points_estimate} points.`, happy?.summary);
    check(c, "Gemini's eco notes are used", tr?.eco_note === 'Mock note for transit.', tr?.eco_note);
    check(c, 'destination from the place search', happy?.destination?.kind === 'search' && /^Test Library/.test(happy?.destination?.name), JSON.stringify(happy?.destination));
    check(c, 'origin is the saved home, said in words', happy?.origin === 'home' && happy?.origin_name === 'your saved home');
    check(c, 'GRT and OpenStreetMap attribution', happy?.attribution?.some((a: string) => /Grand River Transit/.test(a)) && happy?.attribution?.some((a: string) => /OpenStreetMap/.test(a)));
    check(c, '3 Gemini calls (2 tool rounds + final answer)', planRequests(mock).length - before === 3, String(planRequests(mock).length - before));
    const final = planRequests(mock).at(-1)!.body;
    check(c, 'final call uses a response schema', final.generationConfig?.responseMimeType === 'application/json' && !!final.generationConfig?.responseJsonSchema && !final.tools);
    check(c, 'not from the cache', happy?.cached === false);
    check(c, 'every planner call asks for MINIMAL thinking', planRequests(mock).slice(before).every((g) => g.body.generationConfig?.thinkingConfig?.thinkingLevel === 'MINIMAL'));
    check(c, 'tool calls use the planner tools', planRequests(mock).slice(before, before + 1)[0]?.body.tools?.[0]?.functionDeclarations?.map((f: any) => f.name).join(',') === 'find_destination,get_route_options,get_live_buses_near,get_points_estimate');

    // --- Points estimates match the scoring formula -------------------------------------
    c = 'points estimates';
    for (const o of happy?.options ?? []) {
      const exp = expectedPoints(main, 1, o.mode, o.points_km);
      check(c, `user 1 ${o.mode}: km x rate x trust, capped`, o.points_estimate === exp, `${o.points_km} km -> ${o.points_estimate}, expected ${exp}`);
    }
    check(c, 'transit points are for the ride only (track from the stop)', tr && tr.points_km < tr.km, `${tr?.points_km} of ${tr?.km} km`);
    // Low trust and near the daily cap.
    userWithHome(main, 7501, 'Low trust', { trust_multiplier: 0.7 });
    userWithHome(main, 7502, 'Near cap');
    const ended = new Date(Date.now() - 3600_000).toISOString();
    main.db
      .prepare("INSERT INTO trips (user_id, mode, status, started_at, ended_at, distance_km, confidence, points_awarded, flags) VALUES (7502, 'walk', 'finished', ?, ?, 19, 1, 190, '[]')")
      .run(new Date(Date.now() - 7200_000).toISOString(), ended);
    const given = { destination: { name: 'Test Library', lat: TEST_GRT.library.lat, lng: TEST_GRT.library.lng } };
    for (const uid of [7501, 7502]) {
      const p = await planCall(main, uid, given);
      for (const o of p.json?.options ?? []) {
        const exp = expectedPoints(main, uid, o.mode, o.points_km);
        check(c, `user ${uid === 7501 ? 'trust 0.7' : 'with 190 today'} ${o.mode}`, o.points_estimate === exp, `${o.points_estimate} vs ${exp}`);
      }
      if (uid === 7502) check(c, 'daily cap flagged', (p.json?.options ?? []).every((o: any) => o.points_estimate <= 10) && p.json?.options?.some((o: any) => o.points_capped));
    }

    // --- Gemini fails: computed fallback ------------------------------------------------------
    c = 'fallback';
    const sameNumbers = (a: any, b: any) =>
      ['walk', 'bike', 'transit'].every((m) => {
        const x = optionOf(a, m), y = optionOf(b, m);
        return x && y && x.km === y.km && x.points_estimate === y.points_estimate && x.points_km === y.points_km;
      });
    const cases: [string, () => void, number][] = [
      ['Gemini error (500)', () => (mock.state.gemini = 'error'), 7601],
      ['Gemini too slow (9 s)', () => Object.assign(mock.state, { gemini: 'slow', slowMs: 9_000 }), 7602],
      ['Gemini quota (429)', () => (mock.state.gemini = 'quota'), 7603],
      ['answer fails the schema (car)', () => (mock.state.planner = 'invalid'), 7604],
      ['answer names an unknown place', () => (mock.state.planner = 'unknown_place'), 7605],
    ];
    for (const [label, setup, uid] of cases) {
      userWithHome(main, uid, label);
      setup();
      const p = await planCall(main, uid, { destination: 'Test Library' });
      Object.assign(mock.state, { gemini: 'normal', planner: 'good', slowMs: 6_000 });
      check(c, `${label}: 200, source "computed"`, p.status === 200 && p.json?.source === 'computed', `${p.status} ${p.json?.source}`);
      check(c, `${label}: same computed numbers`, sameNumbers(p.json, happy));
      check(c, `${label}: within budget`, p.ms < PLAN_BUDGET_MS + 300, `${Math.round(p.ms)} ms`);
      check(c, `${label}: computed recommendation and summary`, p.json?.recommendation === 'bike' && /^From your saved home, biking to Test Library/.test(p.json?.summary ?? ''), p.json?.summary);
    }
    userWithHome(main, 7606, 'invented number');
    mock.state.planner = 'invented_number';
    r = await planCall(main, 7606, { destination: 'Test Library' });
    mock.state.planner = 'good';
    check(c, 'summary with an invented number is replaced', r.json?.source === 'gemini' && !String(r.json?.summary).includes('9999') && /^From your saved home, taking the bus/.test(r.json?.summary ?? ''), r.json?.summary);

    // --- Errors ---------------------------------------------------------------------------
    c = 'errors';
    addUser(main.db, 7701, 'No home');
    r = await planCall(main, 7701, { destination: 'Test Library' });
    check(c, 'no origin and no saved home -> 400 no_origin', r.status === 400 && r.json?.error?.code === 'no_origin', `${r.status} ${r.json?.error?.code}`);
    r = await planCall(main, 7701, { destination: 'Test Library', origin_lat: 43.47 });
    check(c, 'only origin_lat -> 400', r.status === 400 && r.json?.error?.code === 'validation_error');
    r = await planCall(main, 7701, { destination: 5 });
    check(c, 'destination not a string -> 400', r.status === 400);
    userWithHome(main, 7702, 'Not found');
    r = await planCall(main, 7702, { destination: 'nowhere special' });
    check(c, 'unknown place -> 404 destination_not_found', r.status === 404 && r.json?.error?.code === 'destination_not_found', `${r.status}`);
    userWithHome(main, 7703, 'Search down');
    mock.state.nominatim = 'error';
    r = await planCall(main, 7703, { destination: 'Another library' });
    mock.state.nominatim = 'normal';
    check(c, 'place search down -> 503 search_unavailable', r.status === 503 && r.json?.error?.code === 'search_unavailable', `${r.status}`);

    // --- Saved place, given origin ---------------------------------------------------------
    c = 'saved place';
    const n0 = planRequests(mock).length;
    r = await planCall(main, 1, { destination: 'campus' });
    const savedRaw = planRequests(mock).slice(n0).map((g) => g.raw).join('\n');
    check(c, 'saved location found by its label', r.status === 200 && r.json?.destination?.kind === 'saved' && r.json?.destination?.name === 'Campus', JSON.stringify(r.json?.destination));
    check(c, 'Gemini sees "your saved place", never the label', savedRaw.includes('your saved place') && !/campus/i.test(savedRaw));
    r = await planCall(main, 2, { destination: 'Test Library', origin_lat: 43.4701, origin_lng: -80.5302 });
    check(c, 'origin_lat/origin_lng used when given, said as "your current location"', r.status === 200 && r.json?.origin === 'given' && r.json?.origin_name === 'your current location' && /^From your current location, /.test(r.json?.summary ?? ''), r.json?.summary);

    // --- Starting point (origin_name) ---------------------------------------------------------------
    c = 'starting point';
    addUser(main.db, 7740, 'Named origin, no home');
    let g0 = planRequests(mock).length;
    let n0b = mock.nominatim.length;
    r = await planCall(main, 7740, { destination: 'Test Library', origin_name: 'Test Campus' });
    let rawNamed = planRequests(mock).slice(g0).map((g) => g.raw).join('\n');
    check(c, 'origin_name resolves (no saved home needed)', r.status === 200 && r.json?.origin === 'named' && r.json?.origin_name === 'Test Campus', `${r.status} ${r.json?.origin} ${r.json?.origin_name}`);
    check(c, 'summary starts with the named starting point', /^From Test Campus, /.test(r.json?.summary ?? ''), r.json?.summary);
    check(c, 'Gemini is told the start by name only', rawNamed.includes("I'm starting from Test Campus") && !/\d+\.\d{4,}/.test(rawNamed));
    check(c, 'origin search sends only the name to Nominatim', mock.nominatim.slice(n0b).some((n) => n.q === 'Test Campus') && mock.nominatim.slice(n0b).every((n) => !/lat=|lon=/.test(n.url)));
    n0b = mock.nominatim.length;
    r = await planCall(main, 1, { destination: 'Test Library', origin_name: 'Builders Club' });
    check(c, 'user 1: origin_name "Builders Club" is the saved home, no network search', r.status === 200 && r.json?.origin === 'home' && r.json?.origin_name === 'your saved home' && mock.nominatim.length === n0b, `${r.json?.origin} ${r.json?.origin_name}`);
    userWithHome(main, 7741, 'Warm origin');
    n0b = mock.nominatim.length;
    r = await planCall(main, 7741, { destination: 'Test Library', origin_name: 'test WARM origin' });
    check(c, 'a warmed origin needs no Nominatim request', r.status === 200 && r.json?.origin_name === 'Test Warm Origin' && mock.nominatim.length === n0b, `${r.json?.origin_name}, ${mock.nominatim.length - n0b} requests`);
    userWithHome(main, 7742, 'Origin home');
    r = await planCall(main, 7742, { destination: 'Test Library', origin_name: 'home' });
    check(c, 'origin_name "home" is the saved home', r.json?.origin === 'home' && r.json?.origin_name === 'your saved home' && /^From your saved home, /.test(r.json?.summary ?? ''));
    g0 = planRequests(mock).length;
    r = await planCall(main, 2, { destination: 'Test Library', origin_name: 'work' });
    rawNamed = planRequests(mock).slice(g0).map((g) => g.raw).join('\n');
    check(c, 'a saved-label origin is "your saved place", never the label', r.json?.origin_name === 'your saved place' && rawNamed.includes('your saved place') && !/\bwork\b/i.test(rawNamed), r.json?.origin_name);
    userWithHome(main, 7743, 'Unknown origin');
    r = await planCall(main, 7743, { destination: 'Test Library', origin_name: 'nowhere special' });
    check(c, 'unknown origin -> 404 origin_not_found', r.status === 404 && r.json?.error?.code === 'origin_not_found', `${r.status} ${r.json?.error?.code}`);
    r = await agent(main, 'POST', '/plan', { user: 7743, body: { destination: 'Test Library', origin_name: 'nowhere special' } });
    check(c, 'agent: unknown origin -> ok false, asks for another place', r.status === 200 && r.json?.ok === false && r.json?.code === 'origin_not_found' && /another place/.test(r.json?.summary ?? ''), r.json?.summary);
    r = await planCall(main, 7743, { destination: 'Test Library', origin_name: 'Outside Place' });
    check(c, 'origin outside the KW area -> origin_not_found', r.status === 404 && r.json?.error?.code === 'origin_not_found');
    addUser(main.db, 7744, 'No origin at all');
    r = await planCall(main, 7744, { destination: 'Test Library' });
    check(c, 'no origin at all -> 400 no_origin', r.status === 400 && r.json?.error?.code === 'no_origin');
    r = await agent(main, 'POST', '/plan', { user: 7744, body: { destination: 'Test Library' } });
    check(c, 'agent: no origin -> ok false, "Where are you starting from?"', r.status === 200 && r.json?.ok === false && r.json?.code === 'no_origin' && r.json?.summary === 'Where are you starting from?', r.json?.summary);
    addUser(main.db, 7745, 'Conflict');
    r = await planCall(main, 7745, { destination: 'Test Library', origin_name: 'Test Campus', origin_lat: 43.47, origin_lng: -80.53 });
    check(c, 'origin_name and coordinates together -> 400', r.status === 400 && r.json?.error?.code === 'validation_error');
    r = await planCall(main, 7745, { destination: 'Test Library', origin_name: 42 });
    check(c, 'origin_name not a string -> 400', r.status === 400);
    userWithHome(main, 7746, 'No start in summary');
    mock.state.planner = 'no_start';
    r = await planCall(main, 7746, { destination: 'Test Library' });
    mock.state.planner = 'good';
    check(c, 'Gemini summary without the start gets "Starting from ..." first', r.json?.source === 'gemini' && /^Starting from your saved home\. Mock plan:/.test(r.json?.summary ?? ''), r.json?.summary);
    addUser(main.db, 7747, 'Computed named');
    mock.state.gemini = 'error';
    r = await planCall(main, 7747, { destination: 'Test Library', origin_name: 'Test Campus' });
    mock.state.gemini = 'normal';
    check(c, 'computed answer also starts with the named start', r.json?.source === 'computed' && /^From Test Campus, biking to /.test(r.json?.summary ?? ''), r.json?.summary);

    // --- Privacy ---------------------------------------------------------------------------------
    c = 'privacy';
    const allPlanRaw = planRequests(mock).map((g) => g.raw).join('\n');
    const users = main.db.prepare('SELECT id, name, email FROM users').all() as { id: number; name: string; email: string }[];
    const coordLike = allPlanRaw.match(/\d+\.\d{4,}/g) ?? [];
    check(c, `no coordinates in any Gemini request (${planRequests(mock).length} checked)`, coordLike.length === 0, coordLike.slice(0, 3).join(' '));
    check(c, 'no origin coordinates (even rounded)', !['43.4762', '80.5371', '43.476', '80.537', '43.4701', '80.5302'].some((x) => allPlanRaw.includes(x)));
    check(c, 'no user name or email', !users.some((u) => allPlanRaw.includes(u.name) || allPlanRaw.includes(u.email)), u1.name);
    check(c, 'no user id fields', !/user_?id|X-Demo-User/i.test(allPlanRaw));
    check(c, 'Nominatim gets only the search text', mock.nominatim.length > 0 && mock.nominatim.every((n) => !/43\.47|80\.53|43\.46|80\.52/.test(n.url) && !/lat=|lon=/.test(n.url)), mock.nominatim.map((n) => n.q).join(' | '));
    check(c, 'Nominatim: User-Agent, KW box, bounded', mock.nominatim.every((n) => n.userAgent === 'Commutr/0.1 (hackathon demo)' && n.url.includes('bounded=1') && n.url.includes('viewbox=')));
    check(c, 'Nominatim results are cached', mock.nominatim.filter((n) => n.q === 'Test Library').length === 1, String(mock.nominatim.filter((n) => n.q === 'Test Library').length));

    // --- Limits ----------------------------------------------------------------------------------
    c = 'limits';
    userWithHome(main, 7801, 'Rate limit');
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await planCall(main, 7801, given)).status);
    check(c, 'per-user planner limit: 3 per minute, then 429', statuses.join(',') === '200,200,200,429', statuses.join(','));
    r = await agent(main, 'POST', '/plan', { user: 7801, body: given });
    check(c, 'agent plan shares the limit (ok: false, spoken)', r.status === 200 && r.json?.ok === false && r.json?.code === 'rate_limited' && !!r.json?.summary, `${r.status} ${r.json?.code}`);
    const usage = JSON.parse(readFileSync(dataDir('main') + 'usage.json', 'utf8'));
    const counted = usage.calls.counts[GEMINI_CHAT_MODEL] ?? 0;
    const sent = mock.gemini.filter((g) => g.model === GEMINI_CHAT_MODEL).length;
    check(c, 'every planner Gemini call counts against the chat model ceiling', counted === sent && sent > 0, `${counted} counted, ${sent} sent`);

    // Server 2: real ceiling (8/min). Two plans use 6 calls; the third has room for 2 < 4.
    const n1 = planRequests(mock).length;
    const srcs: string[] = [];
    for (const uid of [7811, 7812, 7813]) {
      userWithHome(second, uid, `ceiling ${uid}`);
      srcs.push((await planCall(second, uid, { destination: 'Test Library' })).json?.source);
    }
    check(c, 'ceiling without room for a whole plan -> computed, no Gemini call', srcs.join(',') === 'gemini,gemini,computed' && planRequests(mock).length - n1 === 6, `${srcs.join(',')}, ${planRequests(mock).length - n1} calls`);
    r = await planCall(second, 7811, { destination: 'Test Library' });
    const tr2 = optionOf(r.json, 'transit');
    check(c, 'trip updates down: next_bus null, default wait assumed', tr2 && tr2.next_bus === null && tr2.minutes >= DEFAULT_WAIT_MIN && tr2.minutes > (tr?.minutes ?? 0), `${tr2?.minutes} min vs ${tr?.minutes}`);

    // --- Thinking level is for the planner only -------------------------------------------------
    c = 'thinking';
    const chatBefore = mock.gemini.filter((g) => g.kind === 'chat').length;
    r = await call(main, 'POST', '/api/chat', { user: 1, body: { message: 'How many points do I have right now?' } });
    const chatReqs = mock.gemini.filter((g) => g.kind === 'chat').slice(chatBefore);
    check(c, 'chat calls do not set a thinking level', r.status === 200 && chatReqs.length > 0 && chatReqs.every((g) => g.body.generationConfig?.thinkingConfig === undefined), `${chatReqs.length} chat calls`);

    // --- Fallback destination choice -------------------------------------------------------------------
    c = 'destination choice';
    userWithHome(main, 7710, 'Ranking');
    mock.state.gemini = 'error';
    r = await planCall(main, 7710, { destination: 'Waterloo Public Library' });
    check(c, 'computed: "Waterloo Public Library" beats the nearer, first-listed Kitchener one', r.json?.source === 'computed' && /^Waterloo Public Library/.test(r.json?.destination?.name ?? ''), r.json?.destination?.name);
    r = await planCall(main, 7710, { destination: 'Test Cafe' });
    check(c, 'computed: equal names -> the nearer one', r.json?.source === 'computed' && /Near Street/.test(r.json?.destination?.name ?? ''), r.json?.destination?.name);
    mock.state.gemini = 'normal';
    userWithHome(main, 7711, 'Ranking with Gemini');
    const nr = planRequests(mock).length;
    r = await planCall(main, 7711, { destination: 'Waterloo Public Library' });
    const firstSeen = planRequests(mock).slice(nr).map((g) => g.raw).join('').match(/"place_id":"(place_\d+)","name":"([^"]+)"/);
    check(c, 'Gemini also sees the best match first', r.json?.source === 'gemini' && /^Waterloo Public Library/.test(firstSeen?.[2] ?? ''), firstSeen?.[2]);

    // --- Warmed geocode cache (npm run geocode:warm) -----------------------------------------------
    c = 'warmed places';
    userWithHome(main, 7715, 'Warm cache');
    let nq = mock.nominatim.length;
    r = await planCall(main, 7715, { destination: 'test WARM place' });
    check(c, 'a warmed place is used from the cache (no Nominatim request)', r.status === 200 && r.json?.destination?.name === 'Test Warm Place, Test Street, Kitchener' && mock.nominatim.length === nq, `${r.status} ${r.json?.destination?.name}`);
    nq = mock.nominatim.length;
    r = await planCall(main, 7715, { destination: 'old library' });
    check(c, 'an old entry without an expiry counts as 24 h (searched again)', r.status === 200 && mock.nominatim.length === nq + 1 && r.json?.destination?.name !== 'Old Cached Library', r.json?.destination?.name);
    const saved = JSON.parse(readFileSync(mainEnv.GEOCODE_CACHE_FILE!, 'utf8'));
    check(c, 'saving keeps the warmed entry and its expiry', saved['test warm place']?.expires > Date.now() + 26 * day);

    // --- KW area only ------------------------------------------------------------------------------
    c = 'KW area';
    userWithHome(main, 7716, 'Outside area');
    r = await planCall(main, 7716, { destination: 'Outside Place' });
    check(c, 'a search result outside the KW area is never used (404)', r.status === 404 && r.json?.error?.code === 'destination_not_found', `${r.status} ${r.json?.error?.code}`);
    check(c, 'Nominatim is asked with bounded=1 and the tighter KW box', mock.nominatim.filter((n) => n.q === 'Outside Place').every((n) => n.url.includes('bounded=1') && decodeURIComponent(n.url).includes('viewbox=-80.62,43.53,-80.37,43.37')));
    check(c, 'the outside result is not in the server cache file', !readFileSync(mainEnv.GEOCODE_CACHE_FILE!, 'utf8').includes('Outside Place'));

    // The warm logic (npm run geocode:warm), run here against the mock.
    c = 'geocode warm';
    const warmFile = dataDir('warm') + 'geocode.json';
    rmSync(dataDir('warm'), { recursive: true, force: true });
    mkdirSync(dataDir('warm'), { recursive: true });
    process.env.NOMINATIM_BASE_URL = mock.url;
    process.env.GEOCODE_CACHE_FILE = warmFile;
    const { warmOne, stationFromStops } = await import('../src/planner/warm.js');
    let w = await warmOne({ key: 'Outside Place' }, []);
    check(c, 'outside-the-area result: reported unresolved', !w.ok && /outside the KW area/.test(w.reason), w.ok ? 'resolved' : w.reason);
    const stA = { ...TEST_GRT.stopA }, stB = { ...TEST_GRT.stopB };
    const platforms = [
      { id: 'P1', code: null, name: 'Test Square Station - Northbound', lat: 43.4651, lng: -80.5226 },
      { id: 'P2', code: null, name: 'Test Square Station - Southbound', lat: 43.4653, lng: -80.5222 },
    ];
    const nq0 = mock.nominatim.length;
    w = await warmOne({ key: 'Test Square Station', stop: 'test square station', aliases: ['the square'] }, [platforms, [stA, stB]]);
    check(c, 'station from GTFS: no Nominatim request', w.ok && w.via === 'gtfs' && mock.nominatim.length === nq0);
    check(c, 'station from GTFS: platforms merged, direction dropped', w.ok && w.result.name === 'Test Square Station' && Math.abs(w.result.lat - 43.4652) < 1e-6 && Math.abs(w.result.lng + 80.5224) < 1e-6, w.ok ? `${w.result.name} ${w.result.lat},${w.result.lng}` : '');
    w = await warmOne({ key: 'Origin stop', stop: TEST_GRT.stopA.name }, [platforms, [stA, stB]]);
    check(c, 'bus stop from GTFS (second feed)', w.ok && w.result.name === TEST_GRT.stopA.name && mock.nominatim.length === nq0);
    check(c, 'unknown stop name: unresolved, not guessed', !(await warmOne({ key: 'Nope', stop: 'No Such Station' }, [platforms])).ok);
    check(c, 'stops too far apart under one name: unresolved', !stationFromStops('Split Stop', [[{ id: 'a', code: null, name: 'Split Stop', lat: 43.45, lng: -80.5 }, { id: 'b', code: null, name: 'Split Stop', lat: 43.47, lng: -80.5 }]]).hasOwnProperty('lat'));
    w = await warmOne({ key: 'Test Library', expect: { town: 'Waterloo' } }, []);
    check(c, 'result failing the expected town: unresolved', !w.ok && /passed the checks/.test(w.reason), w.ok ? 'resolved' : w.reason);
    w = await warmOne({ key: 'Test Library', expect: { name: /Library/, town: 'Kitchener' } }, []);
    check(c, 'result passing the checks: stored', w.ok && w.via === 'nominatim' && w.result.town === 'Kitchener');
    const { WARM_PLACES } = await import('../src/planner/places-warm.js');
    const bc = WARM_PLACES.find((p) => p.key === 'Builders Club')!;
    const nq1 = mock.nominatim.length;
    w = await warmOne(bc, []);
    check(c, 'Builders Club: fixed demo place, no network, same coordinates as the seed', w.ok && w.via === 'fixed' && w.result.lat === BUILDERS_CLUB.lat && w.result.lng === BUILDERS_CLUB.lng && w.result.town === 'Kitchener' && mock.nominatim.length === nq1);
    const warmCache = JSON.parse(readFileSync(warmFile, 'utf8'));
    check(c, 'Builders Club and the alias "Builders" are in the warm cache', !!warmCache['builders club']?.expires && warmCache['builders']?.results?.[0]?.name === warmCache['builders club']?.results?.[0]?.name);
    check(c, 'warm cache: stations, aliases and checked results stored with 30-day expiry', ['test square station', 'the square', 'test library'].every((k) => warmCache[k]?.expires > Date.now() + 29 * day));
    check(c, 'warm cache: nothing outside the area, nothing unresolved', !JSON.stringify(warmCache).includes('Outside Place') && !warmCache['nope'] && !warmCache['outside place']);

    // --- Plan cache ---------------------------------------------------------------------------------------
    c = 'plan cache';
    userWithHome(main, 7720, 'Cache off');
    const off0 = planRequests(mock).length;
    const offA = await planCall(main, 7720, given);
    const offB = await planCall(main, 7720, given);
    check(c, 'cache off: the same plan twice calls Gemini twice', offA.json?.cached === false && offB.json?.cached === false && planRequests(mock).length - off0 === 6, `${planRequests(mock).length - off0} calls`);

    userWithHome(cacheSrv, 7730, 'Cache A');
    userWithHome(cacheSrv, 7731, 'Cache B');
    let k0 = planRequests(mock).length;
    const first1 = await planCall(cacheSrv, 7730, { destination: 'Test Library' });
    check(c, 'first plan: Gemini, not cached', first1.json?.source === 'gemini' && first1.json?.cached === false && planRequests(mock).length - k0 === 3);
    k0 = planRequests(mock).length;
    const again = await planCall(cacheSrv, 7730, { destination: '  test LIBRARY ' });
    check(c, 'same user, destination (any case/spacing) and origin: cached, no Gemini call', again.json?.cached === true && again.json?.source === 'gemini' && planRequests(mock).length === k0, `${planRequests(mock).length - k0} calls`);
    check(c, 'cached: same decision and summary', again.json?.recommendation === first1.json?.recommendation && again.json?.summary === first1.json?.summary);
    check(c, 'cached: next bus recomputed from live data', !!optionOf(again.json, 'transit')?.next_bus && optionOf(again.json, 'transit').next_bus.arrives_at === optionOf(first1.json, 'transit')?.next_bus?.arrives_at);
    // Numbers are fresh: lower the trust, the estimate drops and the stale summary is replaced.
    cacheSrv.db.prepare('UPDATE users SET trust_multiplier = 0.5 WHERE id = 7730').run();
    const fresh = await planCall(cacheSrv, 7730, { destination: 'Test Library' });
    const t1 = optionOf(first1.json, 'transit'), t2 = optionOf(fresh.json, 'transit');
    check(c, 'cached: points recomputed for the current trust', fresh.json?.cached === true && t2.points_estimate === expectedPoints(cacheSrv, 7730, 'transit', t2.points_km) && t2.points_estimate < t1.points_estimate, `${t1.points_estimate} -> ${t2.points_estimate}`);
    check(c, 'cached: summary with now-stale numbers is replaced', fresh.json?.summary !== first1.json?.summary && /^From your saved home, taking the bus/.test(fresh.json?.summary ?? ''), fresh.json?.summary);
    k0 = planRequests(mock).length;
    const other = await planCall(cacheSrv, 7731, { destination: 'Test Library' });
    check(c, 'another user: not served from the cache', other.json?.cached === false && planRequests(mock).length - k0 === 3);
    const near = await planCall(cacheSrv, 7731, { destination: 'Test Library', origin_lat: HOME[0] + 0.0001, origin_lng: HOME[1] });
    const near2 = await planCall(cacheSrv, 7731, { destination: 'Test Library', origin_lat: HOME[0] + 0.0002, origin_lng: HOME[1] - 0.0001 });
    check(c, 'origin within the same ~100 m cell: cached', near.json?.cached === false && near2.json?.cached === true, `${near.json?.cached},${near2.json?.cached}`);
    userWithHome(cacheSrv, 7732, 'Cache C');
    const farA = await planCall(cacheSrv, 7732, { destination: 'Test Library', origin_lat: HOME[0], origin_lng: HOME[1] });
    const farB = await planCall(cacheSrv, 7732, { destination: 'Test Library', origin_lat: HOME[0] + 0.0011, origin_lng: HOME[1] });
    check(c, 'origin ~120 m away: not cached', farA.json?.cached === false && farB.json?.cached === false);
    userWithHome(cacheSrv, 7733, 'Cache D');
    mock.state.gemini = 'error';
    const comp = await planCall(cacheSrv, 7733, { destination: 'Test Library' });
    mock.state.gemini = 'normal';
    const after = await planCall(cacheSrv, 7733, { destination: 'Test Library' });
    check(c, 'computed answers are not cached', comp.json?.source === 'computed' && after.json?.source === 'gemini' && after.json?.cached === false);
    // (Cache hits still count toward the per-user plan limit, so this uses user 7732's third plan.)
    r = await agent(cacheSrv, 'POST', '/plan', { user: 7732, body: { destination: 'Test Library', origin_lat: HOME[0], origin_lng: HOME[1] } });
    check(c, 'the agent plan uses the same cache', r.json?.ok === true && r.json?.cached === true);
    const cacheFiles = readdirSync(dataDir('cache'));
    check(c, 'nothing written to disk for the cache', cacheFiles.every((f) => ['usage.json', 'geocode.json', 'gtfs', 'tts'].includes(f)), cacheFiles.join(','));
    check(c, 'cache never logged (no summaries or keys in the log)', !cacheSrv.serverLog().includes('Mock plan') && !/\|t:|\|p:|7730\|/.test(cacheSrv.serverLog()));

    // --- Agent: secret -----------------------------------------------------------------------------
    c = 'agent secret';
    const endpoints: [string, string, unknown?][] = [
      ['GET', '/status'],
      ['GET', '/rewards'],
      ['POST', '/redeem', { reward_id: 1, confirm: true }],
      ['POST', '/plan', given],
      ['POST', '/trips/start', { mode: 'walk' }],
      ['POST', '/trips/finish', { confirm: true }],
      ['POST', '/route-safety', { destination: 'Test Library' }],
    ];
    const snapshot = () => JSON.stringify([
      main.db.prepare('SELECT points FROM users WHERE id = 1').get(),
      main.db.prepare('SELECT COUNT(*) AS n FROM redemptions').get(),
      main.db.prepare('SELECT COUNT(*) AS n FROM trips').get(),
    ]);
    const beforeSecret = snapshot();
    const wrongSame = AGENT_SECRET.slice(0, -1) + (AGENT_SECRET.endsWith('x') ? 'y' : 'x');
    for (const [m, path, body] of endpoints) {
      const bad = [await agent(main, m, path, { body, secret: null }), await agent(main, m, path, { body, secret: wrongSame }), await agent(main, m, path, { body, secret: 'short' })];
      check(c, `${m} ${path}: missing / wrong / wrong length -> 401`, bad.every((x) => x.status === 401 && x.json?.error?.code === 'bad_agent_secret'), bad.map((x) => x.status).join(','));
    }
    check(c, 'rejected calls changed nothing (points, redemptions, trips)', snapshot() === beforeSecret);
    r = await agent(second, 'GET', '/status');
    check(c, 'no AGENT_TOOL_SECRET on the server -> 503 for everyone', r.status === 503 && r.json?.error?.code === 'agent_not_configured', String(r.status));
    r = await agent(second, 'GET', '/status', { secret: '' });
    check(c, 'empty header against an empty secret -> still 503', r.status === 503);

    // --- Agent: endpoints ----------------------------------------------------------------------------
    c = 'agent tools';
    r = await agent(main, 'GET', '/status');
    const db1 = main.db.prepare('SELECT points, eco_score FROM users WHERE id = 1').get() as { points: number; eco_score: number };
    check(c, 'status: default user 1, real numbers, spoken summary', r.status === 200 && r.json.ok && r.json.points === db1.points && r.json.eco_score === db1.eco_score && r.json.summary.includes(String(db1.points)), r.json?.summary);
    // Streak wording: "a 1-day streak", "a 5-day streak", "no streak going yet".
    addUser(main.db, 7950, 'Streak words', { points: 120, eco_score: 90 });
    const todayToronto = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto' }).format(new Date());
    const setStreak = (n: number) => main.db.prepare('INSERT INTO streaks (user_id, current_days, longest_days, last_active_date) VALUES (7950, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET current_days = excluded.current_days, longest_days = excluded.longest_days, last_active_date = excluded.last_active_date').run(n, Math.max(n, 1), todayToronto);
    const streakWords: string[] = [];
    for (const n of [1, 5]) {
      setStreak(n);
      streakWords.push((await agent(main, 'GET', '/status', { user: 7950 })).json?.summary ?? '');
    }
    main.db.prepare('DELETE FROM streaks WHERE user_id = 7950').run();
    streakWords.push((await agent(main, 'GET', '/status', { user: 7950 })).json?.summary ?? '');
    check(c, 'status summary: "a 1-day streak", "a 5-day streak", "no streak going yet"', streakWords[0]!.includes('a 1-day streak') && streakWords[1]!.includes('a 5-day streak') && streakWords[2]!.includes('no streak going yet') && !streakWords.some((w) => /days streak/.test(w)), streakWords.map((w) => w.match(/(a \S+ streak|no streak going yet)/)?.[0]).join(' / '));
    r = await agent(main, 'GET', '/status', { user: 2 });
    const db2 = main.db.prepare('SELECT points FROM users WHERE id = 2').get() as { points: number };
    check(c, 'status: X-Demo-User picks the user', r.json?.points === db2.points);

    userWithHome(main, 7901, 'Agent rewards', { points: 1000, eco_score: 95 });
    r = await agent(main, 'GET', '/rewards', { user: 7901 });
    const app = await call(main, 'GET', '/api/rewards', { user: 7901 });
    const appAffordable = app.json.rewards.filter((x: any) => !x.locked && x.affordable).length;
    check(c, 'rewards: affordable and locked lists match the app', r.json?.ok && r.json.affordable.length === appAffordable && r.json.affordable.length + r.json.locked.length === app.json.rewards.length && !!r.json.summary, r.json?.summary);
    const pick = r.json.affordable[0];
    const pts = () => (main.db.prepare('SELECT points FROM users WHERE id = 7901').get() as { points: number }).points;
    r = await agent(main, 'POST', '/redeem', { user: 7901, body: { reward_id: pick.reward_id } });
    check(c, 'redeem without confirm: refused, spoken question', r.status === 200 && r.json.ok === false && r.json.code === 'confirm_required' && r.json.summary.includes(String(pick.points_cost)) && pts() === 1000, r.json?.summary);
    r = await agent(main, 'POST', '/redeem', { user: 7901, body: { reward_id: pick.reward_id, confirm: 'true' } });
    check(c, 'redeem with confirm "true" (a string): refused', r.json?.ok === false && r.json?.code === 'confirm_required' && pts() === 1000);
    r = await agent(main, 'POST', '/redeem', { user: 7901, body: { reward_id: pick.reward_id, confirm: true } });
    check(c, 'redeem with confirm: true: done, points deducted, code spoken', r.json?.ok === true && pts() === 1000 - pick.points_cost && r.json.summary.includes(r.json.redemption.code), r.json?.summary);
    r = await agent(main, 'POST', '/redeem', { user: 7901, body: { reward_id: pick.reward_id, confirm: true } });
    check(c, 'redeem twice in a day: refused with a reason', r.json?.ok === false && r.json?.code === 'already_redeemed_today', r.json?.code);
    r = await agent(main, 'POST', '/redeem', { user: 7901, body: { reward_id: 9999, confirm: true } });
    check(c, 'unknown reward: ok false', r.status === 200 && r.json?.ok === false && r.json?.code === 'not_found');
    r = await agent(main, 'POST', '/redeem', { user: 7901, body: { reward_id: 'one' } });
    check(c, 'malformed reward_id: 400', r.status === 400);

    r = await agent(main, 'POST', '/plan', { user: 7901, body: { destination: 'Test Library' } });
    check(c, 'plan: same answer as /api/plan, with ok and summary', r.json?.ok === true && r.json.source === 'gemini' && r.json.options.length === 3 && !!r.json.summary);
    r = await agent(main, 'POST', '/plan', { user: 7901, body: { destination: 'nowhere special' } });
    check(c, 'plan: unknown place is a spoken refusal', r.status === 200 && r.json?.ok === false && r.json?.code === 'destination_not_found' && !!r.json.summary);

    userWithHome(main, 7902, 'Agent trips', { points: 0 });
    r = await agent(main, 'POST', '/trips/start', { user: 7902, body: { mode: 'hoverboard' } });
    check(c, 'trips/start with a bad mode: 400', r.status === 400);
    r = await agent(main, 'POST', '/trips/start', { user: 7902, body: { mode: 'bike' } });
    check(c, 'trips/start: trip created', r.json?.ok === true && r.json.trip?.status === 'active' && /bike trip has started/.test(r.json.summary));
    r = await agent(main, 'POST', '/trips/start', { user: 7902, body: { mode: 'walk' } });
    check(c, 'trips/start twice: spoken refusal', r.json?.ok === false && r.json?.code === 'trip_already_active');
    r = await agent(main, 'POST', '/trips/finish', { user: 7902, body: {} });
    const stillActive = main.db.prepare("SELECT 1 FROM trips WHERE user_id = 7902 AND status = 'active'").get();
    check(c, 'trips/finish with no GPS: warns, trip stays active', r.json?.ok === false && r.json?.code === 'few_gps_points' && !!stillActive, r.json?.summary);
    r = await agent(main, 'POST', '/trips/finish', { user: 7902, body: { confirm: true } });
    check(c, 'trips/finish with confirm: finished, 0 points', r.json?.ok === true && r.json.trip?.points_awarded === 0 && /no points/.test(r.json.summary), r.json?.summary);
    r = await agent(main, 'POST', '/trips/finish', { user: 7902, body: {} });
    check(c, 'trips/finish with nothing active: spoken refusal', r.json?.ok === false && r.json?.code === 'no_active_trip');

    // A real recorded bike trip (app sends GPS), finished by the agent.
    const { points: gpsPts, durationSec } = track(42, [{ path: [HOME, [43.4655, -80.5228]], speed: cycling, ...phone }]);
    const startMs = Date.now() - (durationSec + 120) * 1000;
    const st = await call(main, 'POST', '/api/trips', { user: 7902, body: { mode: 'bike', started_at: new Date(startMs).toISOString() } });
    const gps = gpsPts.map(({ tSec, ...p }) => ({ ...p, timestamp: new Date(startMs + tSec * 1000).toISOString() }));
    await call(main, 'POST', `/api/trips/${st.json.id}/points`, { user: 7902, body: { points: gps } });
    r = await agent(main, 'POST', '/trips/finish', { user: 7902, body: {} });
    check(c, 'trips/finish after a recorded ride: points and a spoken summary', r.json?.ok === true && r.json.trip.points_awarded > 0 && r.json.summary.includes(String(r.json.trip.points_awarded)), r.json?.summary);

    r = await agent(main, 'POST', '/route-safety', { body: { destination: 'Test Library' } });
    check(c, 'route-safety: stub, available false', r.status === 200 && r.json?.available === false && !!r.json.summary);

    // --- Production mode (Render) ---------------------------------------------------------------------
    c = 'production';
    mock.state.staticDelayMs = 5_000; // hold the GTFS download
    const tProd = Date.now();
    prod = await startHarness({
      dbName: 'test-planner-prod.db',
      port: 8786,
      env: plannerEnv('prod', mock.url, { NODE_ENV: 'production', SCORING_ALLOW_BACKDATED: '0', FRONTEND_ORIGINS: 'https://app.example.test, https://www.example.test/', PLACE_WARM_ON_BOOT: '0', PLAN_CACHE_OFF: '1' }),
    });
    const stopsEarly = (await call(prod, 'GET', '/api/stops')).json?.stops?.length ?? -1;
    check(c, '/health answers while GTFS is still downloading', stopsEarly === 0 && !prod.serverLog().includes('[boot] GTFS ready'), `${Date.now() - tProd} ms to /health, ${stopsEarly} stops so far`);
    for (let w = 0; w < 50 && !prod.serverLog().includes('[boot] GTFS ready'); w++) await new Promise((res) => setTimeout(res, 200));
    mock.state.staticDelayMs = 0;
    const stopsLater = (await call(prod, 'GET', '/api/stops')).json?.stops?.length ?? 0;
    check(c, 'GTFS loads in the background after boot', stopsLater > 0 && prod.serverLog().includes('[boot] GTFS ready'), `${stopsLater} stops`);
    check(c, 'listens on 0.0.0.0 in production', prod.serverLog().includes('listening on http://0.0.0.0:8786 (production)'));
    check(c, 'config log is yes/no only', /\[config\] Gemini key: yes, ElevenLabs key: (yes|no), ElevenLabs voice: (yes|no), agent secret: yes, CORS: 2 allowed origin\(s\)/.test(prod.serverLog()));
    const origin = async (h: Harness, o: string, method = 'GET') => {
      const res = await fetch(h.base + '/health', { method, headers: { Origin: o, ...(method === 'OPTIONS' ? { 'Access-Control-Request-Method': 'GET' } : {}) } });
      return res.headers.get('access-control-allow-origin');
    };
    check(c, 'CORS: an origin from FRONTEND_ORIGINS is allowed', (await origin(prod, 'https://app.example.test')) === 'https://app.example.test');
    check(c, 'CORS: a trailing slash in FRONTEND_ORIGINS is ignored', (await origin(prod, 'https://www.example.test')) === 'https://www.example.test');
    check(c, 'CORS: preflight from an allowed origin', (await origin(prod, 'https://app.example.test', 'OPTIONS')) === 'https://app.example.test');
    check(c, 'CORS: any other origin gets no CORS header', (await origin(prod, 'https://evil.example.test')) === null);
    check(c, 'CORS: development still allows any origin', (await origin(main, 'https://evil.example.test')) === '*');
    // The test-only backdating flag must refuse to start in production.
    const refused = await new Promise<{ code: number | null; out: string }>((resolve) => {
      const child = spawn('npx', ['tsx', 'src/index.ts'], { cwd: BACKEND, env: { ...process.env, COMMUTR_ENV_FILE: 'none', NODE_ENV: 'production', SCORING_ALLOW_BACKDATED: '1', PORT: '8785', DB_PATH: dataDir('prod') + 'refused.db' } });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (out += d));
      const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
      child.on('exit', (code) => { clearTimeout(timer); resolve({ code, out }); });
    });
    check(c, 'SCORING_ALLOW_BACKDATED=1 with NODE_ENV=production refuses to start', refused.code !== 0 && /test-only flag/.test(refused.out) && !refused.out.includes('listening'), `exit ${refused.code}`);

    // --- Secrets never leak ------------------------------------------------------------------------------
    c = 'secrets';
    const logs = main.serverLog() + second.serverLog() + cacheSrv.serverLog() + (prod?.serverLog() ?? '');
    const everything = logs + responseBodies.join('\n');
    check(c, 'agent secret never in logs or responses', !everything.includes(AGENT_SECRET) && !everything.includes(wrongSame));
    check(c, 'Gemini key never in logs or responses', !everything.includes(FAKE_GEMINI_KEY));
    check(c, 'fake key really used (sent to the mock)', mock.gemini.length > 0);
    check(c, 'servers still up', main.serverRunning() && second.serverRunning() && cacheSrv.serverRunning() && !!prod?.serverRunning());
  } finally {
    for (const h of [main, second, cacheSrv, ...(prod ? [prod] : [])]) {
      h.db.close();
      await h.stop();
    }
    await mock.stop();
  }
}

// ---------------------------------------------------------------------------
// Part 2: one real plan (only if backend/.env has GEMINI_API_KEY)
// ---------------------------------------------------------------------------

const ENV_PATH = fileURLToPath(new URL('../.env', import.meta.url));
function envFileHas(name: string): boolean {
  if (!existsSync(ENV_PATH)) return false;
  return readFileSync(ENV_PATH, 'utf8').split('\n').some((l) => l.startsWith(`${name}=`) && l.slice(name.length + 1).trim().length > 0);
}

async function real() {
  console.log('\nREAL END-TO-END (one POST /api/plan)');
  if (!envFileHas('GEMINI_API_KEY')) {
    console.log('  SKIPPED: backend/.env has no GEMINI_API_KEY. Counted as a failure, so a skipped real run never looks like a pass.');
    failures++;
    return;
  }
  const dir = dataDir('real');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  // Real .env (COMMUTR_ENV_FILE ''), real Gemini, Nominatim and GRT; real ceilings.
  const s = await startHarness({
    dbName: 'test-planner-real.db',
    port: 8783,
    env: { COMMUTR_ENV_FILE: '', GEMINI_BASE_URL: '', NOMINATIM_BASE_URL: '', CHAT_CEILING_MULTIPLIER: '1', CHAT_USAGE_FILE: dir + 'usage.json', CHAT_TTS_DIR: dir + 'tts/', GEOCODE_CACHE_FILE: dir + 'geocode.json' },
  });
  try {
    const r = await planCall(s, 1, { destination: 'Waterloo Public Library' });
    const ok = r.status === 200 && r.json?.source === 'gemini';
    if (!ok) failures++;
    const logs = s.serverLog();
    const notes = logs.match(/\[(chat|planner|trip-updates|buses)\][^\n]*/g) ?? [];
    table([{ Step: 'POST /api/plan (real)', Outcome: ok ? 'PASS' : 'FAIL', Status: r.status, Source: String(r.json?.source ?? r.json?.error?.code), ms: Math.round(r.ms) }]);
    if (r.status === 200) {
      console.log(`  Destination: ${r.json.destination.name} (${r.json.destination.kind})`);
      console.log(`  Recommendation: ${r.json.recommendation}`);
      console.log(`  Summary: ${r.json.summary}`);
      for (const o of r.json.options) console.log(`    ${o.mode}: ${o.minutes} min, ${o.km} km, ${o.points_estimate} pts${o.next_bus ? `, next ${o.next_bus.route} in ${o.next_bus.minutes} min (${o.next_bus.source})` : ''}`);
    } else {
      console.log(`  Error: ${JSON.stringify(r.json)}`);
    }
    if (notes.length) console.log(`  Server notes:\n    ${notes.join('\n    ')}`);
    const secrets = ['GEMINI_API_KEY', 'ELEVENLABS_API_KEY', 'AGENT_TOOL_SECRET']
      .map((k) => readFileSync(ENV_PATH, 'utf8').match(new RegExp(`^${k}=(.+)$`, 'm'))?.[1]?.trim())
      .filter((v): v is string => !!v && v.length > 3);
    const leaked = secrets.some((v) => (logs + responseBodies.join('')).includes(v));
    console.log(`  Real keys in logs or responses: ${leaked ? 'FOUND (bad)' : 'none'}`);
    if (leaked) failures++;
    console.log(`  Server still up after the real call: ${s.serverRunning() ? 'yes' : 'NO'}`);
    if (!s.serverRunning()) failures++;
  } finally {
    s.db.close();
    await s.stop();
  }
}

// ---------------------------------------------------------------------------

// Default: mocked only (npm test, never a real provider call). --real: only the real plan call (npm run test:real).
const REAL = process.argv.includes('--real');
try {
  if (REAL) {
    await real();
  } else {
    await mocked();
    console.log('\nPLANNER + AGENT TOOLS (mocked providers)');
    table(rows);
    console.log(`\n${rows.length - failures}/${rows.length} checks passed`);
  }
} catch (err) {
  console.error('TEST FAILED:', err);
  if (rows.length) table(rows);
  failures++;
}
process.exit(failures ? 1 : 0);
