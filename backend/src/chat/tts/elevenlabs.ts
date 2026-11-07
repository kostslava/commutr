// ElevenLabs text to speech (the primary voice). Key and voice ID come from env and
// are never logged (see redact.ts).

import { ELEVENLABS_BASE_URL, ELEVENLABS_MODEL, ELEVENLABS_OUTPUT_FORMAT, elevenLabsKey, elevenLabsVoiceId } from '../config.js';

export class ElevenLabsQuota extends Error {}

export const elevenLabsConfigured = () => Boolean(elevenLabsKey() && elevenLabsVoiceId());

export async function elevenLabsSpeech(text: string, timeoutMs: number): Promise<Buffer> {
  const url = `${ELEVENLABS_BASE_URL}/v1/text-to-speech/${encodeURIComponent(elevenLabsVoiceId())}?output_format=${ELEVENLABS_OUTPUT_FORMAT}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'xi-api-key': elevenLabsKey(), 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify({ text, model_id: ELEVENLABS_MODEL }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // Don't pass on the URL (it contains the voice ID): describe the failure only.
    throw new Error((err as Error).name === 'TimeoutError' ? `ElevenLabs timed out after ${timeoutMs} ms` : `ElevenLabs request failed: ${(err as Error).name}`);
  }
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 300);
    // ElevenLabs reports a used-up quota as 401 with detail.status "quota_exceeded", or 429.
    if (res.status === 429 || /quota_exceeded|exceeds your quota|credits/i.test(body)) throw new ElevenLabsQuota(`ElevenLabs quota: HTTP ${res.status}`);
    throw new Error(`ElevenLabs HTTP ${res.status}`);
  }
  const audio = Buffer.from(await res.arrayBuffer());
  if (audio.length === 0) throw new Error('ElevenLabs returned no audio');
  return audio;
}
