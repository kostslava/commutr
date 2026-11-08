// Spoken summaries for the agent endpoints, built from templates in code (never by
// a model), so every number is the real one. Short: the voice agent reads them out.

import type { FinishResult } from '../scoring/apply.js';
import type { UserStatus } from '../status.js';

type Reward = { title: string; points_cost: number; merchant: { name: string }; points_needed: number; eco_needed: number; locked: boolean };

const list = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function statusSummary(s: UserStatus): string {
  const streak = s.streak.current_days > 0 ? `a ${s.streak.current_days}-day streak` : 'no streak going yet'; // "a 1-day streak", "a 5-day streak"
  return `You have ${plural(s.points, 'point')}, an eco score of ${s.eco_score} and ${streak}. You've earned ${s.points_today} of today's ${s.daily_cap} points.`;
}

export function rewardsSummary(affordable: Reward[], locked: Reward[]): string {
  const parts: string[] = [];
  if (affordable.length) {
    const names = affordable.slice(0, 3).map((r) => `${r.title} at ${r.merchant.name}`);
    parts.push(`You can redeem ${plural(affordable.length, 'reward')} now, like ${list(names)}.`);
  } else {
    parts.push("You can't redeem any rewards yet.");
  }
  if (locked.length) {
    const closest = [...locked].sort((a, b) => a.points_needed + a.eco_needed * 50 - (b.points_needed + b.eco_needed * 50))[0]!;
    const need = [closest.points_needed ? plural(closest.points_needed, 'more point') : '', closest.eco_needed ? `${closest.eco_needed} more eco score` : ''].filter(Boolean);
    parts.push(`The closest one to unlock is ${closest.title} at ${closest.merchant.name}: you need ${list(need)}.`);
  }
  return parts.join(' ');
}

export function finishSummary(r: FinishResult): string {
  const t = r.trip;
  const how = { walk: 'walking', bike: 'biking', scooter: 'by scooter', transit: 'by transit', car: 'by car' }[t.mode];
  if (t.mode === 'car') return `Trip finished: ${t.distance_km} km by car. Car trips don't earn points and lower your eco score, which is now ${r.user.eco_score}.`;
  if (t.points_awarded === 0 && !t.capped) return `Trip finished: ${t.distance_km} km ${how}, but it couldn't be verified, so it earned no points. You have ${plural(r.user.points, 'point')}.`;
  const cap = t.capped ? " That's today's cap." : '';
  return `Nice! ${t.distance_km} km ${how} earned you ${plural(t.points_awarded, 'point')}.${cap} You now have ${plural(r.user.points, 'point')}.`;
}
