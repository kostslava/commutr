// Fake Gemini, ElevenLabs, Nominatim and GRT feeds for the chat and planner tests,
// so tests never spend quota or depend on live data. Runs inside the test process;
// the backend reaches it via GEMINI_BASE_URL, ELEVENLABS_BASE_URL, NOMINATIM_BASE_URL
// and GRT_*_URLS. Every request is recorded so tests can inspect prompts.

import { strToU8, zipSync } from 'fflate';
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import http from 'node:http';

const { transit_realtime } = GtfsRealtimeBindings;

export type Mode = 'normal' | 'slow' | 'error' | 'quota';

export type GeminiRequest = { model: string; kind: 'chat' | 'transcribe' | 'tts' | 'plan'; body: any; raw: string };

/** How the fake Gemini answers the planner's final structured-output call. */
/** no_start: a good answer whose summary ignores the "Begin the summary with" instruction. */
export type PlannerAnswer = 'good' | 'invalid' | 'invented_number' | 'unknown_place' | 'no_start';

export type MockState = {
  gemini: Mode;
  geminiTts: Mode;
  eleven: Mode;
  /** ElevenLabs: allow this many more successful calls, then answer with quota errors (null = no limit). */
  elevenAllowance: number | null;
  transcript: string;
  slowMs: number;
  planner: PlannerAnswer;
  nominatim: Mode;
  tripUpdates: 'normal' | 'error';
  /** Hold the static GTFS download this long (to test that /health answers before GTFS is ready). */
  staticDelayMs: number;
};

export type Mock = {
  url: string;
  state: MockState;
  gemini: GeminiRequest[];
  eleven: { voice: string; text: string }[];
  nominatim: { url: string; q: string; userAgent: string; at: number }[];
  count: (kind: GeminiRequest['kind']) => number;
  stop: () => Promise<void>;
};

