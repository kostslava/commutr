// Route safety: mocked tests only (no network, no Gemini, no Mapillary).
// - pure functions: polyline decoding, path sampling, photo selection, rating validation,
//   confidence downgrade, coverage-tile decoding (a synthetic tile), route matching;
// - POST /api/companion/route-safety on an in-memory app with a fixture ratings file.

process.env.COMMUTR_ENV_FILE = 'none';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';

const dir = mkdtempSync(join(tmpdir(), 'commutr-safety-'));
const FIXTURE = join(dir, 'ratings.json');
process.env.SAFETY_RATINGS_FILE = FIXTURE;

const { openDb } = await import('../src/db.js');
const { currentUser } = await import('../src/currentUser.js');
const { safetyRoutes } = await import('../src/routes/safety.js');
const { findRoute, nameMatches } = await import('../src/safety/match.js');
const R = await import('../src/safety/rating.js');
const { TileType, imagesFromTile, tileFor } = await import('./lib/mvt.js');
const { DEMO_ROUTES } = await import('../src/safety/routes.js');
type SavedRoute = import('../src/safety/rating.js').SavedRoute;

let passed = 0;
const ok = (name: string, fn: () => void | Promise<void>) => async () => {
  await fn();
  passed++;
  console.log(`  PASS  ${name}`);
};

// --- fixtures -------------------------------------------------------------------------------
const factor = (note: string) => ({ rating: 'good' as const, note });
const route = (i: number): SavedRoute => {
  const d = DEMO_ROUTES[i]!;
  return {
    id: d.id, from: d.from, to: d.to, km: 0.6,
    rating: { overall: 'good', score: 4, summary: 'Wide sidewalks and signals.', factors: { lighting: factor('Lights.'), sidewalks: factor('Wide.'), traffic: factor('Calm.'), crossings: factor('Signals.') }, confidence: 'high' },
    photos: { count: 6, sample_points_covered: 6, sample_points: 6, captured_from: '2023-09', captured_to: '2024-02', mapillary_image_ids: ['1', '2'], creators: ['alice', 'bob'] },
    model: 'test-model', generated_at: '2026-11-08T00:00:00.000Z',
  };
};
const fixture = { version: 1, routes: [route(0), route(1)] };

