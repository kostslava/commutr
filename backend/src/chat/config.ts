// Every chat number and model name lives here. Keys come from backend/.env
// (see backend/.env.example) and are never logged.

import { ThinkingLevel } from '@google/genai';
import { fileURLToPath } from 'node:url';

const env = process.env;

// --- Gemini -------------------------------------------------------------------

// gemini-2.5-flash-lite is refused for new projects ("no longer available to new
// users", HTTP 404 in the real run), so the 3.5 Flash-Lite model is the default.
/** Chat replies and function calling. */
export const GEMINI_CHAT_MODEL = env.GEMINI_CHAT_MODEL || 'gemini-3.5-flash-lite';
/** Voice transcription (audio in, verbatim text out). */
export const GEMINI_TRANSCRIBE_MODEL = env.GEMINI_TRANSCRIBE_MODEL || 'gemini-3.5-flash-lite';
/** Fallback speech when ElevenLabs fails or its daily budget is used up. */
export const GEMINI_TTS_MODEL = env.GEMINI_TTS_MODEL || 'gemini-3.8-flash-lite-tts';
/** Gemini TTS fallback on/off. Off: when ElevenLabs can't speak a reply, audio_url and voice are null. */
export const GEMINI_TTS_ENABLED = true;
/** API version for every Gemini call (the docs use v1beta; the SDK's default v1 rejected speechConfig). */
export const GEMINI_API_VERSION = 'v1beta';
export const GEMINI_TTS_VOICE = env.GEMINI_VOICE || 'Kore';
/**
 * Wanted 16 kHz to keep WAV files small, but the Gemini API ignores output sample
 * rate settings (the SDK marks responseFormat "not supported in Gemini API"), so the
 * model's own rate is used and read from the response.
 */
export const GEMINI_TTS_DEFAULT_SAMPLE_RATE = 24_000;

export const geminiApiKey = () => env.GEMINI_API_KEY || '';
/** Test-only: point the SDK at the local mock server. */
export const GEMINI_BASE_URL = env.GEMINI_BASE_URL || undefined;

/** One budget for a whole chat turn, including function-calling rounds. */
export const CHAT_TURN_TIMEOUT_MS = 5_000;
export const TRANSCRIBE_TIMEOUT_MS = 10_000;
/** Generating fallback speech on the first GET of an audio URL. */
/** Overridable for npm run test:real, which allows 60 s; the app keeps 20 s. */
export const GEMINI_TTS_TIMEOUT_MS = Number(env.GEMINI_TTS_TIMEOUT_MS || 20_000);

/** Max function-calling rounds per turn (each round is one more Gemini call). */
export const MAX_TOOL_ROUNDS = 3;
export const MAX_OUTPUT_TOKENS = 150;
export const TEMPERATURE = 0.6;

// --- ElevenLabs (primary voice) -------------------------------------------------

export const ELEVENLABS_MODEL = 'eleven_flash_v2_5';
export const ELEVENLABS_OUTPUT_FORMAT = 'mp3_22050_32';
export const elevenLabsKey = () => env.ELEVENLABS_API_KEY || '';
export const elevenLabsVoiceId = () => env.ELEVENLABS_VOICE_ID || '';
/** Test-only: point at the local mock server. */
export const ELEVENLABS_BASE_URL = env.ELEVENLABS_BASE_URL || 'https://api.elevenlabs.io';
/** Characters per Toronto day sent to ElevenLabs (replies + warm script). Over budget: Gemini fallback. */
export const ELEVENLABS_DAILY_CHAR_BUDGET = Number(env.ELEVENLABS_DAILY_CHAR_BUDGET || 6000);
/** How long a reply waits for ElevenLabs before handing speech to the Gemini fallback. */
export const ELEVENLABS_WAIT_MS = 4_000;
export const VOICE_ATTRIBUTION = 'Voice by ElevenLabs';

// --- Provider ceilings (whole server) -----------------------------------------
// The Gemini docs no longer publish free-tier numbers (they're per project, shown in
// AI Studio). These are deliberately conservative defaults; tune them to ~70% of the
// limits on https://aistudio.google.com/rate-limit. Gemini daily limits reset at
// midnight Pacific time, so the per-day counts here do too.

const CHAT_MODEL_CEILING = { perMinute: 8, perDay: 400 };

