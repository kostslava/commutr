// Gemini via the official @google/genai SDK: chat with function calling, the
// "where to eat" reply, voice transcription and fallback speech.
// Every call takes a slot from the provider ceiling first (usage.ts). The key is
// sent by the SDK in a header, never in a URL, and never logged.

import { GoogleGenAI, type Content, type GenerateContentResponse } from '@google/genai';
import type { DB } from '../db.js';
import * as S from '../scoring/config.js';
import * as C from './config.js';
import { log } from './redact.js';
import { runTool, TOOL_DECLARATIONS } from './tools.js';
import { takeProviderCall } from './usage.js';

/** The chat can't use Gemini right now (no key, over a ceiling). Not an outage. */
export class GeminiUnavailable extends Error {
  constructor(public reason: 'no_key' | 'ceiling') {
    super(reason === 'no_key' ? 'GEMINI_API_KEY is not set' : 'provider ceiling reached');
  }
}

let client: GoogleGenAI | null = null;
function ai(): GoogleGenAI {
  const apiKey = C.geminiApiKey();
  if (!apiKey) throw new GeminiUnavailable('no_key');
  client ??= new GoogleGenAI({ apiKey, apiVersion: C.GEMINI_API_VERSION, ...(C.GEMINI_BASE_URL ? { httpOptions: { baseUrl: C.GEMINI_BASE_URL } } : {}) });
  return client;
}

function take(model: string) {
  if (!takeProviderCall(model)) throw new GeminiUnavailable('ceiling');
}

// --- Quota details from 429 responses (reported by the real end-to-end test) ----------

export type QuotaInfo = { model: string; status: number; quotaMetric?: string; quotaId?: string; quotaValue?: string; retryDelay?: string };
const quotaSeen: QuotaInfo[] = [];
export const quotaInfoSeen = () => [...quotaSeen];

function noteError(model: string, err: unknown) {
  const status = (err as { status?: number }).status;
  if (status === 429) {
    const msg = String((err as Error).message ?? '');
    const pick = (k: string) => msg.match(new RegExp(`"${k}"\\s*:\\s*"([^"]+)"`))?.[1];
    const info: QuotaInfo = { model, status, quotaMetric: pick('quotaMetric'), quotaId: pick('quotaId'), quotaValue: pick('quotaValue'), retryDelay: pick('retryDelay') };
    quotaSeen.push(info);
    log.warn(`Gemini quota hit on ${model}: ${JSON.stringify(info)}`);
  }
}

