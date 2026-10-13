// In-memory fuzzy search for products and customers (SRCH-2, SRCH-3, SRCH-5, SRCH-8).
// Every query word must match some word of the item — as a prefix, inside a word, or
// within a small typo distance. Results are ranked by match quality and how often the
// item is used.

export interface Searchable {
  /** Words that describe the item: names, Hindi names, aliases, brand, type, category, pack size. */
  words: string[];
  /** Higher = used more often. */
  frequency?: number;
  /** Words that, when matched, count extra (the item's own name). */
  primary?: string[];
}

export function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // Latin accents (keeps Devanagari matras, which are not in this range)
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .trim();
}

export function tokenize(s: string): string[] {
  const out: string[] = [];
  for (const w of normalize(s).split(' ')) {
    if (!w) continue;
    out.push(w);
    // "1l" -> also "1", "l"; "250g" -> "250", "g"
    const m = w.match(/^(\d+(?:\.\d+)?)([a-z]+)$/);
    if (m) out.push(m[1], m[2]);
  }
  return out;
}

/** Optimal string alignment distance, capped: returns max+1 once it is exceeded. */
export function editDistance(a: string, b: string, max = 2): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev2: number[] = new Array(b.length + 1).fill(0);
  let prev: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur: number[] = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur.push(v);
      rowMin = Math.min(rowMin, v);
    }
    for (let j = 0; j <= b.length; j++) prev2[j] = prev[j];
    prev = cur;
    if (rowMin > max) return max + 1;
  }
  return prev[b.length];
}

function wordScore(q: string, w: string): number {
  if (w === q) return 10;
  if (w.startsWith(q)) return 8;
  const isNum = /^\d/.test(q);
  if (isNum) return 0; // numbers must match from the start: "1" should not find "10"... but "1" finds "1"
  if (q.length >= 3 && w.includes(q)) return 5;
  if (q.length < 4) return 0;
  const allowed = q.length >= 7 ? 2 : 1;
  // Typo against the whole word, or against the word's prefix of similar length.
  const whole = editDistance(q, w, allowed);
  if (whole <= allowed) return 4 - whole;
  if (w.length > q.length) {
    const pre = editDistance(q, w.slice(0, q.length), allowed);
    if (pre <= allowed) return 3 - pre;
  }
  return 0;
}

export function scoreItem(queryTokens: string[], item: Searchable, wordsCache?: string[]): number {
  const words = wordsCache ?? item.words.flatMap(tokenize);
  const primary = new Set((item.primary ?? []).flatMap(tokenize));
  let total = 0;
  for (const q of queryTokens) {
    let best = 0;
    for (const w of words) {
      let s = wordScore(q, w);
      if (s && primary.has(w)) s += 1;
      if (s > best) best = s;
      if (best >= 11) break;
    }
    if (best === 0) return 0;
    total += best;
  }
  return total;
}

export interface Ranked<T> {
  item: T;
  score: number;
}

export class SearchIndex<T> {
  private entries: { item: T; words: string[]; s: Searchable }[];

  constructor(items: T[], describe: (t: T) => Searchable) {
    this.entries = items.map((item) => {
      const s = describe(item);
      return { item, s, words: [...new Set(s.words.flatMap(tokenize))] };
    });
  }

  search(query: string, limit = 20): T[] {
    const q = tokenize(query);
    if (q.length === 0) return [];
    const ranked: Ranked<T>[] = [];
    for (const e of this.entries) {
      const score = scoreItem(q, e.s, e.words);
      if (score > 0) ranked.push({ item: e.item, score: score + Math.log2(1 + (e.s.frequency ?? 0)) * 0.75 });
    }
    ranked.sort((a, b) => b.score - a.score);
    return ranked.slice(0, limit).map((r) => r.item);
  }
}