export const CEILINGS: Record<string, { perMinute: number; perDay: number }> = {
  // Chat turns, tool rounds and transcription all count here (same model).
  [GEMINI_CHAT_MODEL]: CHAT_MODEL_CEILING,
  [GEMINI_TTS_MODEL]: { perMinute: 2, perDay: 10 },
  elevenlabs: { perMinute: 20, perDay: 1000 },
};
// If the transcription model is switched, it gets the chat model's ceiling by default.
if (!CEILINGS[GEMINI_TRANSCRIBE_MODEL]) CEILINGS[GEMINI_TRANSCRIBE_MODEL] = { ...CHAT_MODEL_CEILING };
// Test-only: the mocked tests raise the ceilings (they make many fake calls per minute).
const ceilingMultiplier = Number(env.CHAT_CEILING_MULTIPLIER || 1);
if (ceilingMultiplier !== 1) for (const c of Object.values(CEILINGS)) Object.assign(c, { perMinute: c.perMinute * ceilingMultiplier, perDay: c.perDay * ceilingMultiplier });

// --- Per-user limits ------------------------------------------------------------

export const USER_LIMITS = {
  text: { perMinute: 10, perDay: 100 },
  voice: { perMinute: 4, perDay: 30 },
  // Muta session links serve the shared public demo account. Keep this separate
  // from uploaded voice messages so a demo crowd cannot exhaust 30 daily starts.
  voiceSession: { perMinute: 20, perDay: 1000 },
  /**
   * Trip plans (POST /api/plan, /api/agent/plan and /api/companion/plan share this). Sized
   * for a public demo where every visitor is demo user 1. Gemini quota is protected by
   * CEILINGS above, not by this: a plan only uses Gemini when the ceiling has room for a
   * whole plan, otherwise it answers with the computed plan (200, source "computed").
   */
  plan: { perMinute: 10, perDay: 300 },
  /**
   * Place search (POST /api/companion/discover): Nominatim and its cache only, no Gemini.
   * Nominatim stays at 1 request a second for the whole server (planner/geocode.ts).
   */
  discover: { perMinute: 10, perDay: 300 },
  /** Route safety lookups (POST /api/companion/route-safety): a file read, no provider calls. */
  safety: { perMinute: 20, perDay: 200 },
};

// --- Trip planner's share of the Gemini ceilings ----------------------------------

/**
 * Max Gemini calls in one plan (tool rounds + the final structured answer). They all
 * count against the chat model's ceiling above. A plan only starts with Gemini when
 * the ceiling has room for all of them; otherwise it answers with the computed plan.
 */
export const PLANNER_MAX_GEMINI_CALLS = 4;
/** Tool rounds before the final structured-output call. */
export const PLANNER_MAX_TOOL_ROUNDS = PLANNER_MAX_GEMINI_CALLS - 1;
export const PLANNER_MAX_OUTPUT_TOKENS = 400;
export const PLANNER_TEMPERATURE = 0.4;
/**
 * Thinking for the planner's calls only (tool rounds and the final answer). MINIMAL is
 * the lowest level gemini-3.5-flash-lite supports (thinking can't be switched off on
 * 3.x models) and is also its documented default; set explicitly so it stays lowest.
 */
export const PLANNER_THINKING_LEVEL = ThinkingLevel.MINIMAL;

// --- Messages and uploads -------------------------------------------------------

export const MAX_MESSAGE_CHARS = 500;
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
/** Checked from the header for WAV only; the frontend stops recording at 30 s. */
export const MAX_WAV_SECONDS = 30;
/** Upload types accepted (the parameters after ';' are ignored). */
export const AUDIO_TYPES: Record<string, string> = {
  'audio/webm': 'audio/webm',
  'video/webm': 'audio/webm', // some browsers label audio-only recordings this way
  'audio/mp4': 'audio/mp4',
  'audio/m4a': 'audio/m4a',
  'audio/x-m4a': 'audio/m4a',
  'audio/wav': 'audio/wav',
  'audio/x-wav': 'audio/wav',
  'audio/wave': 'audio/wav',
  'audio/mpeg': 'audio/mpeg',
  'audio/mp3': 'audio/mpeg',
  'audio/ogg': 'audio/ogg',
};

// --- FAQ matching ---------------------------------------------------------------

/** A message matches an FAQ entry at this score (0..1) or higher ... */
export const FAQ_MATCH_THRESHOLD = 0.6;
/** ... unless the runner-up is within this margin, in which case the best needs ... */
export const FAQ_AMBIGUOUS_MARGIN = 0.05;
/** ... at least this score. Otherwise the message goes to Gemini. */
export const FAQ_AMBIGUOUS_MIN = 0.75;
/** FAQ answers are kept short so speech quota lasts. Checked by the tests. */
export const FAQ_ANSWER_MAX_CHARS = 220;

// --- Storage ----------------------------------------------------------------------

// Overridable for the test scripts, so tests never touch the real cache or counters.
export const TTS_DIR = env.CHAT_TTS_DIR || fileURLToPath(new URL('../../data/tts/', import.meta.url));
export const USAGE_FILE = env.CHAT_USAGE_FILE || fileURLToPath(new URL('../../data/chat-usage.json', import.meta.url));
