// Pre-generate speech for FAQ answers so they play instantly.
//
//   npm run chat:warm          the 20 most likely answers (WARM_TOP in src/chat/faq.ts)
//   npm run chat:warm -- --all every FAQ answer
//
// Uses the primary voice (ElevenLabs) when configured, otherwise the Gemini voice.
// Prints the total characters first. Already-cached answers are skipped, so it can
// be re-run to resume. Stops cleanly (exit 0) on any quota error, the ElevenLabs
// daily character budget, or a provider ceiling.

import '../src/env.js';
import * as C from '../src/chat/config.js';
import { FAQ, WARM_TOP } from '../src/chat/faq.js';
import { GeminiUnavailable } from '../src/chat/gemini.js';
import { elevenLabsConfigured, ElevenLabsQuota } from '../src/chat/tts/elevenlabs.js';
import { audioHash, cachedVoice, generateElevenLabs, generateGemini, rememberText, speechText } from '../src/chat/tts/speech.js';
import { elevenLabsBudgetLeft } from '../src/chat/usage.js';

const all = process.argv.includes('--all');
const entries = all ? FAQ : WARM_TOP.map((id) => FAQ.find((e) => e.id === id)!).filter(Boolean);

const jobs = entries.map((e) => {
  const spoken = speechText(e.answer);
  return { id: e.id, spoken, hash: audioHash(spoken) };
});
const todo = jobs.filter((j) => !cachedVoice(j.hash));
const chars = todo.reduce((n, j) => n + j.spoken.length, 0);

const useEleven = elevenLabsConfigured();
const voice = useEleven ? `ElevenLabs (${C.ELEVENLABS_MODEL})` : C.geminiApiKey() ? `Gemini (${C.GEMINI_TTS_MODEL}, ${C.GEMINI_TTS_VOICE})` : null;

console.log(`FAQ audio warm-up: ${all ? 'all' : 'top 20'} answers (${entries.length}); ${jobs.length - todo.length} already cached, ${todo.length} to generate.`);
console.log(`Total characters to send: ${chars}${useEleven ? ` (ElevenLabs budget left today: ${elevenLabsBudgetLeft()})` : ''}`);
if (todo.length === 0) process.exit(0);
if (!voice) {
  console.log('No voice configured (set ELEVENLABS_API_KEY + ELEVENLABS_VOICE_ID, or GEMINI_API_KEY in backend/.env). Nothing to do.');
  process.exit(0);
}
console.log(`Voice: ${voice}\n`);

const perMinute = (useEleven ? C.CEILINGS.elevenlabs : C.CEILINGS[C.GEMINI_TTS_MODEL])!.perMinute;
const pauseMs = Number(process.env.CHAT_WARM_PAUSE_MS ?? Math.ceil(60_000 / perMinute) + 250); // stay under the per-minute ceiling (tests set 0)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let done = 0, spent = 0, stopReason: string | null = null;
for (const [i, job] of todo.entries()) {
  if (i > 0) await sleep(pauseMs);
  try {
    rememberText(job.hash, job.spoken);
    if (useEleven) {
      if (elevenLabsBudgetLeft() < job.spoken.length) { stopReason = 'ElevenLabs daily character budget reached'; break; }
      const ok = await generateElevenLabs(job.hash, job.spoken, 15_000);
      if (!ok) { stopReason = 'ElevenLabs failed or a ceiling was reached (see the log above)'; break; }
    } else {
      await generateGemini(job.hash, job.spoken);
    }
    done++;
    spent += job.spoken.length;
    console.log(`  [${done}/${todo.length}] ${job.id} (${job.spoken.length} chars)`);
  } catch (err) {
    if (err instanceof ElevenLabsQuota) stopReason = 'ElevenLabs quota used up';
    else if (err instanceof GeminiUnavailable) stopReason = err.reason === 'ceiling' ? `Gemini TTS ceiling reached (${C.CEILINGS[C.GEMINI_TTS_MODEL]!.perDay}/day)` : 'GEMINI_API_KEY not set';
    else if ((err as { status?: number }).status === 429) stopReason = 'Gemini quota used up (HTTP 429)';
    else stopReason = `error: ${(err as Error).message}`;
    break;
  }
}

console.log(`\nGenerated ${done}, characters sent ${spent}, remaining ${todo.length - done}.`);
if (stopReason) console.log(`Stopped cleanly: ${stopReason}. Run again later to resume (cached answers are skipped).`);
