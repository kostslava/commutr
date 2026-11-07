import { addDays, torontoDate } from './time.js';

export type StoredStreak = { current_days: number; longest_days: number; last_active_date: string | null };
export type DisplayStreak = StoredStreak & { active_today: boolean };

/**
 * How a streak is shown. The stored row only changes when a trip finishes, so a
 * streak whose last active day is before yesterday (Toronto) is shown as 0.
 * The stored row is not modified; longest_days is always kept.
 */
export function displayStreak(row: StoredStreak | undefined | null, now: Date | string | number = Date.now()): DisplayStreak {
  const s = row ?? { current_days: 0, longest_days: 0, last_active_date: null };
  const today = torontoDate(now);
  const alive = s.last_active_date === today || s.last_active_date === addDays(today, -1);
  return {
    current_days: alive ? s.current_days : 0,
    longest_days: s.longest_days,
    last_active_date: s.last_active_date,
    active_today: s.last_active_date === today,
  };
}
