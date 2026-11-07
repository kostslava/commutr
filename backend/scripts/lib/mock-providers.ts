// Fake Gemini and ElevenLabs for the chat tests, so tests never spend quota.
// Runs inside the test process; the backend reaches it via GEMINI_BASE_URL and
// ELEVENLABS_BASE_URL. Every request is recorded so tests can inspect prompts.

import http from 'node:http';

export type Mode = 'normal' | 'slow' | 'error' | 'quota';

export type GeminiRequest = { model: string; kind: 'chat' | 'transcribe' | 'tts'; body: any; raw: string };

export type MockState = {
  gemini: Mode;
  geminiTts: Mode;
  eleven: Mode;
  /** ElevenLabs: allow this many more successful calls, then answer with quota errors (null = no limit). */
  elevenAllowance: number | null;
  transcript: string;
  slowMs: number;
};

export type Mock = {
  url: string;
  state: MockState;
  gemini: GeminiRequest[];
  eleven: { voice: string; text: string }[];
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

export async function startMockProviders(port: number): Promise<Mock> {
  const state: MockState = { gemini: 'normal', geminiTts: 'normal', eleven: 'normal', elevenAllowance: null, transcript: 'how do i earn points', slowMs: 6_000 };
  const gemini: GeminiRequest[] = [];
  const eleven: { voice: string; text: string }[] = [];

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
      const kind: GeminiRequest['kind'] = isTts ? 'tts' : hasAudio ? 'transcribe' : 'chat';
      gemini.push({ model: g[1]!, kind, body, raw });

      const mode = kind === 'tts' ? state.geminiTts : state.gemini;
      if (mode === 'slow') await sleep(state.slowMs);
      if (mode === 'error') return send(500, { error: { code: 500, message: 'mock internal error', status: 'INTERNAL' } });
      if (mode === 'quota') return send(429, QUOTA_BODY);

      if (kind === 'tts') {
        return send(200, { candidates: [{ content: { role: 'model', parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: fakePcm().toString('base64') } }] }, finishReason: 'STOP' }] });
      }
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

    send(404, { error: 'mock: unknown route' });
  });

  await new Promise<void>((r) => server.listen(port, '127.0.0.1', () => r()));
  return {
    url: `http://127.0.0.1:${port}`,
    state,
    gemini,
    eleven,
    count: (kind) => gemini.filter((x) => x.kind === kind).length,
    stop: () => new Promise((r) => server.close(() => r())),
  };
}
