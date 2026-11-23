// Typo-tolerant search for places, on top of the shared js/fuzzy.js. Every search box first matches
// the way it always did; when that finds nothing (or very little) these helpers add the places the
// person most likely meant: "madid" and "madird" find Madrid, "frnace" finds France.
// Indexes are built the first time they are needed, never at startup.
import { createFuzzyIndex, foldText, editDistance, wordScore } from './fuzzy.js';
import { DATA, loadCityIndex } from './data.js';
import { LANDMARKS } from './landmarks.js';

let countries = null, states = null, landmarks = null, cities = null;

/** Items are [id, country] pairs from DATA.meta.countries. */
export function fuzzyCountries() {
  return countries ||= createFuzzyIndex(Object.entries(DATA.meta.countries), ([, c]) => [c.name, c.long], { weight: ([, c]) => c.pop || 0 });
}
/** Items are [id, state] pairs from DATA.meta.states. */
export function fuzzyStates() {
  return states ||= createFuzzyIndex(Object.entries(DATA.meta.states), ([, s]) => s.name, { weight: ([, s]) => DATA.meta.countries[s.cid]?.pop || 0 });
}
export function fuzzyLandmarks() {
  return landmarks ||= createFuzzyIndex(LANDMARKS, l => l.name);
}
/** The global city list (every city of 15,000+ people); items are its rows [gid, name, cid, lat, lon, pop, stateName]. Bigger cities first. */
export async function fuzzyCities() {
  return cities ||= createFuzzyIndex(await loadCityIndex(), r => r[1], { weight: r => r[5] || 0 });
}

const perList = new WeakMap();
/**
 * Typo-tolerant matches in any list (a country's towns, its regions…), best first. The index is kept
 * for as long as the list itself is.
 */
export function fuzzyIn(list, textOf, query, { weight, limit = 40, minScore = 0.5 } = {}) {
  let index = perList.get(list);
  if (!index) perList.set(list, index = createFuzzyIndex(list, textOf, weight ? { weight } : {}));
  return index.search(query, { limit, minScore }).map(r => r.item);
}

const FILLER = new Set(['the', 'of', 'city', 'de', 'la', 'le', 'du', 'el', 'and']);
/**
 * Is `typed` a misspelling of the whole of `name`? Stricter than a search-box match: a list of finished
 * names ("Madird, Bejing") must not turn "Bali" into "Balikpapan" just because one starts like the other.
 */
export function misspellingOf(typed, name) {
  const tw = foldText(typed).split(' ').filter(Boolean), nw = foldText(name).split(' ').filter(Boolean);
  if (!tw.length || !nw.length) return false;
  if (tw.join('') === nw.join('')) return true;
  const same = (a, b) => {
    if (a === b) return true;
    const max = a.length <= 3 ? 0 : a.length <= 5 ? 1 : 2;
    return max > 0 && a[0] === b[0] && editDistance(a, b, max) <= max;
  };
  const left = [...nw];
  for (const w of tw) {
    const i = left.findIndex(x => same(w, x));
    if (i < 0) { if (FILLER.has(w)) continue; return false; }
    left.splice(i, 1);
  }
  return left.every(w => FILLER.has(w));
}

/** Do all the typed words loosely match words in this (already folded) text? For small on-screen lists. */
export function looselyIn(query, foldedText) {
  const tw = foldText(query).split(' ').filter(Boolean), words = foldText(foldedText).split(' ');
  return tw.length > 0 && tw.every(t => words.some(w => wordScore(t, w) >= 0.6));
}
