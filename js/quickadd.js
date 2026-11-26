// Quick add: turn free text like "London, Beijing, Miami, Paris Texas, Japan, Eiffel Tower"
// into logbook entries. Matches against the app's own data first; anything not found is
// looked up on OpenStreetMap's free Nominatim geocoder (no API key) and snapped to our places.
import { DATA, loadStates, loadCityIndex, loadCountryCities, fold, haversine, countryAt, stateAt, country, stateMeta } from './data.js';
import { allLandmarks } from './landmarks.js';
import { fuzzyCountries, fuzzyStates, fuzzyLandmarks, fuzzyCities, misspellingOf } from './typo.js';

const ALIASES = {
  'nyc': 'new york city', 'new york': 'new york city', 'ny': 'new york city', 'manhattan': 'new york city',
  'la': 'los angeles', 'sf': 'san francisco', 'san fran': 'san francisco', 'dc': 'washington', 'washington dc': 'washington',
  'washington d.c.': 'washington', 'vegas': 'las vegas', 'bombay': 'mumbai', 'peking': 'beijing', 'saigon': 'ho chi minh city',
  'st petersburg': 'saint petersburg', 'st. petersburg': 'saint petersburg', 'kiev': 'kyiv', 'cdmx': 'mexico city',
  'rio': 'rio de janeiro', 'philly': 'philadelphia', 'nola': 'new orleans', 'calcutta': 'kolkata', 'madras': 'chennai',
  'uk': 'united kingdom', 'great britain': 'united kingdom', 'britain': 'united kingdom', 'england': 'united kingdom',
  'scotland': 'united kingdom', 'wales': 'united kingdom', 'northern ireland': 'united kingdom',
  'usa': 'united states of america', 'us': 'united states of america', 'u.s.': 'united states of america', 'u.s.a.': 'united states of america',
  'america': 'united states of america', 'united states': 'united states of america', 'the us': 'united states of america',
  'holland': 'netherlands', 'the netherlands': 'netherlands', 'czech republic': 'czechia', 'uae': 'united arab emirates',
  'ivory coast': "côte d'ivoire", 'burma': 'myanmar', 'swaziland': 'eswatini', 'turkiye': 'turkey', 'türkiye': 'turkey',
  'drc': 'democratic republic of the congo', 'congo': 'republic of the congo', 'korea': 'south korea', 'the bahamas': 'bahamas',
  'east timor': 'timor-leste', 'vatican': 'vatican', 'vatican city': 'vatican', 'macedonia': 'north macedonia',
};
const TYPE_ICON = { country: '🏳️', state: '🗺️', city: '📍', landmark: '🏛️' };

/** Split raw text into queries. Commas separate places, except when the part after a comma
 *  narrows down the place before it: "Paris, Texas" or "Kyoto, Japan" (only if such a place exists there). */
export async function parse(text) {
  indexes();
  const byName = await cityIndex();
  const out = [];
  for (const line of text.split(/[\n;]+/)) {
    const parts = line.split(',').map(s => s.trim()).filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      const q = { text: parts[i], qual: '' };
      while (i + 1 < parts.length && narrows(byName, q.text, q.qual ? q.qual + ', ' + parts[i + 1] : parts[i + 1])) {
        q.qual = q.qual ? q.qual + ', ' + parts[i + 1] : parts[i + 1]; i++;
      }
      out.push(q);
    }
  }
  return out;
}
function narrows(byName, place, region) {
  const last = region.split(',').pop();
  if (!countryOf(last) && !stateIdx.has(raw(last))) return false;
  if (countryOf(place) && !stateIdx.has(raw(place))) return false; // "Japan, China" = two countries
  const n = norm(place);
  const rows = [...(byName.get(n) || []), ...(byName.get(n + ' city') || [])];
  if (rows.some(r => qualMatch(region, r[2], r[6]))) return true;
  if (allLandmarks().some(l => fold(l.name) === n && qualMatch(region, l.cc, ''))) return true;
  return (stateIdx.get(n) || []).some(sid => qualMatch(region, DATA.meta.states[sid].cid, ''));
}

