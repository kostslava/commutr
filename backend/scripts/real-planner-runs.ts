// Real planner check: 5 real POST /api/plan calls (real Gemini, Nominatim and GRT,
// keys from backend/.env), plan cache off, spaced apart to stay under the per-minute
// Gemini ceiling. Not part of npm test (it spends real quota).
//
//   npx tsx scripts/real-planner-runs.ts
//
// Spacing: one plan is about 3 Gemini calls and the chat model's ceiling is 8 per
// minute, so 3 plans inside any 60 s (9 calls) would hit it. 32 s apart keeps at
// most 2 plans (6 calls) in any minute. Server on 8785.

import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startHarness, table } from './lib/harness.js';

const DESTINATIONS = ['Waterloo Public Library', 'Conestoga Mall', 'Kitchener City Hall', 'Waterloo Park', 'Grand River Hospital'];
const SPACING_MS = 32_000;

const ENV_PATH = fileURLToPath(new URL('../.env', import.meta.url));
const hasKey = existsSync(ENV_PATH) && readFileSync(ENV_PATH, 'utf8').split('\n').some((l) => l.startsWith('GEMINI_API_KEY=') && l.slice(15).trim().length > 0);
if (!hasKey) {
  console.log('Skipped: backend/.env has no GEMINI_API_KEY.');
  process.exit(0);
}

const dir = fileURLToPath(new URL('../data/test-planner/real-runs/', import.meta.url));
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

const s = await startHarness({
  dbName: 'test-planner-real-runs.db',
  port: 8785,
  env: {
    COMMUTR_ENV_FILE: '', // load the real backend/.env
    GEMINI_BASE_URL: '',
    NOMINATIM_BASE_URL: '',
    CHAT_CEILING_MULTIPLIER: '1',
    PLAN_CACHE_OFF: '1',
    CHAT_USAGE_FILE: dir + 'usage.json',
    CHAT_TTS_DIR: dir + 'tts/',
    GEOCODE_CACHE_FILE: dir + 'geocode.json',
  },
});

const rows: Record<string, string | number>[] = [];
const bodies: string[] = [];
let failed = 0;
try {
  for (const [i, destination] of DESTINATIONS.entries()) {
    if (i > 0) await new Promise((r) => setTimeout(r, SPACING_MS));
    const logStart = s.serverLog().length;
    const t0 = performance.now();
    const res = await fetch(`${s.base}/api/plan`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Demo-User': '1' }, body: JSON.stringify({ destination }) });
    const ms = Math.round(performance.now() - t0);
    const text = await res.text();
    bodies.push(text);
    const json = JSON.parse(text);
    await new Promise((r) => setTimeout(r, 300)); // let the server's log lines arrive
    const log = s.serverLog().slice(logStart);
    const calls = (log.match(/plan: Gemini call \d+/g) ?? []).length;
    const timings = (log.match(/plan: Gemini call \d+ \([^)]+\) (?:failed after )?\d+ ms/g) ?? []).map((l) => l.match(/(\d+) ms/)![1]).join('+');
    const error = (log.match(/plan: Gemini (?:timed out|failed|ceiling|no_key)[^\n]*/) ?? [''])[0].replace(/^plan: /, '');
    const ok = res.status === 200 && json.source === 'gemini';
    if (!ok) failed++;
    rows.push({
      Run: i + 1,
      Destination: destination,
      Outcome: ok ? 'PASS' : 'FAIL',
      Status: res.status,
      Source: json.source ?? json.error?.code ?? '',
      ms,
      'Gemini calls': calls,
      'Call ms': timings || '-',
      Error: error.slice(0, 90) || '-',
    });
    console.log(`  run ${i + 1}: ${destination} -> ${res.status} ${json.source ?? json.error?.code} in ${ms} ms; ${json.destination?.name ?? ''}; ${json.summary ?? ''}`);
  }
  console.log('');
  table(rows);
  const logs = s.serverLog();
  console.log(`\n  ${rows.length - failed}/${rows.length} runs answered by Gemini`);
  const quotas = logs.match(/Gemini quota hit on [^\n]*/g) ?? [];
  console.log(quotas.length ? `  429s:\n    ${quotas.join('\n    ')}` : '  No 429 responses.');
  const secrets = ['GEMINI_API_KEY', 'ELEVENLABS_API_KEY', 'AGENT_TOOL_SECRET']
    .map((k) => readFileSync(ENV_PATH, 'utf8').match(new RegExp(`^${k}=(.+)$`, 'm'))?.[1]?.trim())
    .filter((v): v is string => !!v && v.length > 3);
  console.log(`  Real keys in logs or responses: ${secrets.some((v) => (logs + bodies.join('')).includes(v)) ? 'FOUND (bad)' : 'none'}`);
  console.log(`  Server still up: ${s.serverRunning() ? 'yes' : 'NO'}`);
} finally {
  s.db.close();
  await s.stop();
}
process.exit(failed ? 1 : 0);
