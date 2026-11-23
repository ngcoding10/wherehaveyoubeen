// fuzzy.js — typo-tolerant search, shared by every app. Copy this file into an app unchanged
// (see docs/STANDARD.md); edit it here and copy again.
//
// People don't spell perfectly: "avenjers", "avgenrs", "madird", "xantham gum" should still find
// Avengers, Madrid and xanthan gum. Use it as the fallback when an app's normal search finds
// little or nothing:
//
//   const index = createFuzzyIndex(films, (f) => [f.title, ...f.otherNames], { weight: (f) => f.popularity });
//   const results = index.search("avgenrs", { limit: 10 });   // -> [{ item, score }, ...] best first
//
// It needs no server and no library, and builds its word list the first time it is used.
export const FUZZY_VERSION = '1.0.0';

/** Lower-case, strip accents and apostrophes, turn everything else that isn't a letter or digit into a space. */
export function foldText(s) {
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/['’`]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
}

/** How many typos a word of this length may have. */
const allowedEdits = (len) => (len <= 3 ? 0 : len <= 5 ? 1 : 2);

/**
 * Edit distance where a swap of two neighbouring letters counts as one mistake.
 * Gives up early and returns max + 1 once the distance must exceed `max`.
 */
export function editDistance(a, b, max = 2) {
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > max) return max + 1;
  if (a === b) return 0;
  let prev2 = null, prev = new Array(lb + 1), cur = new Array(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    cur[0] = i;
    let best = cur[0];
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= lb; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (prev2 && i > 1 && j > 1 && ca === b.charCodeAt(j - 2) && a.charCodeAt(i - 2) === b.charCodeAt(j - 1)) v = Math.min(v, prev2[j - 2] + 1);
      cur[j] = v;
      if (v < best) best = v;
    }
    if (best > max) return max + 1;
    const spare = prev2 || new Array(lb + 1);
    prev2 = prev; prev = cur; cur = spare;
  }
  return prev[lb];
}

/** Share of letter pairs two words have in common (0–1). Catches scrambles like "avgenrs". */
function pairOverlap(a, b) {
  const pairs = (w) => { const p = `^${w}$`, out = []; for (let i = 0; i < p.length - 1; i++) out.push(p.slice(i, i + 2)); return out; };
  const pa = pairs(a), pb = pairs(b);
  const left = new Map();
  for (const p of pb) left.set(p, (left.get(p) || 0) + 1);
  let common = 0;
  for (const p of pa) { const n = left.get(p); if (n) { common++; left.set(p, n - 1); } }
  return (2 * common) / (pa.length + pb.length);
}

/**
 * How well a typed word matches a real word, 0 (not at all) to 1 (exactly).
 * Understands: exact, still-typing (prefix), a typo or two, a typo while still typing, and scrambles.
 */
export function wordScore(typed, word) {
  if (typed === word) return 1;
  const lt = typed.length, lw = word.length;
  if (lt >= 2 && lw > lt && word.startsWith(typed)) return 0.92 - Math.min(0.12, (lw - lt) * 0.01);
  const max = allowedEdits(lt);
  if (!max) return 0;
  const sameStart = typed.charCodeAt(0) === word.charCodeAt(0);
  if (Math.abs(lt - lw) <= max) {
    const d = editDistance(typed, word, max);
    if (d <= max) return (d === 1 ? 0.8 : 0.66) - (sameStart ? 0 : 0.08);
  }
  // a typo in a word they haven't finished typing: compare with the start of the real word
  if (sameStart && lt >= 4 && lw > lt + 1) {
    const d = Math.min(editDistance(typed, word.slice(0, lt), 1), editDistance(typed, word.slice(0, lt + 1), 1));
    if (d <= 1) return 0.6;
  }
  // scrambled letters ("avgenrs"): same first letter, similar length, most letter pairs shared
  if (sameStart && lt >= 5 && Math.abs(lt - lw) <= 2) {
    const o = pairOverlap(typed, word);
    if (o >= 0.5) return 0.3 + 0.4 * o;
  }
  return 0;
}