let countryIdx = null, stateIdx = null;
function indexes() {
  if (countryIdx) return;
  countryIdx = new Map(); stateIdx = new Map();
  for (const [id, c] of Object.entries(DATA.meta.countries)) {
    for (const n of [c.name, c.long, c.sov === c.name ? '' : '', id.length === 2 ? id : '']) if (n) countryIdx.set(fold(n), id);
  }
  for (const [id, s] of Object.entries(DATA.meta.states)) {
    const k = fold(s.name);
    if (!stateIdx.has(k)) stateIdx.set(k, []);
    stateIdx.get(k).push(id);
  }
}
const raw = s => fold(s).replace(/\s+/g, ' ').trim();
const norm = s => { const f = raw(s); return ALIASES[f] ? fold(ALIASES[f]) : f; };
function countryOf(name) { indexes(); return countryIdx.get(norm(name)) || countryIdx.get(raw(name)) || null; }
function isRegion(s) { indexes(); return !!countryOf(s) || stateIdx.has(raw(s)); }
// a qualifier only binds if the first part isn't itself a country/state and the qualifier is a country/state
function qualifies(place, region) { return !!place && !!region; }

let cityIdxCache = null;
async function cityIndex() {
  if (cityIdxCache) return cityIdxCache;
  const rows = await loadCityIndex();
  const byName = new Map();
  for (const r of rows) { const k = fold(r[1]); if (!byName.has(k)) byName.set(k, []); byName.get(k).push(r); }
  return (cityIdxCache = byName);
}

function qualMatch(qual, cid, stateName) {
  if (!qual) return true;
  return qual.split(',').every(qp => {
    const q = raw(qp);
    const qc = countryOf(qp);
    if (qc && !stateIdx.has(q)) return qc === cid;
    if (qc === cid) return true;
    // a named state must match the place's own state (when we know it), not just its country
    if (stateName) return fold(stateName).includes(q);
    return (stateIdx.get(q) || []).some(sid => DATA.meta.states[sid]?.cid === cid);
  });
}

