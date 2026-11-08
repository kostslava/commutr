// Create or update the Commutr Mascot (ElevenLabs live voice agent) and its 7 webhook
// tools from backend/elevenlabs/agent.json, through the ElevenLabs API.
//
//   npm run agent:setup -- --tunnel https://<words>.trycloudflare.com    (or TUNNEL_URL=...)
//   npm run agent:setup -- --tunnel https://<service>.onrender.com --allowlist app.example.com,www.example.com
//     --allowlist: frontend hostnames allowed to start sessions, added to agent.json's list (localhost)
//   npm run agent:verify -- --tunnel https://<words>.trycloudflare.com
//   npm run agent:test [-- --only "name,name"] [--max-credits N] [--total-credits N]
//                                       text-only tool-call tests on the live agent (costs credits, no call minutes)
//
// setup: re-runnable. Finds the tools and the agent by name (and by the ids in
//   backend/elevenlabs/state.json) and updates them; creates only what's missing. Run it
//   again after every tunnel restart: only the URLs change. Needs:
//   - ELEVENLABS_API_KEY in backend/.env (read inside this process only; never printed)
//   - a workspace secret named as agent.json's secret_name, created in the dashboard. This
//     script only looks up its id by name; it never reads or sends AGENT_TOOL_SECRET.
// verify: calls the 7 tool endpoints through the tunnel, as ElevenLabs would. Spends no
//   agent minutes and changes no data. Takes AGENT_TOOL_SECRET from the shell environment
//   (e.g. `set -a; . ./.env; set +a` in backend/), never printed. /plan makes ~3 real
//   Gemini calls of our own.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const API = 'https://api.elevenlabs.io';
const CONFIG_PATH = fileURLToPath(new URL('../elevenlabs/agent.json', import.meta.url));
const STATE_PATH = fileURLToPath(new URL('../elevenlabs/state.json', import.meta.url));
const ENV_PATH = fileURLToPath(new URL('../.env', import.meta.url));

type ToolDef = {
  name: string;
  description: string;
  method: 'GET' | 'POST';
  path: string;
  body?: Record<string, unknown>;
  /** ElevenLabs: auto (default) | force | off */
  pre_tool_speech?: 'auto' | 'force' | 'off';
  /** ElevenLabs: allow (default) | disable_during_tool | disable_during_tool_and_turn */
  interruption_mode?: 'allow' | 'disable_during_tool' | 'disable_during_tool_and_turn';
};
type Config = {
  name: string;
  language: string;
  llm: string;
  /** null: if the plan refuses `llm`, stop instead of falling back. */
  llm_fallback: string | null;
  voice: { voice_id: string; name: string };
  max_duration_seconds: number;
  /** End the call after this many seconds without the user speaking (ElevenLabs default -1 = never). */
  silence_end_call_timeout_secs: number;
  allowlist: string[];
  secret_name: string;
  tool_response_timeout_secs: number;
  first_message: string;
  system_prompt: string;
  tools: ToolDef[];
};
type State = { agent_id?: string; tool_ids?: Record<string, string>; test_ids?: Record<string, string> };

const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as Config;
const mode = process.argv[2] === 'verify' ? 'verify' : process.argv[2] === 'test' ? 'test' : 'setup';
const argTunnel = process.argv.indexOf('--tunnel');
const base = (argTunnel > 0 ? process.argv[argTunnel + 1] : process.env.TUNNEL_URL)?.replace(/\/+$/, '');
if (mode !== 'test' && (!base || !/^https:\/\/[^/]+$/.test(base))) {
  console.error('Give the tunnel base URL: --tunnel https://<words>.trycloudflare.com (or TUNNEL_URL). HTTPS, no path.');
  process.exit(1);
}

