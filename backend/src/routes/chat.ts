import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { answer, cannedReply, NO_SPEECH_REPLY, TRANSCRIBE_FAILED_REPLY } from '../chat/chat.js';
import * as C from '../chat/config.js';
import { transcribe } from '../chat/gemini.js';
import { log } from '../chat/redact.js';
import { serveAudio } from '../chat/tts/speech.js';
import { wavDurationSec } from '../chat/tts/wav.js';
import { takeUserRequest } from '../chat/usage.js';
import type { CurrentUserEnv } from '../currentUser.js';
import type { DB } from '../db.js';
import { bad, isObj, jsonBody } from './http.js';

const rateLimited = (c: Context, retryAfterSec: number) => {
  c.header('Retry-After', String(retryAfterSec));
  return c.json({ error: { code: 'rate_limited', message: 'Too many chat messages. Try again soon.' }, retry_after_sec: retryAfterSec }, 429);
};

export function chatRoutes(db: DB) {
  const r = new Hono<CurrentUserEnv>();

  r.post('/chat', async (c) => {
    const limit = takeUserRequest('text', c.get('userId'));
    if (!limit.ok) return rateLimited(c, limit.retryAfterSec);
    const body = await jsonBody(c);
    if (!isObj(body) || typeof body.message !== 'string' || body.message.trim().length === 0) return bad(c, 'message must be a non-empty string');
    if (body.message.length > C.MAX_MESSAGE_CHARS) return bad(c, `message must be at most ${C.MAX_MESSAGE_CHARS} characters`);
    return c.json(await answer(db, c.get('userId'), body.message));
  });

  r.post(
    '/chat/voice',
    // The multipart envelope adds a little; the file itself is checked exactly below.
    bodyLimit({
      maxSize: C.MAX_UPLOAD_BYTES + 64 * 1024,
      onError: (c) => c.json({ error: { code: 'too_large', message: `Audio must be at most ${C.MAX_UPLOAD_BYTES / 1024 / 1024} MB` } }, 413),
    }),
    async (c) => {
      const limit = takeUserRequest('voice', c.get('userId'));
      if (!limit.ok) return rateLimited(c, limit.retryAfterSec);

      let form: Record<string, unknown>;
      try {
        form = await c.req.parseBody();
      } catch {
        return bad(c, 'send multipart/form-data with an "audio" file field');
      }
      const audio = form.audio;
      if (!(audio instanceof File)) return bad(c, 'send multipart/form-data with an "audio" file field');

      const baseType = (audio.type || '').split(';')[0]!.trim().toLowerCase();
      const mimeType = C.AUDIO_TYPES[baseType];
      if (!mimeType) {
        return c.json({ error: { code: 'unsupported_audio', message: 'Audio must be webm, m4a/mp4, wav, mp3 or ogg' } }, 415);
      }
      if (audio.size === 0) return bad(c, 'audio is empty');
      if (audio.size > C.MAX_UPLOAD_BYTES) return c.json({ error: { code: 'too_large', message: `Audio must be at most ${C.MAX_UPLOAD_BYTES / 1024 / 1024} MB` } }, 413);

      const buf = Buffer.from(await audio.arrayBuffer());
      if (mimeType === 'audio/wav') {
        const seconds = wavDurationSec(buf);
        if (seconds !== null && seconds > C.MAX_WAV_SECONDS) {
          return c.json({ error: { code: 'too_long', message: `Audio must be at most ${C.MAX_WAV_SECONDS} seconds` } }, 413);
        }
      }

      let transcript: string;
      try {
        transcript = await transcribe(buf, mimeType);
      } catch (err) {
        log.warn('transcription failed', err);
        return c.json({ ...(await cannedReply(TRANSCRIBE_FAILED_REPLY)), transcript: null });
      }
      if (!transcript) return c.json({ ...(await cannedReply(NO_SPEECH_REPLY)), transcript: '' });
      return c.json({ ...(await answer(db, c.get('userId'), transcript.slice(0, C.MAX_MESSAGE_CHARS))), transcript });
    },
  );

  return r;
}

// Public: an <audio src> can't send X-Demo-User. Hashes are unguessable (sha256).
export const chatAudioRoutes = new Hono();

chatAudioRoutes.get('/chat/audio/:hash', async (c) => {
  const result = await serveAudio(c.req.param('hash'));
  if (result.status !== 200) {
    if (result.status === 503) c.header('Retry-After', '30');
    return c.json({ error: { code: result.code, message: result.message } }, result.status);
  }
  c.header('Content-Type', result.contentType);
  c.header('Cache-Control', 'public, max-age=31536000, immutable');
  return c.body(new Uint8Array(result.body));
});
