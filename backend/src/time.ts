// Toronto local dates. Streaks, the daily points cap and club weeks all follow
// local time in Kitchener-Waterloo, not UTC.

const TZ = 'America/Toronto';
const dateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });

/** Toronto calendar date, "YYYY-MM-DD". */
export function torontoDate(at: Date | string | number = Date.now()): string {
  return dateFmt.format(new Date(at)); // en-CA formats as YYYY-MM-DD
}

/** Add whole days to a "YYYY-MM-DD" date. */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`); // noon avoids any DST edge
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Monday of the Toronto week containing `at`, "YYYY-MM-DD". */
export function torontoWeekStart(at: Date | string | number = Date.now()): string {
  const date = torontoDate(at);
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(date, -((weekday + 6) % 7));
}

/** UTC ISO range [start, end) covering one Toronto calendar day, for SQL queries on ISO text columns. */
export function torontoDayRangeUtc(date: string): [string, string] {
  return [torontoMidnightUtc(date), torontoMidnightUtc(addDays(date, 1))];
}

function torontoMidnightUtc(date: string): string {
  // Toronto is UTC-5 or UTC-4. Try both offsets, keep the one that maps back to `date` at 00:00.
  for (const offset of [4, 5]) {
    const candidate = new Date(`${date}T${String(offset).padStart(2, '0')}:00:00.000Z`);
    if (torontoDate(candidate) === date && torontoDate(candidate.getTime() - 1) !== date) return candidate.toISOString();
  }
  return new Date(`${date}T05:00:00.000Z`).toISOString();
}