const QUOTA_BODY = {
  error: {
    code: 429,
    message: 'Resource has been exhausted (e.g. check quota).',
    status: 'RESOURCE_EXHAUSTED',
    details: [
      {
        '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
        violations: [{ quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests', quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier', quotaValue: '15' }],
      },
      { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '42s' },
    ],
  },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A fake mp3: an ID3 tag plus filler. */
const fakeMp3 = (n: number) => Buffer.concat([Buffer.from('ID3\x03\x00\x00\x00\x00\x00\x00', 'binary'), Buffer.alloc(n, 0x55)]);
/** 0.25 s of 24 kHz 16-bit silence-ish PCM, like Gemini's raw TTS output. */
const fakePcm = () => Buffer.alloc(24_000 * 2 * 0.25, 0);

function chatReply(body: any): any {
  const contents: any[] = body.contents ?? [];
  const last = contents[contents.length - 1];
  const fr = last?.parts?.find((p: any) => p.functionResponse)?.functionResponse;
  if (fr) {
    const r = fr.response ?? {};
    const text =
      r.points !== undefined
        ? `You have ${r.points} points and an eco score of ${r.eco_score}.`
        : Array.isArray(r.rewards)
          ? `You can look at ${r.rewards.map((x: any) => x.title).join(', ') || 'nothing yet'}.`
          : Array.isArray(r.clubs)
            ? `You are in ${r.clubs.length} club(s).`
            : 'Here is what I found.';
    return { parts: [{ text }] };
  }
  const userText: string = (last?.parts ?? []).map((p: any) => p.text ?? '').join(' ').toLowerCase();
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
  if (hasTools) {
    const call = /afford/.test(userText) ? 'get_affordable_rewards' : /lock/.test(userText) ? 'get_locked_rewards' : /club/.test(userText) ? 'get_clubs' : /point|eco|streak/.test(userText) ? 'get_my_status' : null;
    if (call) return { parts: [{ functionCall: { name: call, args: {} } }] };
    return { parts: [{ text: 'Mock Gemini here, happy to help you get around KW.' }] };
  }
  const summary = userText.match(/\[suggestions computed by the app, use only these: (.*)\]/)?.[1] ?? '';
  return { parts: [{ text: `Mock suggestion: ${summary.slice(0, 80)}` }] };
}

// --- Planner (Gemini function calling + structured output) ----------------------------

const PLANNER_TOOL_NAMES = new Set(['find_destination', 'get_route_options', 'get_live_buses_near', 'get_points_estimate']);
const isPlannerRequest = (body: any) =>
  (body.tools ?? []).some((t: any) => (t.functionDeclarations ?? []).some((f: any) => PLANNER_TOOL_NAMES.has(f.name))) ||
  body.generationConfig?.responseMimeType === 'application/json';

function lastResponse(contents: any[], name: string): any {
  for (let i = contents.length - 1; i >= 0; i--) {
    const fr = (contents[i].parts ?? []).find((p: any) => p.functionResponse?.name === name)?.functionResponse;
    if (fr) return fr.response;
  }
  return null;
}

function plannerReply(body: any, answer: PlannerAnswer): any {
  const contents: any[] = body.contents ?? [];
  if (body.generationConfig?.responseMimeType === 'application/json') {
    const route = lastResponse(contents, 'get_route_options');
    const places = lastResponse(contents, 'find_destination');
    const options: any[] = route?.options ?? [];
    const best = options.find((o) => o.mode === 'transit') ?? options[0];
    const placeId = answer === 'unknown_place' ? 'place_99' : places?.places?.[0]?.place_id;
    // Follow the request's "Begin the summary with exactly "From X, "" like a real model would.
    const firstText: string = (contents[0]?.parts ?? []).map((p: any) => p.text ?? '').join(' ');
    const start = answer === 'no_start' ? '' : (firstText.match(/Begin the summary with exactly "(From [^"]*?), "/)?.[1] ?? '');
    const prefix = start ? `${start}, ` : '';
    const summary =
      answer === 'invented_number'
        ? `${prefix}take the bus, it earns about 9999 points.`
        : `${prefix}Mock plan: ${best?.mode} takes about ${best?.minutes} minutes and earns about ${best?.points_estimate} points.`;
    const out = {
      place_id: placeId,
      recommendation: answer === 'invalid' ? 'car' : best?.mode,
      order: [best?.mode, ...options.map((o) => o.mode).filter((m) => m !== best?.mode)],
      eco_notes: options.map((o) => ({ mode: o.mode, note: `Mock note for ${o.mode}.` })),
      summary,
    };
    return { parts: [{ text: JSON.stringify(out) }] };
  }
  const last = contents[contents.length - 1];
  const responded = (last?.parts ?? []).filter((p: any) => p.functionResponse).map((p: any) => p.functionResponse.name);
  if (responded.length === 0) {
    const text: string = (last?.parts ?? []).map((p: any) => p.text ?? '').join(' ');
    const query = text.match(/Destination: (.*?)\. I'm starting/)?.[1] ?? text;
    return { parts: [{ functionCall: { name: 'find_destination', args: { query } } }] };
  }
  if (responded.includes('find_destination')) {
    const placeId = lastResponse(contents, 'find_destination')?.places?.[0]?.place_id;
    if (!placeId) return { parts: [{ text: 'I could not find that place.' }] };
    // Two calls in one round, like a real model may do.
    return { parts: [{ functionCall: { name: 'get_route_options', args: { place_id: placeId } } }, { functionCall: { name: 'get_live_buses_near', args: {} } }] };
  }
  return { parts: [{ text: 'Here is your plan.' }] };
}

// --- GRT test network: one route along a straight line from near the seeded
// home of user 1 (43.4762, -80.5371) to near the fake library (43.4520, -80.4990).

export const TEST_GRT = {
  shape: Array.from({ length: 41 }, (_, i) => [43.4775 - 0.027 * (i / 40), -80.539 + 0.042 * (i / 40)] as [number, number]),
  stopA: { id: 'S_A', code: '9001', name: 'Test Origin Stop', lat: 43.4772, lng: -80.53853 },
  stopB: { id: 'S_B', code: '9002', name: 'Test Library Stop', lat: 43.452, lng: -80.49933 },
  library: { lat: 43.452, lng: -80.499, name: 'Test Library' },
  /** Minutes from now of the next two buses at stop A. */
  arrivalsMin: [6, 21],
};

function staticZip(): Buffer {
  const g = TEST_GRT;
  const files = {
    'routes.txt': 'route_id,route_short_name,route_long_name,route_type\n7,7,Test King,3\n',
    'trips.txt': 'route_id,service_id,trip_id,trip_headsign,shape_id,direction_id\n7,WK,T1,7 Test Mall,SH1,0\n7,WK,T2,7 Test Mall,SH1,0\n',
    'stops.txt': `stop_id,stop_code,stop_name,stop_lat,stop_lon,location_type\n${[g.stopA, g.stopB].map((s) => `${s.id},${s.code},${s.name},${s.lat},${s.lng},0`).join('\n')}\n`,
    'shapes.txt': 'shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\n' + g.shape.map((p, i) => `SH1,${p[0]},${p[1]},${i + 1}`).join('\n') + '\n',
  };
  return Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)]))));
}

