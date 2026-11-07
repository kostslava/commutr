// Local fuzzy FAQ matching. No API calls; runs in well under a millisecond.
//
// 1. Normalise: lowercase, expand contractions, strip punctuation, light stemming,
//    synonyms, drop filler words.
// 2. Fix typos against the FAQ's own vocabulary (1 edit for 4-6 letter words,
//    2 edits for 7+).
// 3. Score each stored wording with a weighted Dice overlap (rare words weigh
//    more; unknown words weigh the most, so off-topic messages score low).
// Thresholds live in config.ts.

import { FAQ_AMBIGUOUS_MARGIN, FAQ_AMBIGUOUS_MIN, FAQ_MATCH_THRESHOLD } from './config.js';
import { FAQ, type FaqEntry } from './faq.js';

const CONTRACTIONS: [RegExp, string][] = [
  [/\bcan't\b|\bcant\b|\bcannot\b/g, 'can not'],
  [/\bwon't\b|\bwont\b/g, 'will not'],
  [/n't\b/g, ' not'],
  [/'re\b/g, ' are'],
  [/'s\b/g, ' is'],
  [/'m\b/g, ' am'],
  [/'ll\b/g, ' will'],
  [/'ve\b/g, ' have'],
  [/'d\b/g, ' would'],
];

const STOPWORDS = new Set(
  'a an the i me my mine is are was were be been do does did how what why when where which who can could would should will shall to of in on at for it its you your and or so if this that these those with about am please tell know just any some there their them get got really very much one'.split(' '),
);

const SYNONYMS: Record<string, string> = {
  pt: 'point', pts: 'point', ecoscore: 'eco', green: 'eco', environmental: 'eco',
  redemption: 'redeem', claim: 'redeem', spend: 'redeem',
  bicycle: 'bike', bicycl: 'bike', cycl: 'bike', cyclist: 'bike', biking: 'bike', bik: 'bike',
  walking: 'walk', walked: 'walk', foot: 'walk', jog: 'run', jogging: 'run', running: 'run',
  driving: 'car', drive: 'car', drove: 'car', driv: 'car', automobile: 'car',
  buse: 'bus', busse: 'bus', lrt: 'ion', train: 'ion', transit: 'transit', grt: 'grt',
  streak: 'streak', club: 'club', team: 'club', group: 'club',
  journey: 'trip', commute: 'trip', ride: 'trip', travel: 'trip', record: 'track', log: 'track',
  unlock: 'lock', locked: 'lock', unlocked: 'lock', lock: 'lock',
  cost: 'price', fare: 'price', ticket: 'price',
  hello: 'hi', hey: 'hi', hiya: 'hi', thank: 'thanks', thx: 'thanks', cheer: 'thanks',
  km: 'kilometre', kilometer: 'kilometre', kms: 'kilometre', distanc: 'distance',
  favorite: 'favourite', fave: 'favourite',
};

function stem(w: string): string {
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

/** Normalised content words of a message. */
export function normalise(text: string): string[] {
  let t = text.toLowerCase().replace(/[’‘`]/g, "'");
  for (const [re, rep] of CONTRACTIONS) t = t.replace(re, rep);
  t = t.replace(/[^a-z0-9\s]/g, ' ');
  const out: string[] = [];
  for (const raw of t.split(/\s+/)) {
    if (!raw || STOPWORDS.has(raw)) continue;
    const w = SYNONYMS[raw] ?? SYNONYMS[stem(raw)] ?? stem(raw);
    if (!STOPWORDS.has(w)) out.push(w);
  }
  return out;
}

// --- Index built once at startup ------------------------------------------------

type Wording = { entry: FaqEntry; tokens: Set<string> };
const wordings: Wording[] = FAQ.flatMap((entry) => entry.questions.map((q) => ({ entry, tokens: new Set(normalise(q)) })));
const docFreq = new Map<string, number>();
for (const w of wordings) for (const t of w.tokens) docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
const vocab = [...docFreq.keys()];
const N = wordings.length;
const idf = (t: string) => Math.log(1 + N / (docFreq.get(t) ?? 0.5)); // unknown words weigh the most

// Exact phrases first: catches wordings made only of filler words ("who are you").
const phrase = (text: string) => {
  let t = text.toLowerCase().replace(/[’‘`]/g, "'");
  for (const [re, rep] of CONTRACTIONS) t = t.replace(re, rep);
  return t.replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
};
const exact = new Map<string, FaqEntry>();
for (const entry of FAQ) for (const q of entry.questions) if (!exact.has(phrase(q))) exact.set(phrase(q), entry);

/** Damerau-Levenshtein distance with an early exit above `max`. */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    let rowMin = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2]![j - 2]! + 1);
      d[i]![j] = v;
      rowMin = Math.min(rowMin, v);
    }
    if (rowMin > max) return max + 1;
  }
  return d[a.length]![b.length]!;
}

/** Replace unknown words with the closest FAQ word (typo fix). */
function correct(tokens: string[]): string[] {
  return tokens.map((t) => {
    if (docFreq.has(t) || t.length < 4 || /\d/.test(t)) return t;
    const max = t.length >= 7 ? 2 : 1;
    let best = t, bestD = max + 1, bestF = 0;
    for (const v of vocab) {
      const dist = editDistance(t, v, max);
      const f = docFreq.get(v)!;
      if (dist < bestD || (dist === bestD && f > bestF)) [best, bestD, bestF] = [v, dist, f];
    }
    return bestD <= max ? best : t;
  });
}

function score(input: Set<string>, w: Set<string>): number {
  let common = 0, a = 0, b = 0;
  for (const t of input) {
    a += idf(t);
    if (w.has(t)) common += idf(t);
  }
  for (const t of w) b += idf(t);
  return a + b === 0 ? 0 : (2 * common) / (a + b);
}

export type FaqMatch = { entry: FaqEntry; score: number };

/** Best FAQ match, or null if nothing is close enough (the message goes to Gemini). */
export function matchFaq(message: string): FaqMatch | null {
  const hit = exact.get(phrase(message));
  if (hit) return { entry: hit, score: 1 };

  const tokens = new Set(correct(normalise(message)));
  if (tokens.size === 0) return null;

  // Best score per entry (an entry has several wordings).
  const perEntry = new Map<string, FaqMatch>();
  for (const w of wordings) {
    const s = score(tokens, w.tokens);
    const prev = perEntry.get(w.entry.id);
    if (!prev || s > prev.score) perEntry.set(w.entry.id, { entry: w.entry, score: s });
  }
  const ranked = [...perEntry.values()].sort((x, y) => y.score - x.score);
  const [best, second] = ranked;
  if (!best || best.score < FAQ_MATCH_THRESHOLD) return null;
  if (second && best.score - second.score < FAQ_AMBIGUOUS_MARGIN && best.score < FAQ_AMBIGUOUS_MIN) return null;
  return { entry: best.entry, score: Math.round(best.score * 1000) / 1000 };
}

/** For tests: the top few entries with scores. */
export function rankFaq(message: string, n = 3): FaqMatch[] {
  const tokens = new Set(correct(normalise(message)));
  const perEntry = new Map<string, FaqMatch>();
  for (const w of wordings) {
    const s = score(tokens, w.tokens);
    const prev = perEntry.get(w.entry.id);
    if (!prev || s > prev.score) perEntry.set(w.entry.id, { entry: w.entry, score: Math.round(s * 1000) / 1000 });
  }
  return [...perEntry.values()].sort((x, y) => y.score - x.score).slice(0, n);
}
