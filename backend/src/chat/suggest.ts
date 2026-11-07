// "What should I eat / where should I go": suggestions built in code from the
// demo merchants and rewards, never by the model.
//   - Up to 3 unlocked + affordable rewards at places with a location, cheapest first.
//   - None affordable: the cheapest unlocked one, with how many points are missing
//     and how far to walk or bike to earn them.
//   - Everything locked by eco score: the cheapest one, with an eco note.
// Gift cards (no location) are never suggested as places.

import type { DB } from '../db.js';
import { haversineKm } from '../geo.js';
import { listRewards } from '../rewards/redeem.js';
import { MODE_RATES } from '../scoring/config.js';

export type Suggestion = {
  type: 'reward' | 'destination';
  reward_id: number;
  merchant_id: number;
  name: string;
  category: string;
  reward_title: string;
  lat: number;
  lng: number;
  points_cost: number;
  affordable: boolean;
  locked: boolean;
  points_short: number;
  eco_needed: number;
  /** km to walk (or bike) to earn the missing points, at the user's trust level. */
  earn_by_walking_km: number | null;
  earn_by_biking_km: number | null;
  /** From the user's saved home, if any. Computed here only; never sent to Gemini. */
  distance_km: number | null;
};

export type SuggestionPlan = {
  kind: 'affordable' | 'earn_more' | 'eco_locked' | 'none';
  suggestions: Suggestion[];
  /** Plain-text summary for Gemini: no coordinates, no distances, no personal data. */
  promptSummary: string;
  /** Local reply if Gemini is unavailable. */
  templateReply: string;
};

const round1 = (n: number) => Math.round(n * 10) / 10;

export function planSuggestions(db: DB, userId: number): SuggestionPlan {
  const { trust_multiplier: trust } = db.prepare('SELECT trust_multiplier FROM users WHERE id = ?').get(userId) as { trust_multiplier: number };
  const home = db.prepare("SELECT lat, lng FROM saved_locations WHERE user_id = ? AND kind = 'home'").get(userId) as { lat: number; lng: number } | undefined;

  const places = listRewards(db, userId).filter((r) => r.merchant.lat !== null && r.merchant.lng !== null);
  const toSuggestion = (r: (typeof places)[number], type: Suggestion['type']): Suggestion => {
    const short = r.points_needed;
    const kmFor = (rate: number) => (short > 0 && rate > 0 ? round1(short / (rate * Math.max(trust, 0.01))) : null);
    return {
      type,
      reward_id: r.id,
      merchant_id: r.merchant.id,
      name: r.merchant.name,
      category: r.merchant.category,
      reward_title: r.title,
      lat: r.merchant.lat!,
      lng: r.merchant.lng!,
      points_cost: r.points_cost,
      affordable: r.affordable,
      locked: r.locked,
      points_short: short,
      eco_needed: r.eco_needed,
      earn_by_walking_km: kmFor(MODE_RATES.walk),
      earn_by_biking_km: kmFor(MODE_RATES.bike),
      distance_km: home ? round1(haversineKm([home.lat, home.lng], [r.merchant.lat!, r.merchant.lng!])) : null,
    };
  };
  const byCost = (a: { points_cost: number }, b: { points_cost: number }) => a.points_cost - b.points_cost;

  const ready = places.filter((r) => !r.locked && r.affordable).sort(byCost).slice(0, 3);
  if (ready.length) {
    const suggestions = ready.map((r) => toSuggestion(r, 'reward'));
    return {
      kind: 'affordable',
      suggestions,
      promptSummary: `You can redeem these now: ${suggestions.map((s) => `${s.reward_title} at ${s.name} (${s.category}, ${s.points_cost} points)`).join('; ')}.`,
      templateReply: `You can treat yourself at ${suggestions.map((s) => s.name).join(', ')}. Walk or bike there and you'll earn points on the way.`,
    };
  }

  const unlocked = places.filter((r) => !r.locked).sort(byCost)[0];
  if (unlocked) {
    const s = toSuggestion(unlocked, 'destination');
    return {
      kind: 'earn_more',
      suggestions: [s],
      promptSummary: `Nothing is affordable yet. Closest: ${s.reward_title} at ${s.name} (${s.category}) costs ${s.points_cost} points; the user is ${s.points_short} points short, about ${s.earn_by_walking_km} km of walking or ${s.earn_by_biking_km} km of biking.`,
      templateReply: `You're ${s.points_short} points away from ${s.reward_title} at ${s.name}. Walk about ${s.earn_by_walking_km} km or bike about ${s.earn_by_biking_km} km to earn the difference, maybe by walking there!`,
    };
  }

  const cheapest = places.sort(byCost)[0];
  if (cheapest) {
    const s = toSuggestion(cheapest, 'destination');
    return {
      kind: 'eco_locked',
      suggestions: [s],
      promptSummary: `Every reward is locked by eco score. Cheapest: ${s.reward_title} at ${s.name} needs ${s.eco_needed} more eco score points (green trips raise it) and ${s.points_short} more points.`,
      templateReply: `Your rewards are locked for now. ${s.name} needs ${s.eco_needed} more eco score points. Green trips raise your eco score, so walk or bike there!`,
    };
  }

  return { kind: 'none', suggestions: [], promptSummary: 'There are no rewards to suggest right now.', templateReply: 'There are no places to suggest right now. Try again later!' };
}