function feed(entities: any[]): Buffer {
  const msg = transit_realtime.FeedMessage.fromObject({ header: { gtfsRealtimeVersion: '2.0', timestamp: Math.floor(Date.now() / 1000) }, entity: entities });
  return Buffer.from(transit_realtime.FeedMessage.encode(msg).finish());
}

function tripUpdatesFeed(): Buffer {
  const now = Math.floor(Date.now() / 1000);
  return feed(
    TEST_GRT.arrivalsMin.map((m, i) => ({
      id: `tu${i}`,
      tripUpdate: {
        trip: { tripId: `T${i + 1}`, routeId: '7' },
        stopTimeUpdate: [
          { stopSequence: 1, stopId: 'S_A', arrival: { time: now + m * 60 } },
          { stopSequence: 30, stopId: 'S_B', arrival: { time: now + (m + 13) * 60 } },
        ],
      },
    })),
  );
}

function vehiclesFeed(): Buffer {
  const p = TEST_GRT.shape[0]!;
  return feed([{ id: 'v1', vehicle: { trip: { tripId: 'T1', routeId: '7' }, vehicle: { id: 'bus-1' }, position: { latitude: p[0], longitude: p[1] }, timestamp: Math.floor(Date.now() / 1000) } }]);
}

export async function startMockProviders(port: number): Promise<Mock> {
  const state: MockState = {
    gemini: 'normal',
    geminiTts: 'normal',
    eleven: 'normal',
    elevenAllowance: null,
    transcript: 'how do i earn points',
    slowMs: 6_000,
    planner: 'good',
    nominatim: 'normal',
    tripUpdates: 'normal',
    staticDelayMs: 0,
  };
  const gemini: GeminiRequest[] = [];
  const eleven: { voice: string; text: string }[] = [];
  const nominatim: { url: string; q: string; userAgent: string; at: number }[] = [];

  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const send = (status: number, body: unknown, type = 'application/json') => {
      res.writeHead(status, { 'Content-Type': type });
      res.end(Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };

    // --- Gemini: POST /{version}/models/{model}:generateContent
    const g = req.url?.match(/^\/v1[a-z0-9]*\/models\/([^:/?]+):generateContent/);
    if (g && req.method === 'POST') {
      const body = JSON.parse(raw || '{}');
      const isTts = (body.generationConfig?.responseModalities ?? []).map((m: string) => m.toUpperCase()).includes('AUDIO');
      const hasAudio = (body.contents ?? []).some((c: any) => (c.parts ?? []).some((p: any) => p.inlineData));
      const kind: GeminiRequest['kind'] = isTts ? 'tts' : hasAudio ? 'transcribe' : isPlannerRequest(body) ? 'plan' : 'chat';
      gemini.push({ model: g[1]!, kind, body, raw });

      const mode = kind === 'tts' ? state.geminiTts : state.gemini;
      if (mode === 'slow') await sleep(state.slowMs);
      if (mode === 'error') return send(500, { error: { code: 500, message: 'mock internal error', status: 'INTERNAL' } });
      if (mode === 'quota') return send(429, QUOTA_BODY);

      if (kind === 'tts') {
        return send(200, { candidates: [{ content: { role: 'model', parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: fakePcm().toString('base64') } }] }, finishReason: 'STOP' }] });
      }
      if (kind === 'plan') return send(200, { candidates: [{ content: { role: 'model', ...plannerReply(body, state.planner) }, finishReason: 'STOP' }] });
      if (kind === 'transcribe') return send(200, { candidates: [{ content: { role: 'model', parts: [{ text: state.transcript }] }, finishReason: 'STOP' }] });
      return send(200, { candidates: [{ content: { role: 'model', ...chatReply(body) }, finishReason: 'STOP' }] });
    }

    // --- ElevenLabs: POST /v1/text-to-speech/{voice}
    const e = req.url?.match(/^\/v1\/text-to-speech\/([^/?]+)/);
    if (e && req.method === 'POST') {
      const body = JSON.parse(raw || '{}');
      eleven.push({ voice: decodeURIComponent(e[1]!), text: body.text ?? '' });
      let mode = state.eleven;
      if (state.elevenAllowance !== null && state.elevenAllowance <= 0) mode = 'quota';
      if (mode === 'slow') await sleep(state.slowMs);
      if (mode === 'error') return send(500, { detail: 'mock error' });
      if (mode === 'quota') return send(401, { detail: { status: 'quota_exceeded', message: 'This request exceeds your quota.' } });
      if (state.elevenAllowance !== null) state.elevenAllowance--;
      return send(200, fakeMp3(2000), 'audio/mpeg');
    }

    // --- Nominatim: GET /search?q=...
    if (req.url?.startsWith('/search') && req.method === 'GET') {
      const u = new URL(req.url, 'http://mock');
      const q = u.searchParams.get('q') ?? '';
      nominatim.push({ url: req.url, q, userAgent: String(req.headers['user-agent'] ?? ''), at: Date.now() });
      if (state.nominatim === 'slow') await sleep(state.slowMs);
      if (state.nominatim === 'error') return send(503, { error: 'mock nominatim down' });
      const L = TEST_GRT.library;
      const hit = (name: string, lat: number, lng: number, road: string, city: string) => ({ lat: String(lat), lon: String(lng), name, display_name: `${name}, ${road}, ${city}, Ontario, Canada`, address: { road, city } });
      // Discover: parks and a museum at known straight-line distances from the test home
      // (43.4762, -80.5371). Honours viewbox + bounded and limit, like Nominatim.
      if (/^(parks?|museums?)$/i.test(q)) {
        const [w, n, e, s] = (u.searchParams.get('viewbox') ?? '-180,90,180,-90').split(',').map(Number);
        const limit = Number(u.searchParams.get('limit') ?? 10);
        const at = (km: number, bearing: number) => {
          const rad = (bearing * Math.PI) / 180;
          return [43.4762 + (km * Math.cos(rad)) / 111, -80.5371 + (km * Math.sin(rad)) / (111 * Math.cos((43.4762 * Math.PI) / 180))] as const;
        };
        const list = /^parks?$/i.test(q)
          ? ([['Big Mock Park', 4.0, 200], ['Near Mock Park', 0.4, 100], ['Mid Mock Park', 1.5, 10], ['Other Mock Park', 1.65, 170], ['Far Mock Park', 2.9, 280], ['Little Mock Park', 0.9, 45], ['Edge Mock Park', 5.5, 135]] as const)
          : ([['Mock Museum', 1.4, 20]] as const);
        const out = list
          .map(([name, km, b]) => { const [lat, lng] = at(km, b); return hit(name, Number(lat.toFixed(6)), Number(lng.toFixed(6)), 'Mock Road', 'Waterloo'); })
          .filter((h) => Number(h.lon) >= w! && Number(h.lon) <= e! && Number(h.lat) <= n! && Number(h.lat) >= s!);
        return send(200, out.slice(0, limit));
      }
      // Ranking cases: the better name match is listed second (and is farther away).
      if (/^waterloo public library$/i.test(q)) {
        return send(200, [hit('Kitchener Public Library', 43.47, -80.53, 'Queen Street North', 'Kitchener'), hit('Waterloo Public Library', 43.456, -80.5, 'Albert Street', 'Waterloo')]);
      }
      // A starting point near user 1's home (for origin_name).
      if (/^test campus$/i.test(q)) return send(200, [hit('Test Campus', 43.4745, -80.54, 'Campus Road', 'Waterloo')]);
      // Outside the KW area (Guelph): must never be used or cached.
      if (/^outside place$/i.test(q)) return send(200, [hit('Outside Place', 43.55, -80.25, 'Gordon Street', 'Guelph')]);
      // Equal names: the nearer one must win; the far one is listed first.
      if (/^test cafe$/i.test(q)) {
        return send(200, [hit('Test Cafe', 43.4, -80.4, 'Far Street', 'Cambridge'), hit('Test Cafe', 43.472, -80.535, 'Near Street', 'Waterloo')]);
      }
      if (/library/i.test(q)) {
        return send(200, [{ lat: String(L.lat), lon: String(L.lng), name: L.name, display_name: `${L.name}, 1, Test Street, Kitchener, Ontario, Canada`, address: { road: 'Test Street', city: 'Kitchener' } }]);
      }
      return send(200, []);
    }

    // --- GRT feeds
    if (req.url === '/grt/staticfeeds/1') {
      if (state.staticDelayMs) await sleep(state.staticDelayMs);
      return send(200, staticZip(), 'application/zip');
    }
    if (req.url === '/grt/vehiclepositions/1') return send(200, vehiclesFeed(), 'application/octet-stream');
    if (req.url === '/grt/tripupdates/1') {
      if (state.tripUpdates === 'error') return send(500, { error: 'mock trip updates down' });
      return send(200, tripUpdatesFeed(), 'application/octet-stream');
    }

    send(404, { error: 'mock: unknown route' });
  });

  await new Promise<void>((r) => server.listen(port, '127.0.0.1', () => r()));
  return {
    url: `http://127.0.0.1:${port}`,
    state,
    gemini,
    eleven,
    nominatim,
    count: (kind) => gemini.filter((x) => x.kind === kind).length,
    stop: () => new Promise((r) => server.close(() => r())),
  };
}
