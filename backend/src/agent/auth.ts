// X-Agent-Secret check for the ElevenLabs live agent's tool endpoints.
// - AGENT_TOOL_SECRET empty or unset: every agent endpoint answers 503 (never open).
// - Missing or wrong header: 401. Compared in constant time (both sides hashed first,
//   so the length doesn't leak either).
// - Neither the expected nor the received secret is ever logged or echoed.

import { createHash, timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';

const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest();

export function secretMatches(received: string | undefined, expected: string): boolean {
  // Always hash and compare, even for a missing header, so timing doesn't say which case it was.
  const ok = timingSafeEqual(digest(received ?? ''), digest(expected));
  return ok && received !== undefined && expected.length > 0;
}

export function agentAuth(): MiddlewareHandler {
  return async (c, next) => {
    const expected = process.env.AGENT_TOOL_SECRET ?? '';
    if (!expected) {
      return c.json({ ok: false, error: { code: 'agent_not_configured', message: 'AGENT_TOOL_SECRET is not set on the server' }, summary: "The assistant's tools aren't set up on the server yet." }, 503);
    }
    if (!secretMatches(c.req.header('X-Agent-Secret'), expected)) {
      return c.json({ ok: false, error: { code: 'bad_agent_secret', message: 'Missing or wrong X-Agent-Secret header' }, summary: "I couldn't reach your Commutr account." }, 401);
    }
    await next();
  };
}
