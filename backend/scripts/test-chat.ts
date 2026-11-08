// Chat tests.
//
//   npm run test:chat     mocked only (fake Gemini + ElevenLabs, fake keys): never a
//                         real provider call. Part of npm test.
//   ... test-chat.ts --real   only the real part (npm run test:real): one real chat
//                         turn with a tool, real speech, real Gemini TTS (60 s allowed)
//                         and a real voice round trip. Needs GEMINI_API_KEY in backend/.env.
//
// Servers: 8796 (main, mocked), 8795 (no Gemini key), 8794 (real ceilings, small
// ElevenLabs budget), 8793/8792 (real run). Mock providers on 8788.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FAQ_ANSWER_MAX_CHARS, GEMINI_TTS_ENABLED } from '../src/chat/config.js';
import { FAQ } from '../src/chat/faq.js';
import { matchFaq } from '../src/chat/match.js';
import { addUser, BACKEND, startHarness, table, type Harness } from './lib/harness.js';
import { startMockProviders } from './lib/mock-providers.js';

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
const FAKE = {
  GEMINI_API_KEY: 'test-gemini-key-SECRET-4f1c9a',
  ELEVENLABS_API_KEY: 'test-eleven-key-SECRET-77b2e0',
  ELEVENLABS_VOICE_ID: 'test-voice-SECRET-c3d4e5',
};
const responseBodies: string[] = [];
const extraLogs: string[] = [];

