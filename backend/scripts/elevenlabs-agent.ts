// Create or update the Commutr Mascot (ElevenLabs live voice agent) and its 7 webhook
// tools from backend/elevenlabs/agent.json, through the ElevenLabs API.
//
//   npm run agent:setup -- --tunnel https://<words>.trycloudflare.com    (or TUNNEL_URL=...)
//   npm run agent:verify -- --tunnel https://<words>.trycloudflare.com
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
  force_pre_tool_speech?: boolean;
  disable_interruptions?: boolean;
};
type Config = {
  name: string;
  language: string;
  llm: string;
  llm_fallback: string;
  voice: { voice_id: string; name: string };
  max_duration_seconds: number;
  allowlist: string[];
  secret_name: string;
  tool_response_timeout_secs: number;
  first_message: string;
  system_prompt: string;
  tools: ToolDef[];
};
type State = { agent_id?: string; tool_ids?: Record<string, string> };

const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as Config;
const mode = process.argv[2] === 'verify' ? 'verify' : 'setup';
const argTunnel = process.argv.indexOf('--tunnel');
const base = (argTunnel > 0 ? process.argv[argTunnel + 1] : process.env.TUNNEL_URL)?.replace(/\/+$/, '');
if (!base || !/^https:\/\/[^/]+$/.test(base)) {
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
    ...(t.force_pre_tool_speech ? { force_pre_tool_speech: true } : {}),
    ...(t.disable_interruptions ? { disable_interruptions: true } : {}),
    api_schema: {
      url: base + t.path,
      method: t.method,
      request_headers: { 'X-Agent-Secret': { secret_id: secretId } },
      ...(t.body ? { request_body_schema: t.body } : {}),
    },
  };
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
    },
    platform_settings: { auth: { enable_auth: false, allowlist: cfg.allowlist.map((hostname) => ({ hostname })) } },
  };
}

async function setup() {
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
    if (!(err instanceof ApiError && err.status === 422 && /llm/i.test(err.body))) throw err;
    console.log(`LLM ${llm} was refused (HTTP 422: ${err.body.slice(0, 200)}); trying ${cfg.llm_fallback}`);
    llm = cfg.llm_fallback;
    action = await send(llm);
  }
  saveState({ agent_id: agentId, tool_ids: toolIds });

  // 5. Read back what ElevenLabs stored.
  const agent = await api<any>('GET', `/v1/convai/agents/${agentId}`);
  const a = agent.conversation_config?.agent ?? {};
  console.log(`\nagent "${agent.name}": ${action}`);
  console.log(`  agent_id: ${agentId}`);
  console.log(`  LLM: ${a.prompt?.llm}   language: ${a.language}   voice: ${agent.conversation_config?.tts?.voice_id}`);
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

try {
  await (mode === 'verify' ? verify() : setup());
} catch (err) {
  if (err instanceof ApiError) console.error(`\nFAILED: ElevenLabs API ${err.message}: ${err.body}`);
  else console.error(`\nFAILED: ${scrub((err as Error).message)}`);
  process.exit(1);
}
