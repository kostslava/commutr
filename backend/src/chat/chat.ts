// One chat message, start to finish. Never throws: Gemini problems become a
// fallback reply, speech problems become audio_url null or a 503 on the audio URL.
//
//   "what to eat / where to go"  -> suggestions built in code; Gemini words the reply
//                                   (local template if Gemini is unavailable)
//   personal ("my points")       -> Gemini with function-calling tools
//   general question             -> local FAQ (no API call)
//   anything else                -> Gemini with tools
//   Gemini fails / times out     -> canned fallback, source "fallback"

import type { DB } from '../db.js';
import { chatTurn, GeminiUnavailable, suggestionReply } from './gemini.js';
import { isFoodOrPlaceQuestion, isPersonalQuestion } from './intents.js';
import { matchFaq } from './match.js';
import { log } from './redact.js';
import { planSuggestions, type Suggestion } from './suggest.js';
import { prepareSpeech, type Voice } from './tts/speech.js';

export type ChatSource = 'faq' | 'gemini' | 'fallback';

export type ChatReply = {
  reply: string;
  source: ChatSource;
  audio_url: string | null;
  voice: Voice | null;
  attribution: string | null;
  suggestions: Suggestion[];
};

export const FALLBACK_REPLY = "I'm having trouble thinking right now. Try asking me about points, rewards, streaks or live buses!";
export const NO_SPEECH_REPLY = "Sorry, I didn't catch that. Could you try again a little closer to the mic?";
export const TRANSCRIBE_FAILED_REPLY = "Sorry, I couldn't understand the recording right now. You can type your question instead.";

let warnedNoKey = false;
function noteGeminiFailure(what: string, err: unknown) {
  if (err instanceof GeminiUnavailable && err.reason === 'no_key') {
    if (!warnedNoKey) log.warn('GEMINI_API_KEY is not set; chat uses the FAQ and fallback replies only');
    warnedNoKey = true;
    return;
  }
  log.warn(`${what} failed, using the fallback`, err);
}

/** Text only (no speech): exported so the tests can time the FAQ path on its own. */
export async function answerText(db: DB, userId: number, message: string): Promise<Omit<ChatReply, 'audio_url' | 'voice' | 'attribution'>> {
  const text = message.trim();

  if (isFoodOrPlaceQuestion(text)) {
    const plan = planSuggestions(db, userId);
    try {
      return { reply: await suggestionReply(text, plan.promptSummary), source: 'gemini', suggestions: plan.suggestions };
    } catch (err) {
      noteGeminiFailure('Suggestion reply', err);
      return { reply: plan.templateReply, source: 'fallback', suggestions: plan.suggestions };
    }
  }

  if (!isPersonalQuestion(text)) {
    const hit = matchFaq(text);
    if (hit) return { reply: hit.entry.answer, source: 'faq', suggestions: [] };
  }

  try {
    return { reply: await chatTurn(db, userId, text), source: 'gemini', suggestions: [] };
  } catch (err) {
    noteGeminiFailure('Gemini chat', err);
    return { reply: FALLBACK_REPLY, source: 'fallback', suggestions: [] };
  }
}

export async function answer(db: DB, userId: number, message: string): Promise<ChatReply> {
  const result = await answerText(db, userId, message);
  return { ...result, ...(await prepareSpeech(result.reply)) };
}

/** A canned reply (voice errors) with speech, in the same shape as answer(). */
export async function cannedReply(reply: string): Promise<ChatReply> {
  return { reply, source: 'fallback', suggestions: [], ...(await prepareSpeech(reply)) };
}