/**
 * @param {Array} items
 * @param {(item) => string | string[]} textsOf  the name(s) an item can be found by
 * @param {{ weight?: (item) => number }} [o]  tie-breaker: higher comes first (e.g. popularity, population)
 */
export function createFuzzyIndex(items, textsOf, { weight = () => 0 } = {}) {
  let vocab = null;       // word -> array of item positions
  let words = null;       // all words, for scanning
  const cache = new Map(); // typed word -> Map(item position -> score)

  function build() {
    vocab = new Map();
    const add = (word, i) => {
      if (!word) return;
      const list = vocab.get(word);
      if (!list) vocab.set(word, [i]);
      else if (list[list.length - 1] !== i) list.push(i);
    };
    for (let i = 0; i < items.length; i++) {
      const texts = textsOf(items[i]);
      for (const t of Array.isArray(texts) ? texts : [texts]) {
        const folded = foldText(t);
        if (!folded) continue;
        const parts = folded.split(' ');
        for (const p of parts) add(p, i);
        // "spiderman" should find "Spider-Man", "starwars" should find "Star Wars"
        if (parts.length > 1 && folded.length <= 28) add(parts.join(''), i);
      }
    }
    words = [...vocab.keys()];
  }

  function matchesFor(typed) {
    let hit = cache.get(typed);
    if (hit) return hit;
    hit = new Map();
    const scored = [];
    for (const w of words) {
      const s = wordScore(typed, w);
      if (s > 0) scored.push([s, w]);
    }
    scored.sort((a, b) => b[0] - a[0]);
    // the closest real words; enough to cover a common prefix without flooding the results
    for (const [s, w] of scored.slice(0, 60)) {
      for (const i of vocab.get(w)) if ((hit.get(i) || 0) < s) hit.set(i, s);
    }
    if (cache.size > 200) cache.clear();
    cache.set(typed, hit);
    return hit;
  }

  return {
    /** Number of distinct words known (builds the index if needed). */
    get size() { if (!vocab) build(); return words.length; },
    /**
     * @param {string} query
     * @param {{ limit?: number, filter?: (item) => boolean, minScore?: number }} [o]
     * @returns {Array<{ item, score: number }>} best first; score 1 = every word matched exactly
     */
    search(query, { limit = 20, filter = null, minScore = 0.3 } = {}) {
      if (!vocab) build();
      const typed = foldText(query).split(' ').filter(Boolean);
      if (!typed.length) return [];
      // Short filler words must not sink a query ("lord of teh rings"): they help the score but are not required.
      const required = typed.filter((w) => w.length > 3);
      const need = required.length ? required : typed;
      const per = new Map(typed.map((w) => [w, matchesFor(w)]));
      const smallest = need.map((w) => per.get(w)).sort((a, b) => a.size - b.size)[0];
      const out = [];
      for (const i of smallest.keys()) {
        let total = 0, ok = true;
        for (const w of typed) {
          const s = per.get(w).get(i) || 0;
          if (!s && need.includes(w)) { ok = false; break; }
          total += s;
        }
        if (!ok) continue;
        const score = total / typed.length;
        if (score < minScore) continue;
        const item = items[i];
        if (filter && !filter(item)) continue;
        out.push({ item, score, w: weight(item) });
      }
      // Rank in broad bands (exact, nearly right, a guess) and let the app's own weight (popularity,
      // population) order items inside a band: for "avgenrs" the famous Avengers beat an obscure "Agents".
      const band = (x) => (x >= 0.999 ? 6 : Math.round(x * 5));
      out.sort((a, b) => band(b.score) - band(a.score) || b.w - a.w || b.score - a.score);
      return out.slice(0, limit).map(({ item, score }) => ({ item, score }));
    },
  };
}
