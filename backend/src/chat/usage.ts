// Usage counters.
// - Provider ceilings (whole server): per-minute in memory, per-day persisted to
//   backend/data/chat-usage.json so a restart doesn't reset the daily count.
//   Gemini days follow Pacific time (when Google resets daily quotas).
// - ElevenLabs characters per Toronto day (the daily character budget), persisted too.
// - Per-user request limits: in memory (reset on restart; fine for the demo).

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { torontoDate } from '../time.js';
import { CEILINGS, ELEVENLABS_DAILY_CHAR_BUDGET, USAGE_FILE, USER_LIMITS } from './config.js';

const pacificDate = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

type Persisted = {
  calls: { date: string; counts: Record<string, number> };
  elevenlabs: { date: string; chars: number; exhausted: boolean };
};

let state: Persisted = load();

function load(): Persisted {
  try {
    return JSON.parse(readFileSync(USAGE_FILE, 'utf8')) as Persisted;
  } catch {
    return { calls: { date: pacificDate(), counts: {} }, elevenlabs: { date: torontoDate(), chars: 0, exhausted: false } };
  }
}

function save() {
  try {
    mkdirSync(dirname(USAGE_FILE), { recursive: true });
    writeFileSync(USAGE_FILE + '.tmp', JSON.stringify(state));
    renameSync(USAGE_FILE + '.tmp', USAGE_FILE);
  } catch {
    /* counters are best effort; never break a request over them */
  }
}

function rollDays() {
  if (state.calls.date !== pacificDate()) state.calls = { date: pacificDate(), counts: {} };
  if (state.elevenlabs.date !== torontoDate()) state.elevenlabs = { date: torontoDate(), chars: 0, exhausted: false };
}

// --- Provider ceilings ------------------------------------------------------------

const minuteWindows = new Map<string, number[]>();

/** Take one call from a provider's ceiling. false = over the ceiling, don't call. */
export function takeProviderCall(key: string): boolean {
  rollDays();
  const ceiling = CEILINGS[key];
  if (!ceiling) return true;
  const now = Date.now();
  const recent = (minuteWindows.get(key) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= ceiling.perMinute) return false;
  if ((state.calls.counts[key] ?? 0) >= ceiling.perDay) return false;
  recent.push(now);
  minuteWindows.set(key, recent);
  state.calls.counts[key] = (state.calls.counts[key] ?? 0) + 1;
  save();
  return true;
}

/** Seconds until a provider call would be allowed again under the per-minute ceiling. */
export function providerRetryAfterSec(key: string): number {
  const recent = (minuteWindows.get(key) ?? []).filter((t) => Date.now() - t < 60_000);
  return recent.length ? Math.max(1, Math.ceil((60_000 - (Date.now() - recent[0]!)) / 1000)) : 1;
}

// --- ElevenLabs daily character budget ---------------------------------------------

export function elevenLabsBudgetLeft(): number {
  rollDays();
  return state.elevenlabs.exhausted ? 0 : Math.max(0, ELEVENLABS_DAILY_CHAR_BUDGET - state.elevenlabs.chars);
}

export function spendElevenLabsChars(chars: number) {
  rollDays();
  state.elevenlabs.chars += chars;
  save();
}

/** ElevenLabs said its quota is used up: skip it until tomorrow. */
export function markElevenLabsExhausted() {
  rollDays();
  state.elevenlabs.exhausted = true;
  save();
}

// --- Per-user limits ----------------------------------------------------------------

const userHits = new Map<string, { minute: number[]; day: string; dayCount: number }>();

export function takeUserRequest(kind: keyof typeof USER_LIMITS, userId: number): { ok: true } | { ok: false; retryAfterSec: number } {
  const limit = USER_LIMITS[kind];
  const key = `${kind}:${userId}`;
  const today = torontoDate();
  const now = Date.now();
  const entry = userHits.get(key) ?? { minute: [], day: today, dayCount: 0 };
  if (entry.day !== today) Object.assign(entry, { day: today, dayCount: 0 });
  entry.minute = entry.minute.filter((t) => now - t < 60_000);

  if (entry.dayCount >= limit.perDay) return { ok: false, retryAfterSec: secondsToTorontoMidnight() };
  if (entry.minute.length >= limit.perMinute) return { ok: false, retryAfterSec: Math.max(1, Math.ceil((60_000 - (now - entry.minute[0]!)) / 1000)) };

  entry.minute.push(now);
  entry.dayCount++;
  userHits.set(key, entry);
  return { ok: true };
}

function secondsToTorontoMidnight(): number {
  const now = Date.now();
  for (let s = 60; s <= 25 * 3600; s += 60) if (torontoDate(now + s * 1000) !== torontoDate(now)) return s;
  return 3600;
}