const dataDir = (name: string) => fileURLToPath(new URL(`../data/test-chat/${name}/`, import.meta.url));
function chatEnv(name: string, extra: Record<string, string> = {}, mockUrl?: string): Record<string, string> {
  const dir = dataDir(name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return {
    CHAT_TTS_DIR: dir + 'tts/',
    CHAT_USAGE_FILE: dir + 'usage.json',
    CHAT_CEILING_MULTIPLIER: '100',
    ...(mockUrl ? { GEMINI_BASE_URL: mockUrl, ELEVENLABS_BASE_URL: mockUrl, ...FAKE } : {}),
    ...extra,
  };
}

async function post(h: Harness, userId: number, message: string) {
  const t0 = performance.now();
  const r = await h.api(userId, 'POST', '/api/chat', { message });
  responseBodies.push(JSON.stringify(r.json));
  return { ...r, ms: performance.now() - t0 };
}

async function getAudio(h: Harness, url: string | null) {
  if (!url) return { status: 0, type: '', body: Buffer.alloc(0) };
  // Real Gemini speech can be slow: the real servers allow it 60 s, so wait a little longer.
  const res = await fetch(h.base + url, { signal: AbortSignal.timeout(65_000) });
  const body = Buffer.from(await res.arrayBuffer());
  if ((res.headers.get('content-type') ?? '').includes('json')) responseBodies.push(body.toString());
  return { status: res.status, type: res.headers.get('content-type') ?? '', body };
}

async function voice(h: Harness, userId: number, data: Buffer, type: string, filename = 'clip.wav') {
  const form = new FormData();
  form.append('audio', new Blob([new Uint8Array(data)], { type }), filename);
  let res: Response;
  try {
    res = await fetch(h.base + '/api/chat/voice', { method: 'POST', headers: { 'X-Demo-User': String(userId) }, body: form });
  } catch (err) {
    return { status: -1, json: { error: { code: `socket: ${(err as any).cause?.code ?? (err as Error).message}` } } as any };
  }
  const text = await res.text();
  responseBodies.push(text);
  return { status: res.status, json: JSON.parse(text) };
}

/** A WAV of `seconds` of silence (16-bit mono). */
function wav(seconds: number, rate = 16_000): Buffer {
  const pcm = Buffer.alloc(Math.round(seconds * rate) * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

const faqAnswer = (id: string) => FAQ.find((e) => e.id === id)!.answer;

/** Run a script without blocking this process (the mock providers live in this process). */
function runScript(args: string[], env: Record<string, string>): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('npx', ['tsx', ...args], { cwd: BACKEND, env: { ...process.env, COMMUTR_ENV_FILE: 'none', ...env } });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

// ---------------------------------------------------------------------------
// Part 1: mocked
// ---------------------------------------------------------------------------

async function mocked() {
  // --- FAQ matching, in process ---------------------------------------------------
  let c = 'FAQ matcher';
  let self = 0, total = 0;
  for (const e of FAQ) for (const q of e.questions) { total++; if (matchFaq(q)?.entry.id === e.id) self++; }
  check(c, `${FAQ.length} entries: every wording matches its own entry`, self === total, `${self}/${total}`);
  const long = FAQ.filter((e) => e.answer.length > FAQ_ANSWER_MAX_CHARS);
  check(c, `all answers <= ${FAQ_ANSWER_MAX_CHARS} chars`, long.length === 0, long.map((e) => e.id).join(', ') || `max ${Math.max(...FAQ.map((e) => e.answer.length))}`);
  check(c, 'no hardcoded rates: answers follow config', faqAnswer('points-rates').includes('walking 10') && faqAnswer('points-cap').includes('200'));
  const t0 = performance.now();
  for (let i = 0; i < 200; i++) matchFaq('how do i redem a reward');
  check(c, 'matching speed (typo, 200 runs)', (performance.now() - t0) / 200 < 5, `${((performance.now() - t0) / 200).toFixed(2)} ms each`);

  const mock = await startMockProviders(8788);
  // Isolate quota accounting from delayed audio requests in earlier scenarios.
  const warmMock = await startMockProviders(8789);
  const main = await startHarness({ dbName: 'test-chat.db', port: 8796, env: chatEnv('main', {}, mock.url) });
  const servers: Harness[] = [main];
  try {
    const db = main.db;
    // Users: 7301 tools/privacy, 7302 rich, 7303 poor, 7304-7306 FAQ/misc, 7307 rate limit, 7308 voice
    addUser(db, 7301, 'Tool User', { points: 1234, eco_score: 91 });
    addUser(db, 7302, 'Rich Eater', { points: 5000, eco_score: 98 });
    addUser(db, 7303, 'Poor Eater', { points: 100, eco_score: 90 });
    for (const id of [7304, 7305, 7306, 7307, 7308, 7309]) addUser(db, id, `User ${id}`, { points: 800, eco_score: 88 });
    db.prepare("INSERT INTO saved_locations (user_id, kind, label, lat, lng) VALUES (7302, 'home', 'Home', 43.4712, -80.5401)").run();

    // --- FAQ through the endpoint ------------------------------------------------------
    c = 'FAQ endpoint';
    let r = await post(main, 7304, 'How do points work?');
    check(c, 'exact wording -> faq', r.json.source === 'faq' && r.json.reply === faqAnswer('points-how'));
    r = await post(main, 7304, 'how do you earn points on commutr');
    check(c, 'reworded -> same answer', r.json.source === 'faq' && r.json.reply === faqAnswer('points-how'));
    r = await post(main, 7304, 'how do i redem a reward');
    check(c, "typo'd ('redem') -> faq", r.json.source === 'faq' && r.json.reply === faqAnswer('rewards-redeem'));
    const before = mock.count('chat');
    r = await post(main, 7304, 'tell me about the history of the iron ring');
    check(c, 'miss -> Gemini', r.json.source === 'gemini' && mock.count('chat') === before + 1, r.json.reply);
    r = await post(main, 7304, 'How do points work?'); // audio now cached
    check(c, 'cached FAQ reply < 50 ms over HTTP', r.json.source === 'faq' && r.ms < 50, `${r.ms.toFixed(1)} ms`);

    // --- Function calling + privacy --------------------------------------------------------
    c = 'Tools';
    const nBefore = mock.gemini.length;
    r = await post(main, 7301, 'how many points do I have?');
    const turn = mock.gemini.slice(nBefore);
    const fr = turn.flatMap((q) => q.body.contents ?? []).flatMap((x: any) => x.parts ?? []).find((p: any) => p.functionResponse)?.functionResponse;
    check(c, 'personal question -> Gemini calls get_my_status', fr?.name === 'get_my_status' && turn.length === 2, `${turn.length} Gemini calls`);
    check(c, 'reply uses the real DB value', r.json.source === 'gemini' && r.json.reply.includes('1234'), r.json.reply);
    r = await post(main, 7301, 'what can I afford?');
    check(c, 'get_affordable_rewards returns only unlocked + affordable', r.json.source === 'gemini' && /\$5 Maple Loop/.test(r.json.reply) && !/\$25/.test(r.json.reply), r.json.reply.slice(0, 70));
    r = await post(main, 7301, 'why is my reward locked');
    check(c, 'get_locked_rewards used', mock.gemini.slice(-2)[1]?.body.contents.some((x: any) => x.parts?.some((p: any) => p.functionResponse?.name === 'get_locked_rewards')));
    r = await post(main, 7301, 'show my club progress');
    check(c, 'get_clubs used', mock.gemini.slice(-2)[1]?.body.contents.some((x: any) => x.parts?.some((p: any) => p.functionResponse?.name === 'get_clubs')));

    // --- Suggestions ---------------------------------------------------------------------
    c = 'Where to eat';
    r = await post(main, 7302, 'I am hungry, where should I eat?');
    const sug = r.json.suggestions as any[];
    check(c, 'rich user: affordable rewards first, cheapest first', sug.length === 3 && sug.every((s) => s.type === 'reward' && s.affordable && !s.locked) && sug[0].points_cost <= sug[1].points_cost, sug.map((s) => `${s.name} ${s.points_cost}`).join(', '));
    check(c, 'Gemini wrote the reply from the computed list', r.json.source === 'gemini' && r.json.reply.startsWith('Mock suggestion'));
    check(c, 'distance from saved home (backend only)', typeof sug[0].distance_km === 'number', `${sug[0].distance_km} km`);
    r = await post(main, 7303, "what's good for lunch?");
    const poor = r.json.suggestions[0];
    check(c, 'poor user: cheapest + earn the difference', r.json.suggestions.length === 1 && poor.type === 'destination' && poor.points_short > 0 && poor.earn_by_walking_km > 0, `${poor?.name}: ${poor?.points_short} short, walk ${poor?.earn_by_walking_km} km`);
    mock.state.gemini = 'error';
    r = await post(main, 7303, 'where can i get food');
    check(c, 'Gemini down -> local template reply', r.json.source === 'fallback' && r.json.reply.includes(poor.name) && r.json.suggestions.length === 1, r.json.reply.slice(0, 60));

    // --- Gemini failures ------------------------------------------------------------------
    c = 'Gemini fallback';
    r = await post(main, 7305, 'what is the best ice cream flavour');
    check(c, 'HTTP 500 -> fallback', r.json.source === 'fallback');
    mock.state.gemini = 'quota';
    r = await post(main, 7305, 'what is the best ice cream flavour');
    check(c, '429 quota -> fallback, quota details logged', r.json.source === 'fallback' && main.serverLog().includes('"quotaValue":"15"'));
    mock.state.gemini = 'slow';
    r = await post(main, 7305, 'what is the best ice cream flavour');
    check(c, 'slow Gemini (6 s) -> fallback at the 5 s timeout', r.json.source === 'fallback' && r.ms >= 4800 && r.ms < 6000, `${(r.ms / 1000).toFixed(2)} s`);
    mock.state.gemini = 'normal';

    // --- Speech -------------------------------------------------------------------------------
    c = 'Speech';
    let calls = mock.eleven.length;
    r = await post(main, 7306, 'what are clubs');
    check(c, 'ElevenLabs primary: voice + attribution', r.json.voice === 'elevenlabs' && r.json.attribution === 'Voice by ElevenLabs' && mock.eleven.length === calls + 1);
    let a = await getAudio(main, r.json.audio_url);
    check(c, 'GET audio -> audio/mpeg', a.status === 200 && a.type === 'audio/mpeg' && a.body.subarray(0, 3).toString() === 'ID3');
    r = await post(main, 7306, 'what are clubs');
    check(c, 'same text again -> cached, no new ElevenLabs call', mock.eleven.length === calls + 1);
    check(c, 'ElevenLabs got the voice id, no markdown/emoji', mock.eleven[calls]!.voice === FAKE.ELEVENLABS_VOICE_ID);

    mock.state.eleven = 'error';
    calls = mock.count('tts');
    r = await post(main, 7306, 'what is a streak');
    check(c, 'ElevenLabs fails -> voice gemini, url still set', r.json.voice === 'gemini' && r.json.attribution === null && typeof r.json.audio_url === 'string');
    check(c, 'reply did not wait for Gemini TTS', mock.count('tts') === calls);
    a = await getAudio(main, r.json.audio_url);
    const rate = a.body.length > 28 ? a.body.readUInt32LE(24) : 0;
    check(c, 'first GET generates Gemini WAV', a.status === 200 && a.type === 'audio/wav' && a.body.subarray(0, 4).toString() === 'RIFF' && mock.count('tts') === calls + 1, `${rate} Hz, ${a.body.length} bytes`);
    a = await getAudio(main, r.json.audio_url);
    check(c, 'second GET cached', a.status === 200 && mock.count('tts') === calls + 1);

    mock.state.geminiTts = 'error';
    r = await post(main, 7306, 'what is the eco score');
    a = await getAudio(main, r.json.audio_url);
    check(c, 'both voices fail -> GET 503, text fine', a.status === 503 && r.json.reply === faqAnswer('eco-what'));
    mock.state.geminiTts = 'normal';

    mock.state.eleven = 'slow';
    r = await post(main, 7306, 'how do i start a trip');
    check(c, 'slow ElevenLabs -> reply after ~4 s with gemini voice', r.json.voice === 'gemini' && r.ms >= 3800 && r.ms < 5500, `${(r.ms / 1000).toFixed(2)} s`);
    mock.state.eleven = 'quota';
    r = await post(main, 7306, 'what is the trust multiplier');
    calls = mock.eleven.length;
    mock.state.eleven = 'normal';
    r = await post(main, 7306, 'are there shared bikes in kw');
    check(c, 'ElevenLabs quota -> skipped for the rest of the day', r.json.voice === 'gemini' && mock.eleven.length === calls);
    check(c, 'unknown audio hash -> 404', (await getAudio(main, '/api/chat/audio/' + '0'.repeat(64))).status === 404);
    check(c, 'audio route works without X-Demo-User', (await fetch(main.base + '/api/chat/audio/' + '0'.repeat(64))).status === 404);

    // --- Voice input -------------------------------------------------------------------------
    c = 'Voice';
    mock.state.transcript = 'how do i earn points';
    const tBefore = mock.count('transcribe');
    let v = await voice(main, 7308, wav(1), 'audio/wav');
    const tReq = mock.gemini.filter((x) => x.kind === 'transcribe').at(-1);
    check(c, 'WAV -> Gemini transcript -> FAQ answer', v.status === 200 && v.json.transcript === 'how do i earn points' && v.json.reply === faqAnswer('points-how') && mock.count('transcribe') === tBefore + 1);
    check(c, 'audio sent to Gemini as inline audio/wav', tReq?.body.contents[0].parts.some((p: any) => p.inlineData?.mimeType === 'audio/wav'));
    v = await voice(main, 7308, Buffer.alloc(6 * 1024 * 1024, 1), 'audio/webm', 'big.webm');
    check(c, 'over 5 MB -> 413', v.status === 413, v.json.error?.code);
    v = await voice(main, 7308, Buffer.from('hello'), 'text/plain', 'x.txt');
    check(c, 'wrong type -> 415', v.status === 415);
    v = await voice(main, 7308, wav(31, 8000), 'audio/wav');
    check(c, 'WAV over 30 s (header) -> 413 too_long', v.status === 413 && v.json.error?.code === 'too_long');
    mock.state.transcript = '';
    v = await voice(main, 7309, wav(1), 'audio/webm;codecs=opus', 'clip.webm');
    check(c, 'no speech -> polite reply, transcript ""', v.status === 200 && v.json.transcript === '' && v.json.source === 'fallback');
    mock.state.gemini = 'error';
    v = await voice(main, 7309, wav(1), 'audio/wav');
    check(c, 'transcription fails -> 200 fallback, transcript null', v.status === 200 && v.json.transcript === null && v.json.source === 'fallback');
    mock.state.gemini = 'normal';
    mock.state.transcript = 'how do i earn points';

    // --- Per-user rate limit --------------------------------------------------------------------
    c = 'Rate limit';
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await post(main, 7307, 'what are clubs')).status);
    const last = await main.api(7307, 'POST', '/api/chat', { message: 'hi' });
    check(c, '10 per minute, then 429 with retry_after_sec', statuses.slice(0, 10).every((s) => s === 200) && statuses[10] === 429 && last.json.retry_after_sec > 0, `11th: ${statuses[10]}, retry ${last.json.retry_after_sec}s`);
    check(c, 'bad input -> 400', (await main.api(7304, 'POST', '/api/chat', { message: '' })).status === 400 && (await main.api(7304, 'POST', '/api/chat', { message: 'x'.repeat(501) })).status === 400);

    // --- Privacy: every prompt and tool result sent to Gemini ---------------------------------------
    c = 'Privacy';
    const sent = mock.gemini.filter((x) => x.kind !== 'tts').map((x) => x.raw).join('\n');
    const names = (db.prepare('SELECT name, email FROM users').all() as { name: string; email: string }[]).flatMap((u) => [u.name, u.email]);
    const leakedNames = names.filter((n) => sent.includes(n));
    check(c, `no names or emails (${names.length} checked, ${mock.gemini.length} requests)`, leakedNames.length === 0, leakedNames.join(', '));
    const coordHits = sent.match(/\b4[23]\.\d{3,}|-80\.\d{3,}|"lat"|"lng"|latitude|longitude/g) ?? [];
    check(c, 'no coordinates', coordHits.length === 0, coordHits.slice(0, 3).join(', '));
    check(c, 'no user IDs', !/\b730[1-9]\b|"user_id"|"userId"/.test(sent));
    check(c, 'system prompt has rules from config, no user data', mock.gemini.find((x) => x.kind === 'chat')!.raw.includes('walk 10'));

    // --- Server 2: no Gemini key ----------------------------------------------------------------------
    c = 'No Gemini key';
    const noKey = await startHarness({ dbName: 'test-chat-nokey.db', port: 8795, env: chatEnv('nokey', { GEMINI_BASE_URL: mock.url, ELEVENLABS_BASE_URL: mock.url, GEMINI_API_KEY: '', ELEVENLABS_API_KEY: '', ELEVENLABS_VOICE_ID: '' }) });
    servers.push(noKey);
    const nCalls = mock.gemini.length;
    r = await post(noKey, 1, 'tell me about the history of the iron ring');
    check(c, 'miss -> fallback instantly, no API call', r.json.source === 'fallback' && r.ms < 1000 && mock.gemini.length === nCalls, `${r.ms.toFixed(0)} ms`);
    r = await post(noKey, 1, 'how do points work');
    check(c, 'FAQ still works', r.json.source === 'faq');
    check(c, 'no voice possible -> audio_url null', r.json.audio_url === null && r.json.voice === null);
    check(c, 'logs say the key is missing (once)', (noKey.serverLog().match(/GEMINI_API_KEY is not set/g) ?? []).length === 1);

    // --- Server 3: real ceilings + small ElevenLabs budget ---------------------------------------------
    c = 'Ceilings & budget';
    const tight = await startHarness({ dbName: 'test-chat-tight.db', port: 8794, env: chatEnv('tight', { CHAT_CEILING_MULTIPLIER: '1', ELEVENLABS_DAILY_CHAR_BUDGET: '50' }, mock.url) });
    servers.push(tight);
    calls = mock.eleven.length;
    r = await post(tight, 1, 'what are clubs');
    check(c, 'answer longer than budget -> straight to Gemini voice', r.json.voice === 'gemini' && mock.eleven.length === calls, `${r.json.reply.length} chars > 50`);
    const sources: string[] = [];
    for (let i = 0; i < 9; i++) sources.push((await post(tight, 1 + (i % 3), `tell me something fun number ${i}`)).json.source ?? 'none');
    check(c, 'Gemini ceiling 8/min: 9th call falls back', sources.slice(0, 8).every((s) => s === 'gemini') && sources[8] === 'fallback', sources.join(','));

    // --- Warm script ---------------------------------------------------------------------------------
    c = 'chat:warm';
    warmMock.state.eleven = 'normal';
    warmMock.state.elevenAllowance = 3; // 3 more successes, then quota
    const warmEnv = chatEnv('warm', { CHAT_WARM_PAUSE_MS: '0' }, warmMock.url);
    const warm = await runScript(['scripts/chat-warm.ts'], warmEnv);
    const out = warm.stdout + warm.stderr;
    extraLogs.push(out);
    check(c, 'prints total characters first', /Total characters to send: \d+/.test(out), out.match(/Total characters to send: \d+/)?.[0]);
    check(c, 'stops cleanly on quota (exit 0)', warm.status === 0 && /Generated 3,/.test(out) && /Stopped cleanly: ElevenLabs quota used up/.test(out), out.match(/Generated .*/)?.[0]);
    const warm2 = await runScript(['scripts/chat-warm.ts'], { ...warmEnv, ELEVENLABS_DAILY_CHAR_BUDGET: '6000' });
    extraLogs.push(warm2.stdout + warm2.stderr);
    check(c, 're-run skips the cached ones', /3 already cached, 17 to generate/.test(warm2.stdout), warm2.stdout.match(/\d+ already cached, \d+ to generate/)?.[0]);
    mock.state.elevenAllowance = null;

    // --- Secrets ----------------------------------------------------------------------------------------
    c = 'Secrets';
    const everything = [...servers.map((s) => s.serverLog()), ...responseBodies, ...extraLogs].join('\n');
    const leaks = Object.entries(FAKE).filter(([, v]) => everything.includes(v)).map(([k]) => k);
    check(c, `no key or voice id in logs or ${responseBodies.length} responses`, leaks.length === 0, leaks.join(', ') || `${everything.length} chars scanned`);
    check(c, 'keys were really used (sent to the mock)', mock.eleven.some((e) => e.voice === FAKE.ELEVENLABS_VOICE_ID));

    c = 'Server';
    for (const s of servers) {
      const ok = (await fetch(s.base + '/health')).ok && s.serverRunning();
      check(c, `${s.base} /health OK, still running`, ok);
    }
  } finally {
    if (failures) {
      for (const s of servers) console.log(`--- ${s.base} running=${s.serverRunning()} log tail ---\n${s.serverLog().split('\n').slice(-12).join('\n')}`);
      for (const l of extraLogs) console.log(`--- warm output ---\n${l}`);
    }
    for (const s of servers) { s.db.close(); await s.stop(); }
    await mock.stop();
    await warmMock.stop();
  }
}

// ---------------------------------------------------------------------------
// Part 2: real providers (only if backend/.env has GEMINI_API_KEY)
// ---------------------------------------------------------------------------

function envFileHas(name: string): boolean {
  const path = fileURLToPath(new URL('../.env', import.meta.url));
  if (!existsSync(path)) return false;
  return readFileSync(path, 'utf8').split('\n').some((l) => l.startsWith(`${name}=`) && l.slice(name.length + 1).trim().length > 0);
}

async function real() {
  console.log('\nREAL END-TO-END');
  if (!envFileHas('GEMINI_API_KEY')) {
    console.log('  SKIPPED: backend/.env has no GEMINI_API_KEY. Counted as a failure, so a skipped real run never looks like a pass.');
    failures++;
    return;
  }
  const hasEleven = envFileHas('ELEVENLABS_API_KEY') && envFileHas('ELEVENLABS_VOICE_ID');
  const report: Record<string, string | number>[] = [];
  const step = (name: string, ok: boolean, result: string, detail: string, ms: number | '' = '') => {
    if (!ok) failures++;
    report.push({ Step: name, Outcome: ok ? 'PASS' : 'FAIL', Result: result, Detail: detail.slice(0, 110), ms });
  };
  const realEnv = (name: string, extra: Record<string, string> = {}) => ({ ...chatEnv(name, { CHAT_CEILING_MULTIPLIER: '1' }), COMMUTR_ENV_FILE: '', GEMINI_BASE_URL: '', ELEVENLABS_BASE_URL: '', GEMINI_TTS_TIMEOUT_MS: '60000', ...extra });

  const s1 = await startHarness({ dbName: 'test-chat-real.db', port: 8793, env: realEnv('real') });
  // Gemini voice only (ElevenLabs disabled) to exercise Gemini TTS and transcription.
  const s2 = await startHarness({ dbName: 'test-chat-real2.db', port: 8792, env: realEnv('real2', { ELEVENLABS_API_KEY: '', ELEVENLABS_VOICE_ID: '' }) });
  try {
    addUser(s1.db, 7401, 'Real User', { points: 1234, eco_score: 91 });
    // 1. Chat with function calling: must really reach Gemini and use the DB value.
    let r = await post(s1, 7401, 'How many points do I have, and what can I afford?');
    step('chat (tools)', r.status === 200 && r.json.source === 'gemini', `${r.status} source=${r.json.source}`, String(r.json.reply), Math.round(r.ms));

    // 2. Speech for that reply (ElevenLabs if fully configured, else the Gemini voice).
    let a = await getAudio(s1, r.json.audio_url);
    if (r.json.audio_url === null) {
      step(`speech (${r.json.voice})`, !GEMINI_TTS_ENABLED && !hasEleven, 'audio_url null', GEMINI_TTS_ENABLED || hasEleven ? 'expected audio' : 'Gemini TTS switched off and no ElevenLabs voice: no audio, as designed');
    } else {
      step(`speech (${r.json.voice})`, a.status === 200, `${a.status} ${a.type}`, a.status === 200 ? `${a.body.length} bytes${hasEleven ? '' : ' (no ElevenLabs voice id: Gemini voice)'}` : a.body.toString().slice(0, 100));
    }

    // 3. Gemini TTS on its own (ElevenLabs disabled on this server).
    r = await post(s2, 1, 'What is a streak?');
    a = await getAudio(s2, r.json.audio_url);
    const rate = a.type === 'audio/wav' ? a.body.readUInt32LE(24) : 0;
    if (!GEMINI_TTS_ENABLED) {
      step('Gemini TTS (fallback voice)', r.json.audio_url === null && r.json.voice === null, 'switched off', `audio_url=${r.json.audio_url}, voice=${r.json.voice}`);
    } else {
      step('Gemini TTS (fallback voice)', a.status === 200 && a.type === 'audio/wav', `${a.status} ${a.type}`, a.status === 200 ? `${a.body.length} bytes, ${rate} Hz` : a.body.toString().slice(0, 100));
    }

    // 4. Voice input: Gemini audio input. Uses the Gemini TTS audio if we have it,
    //    otherwise a WAV of silence (then an empty transcript is the right answer).
    const clip = a.status === 200 && a.type === 'audio/wav' ? a.body : null;
    const t0 = performance.now();
    const v = await voice(s2, 1, clip ?? wav(2), 'audio/wav', 'q.wav');
    const okTranscript = clip ? typeof v.json.transcript === 'string' && /streak/i.test(v.json.transcript) : v.json.transcript === '';
    step(
      `voice in (Gemini audio input${clip ? '' : ', silent clip'})`,
      v.status === 200 && okTranscript,
      `${v.status} source=${v.json.source}`,
      `transcript: ${JSON.stringify(v.json.transcript)}`,
      Math.round(performance.now() - t0),
    );

    table(report);
    const logs = s1.serverLog() + s2.serverLog();
    const quotas = logs.match(/Gemini quota hit on [^\n]*/g) ?? [];
    console.log(`\n  Real steps: ${report.filter((x) => x.Outcome === 'PASS').length}/${report.length} passed`);
    console.log(quotas.length ? `  429s seen:\n    ${quotas.join('\n    ')}` : '  No 429 responses, so no quota numbers were revealed.');
    const warnings = logs.match(/\[chat\][^\n]*/g) ?? [];
    if (warnings.length) console.log(`  Server notes:\n    ${warnings.join('\n    ')}`);
    const secret = ['GEMINI_API_KEY', 'ELEVENLABS_API_KEY', 'ELEVENLABS_VOICE_ID']
      .map((k) => readFileSync(fileURLToPath(new URL('../.env', import.meta.url)), 'utf8').match(new RegExp(`^${k}=(.+)$`, 'm'))?.[1]?.trim())
      .filter((v): v is string => !!v && v.length > 3);
    const leaked = secret.some((v) => (logs + responseBodies.join('')).includes(v));
    console.log(`  Real keys in logs or responses: ${leaked ? 'FOUND (bad)' : 'none'}`);
    if (leaked) failures++;
  } finally {
    for (const s of [s1, s2]) { s.db.close(); await s.stop(); }
  }
}

// ---------------------------------------------------------------------------

// Default: mocked only (npm test, never a real provider call). --real: only the real part (npm run test:real).
const REAL = process.argv.includes('--real');
try {
  if (REAL) {
    await real();
  } else {
    await mocked();
    console.log('\nCHAT (mocked providers)');
    table(rows);
    console.log(`\n${rows.length - failures}/${rows.length} checks passed`);
  }
} catch (err) {
  console.error('TEST FAILED:', err);
  if (rows.length) table(rows);
  process.exitCode = 1;
}
if (failures) process.exitCode = 1;