/** Run `fn` with an abort signal that fires after `ms`; rejects at `ms` even if the SDK ignores the signal. */
async function withTimeout<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctl = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctl.abort();
      reject(Object.assign(new Error(`timed out after ${ms} ms`), { name: 'TimeoutError' }));
    }, ms);
  });
  try {
    return await Promise.race([fn(ctl.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// --- System prompt: persona + scoring rules from config. No user data. -------------

const r = S.MODE_RATES;
export const SYSTEM_PROMPT = [
  'You are the Commutr mascot, a friendly, upbeat guide in the Commutr app.',
  'Commutr rewards people in Kitchener-Waterloo, Ontario, for walking, biking, scootering and taking transit instead of driving.',
  'Only talk about Commutr and getting around Kitchener-Waterloo. For anything else, politely steer back.',
  'Answer in at most 2 short sentences. Plain text only: no markdown, no lists, no emoji. Your reply is read aloud.',
  "For the user's own numbers (points, eco score, streak, rewards, clubs) always call a tool; never guess or invent numbers.",
  'Never ask for or mention personal details like names, emails or locations.',
  'All merchants and rewards are demo data. Commutr is not affiliated with GRT or any government; for fares and schedules say to check grt.ca.',
  `Rules: points = verified km x mode rate x trip confidence x trust. Rates per km: walk ${r.walk}, bike ${r.bike}, scooter ${r.scooter}, transit ${r.transit}, car ${r.car}.`,
  `Daily cap ${S.DAILY_POINTS_CAP} points (Toronto time). Trips with confidence below ${S.LOW_CONFIDENCE} earn 0 points and lower trust.`,
  `Car trips lower the eco score by ${S.ECO_PENALTY_PER_CAR_KM} per km (${S.ECO_PENALTY_MIN} to ${S.ECO_PENALTY_MAX} per trip); green trips of ${S.ECO_RECOVERY_MIN_KM} km or more add ${S.ECO_RECOVERY_PER_TRIP} (max ${S.ECO_RECOVERY_MAX_PER_DAY} a day).`,
  'A reward is locked when the eco score is below its minimum, even with enough points.',
  `A streak day needs one non-car trip of at least ${S.STREAK_MIN_KM} km. Club goals count walking only, ${S.STEPS_PER_WALK_KM} steps per km, reset every Monday.`,
].join('\n');

// --- Chat turn with function calling -------------------------------------------------

export async function chatTurn(db: DB, userId: number, message: string): Promise<string> {
  const model = C.GEMINI_CHAT_MODEL;
  const genai = ai();
  return withTimeout(C.CHAT_TURN_TIMEOUT_MS, async (abortSignal) => {
    const contents: Content[] = [{ role: 'user', parts: [{ text: message }] }];
    for (let round = 0; round <= C.MAX_TOOL_ROUNDS; round++) {
      take(model);
      let res: GenerateContentResponse;
      try {
        res = await genai.models.generateContent({
          model,
          contents,
          config: {
            systemInstruction: SYSTEM_PROMPT,
            tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
            maxOutputTokens: C.MAX_OUTPUT_TOKENS,
            temperature: C.TEMPERATURE,
            abortSignal,
          },
        });
      } catch (err) {
        noteError(model, err);
        throw err;
      }

      const calls = res.functionCalls ?? [];
      if (calls.length === 0) {
        const text = res.text?.trim();
        if (!text) throw new Error('empty reply');
        return text;
      }
      if (round === C.MAX_TOOL_ROUNDS) throw new Error('too many tool rounds');

      const modelTurn = res.candidates?.[0]?.content;
      if (modelTurn) contents.push(modelTurn);
      contents.push({
        role: 'user',
        parts: calls.map((call) => ({
          functionResponse: { id: call.id, name: call.name, response: runTool(db, userId, call.name ?? '') },
        })),
      });
    }
    throw new Error('too many tool rounds');
  });
}

// --- "Where to eat" reply from suggestions computed in code --------------------------

export async function suggestionReply(message: string, summary: string): Promise<string> {
  const model = C.GEMINI_CHAT_MODEL;
  const genai = ai();
  return withTimeout(C.CHAT_TURN_TIMEOUT_MS, async (abortSignal) => {
    take(model);
    try {
      const res = await genai.models.generateContent({
        model,
        contents: [{ role: 'user', parts: [{ text: `${message}\n\n[Suggestions computed by the app, use only these: ${summary}]` }] }],
        config: { systemInstruction: SYSTEM_PROMPT, maxOutputTokens: C.MAX_OUTPUT_TOKENS, temperature: C.TEMPERATURE, abortSignal },
      });
      const text = res.text?.trim();
      if (!text) throw new Error('empty reply');
      return text;
    } catch (err) {
      noteError(model, err);
      throw err;
    }
  });
}

// --- Transcription -------------------------------------------------------------------

const TRANSCRIBE_PROMPT =
  'Transcribe the speech in this audio verbatim, in the language spoken. Output only the transcript text, with no labels, quotes or commentary. If there is no speech, output nothing.';

export async function transcribe(audio: Buffer, mimeType: string): Promise<string> {
  const model = C.GEMINI_TRANSCRIBE_MODEL;
  const genai = ai();
  return withTimeout(C.TRANSCRIBE_TIMEOUT_MS, async (abortSignal) => {
    take(model);
    try {
      const res = await genai.models.generateContent({
        model,
        contents: [{ role: 'user', parts: [{ inlineData: { mimeType, data: audio.toString('base64') } }, { text: TRANSCRIBE_PROMPT }] }],
        config: { temperature: 0, maxOutputTokens: 400, abortSignal },
      });
      return (res.text ?? '').trim();
    } catch (err) {
      noteError(model, err);
      throw err;
    }
  });
}

// --- Fallback speech -------------------------------------------------------------------

export async function geminiSpeech(text: string): Promise<{ data: Buffer; mimeType: string }> {
  const model = C.GEMINI_TTS_MODEL;
  const genai = ai();
  return withTimeout(C.GEMINI_TTS_TIMEOUT_MS, async (abortSignal) => {
    take(model);
    try {
      const res = await genai.models.generateContent({
        model,
        contents: [{ role: 'user', parts: [{ text }] }],
        config: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: C.GEMINI_TTS_VOICE } } },
          abortSignal,
        },
      });
      const part = res.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
      if (!part?.inlineData?.data) throw new Error('no audio in response');
      return { data: Buffer.from(part.inlineData.data, 'base64'), mimeType: part.inlineData.mimeType ?? '' };
    } catch (err) {
      noteError(model, err);
      throw err;
    }
  });
}
