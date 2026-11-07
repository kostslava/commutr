// Local intent checks that decide where a message goes before the FAQ.

const lower = (t: string) => t.toLowerCase().replace(/[’‘`]/g, "'");

/**
 * A question about the user's own numbers ("how many points do I have", "what's my
 * eco score", "can I afford the $10 card", "why is my reward locked"). These go to
 * Gemini with function-calling tools, not the general FAQ. "How do I keep my streak"
 * is a how-to question, not a status question, so it stays with the FAQ.
 */
export function isPersonalQuestion(text: string): boolean {
  const t = lower(text);
  return (
    /\b(how many|how much|what('s| is| are)|whats|show( me)?|check|tell me)\b[^?]*\bmy\b/.test(t) ||
    /\b(do|have) i (have|got|earned)\b/.test(t) ||
    /\bcan i afford\b|\bwhat can i (get|afford|buy|redeem)\b|\bhow close am i\b|\bam i close\b/.test(t) ||
    /\bwhy (is|are|was) my\b/.test(t)
  );
}

/** "What should I eat", "where can I go", "I'm hungry": answered with suggestions built in code. */
export function isFoodOrPlaceQuestion(text: string): boolean {
  const t = lower(text);
  return (
    /\b(eat|food|hungry|lunch|dinner|breakfast|brunch|snack|restaurant|cafe|bakery|treat myself|grab a bite)\b/.test(t) ||
    /\bwhere (should|can|could|do) i go\b|\bsomewhere to go\b|\bplace to go\b|\bwhere to go\b/.test(t) ||
    /\b(get|grab|want|need) (a )?coffee\b/.test(t)
  );
}