const db = openDb(':memory:');
db.prepare('INSERT INTO users (id, name, email, points) VALUES (1, ?, ?, 0), (2, ?, ?, 0), (3, ?, ?, 0)').run('A', 'a@example.test', 'B', 'b@example.test', 'C', 'c@example.test');
db.prepare("INSERT INTO saved_locations (user_id, kind, label, lat, lng) VALUES (1, 'home', 'Builders Club', ?, ?)").run(DEMO_ROUTES[0]!.from.lat, DEMO_ROUTES[0]!.from.lng);
const app = new Hono();
app.use('/api/*', currentUser(db));
app.route('/api', safetyRoutes(db));
const call = async (body: unknown, user = 1) => {
  const res = await app.request('/api/companion/route-safety', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Demo-User': String(user) }, body: JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as any };
};

const tests = [
  ok('polyline6 decodes a known shape', () => {
    // Encoded from [[43.450696,-80.492268],[43.452969,-80.498614]] at precision 6.
    const enc = (pts: [number, number][]) => {
      let out = '', plat = 0, plng = 0;
      const one = (v: number) => { let s = v < 0 ? ~(v << 1) : v << 1; let o = ''; while (s >= 0x20) { o += String.fromCharCode((0x20 | (s & 0x1f)) + 63); s >>= 5; } return o + String.fromCharCode(s + 63); };
      for (const [la, ln] of pts) { const a = Math.round(la * 1e6), b = Math.round(ln * 1e6); out += one(a - plat) + one(b - plng); plat = a; plng = b; }
      return out;
    };
    const pts = R.decodePolyline6(enc([[43.450696, -80.492268], [43.452969, -80.498614]]));
    assert.equal(pts.length, 2);
    assert.ok(Math.abs(pts[1]![0] - 43.452969) < 1e-6 && Math.abs(pts[1]![1] + 80.498614) < 1e-6);
  }),
  ok('sampleAlong spaces points evenly, ends included', () => {
    const s = R.sampleAlong([[43.45, -80.49], [43.46, -80.49]], 3);
    assert.equal(s.length, 3);
    assert.ok(Math.abs(s[1]![0] - 43.455) < 1e-9 && s[0]![0] === 43.45 && Math.abs(s[2]![0] - 43.46) < 1e-9);
  }),
  ok('selectPhotos: max 6, no panos, within 25 m, at most 2 per sequence, prefers 2022+', () => {
    const path: [number, number][] = [[43.45, -80.49], [43.46, -80.49]];
    const pts = R.sampleAlong(path, 6);
    const c = (id: string, p: [number, number], year: number, seq: string, pano = false, offsetM = 5) => ({ id, lat: p[0] + offsetM / 111_320, lng: p[1], captured_at: Date.UTC(year, 5, 1), is_pano: pano, sequence_id: seq });
    const cands = [
      ...pts.map((p, i) => c(`old${i}`, p, 2018, 'S1')),
      ...pts.map((p, i) => c(`new${i}`, p, 2024, `S${i % 2 ? 'A' : 'B'}${Math.floor(i / 4)}`)),
      c('pano', pts[0]!, 2025, 'P', true),
      c('far', pts[1]!, 2025, 'F', false, 60),
    ];
    const sel = R.selectPhotos(path, cands);
    assert.equal(sel.samples, 6);
    assert.equal(sel.covered, 6);
    assert.ok(sel.chosen.length <= 6);
    assert.ok(!sel.chosen.some((p) => p.id === 'pano' || p.id === 'far'));
    const perSeq = new Map<string, number>();
    sel.chosen.forEach((p) => perSeq.set(p.sequence_id, (perSeq.get(p.sequence_id) ?? 0) + 1));
    assert.ok([...perSeq.values()].every((n) => n <= 2));
    assert.ok(sel.chosen.filter((p) => p.id.startsWith('new')).length >= 4, 'newer photos preferred');
  }),
  ok('parseRating accepts a valid answer and clamps the score', () => {
    const r = R.parseRating({ overall: 'fair', score: 7, summary: ' ok ', factors: { lighting: { rating: 'unknown', note: 'n' }, sidewalks: { rating: 'good', note: 'n' }, traffic: { rating: 'poor', note: 'n' }, crossings: { rating: 'fair', note: 'n' } }, confidence: 'medium' });
    assert.ok(r);
    assert.equal(r!.score, 5);
    assert.equal(r!.summary, 'ok');
  }),
  ok('parseRating rejects bad shapes', () => {
    assert.equal(R.parseRating(null), null);
    assert.equal(R.parseRating({ overall: 'great', score: 3, summary: 's', factors: {}, confidence: 'high' }), null);
    assert.equal(R.parseRating({ overall: 'good', score: 3, summary: 's', factors: { lighting: { rating: 'good', note: 'n' } }, confidence: 'high' }), null, 'missing factors');
    assert.equal(R.parseRating({ overall: 'good', score: 'x', summary: 's', factors: {}, confidence: 'high' }), null);
  }),
  ok('adjustConfidence: few photos -> low, old photos -> one step down', () => {
    assert.equal(R.adjustConfidence('high', 3, 2024), 'low');
    assert.equal(R.adjustConfidence('high', 6, 2019), 'medium');
    assert.equal(R.adjustConfidence('medium', 6, null), 'low');
    assert.equal(R.adjustConfidence('high', 6, 2024), 'high');
  }),
  ok('coverage tile decoding keeps 64-bit IDs exact and skips proto defaults', () => {
    const [x, y] = tileFor(43.4507, -80.4923, 14);
    const zz = (n: number) => (n << 1) ^ (n >> 31);
    const buf = TileType.encode(TileType.fromObject({
      layers: [{ version: 2, name: 'image', extent: 4096, keys: ['id', 'captured_at', 'is_pano', 'sequence_id'],
        values: [{ intValue: '1234567890123456' }, { intValue: '1700000000000' }, { boolValue: false }, { stringValue: 'seqA' }],
        features: [{ id: 1, type: 1, tags: [0, 0, 1, 1, 2, 2, 3, 3], geometry: [9, zz(2048), zz(2048)] }] }],
    })).finish();
    const imgs = imagesFromTile(buf, 14, x, y);
    assert.equal(imgs.length, 1);
    assert.equal(imgs[0]!.id, '1234567890123456');
    assert.equal(imgs[0]!.sequence_id, 'seqA');
    assert.equal(imgs[0]!.is_pano, false);
    assert.equal(imgs[0]!.captured_at, 1700000000000);
    assert.deepEqual(tileFor(imgs[0]!.lat, imgs[0]!.lng, 14), [x, y]);
  }),
  ok('route matching: names, aliases, coordinates, reversed, outside 400 m', () => {
    const routes = fixture.routes;
    assert.equal(findRoute(routes, 'Builders Club', 'Central Station')?.id, 'builders-central-station');
    assert.equal(findRoute(routes, 'builders', 'central station kitchener')?.id, 'builders-central-station', 'aliases, case');
    assert.equal(findRoute(routes, 'Central Station', 'Builders Club')?.id, 'builders-central-station', 'reversed');
    assert.equal(findRoute(routes, { lat: 43.4509, lng: -80.4925 }, 'Victoria Park, Kitchener')?.id, 'builders-victoria-park', 'coords + name containing the full name');
    assert.equal(findRoute(routes, { lat: 43.4600, lng: -80.4925 }, 'Victoria Park'), null, 'origin ~1 km away');
    assert.equal(findRoute(routes, 'Builders Club', 'Waterloo Park'), null, 'not a rated pair');
    assert.equal(nameMatches('park', DEMO_ROUTES[1]!.to), false, 'short partial names do not match');
  }),
  ok('POST /route-safety: found, with CC BY-SA attribution and creators', async () => {
    writeFileSync(FIXTURE, JSON.stringify(fixture));
    const r = await call({ origin: 'Builders Club', destination: 'Central Station' });
    assert.equal(r.status, 200);
    assert.equal(r.json.available, true);
    assert.equal(r.json.route.id, 'builders-central-station');
    assert.equal(r.json.rating.overall, 'good');
    assert.ok(r.json.attribution.some((a: string) => /Mapillary/.test(a) && /CC BY-SA/.test(a)));
    assert.ok(r.json.attribution.some((a: string) => /alice/.test(a) && /bob/.test(a)));
    assert.match(r.json.note, /6 street photos from 2023–2024/);
    assert.ok(!JSON.stringify(r.json).includes('mapillary_image_ids'), 'internal fields not exposed');
  }),
  ok('POST /route-safety: origin defaults to the saved home; "home" means it too', async () => {
    assert.equal((await call({ destination: 'Victoria Park' })).json.route?.id, 'builders-victoria-park');
    assert.equal((await call({ origin: 'home', destination: 'Central Station' })).json.route?.id, 'builders-central-station');
    const noHome = await call({ destination: 'Victoria Park' }, 2);
    assert.equal(noHome.status, 400);
    assert.equal(noHome.json.error.code, 'no_origin');
  }),
  ok('POST /route-safety: unknown route -> available false, no_route_data, rated_routes', async () => {
    const r = await call({ origin: 'Builders Club', destination: 'Conestoga Mall' });
    assert.equal(r.status, 200);
    assert.equal(r.json.available, false);
    assert.equal(r.json.code, 'no_route_data');
    assert.match(r.json.summary, /street photo data/);
    assert.equal(r.json.rated_routes.length, 2);
  }),
  ok('POST /route-safety: validation errors', async () => {
    assert.equal((await call({})).status, 400);
    assert.equal((await call({ destination: '' })).status, 400);
    assert.equal((await call({ destination: { lat: 99, lng: 0 } })).status, 400);
    assert.equal((await call({ destination: 'x'.repeat(201) })).status, 400);
    assert.equal((await call({ destination: 'Victoria Park', origin: 5 })).status, 400);
  }),
  ok('POST /route-safety: missing or empty ratings file -> not_generated', async () => {
    writeFileSync(FIXTURE, JSON.stringify({ version: 1, routes: [] }));
    const r = await call({ origin: 'Builders Club', destination: 'Central Station' }, 3);
    assert.equal(r.json.available, false);
    assert.equal(r.json.code, 'not_generated');
    rmSync(FIXTURE);
    assert.equal((await call({ origin: 'Builders Club', destination: 'Central Station' }, 3)).json.code, 'not_generated');
  }),
  ok('POST /route-safety: 429 with retry_after_sec after 20 a minute', async () => {
    writeFileSync(FIXTURE, JSON.stringify(fixture));
    let last = { status: 0, json: {} as any };
    for (let i = 0; i < 21; i++) last = await call({ origin: 'Builders Club', destination: 'Central Station' }, 3);
    assert.equal(last.status, 429);
    assert.equal(last.json.error.code, 'rate_limited');
    assert.ok(Number.isInteger(last.json.retry_after_sec) && last.json.retry_after_sec > 0);
  }),
  ok('the committed ratings.json has the 4 demo routes and no image data', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const text = readFileSync(fileURLToPath(new URL('../src/safety/ratings.json', import.meta.url)), 'utf8');
    const file = JSON.parse(text);
    assert.deepEqual(file.routes.map((r: SavedRoute) => r.id), DEMO_ROUTES.map((r) => r.id));
    for (const r of file.routes as SavedRoute[]) assert.ok(R.parseRating(r.rating), `${r.id} rating valid`);
    assert.ok(!/base64|data:image|inlineData|https?:\/\//.test(text), 'no images or URLs stored');
  }),
];

try {
  console.log('Route safety (mocked)');
  for (const t of tests) await t();
  console.log(`\n${passed}/${tests.length} checks passed`);
} finally {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