/** Local candidates for one query, best first. */
export async function resolveLocal({ text, qual }) {
  indexes();
  const q = norm(text);
  const cands = [];
  const cid = countryIdx.get(q) || (raw(text).length > 2 ? countryIdx.get(raw(text)) : null);
  if (cid && !qual) cands.push({ type: 'country', id: cid, label: country(cid).name, sub: country(cid).cont, cid, score: 100 });
  for (const l of allLandmarks()) {
    const n = fold(l.name);
    if (n === q || (q.length >= 4 && (n.startsWith(q + ' ') || n.startsWith(q))) || (q.length >= 6 && n.includes(q))) {
      if (qual && !qualMatch(qual, l.cc, '')) continue;
      cands.push({ type: 'landmark', id: l.id, label: l.name, sub: country(l.cc)?.name || '', cid: l.cc, score: n === q ? 96 : n.startsWith(q) ? 78 : 66 });
    }
  }
  for (const sid of new Set([...(stateIdx.get(q) || []), ...(stateIdx.get(raw(text)) || [])])) {
    const s = DATA.meta.states[sid];
    if (!qualMatch(qual, s.cid, s.name)) continue;
    cands.push({ type: 'state', id: sid, label: s.name, sub: `${s.type || 'Region'}, ${country(s.cid)?.name}`, cid: s.cid, score: 89.5 });
  }
  const byName = await cityIndex();
  const names = [q];
  if (!q.endsWith(' city')) names.push(q + ' city');
  if (q.startsWith('saint ')) names.push('st. ' + q.slice(6), 'st ' + q.slice(6));
  for (const n of names) for (const r of byName.get(n) || []) {
    const [gid, name, ccid, lat, lon, pop, sname] = r;
    if (!qualMatch(qual, ccid, sname)) continue;
    cands.push({ type: 'city', id: gid, label: name, sub: [sname, country(ccid)?.name].filter(Boolean).join(', '), cid: ccid,
      lat, lon, pop, score: (n === q ? 60 : 55) + Math.log10(pop + 1) * 5 });
  }
  if (!cands.length) cands.push(...await misspelled(text, q, qual));
  cands.sort((a, b) => b.score - a.score);
  const seen = new Set();
  return cands.filter(c => { const k = c.type + c.id; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 8);
}

/**
 * Nothing is spelled like this: look for places it is a misspelling of ("Madird", "Bejing", "Eifel Tower").
 * Only whole-name misspellings count, so a real but unlisted village still goes to the online lookup.
 * Scores sit below every exact match; cities are ranked by size.
 */
async function misspelled(text, q, qual) {
  if (q.replace(/ /g, '').length < 4) return [];
  const out = [], opts = { limit: 12, minScore: 0.6 };
  const ok = name => misspellingOf(q, name) || misspellingOf(text, name);
  if (!qual) for (const { item: [id, c], score } of fuzzyCountries().search(q, opts)) {
    if (ok(c.name) || ok(c.long)) out.push({ type: 'country', id, label: c.name, sub: c.cont, cid: id, score: 95 * score, typo: true });
  }
  for (const { item: l, score } of fuzzyLandmarks().search(q, opts)) {
    if (ok(l.name) && qualMatch(qual, l.cc, '')) out.push({ type: 'landmark', id: l.id, label: l.name, sub: country(l.cc)?.name || '', cid: l.cc, score: 90 * score, typo: true });
  }
  for (const { item: [sid, s], score } of fuzzyStates().search(q, opts)) {
    if (ok(s.name) && qualMatch(qual, s.cid, s.name)) out.push({ type: 'state', id: sid, label: s.name, sub: `${s.type || 'Region'}, ${country(s.cid)?.name}`, cid: s.cid, score: 80 * score, typo: true });
  }
  for (const { item: r, score } of (await fuzzyCities()).search(q, { ...opts, limit: 30 })) {
    const [gid, name, ccid, lat, lon, pop, sname] = r;
    if (ok(name) && qualMatch(qual, ccid, sname)) out.push({ type: 'city', id: gid, label: name, sub: [sname, country(ccid)?.name].filter(Boolean).join(', '), cid: ccid, lat, lon, pop, score: (55 + Math.log10(pop + 1) * 5) * score, typo: true });
  }
  return out;
}

// ---- online fallback (OpenStreetMap Nominatim, 1 request per second, no key) ----
let lastCall = 0;
async function nominatim(query) {
  const wait = Math.max(0, lastCall + 1100 - Date.now());
  if (wait) await new Promise(r => setTimeout(r, wait));
  lastCall = Date.now();
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=3&addressdetails=1&accept-language=en&q=${encodeURIComponent(query)}`;
  const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!r.ok) throw new Error('lookup failed');
  return r.json();
}

/** Look a place up online and snap it to a country / state / city in our data. */
export async function resolveOnline({ text, qual }) {
  const res = await nominatim(qual ? `${text}, ${qual}` : text);
  const out = [];
  for (const hit of res) {
    const lat = +hit.lat, lon = +hit.lon;
    const cc = (hit.address?.country_code || '').toUpperCase();
    const cid = DATA.meta.countries[cc] ? cc : countryAt(lon, lat);
    if (!cid) continue;
    const kind = hit.addresstype || hit.type;
    if (kind === 'country') { out.push({ type: 'country', id: cid, label: country(cid).name, sub: country(cid).cont, cid, score: 90, online: true }); continue; }
    if (['state', 'province', 'region', 'state_district'].includes(kind)) {
      await loadStates().catch(() => {});
      const sid = stateAt(lon, lat, cid);
      if (sid && fold(stateMeta(sid).name).includes(fold(text).slice(0, 4))) {
        out.push({ type: 'state', id: sid, label: stateMeta(sid).name, sub: country(cid).name, cid, score: 85, online: true });
      } else {
        out.push({ type: 'country', id: cid, label: country(cid).name, sub: `“${hit.name}” isn't a region on this map, so the country is logged`, cid, score: 70, online: true });
      }
      continue;
    }
    // a town / village / place: snap to the nearest place in our city list
    const d = await loadCountryCities(cid).catch(() => null);
    if (!d?.cities.length) { out.push({ type: 'country', id: cid, label: country(cid).name, sub: 'no towns listed here, so the country is logged', cid, score: 60, online: true }); continue; }
    const want = fold(hit.name || text);
    let best = null, bestNamed = null;
    for (const c of d.cities) {
      const dist = haversine(lat, lon, c[2], c[3]);
      if (!best || dist < best.dist) best = { c, dist };
      if (fold(c[1]) === want && dist < 30 && (!bestNamed || dist < bestNamed.dist)) bestNamed = { c, dist };
    }
    const pick = bestNamed || best;
    const [gid, name, clat, clon, pop, si] = pick.c;
    const sname = si >= 0 ? d.states[si][1] : '';
    out.push({ type: 'city', id: gid, label: name, cid, lat: clat, lon: clon, pop, score: bestNamed ? 88 : 72, online: true,
      sub: [sname, country(cid).name].filter(Boolean).join(', ') + (bestNamed || pick.dist < 3 ? '' : ` · nearest listed town to “${hit.name}” (${Math.round(pick.dist)} km)`) });
  }
  const seen = new Set();
  return out.filter(c => { const k = c.type + c.id; if (seen.has(k)) return false; seen.add(k); return true; });
}

export function candLabel(c) { return `${TYPE_ICON[c.type]} ${c.label}${c.sub ? ' — ' + c.sub : ''}`; }
