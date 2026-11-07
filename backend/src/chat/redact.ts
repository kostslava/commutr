// Logging for the chat code. Every message goes through redact(), which removes
// the values of all secret env vars, so a key can't leak through an error message
// from an SDK or an HTTP response.

const SECRET_VARS = ['GEMINI_API_KEY', 'ELEVENLABS_API_KEY', 'ELEVENLABS_VOICE_ID'];

export function redact(text: string): string {
  let out = text;
  for (const name of SECRET_VARS) {
    const value = process.env[name];
    if (value && value.length >= 4) out = out.split(value).join(`[${name}]`);
  }
  // Belt and braces: anything that looks like a Google API key.
  return out.replace(/AIza[0-9A-Za-z_-]{20,}/g, '[REDACTED]');
}

const describe = (err: unknown) => {
  if (err instanceof Error) {
    const status = (err as { status?: number }).status;
    return `${err.name}${status ? ` ${status}` : ''}: ${err.message}`.slice(0, 400);
  }
  return String(err).slice(0, 400);
};

export const log = {
  info: (msg: string) => console.log(redact(`[chat] ${msg}`)),
  warn: (msg: string, err?: unknown) => console.warn(redact(`[chat] ${msg}${err === undefined ? '' : ` (${describe(err)})`}`)),
};
