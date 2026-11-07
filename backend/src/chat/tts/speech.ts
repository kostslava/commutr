// Speech for chat replies, cached on disk by a hash of the spoken text.
//
//   prepareSpeech(text), called for every reply:
//     cached file?                      -> its URL (instant)
//     ElevenLabs configured, in budget? -> wait up to 4 s for it -> .mp3, voice "elevenlabs"
//     otherwise / on failure            -> URL still returned, voice "gemini"
//   serveAudio(hash), GET /api/chat/audio/:hash:
//     .mp3 or .wav on disk              -> serve it
//     only the .txt                     -> generate with Gemini TTS now, cache .wav, serve
//     that fails                        -> 503 (the reply text is unaffected)
//
// Files: backend/data/tts/<hash>.txt (the text), <hash>.mp3 or <hash>.wav (the audio).

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as C from '../config.js';
import { geminiSpeech } from '../gemini.js';
import { log } from '../redact.js';
import { elevenLabsBudgetLeft, markElevenLabsExhausted, spendElevenLabsChars, takeProviderCall } from '../usage.js';
import { elevenLabsConfigured, elevenLabsSpeech, ElevenLabsQuota } from './elevenlabs.js';
import { isWav, pcmToWav, sampleRateFromMime } from './wav.js';

export type Voice = 'elevenlabs' | 'gemini';
export type SpeechRef = { audio_url: string | null; voice: Voice | null; attribution: string | null };

/** What gets spoken: no emoji, no markdown, tidy whitespace. */
export function speechText(text: string): string {
  return text
    .replace(/\p{Extended_Pictographic}|\p{Emoji_Presentation}|️|‍/gu, '')
    .replace(/!\[[^\]]*]\([^)]*\)/g, '') // images
    .replace(/\[([^\]]+)]\([^)]*\)/g, '$1') // links -> text
    .replace(/[*_~`#>|]+/g, '')
    .replace(/^\s*[-+]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The hash covers everything that changes the sound, so a config change makes new files. */
export function audioHash(spoken: string): string {
  return createHash('sha256')
    .update(JSON.stringify([spoken, C.ELEVENLABS_MODEL, C.ELEVENLABS_OUTPUT_FORMAT, C.elevenLabsVoiceId(), C.GEMINI_TTS_MODEL, C.GEMINI_TTS_VOICE]))
    .digest('hex');
}

const file = (hash: string, ext: 'txt' | 'mp3' | 'wav') => join(C.TTS_DIR, `${hash}.${ext}`);
const urlFor = (hash: string) => `/api/chat/audio/${hash}`;

function writeAtomic(path: string, data: Buffer | string) {
  mkdirSync(C.TTS_DIR, { recursive: true });
  writeFileSync(path + '.tmp', data);
  renameSync(path + '.tmp', path);
}

/** Save the spoken text beside its audio (needed to regenerate the Gemini fallback on GET). */
export function rememberText(hash: string, spoken: string) {
  if (!existsSync(file(hash, 'txt'))) writeAtomic(file(hash, 'txt'), spoken);
}

export function cachedVoice(hash: string): Voice | null {
  if (existsSync(file(hash, 'mp3'))) return 'elevenlabs';
  if (existsSync(file(hash, 'wav'))) return 'gemini';
  return null;
}

/** Try ElevenLabs for this text (budget, ceiling, quota). Returns true if the .mp3 was written. */
export async function generateElevenLabs(hash: string, spoken: string, timeoutMs: number): Promise<boolean> {
  if (!elevenLabsConfigured()) return false;
  if (elevenLabsBudgetLeft() < spoken.length) return false;
  if (!takeProviderCall('elevenlabs')) return false;
  try {
    const mp3 = await elevenLabsSpeech(spoken, timeoutMs);
    writeAtomic(file(hash, 'mp3'), mp3);
    spendElevenLabsChars(spoken.length);
    return true;
  } catch (err) {
    if (err instanceof ElevenLabsQuota) markElevenLabsExhausted();
    log.warn('ElevenLabs speech failed, using the Gemini voice', err);
    if (err instanceof ElevenLabsQuota) throw err;
    return false;
  }
}

/** Generate the Gemini fallback voice and cache it as .wav. Throws on failure. */
export async function generateGemini(hash: string, spoken: string): Promise<void> {
  const { data, mimeType } = await geminiSpeech(spoken);
  const wav = isWav(data) ? data : pcmToWav(data, sampleRateFromMime(mimeType, C.GEMINI_TTS_DEFAULT_SAMPLE_RATE));
  writeAtomic(file(hash, 'wav'), wav);
}

/** Called for every reply. Never throws. */
export async function prepareSpeech(text: string): Promise<SpeechRef> {
  const spoken = speechText(text);
  if (!spoken) return { audio_url: null, voice: null, attribution: null };
  const hash = audioHash(spoken);
  try {
    let voice = cachedVoice(hash);
    const geminiVoice = C.GEMINI_TTS_ENABLED && Boolean(C.geminiApiKey());
    // No voice can be generated at all: no URL.
    if (!voice && !elevenLabsConfigured() && !geminiVoice) return { audio_url: null, voice: null, attribution: null };
    rememberText(hash, spoken);
    if (!voice) {
      const ok = await generateElevenLabs(hash, spoken, C.ELEVENLABS_WAIT_MS).catch(() => false);
      if (!ok && !geminiVoice) return { audio_url: null, voice: null, attribution: null }; // no fallback voice
      voice = ok ? 'elevenlabs' : 'gemini'; // gemini: generated on the first GET
    }
    return { audio_url: urlFor(hash), voice, attribution: voice === 'elevenlabs' ? C.VOICE_ATTRIBUTION : null };
  } catch (err) {
    log.warn('speech setup failed', err);
    return { audio_url: null, voice: null, attribution: null };
  }
}

// --- GET /api/chat/audio/:hash ----------------------------------------------------------

const inFlight = new Map<string, Promise<void>>();

export type AudioResult =
  | { status: 200; body: Buffer; contentType: 'audio/mpeg' | 'audio/wav' }
  | { status: 404 | 503; code: 'not_found' | 'audio_unavailable'; message: string };

export async function serveAudio(hash: string): Promise<AudioResult> {
  if (!/^[a-f0-9]{64}$/.test(hash)) return { status: 404, code: 'not_found', message: 'No such audio' };
  if (existsSync(file(hash, 'mp3'))) return { status: 200, body: readFileSync(file(hash, 'mp3')), contentType: 'audio/mpeg' };
  if (existsSync(file(hash, 'wav'))) return { status: 200, body: readFileSync(file(hash, 'wav')), contentType: 'audio/wav' };
  if (!existsSync(file(hash, 'txt'))) return { status: 404, code: 'not_found', message: 'No such audio' };
  if (!C.GEMINI_TTS_ENABLED) return { status: 503, code: 'audio_unavailable', message: 'Speech is unavailable right now; the text reply still works.' };

  const spoken = readFileSync(file(hash, 'txt'), 'utf8');
  let job = inFlight.get(hash);
  if (!job) {
    job = generateGemini(hash, spoken).finally(() => inFlight.delete(hash));
    inFlight.set(hash, job);
  }
  try {
    await job;
    return { status: 200, body: readFileSync(file(hash, 'wav')), contentType: 'audio/wav' };
  } catch (err) {
    log.warn('Gemini speech failed', err);
    return { status: 503, code: 'audio_unavailable', message: 'Speech is unavailable right now; the text reply still works.' };
  }
}