/** Only ELEVENLABS_API_KEY is taken from backend/.env (the other lines, including AGENT_TOOL_SECRET, are not read into the process). */
function elevenLabsKey(): string {
  if (process.env.ELEVENLABS_API_KEY) return process.env.ELEVENLABS_API_KEY;
  if (!existsSync(ENV_PATH)) return '';
  const line = readFileSync(ENV_PATH, 'utf8').split('\n').find((l) => l.startsWith('ELEVENLABS_API_KEY='));
  return line ? line.slice('ELEVENLABS_API_KEY='.length).trim().replace(/^["']|["']$/g, '') : '';
}

class ApiError extends Error {
  constructor(public status: number, public body: string) {
    super(`HTTP ${status}`);
  }
}

let KEY = '';
const scrub = (s: string) => (KEY ? s.split(KEY).join('[ELEVENLABS_API_KEY]') : s);

async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(API + path, {
    method,
    headers: { 'xi-api-key': KEY, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) throw new ApiError(res.status, scrub(text).slice(0, 600));
  return (text ? JSON.parse(text) : {}) as T;
}

const loadState = (): State => (existsSync(STATE_PATH) ? (JSON.parse(readFileSync(STATE_PATH, 'utf8')) as State) : {});
const saveState = (s: State) => writeFileSync(STATE_PATH, JSON.stringify(s, null, 2) + '\n');

function toolConfig(t: ToolDef, secretId: string) {
  return {
    type: 'webhook',
    name: t.name,
    description: t.description,
    response_timeout_secs: cfg.tool_response_timeout_secs,
    ...(t.pre_tool_speech ? { pre_tool_speech: t.pre_tool_speech } : {}),
    ...(t.interruption_mode ? { interruption_mode: t.interruption_mode } : {}),
    api_schema: {
      url: base + t.path,
      method: t.method,
      request_headers: { 'X-Agent-Secret': { secret_id: secretId } },
      ...(t.body ? { request_body_schema: t.body } : {}),
    },
  };
}

/** agent.json's allowlist plus --allowlist host1,host2 (hostnames only: no scheme, path or port). */
function allowlist(): string[] {
  const i = process.argv.indexOf('--allowlist');
  const extra = i > 0 ? (process.argv[i + 1] ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean) : [];
  for (const h of extra) {
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(h)) throw new Error(`--allowlist: "${h}" is not a bare hostname (no https://, path or port)`);
  }
  return [...new Set([...cfg.allowlist, ...extra])];
}

function agentBody(toolIds: string[], llm: string) {
  return {
    name: cfg.name,
    conversation_config: {
      agent: {
        first_message: cfg.first_message,
        language: cfg.language,
        prompt: { prompt: cfg.system_prompt, llm, tool_ids: toolIds },
      },
      tts: { voice_id: cfg.voice.voice_id },
      conversation: { max_duration_seconds: cfg.max_duration_seconds },
      turn: { silence_end_call_timeout: cfg.silence_end_call_timeout_secs },
    },
    platform_settings: { auth: { enable_auth: false, allowlist: allowlist().map((hostname) => ({ hostname })) } },
  };
}

async function setup() {
  const hosts = allowlist(); // validate --allowlist before any API call
  console.log(`allowlist: ${hosts.join(', ')}`);
  KEY = elevenLabsKey();
  if (!KEY) throw new Error('ELEVENLABS_API_KEY is not set in backend/.env');
  const state = loadState();

  // 1. The secret, by name. Its value is never read or sent by this script.
  const { secrets } = await api<{ secrets: { secret_id: string; name: string }[] }>('GET', '/v1/convai/secrets');
  const secret = secrets.find((s) => s.name === cfg.secret_name);
  if (!secret) {
    console.log(`\nSTOPPED: no ElevenLabs workspace secret named "${cfg.secret_name}" exists yet (checked GET /v1/convai/secrets; ${secrets.length} other secret(s) found).`);
    console.log('Create it in the dashboard (see docs/elevenlabs-agent-setup.md, "Set it up from the command line"), then run this again. Nothing was created or changed.');
    process.exit(2);
  }
  console.log(`secret "${cfg.secret_name}": found (id ${secret.secret_id})`);

  // 2. The voice.
  const voice = await api<{ voice_id: string; name: string; category?: string }>('GET', `/v1/voices/${cfg.voice.voice_id}`);
  console.log(`voice: ${voice.name} (${voice.voice_id}, ${voice.category ?? 'category unknown'}): HTTP 200`);

  // 3. The tools: update by id or name, create only what's missing.
  const listed = await api<{ tools: { id: string; tool_config: { name: string } }[] }>('GET', '/v1/convai/tools');
  const toolIds: Record<string, string> = {};
  for (const t of cfg.tools) {
    const known = state.tool_ids?.[t.name];
    const existing = listed.tools.find((x) => x.id === known) ?? listed.tools.find((x) => x.tool_config?.name === t.name);
    const body = { tool_config: toolConfig(t, secret.secret_id) };
    if (existing) {
      await api('PATCH', `/v1/convai/tools/${existing.id}`, body);
      toolIds[t.name] = existing.id;
      console.log(`tool ${t.name}: updated (${existing.id}) -> ${t.method} ${base}${t.path}`);
    } else {
      const created = await api<{ id: string }>('POST', '/v1/convai/tools', body);
      toolIds[t.name] = created.id;
      console.log(`tool ${t.name}: created (${created.id}) -> ${t.method} ${base}${t.path}`);
    }
  }
  saveState({ ...state, tool_ids: toolIds });

  // 4. The agent: by saved id, else by name; update or create. LLM: preferred, else the fallback.
  let agentId = state.agent_id;
  if (agentId) {
    try {
      await api('GET', `/v1/convai/agents/${agentId}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) agentId = undefined;
      else throw err;
    }
  }
  if (!agentId) {
    const found = await api<{ agents: { agent_id: string; name: string }[] }>('GET', `/v1/convai/agents?search=${encodeURIComponent(cfg.name)}`);
    const same = found.agents.filter((a) => a.name === cfg.name);
    if (same.length > 1) throw new Error(`${same.length} agents are named "${cfg.name}"; put the right agent_id in backend/elevenlabs/state.json`);
    agentId = same[0]?.agent_id;
  }

  const ids = cfg.tools.map((t) => toolIds[t.name]!);
  let llm = cfg.llm;
  const send = async (model: string) => {
    if (agentId) {
      await api('PATCH', `/v1/convai/agents/${agentId}`, agentBody(ids, model));
      return 'updated';
    }
    agentId = (await api<{ agent_id: string }>('POST', '/v1/convai/agents/create', agentBody(ids, model))).agent_id;
    return 'created';
  };
  let action: string;
  try {
    action = await send(llm);
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 422 && /llm/i.test(err.body)) || !cfg.llm_fallback) throw err;
    console.log(`LLM ${llm} was refused (HTTP 422: ${err.body.slice(0, 200)}); trying ${cfg.llm_fallback}`);
    llm = cfg.llm_fallback;
    action = await send(llm);
  }
  saveState({ ...loadState(), agent_id: agentId, tool_ids: toolIds });

  // 5. Read back what ElevenLabs stored.
  const agent = await api<any>('GET', `/v1/convai/agents/${agentId}`);
  const a = agent.conversation_config?.agent ?? {};
  console.log(`\nagent "${agent.name}": ${action}`);
  console.log(`  agent_id: ${agentId}`);
  console.log(`  LLM: ${a.prompt?.llm}   language: ${a.language}   voice: ${agent.conversation_config?.tts?.voice_id}`);
  console.log(`  silence end-call timeout: ${agent.conversation_config?.turn?.silence_end_call_timeout} s   max duration: ${agent.conversation_config?.conversation?.max_duration_seconds} s`);
  console.log(`  tools attached: ${(a.prompt?.tool_ids ?? []).length}/${cfg.tools.length}`);
  console.log(`  allowlist: ${JSON.stringify((agent.platform_settings?.auth?.allowlist ?? []).map((x: any) => x.hostname))}   auth: ${agent.platform_settings?.auth?.enable_auth}`);
  console.log(`  dashboard (link format UNVERIFIED): https://elevenlabs.io/app/agents/agents/${agentId}`);
}

async function verify() {
  const secret = process.env.AGENT_TOOL_SECRET ?? '';
  if (!secret) throw new Error('AGENT_TOOL_SECRET is not in the environment. In backend/: set -a; . ./.env; set +a');
  const call = async (method: string, path: string, body?: unknown, withSecret = true) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(withSecret ? { 'X-Agent-Secret': secret } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const text = (await res.text()).split(secret).join('[AGENT_TOOL_SECRET]');
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: res.status, json };
  };

  const rows: [string, boolean, string][] = [];
  const row = (name: string, ok: boolean, detail: string) => rows.push([name, ok, detail]);
  const say = (j: any) => `ok=${j?.ok}${j?.code ? ` code=${j.code}` : ''}: ${String(j?.summary ?? j?.error?.message ?? '').slice(0, 110)}`;

  let r = await call('GET', '/api/agent/status');
  row('get_status       GET  /api/agent/status', r.status === 200 && r.json?.ok === true, `${r.status} ${say(r.json)}`);
  r = await call('GET', '/api/agent/rewards');
  row('get_rewards      GET  /api/agent/rewards', r.status === 200 && r.json?.ok === true, `${r.status} ${say(r.json)}`);
  r = await call('POST', '/api/agent/redeem', { reward_id: 1 });
  row('redeem_reward    POST /api/agent/redeem (no confirm)', r.status === 200 && r.json?.code === 'confirm_required', `${r.status} ${say(r.json)}`);
  r = await call('POST', '/api/agent/plan', { destination: 'Waterloo Park', origin_name: 'University of Waterloo' });
  const startsThere = r.json?.origin === 'named' && /University of Waterloo/i.test(r.json?.origin_name ?? '') && /^(From|Starting from) University of Waterloo/i.test(r.json?.summary ?? '');
  row('plan_trip        POST /api/agent/plan (origin_name)', r.status === 200 && r.json?.ok === true && startsThere, `${r.status} source=${r.json?.source} origin=${r.json?.origin} origin_name=${r.json?.origin_name} ${say(r.json)}`);
  r = await call('POST', '/api/agent/trips/start', { mode: 'not-a-mode' });
  row('start_trip       POST /api/agent/trips/start (bad mode)', r.status === 400, `${r.status} ${say(r.json)}`);
  const trips = await call('GET', '/api/trips?limit=1', undefined, false);
  if (trips.json?.trips?.[0]?.status === 'active') {
    row('finish_trip      POST /api/agent/trips/finish', true, 'SKIPPED: user 1 has an active trip, not finishing it');
  } else {
    r = await call('POST', '/api/agent/trips/finish', {});
    row('finish_trip      POST /api/agent/trips/finish (none active)', r.status === 200 && r.json?.code === 'no_active_trip', `${r.status} ${say(r.json)}`);
  }
  r = await call('POST', '/api/agent/route-safety', { destination: 'Uptown Waterloo' });
  row('get_route_safety POST /api/agent/route-safety', r.status === 200 && r.json?.available === false, `${r.status} ${say(r.json)}`);
  r = await call('GET', '/api/agent/status', undefined, false);
  row('no X-Agent-Secret header -> 401', r.status === 401, `${r.status}`);

  console.log(`\nverify through ${base}`);
  for (const [name, ok, detail] of rows) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
  const failed = rows.filter(([, ok]) => !ok).length;
  console.log(`\n${rows.length - failed}/${rows.length} passed`);
  if (failed) process.exitCode = 1;
}

// --- Text-only tool-call tests (ElevenLabs agent testing API) ------------------------------
// Each test gives a chat history and checks the agent's NEXT turn for a real, structured
// tool call (type "tool"). No audio and no call minutes, but each run bills credits
// (reported as credits_used). Tests run one at a time; after the first, the run stops if it
// used more than --max-credits (default 200).

type AgentTest = { name: string; history: { role: 'user' | 'agent'; message: string }[]; tool: string; params: { path: string; description: string }[]; forbid?: { tool: string; path: string; value: unknown } };
const TESTS_PATH = fileURLToPath(new URL('../elevenlabs/tests.json', import.meta.url));

async function runAgentTests() {
  KEY = elevenLabsKey();
  if (!KEY) throw new Error('ELEVENLABS_API_KEY is not set in backend/.env');
  const state = loadState();
  if (!state.agent_id || !state.tool_ids) throw new Error('Run agent:setup first (no agent_id/tool_ids in state.json)');
  const maxArg = process.argv.indexOf('--max-credits');
  const maxCredits = maxArg > 0 ? Number(process.argv[maxArg + 1]) : 200;
  // --total-credits N: before each further test, stop if the credits so far plus one more test
  // (estimated as the most expensive one so far) would pass N.
  const totalArg = process.argv.indexOf('--total-credits');
  const totalCredits = totalArg > 0 ? Number(process.argv[totalArg + 1]) : Infinity;
  const onlyArg = process.argv.indexOf('--only');
  const only = onlyArg > 0 ? process.argv[onlyArg + 1]!.split(',').map((x) => x.trim().toLowerCase()) : null;
  const all = JSON.parse(readFileSync(TESTS_PATH, 'utf8')).tests as AgentTest[];
  const tests = only ? all.filter((t) => only.includes(t.name.toLowerCase())) : all;
  if (only && tests.length !== only.length) throw new Error(`--only: unknown test name(s). Names: ${all.map((t) => t.name).join(', ')}`);
  let maxSeen = 0;
  const testIds = { ...(state.test_ids ?? {}) };
  let total = 0;

  for (const [i, t] of tests.entries()) {
    if (i > 0 && total + maxSeen > totalCredits) {
      console.log(`\nSTOPPED before "${t.name}": ${total} credits used so far, and another test (~${maxSeen}) would pass the ${totalCredits}-credit total.`);
      process.exitCode = 1;
      break;
    }
    const body = {
      name: `Commutr: ${t.name}`,
      type: 'tool',
      chat_history: t.history.map((h, k) => ({ role: h.role, message: h.message, time_in_call_secs: k * 5 })),
      tool_call_parameters: {
        referenced_tool: { id: state.tool_ids[t.tool], type: 'webhook' },
        parameters: t.params.map((p) => ({ path: p.path, eval: { type: 'llm', description: p.description } })),
      },
    };
    let id: string | undefined = testIds[t.name];
    if (id) {
      try {
        await api('PUT', `/v1/convai/agent-testing/${id}`, body);
      } catch (err) {
        if (!(err instanceof ApiError && (err.status === 404 || err.status === 405))) throw err;
        id = undefined;
      }
    }
    if (!id) id = (await api<{ id: string }>('POST', '/v1/convai/agent-testing/create', body)).id;
    testIds[t.name] = id;
    saveState({ ...loadState(), test_ids: testIds });

    const started = await api<any>('POST', `/v1/convai/agents/${state.agent_id}/run-tests`, { tests: [{ test_id: id }] });
    let run = started;
    for (let w = 0; w < 40 && (run.test_runs ?? []).some((r: any) => r.status === 'pending'); w++) {
      await new Promise((r) => setTimeout(r, 3_000));
      run = await api<any>('GET', `/v1/convai/test-invocations/${started.id}`);
    }
    const tr = (run.test_runs ?? [])[0] ?? {};
    const credits = Number(tr.credits_used ?? 0);
    total += credits;
    maxSeen = Math.max(maxSeen, credits);
    const turns: any[] = tr.agent_responses ?? [];
    const calls = turns.flatMap((x) => x.tool_calls ?? []);
    const callText = calls.map((c: any) => `${c.tool_name ?? c.name}(${String(c.params_as_json ?? JSON.stringify(c.params ?? c.parameters ?? {})).slice(0, 160)})`).join('; ') || 'none';
    const said = turns.map((x) => x.message ?? '').join(' ').trim();
    const leaked = /\b(get_status|get_rewards|redeem_reward|plan_trip|start_trip|finish_trip|get_route_safety)\b|system__|\w+\([^)]*=/.test(said);
    let forbidden = false;
    if (t.forbid) {
      for (const c of calls) {
        if ((c.tool_name ?? c.name) !== t.forbid.tool) continue;
        try {
          if (JSON.parse(c.params_as_json ?? '{}')[t.forbid.path] === t.forbid.value) forbidden = true;
        } catch {
          /* unparsable params */
        }
      }
    }
    const structured = calls.length > 0;
    const ok = structured && !leaked && !forbidden;
    console.log(`\n[${i + 1}/${tests.length}] "${t.history.at(-1)!.message}"`);
    const why = tr.condition_result?.rationale;
    const reason = !why ? '' : typeof why === 'string' ? why : [why.summary, ...(why.messages ?? [])].filter(Boolean).join(' | ');
    console.log(`  platform result: ${tr.status} (${tr.condition_result?.result ?? 'n/a'})${reason ? `: ${reason.slice(0, 300)}` : ''}`);
    console.log(`  structured tool call: ${structured ? 'yes' : 'NO'} -> ${callText}`);
    if (said) console.log(`  agent text: ${said.slice(0, 200)}`);
    console.log(`  tool call written as text: ${leaked ? 'YES (bad)' : 'no'}${t.forbid ? ` | ${t.forbid.tool} with ${t.forbid.path}=${JSON.stringify(t.forbid.value)}: ${forbidden ? 'YES (bad)' : 'no'}` : ''}`);
    console.log(`  credits_used: ${tr.credits_used ?? 'not reported'}   => ${ok ? 'PASS' : 'FAIL'}`);
    if (!ok) process.exitCode = 1;
    if (i === 0 && credits > maxCredits) {
      console.log(`\nSTOPPED: the first test used ${credits} credits (> ${maxCredits}). The other ${tests.length - 1} tests were not run.`);
      process.exitCode = 1;
      break;
    }
  }
  console.log(`\nTotal credits_used: ${total}`);
}

try {
  await (mode === 'verify' ? verify() : mode === 'test' ? runAgentTests() : setup());
} catch (err) {
  if (err instanceof ApiError) console.error(`\nFAILED: ElevenLabs API ${err.message}: ${err.body}`);
  else console.error(`\nFAILED: ${scrub((err as Error).message)}`);
  process.exit(1);
}
