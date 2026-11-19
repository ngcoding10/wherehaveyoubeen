// Logbook store: every visited place is an item keyed by type, with a timestamp.
// Removals are kept as tombstones so two devices can merge without resurrecting deleted places.
//   c:<countryId>   s:<stateId>   ci:<geonameId>   l:<landmarkId>
const LS_KEY = 'whyb.logbook.v1';
const LS_SETTINGS = 'whyb.settings.v1';

export const DEFAULT_SETTINGS = {
  theme: 'midnight',
  projection: 'globe',
  autoParents: true,
  showLandmarks: true,
  showWishlist: true,
  colors: { country: '#3b82f6', state: '#22c55e', city: '#facc15', landmark: '#ff8a3d', wish: '#e879f9' },
};
// colours from the first version; anyone still on them gets the new scheme automatically
const OLD_DEFAULT_COLORS = { country: '#2ec4b6', state: '#ffb703', city: '#ff4d6d', landmark: '#ffd447' };

function emptyBook() { return { items: {}, removed: {}, home: null, updated: 0 }; }

function safeRead(key) {
  try { const s = localStorage.getItem(key); return s ? JSON.parse(s) : null; } catch { return null; }
}
function safeWrite(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* private mode */ } }

class Store extends EventTarget {
  constructor() {
    super();
    this.book = Object.assign(emptyBook(), safeRead(LS_KEY) || {});
    const s = safeRead(LS_SETTINGS) || {};
    const saved = { ...(s.colors || {}) };
    for (const k of Object.keys(OLD_DEFAULT_COLORS)) if ((saved[k] || '').toLowerCase() === OLD_DEFAULT_COLORS[k]) delete saved[k];
    this.settings = { ...DEFAULT_SETTINGS, ...s, colors: { ...DEFAULT_SETTINGS.colors, ...saved } };
    this.resolve = { stateCountry: () => null, landmarkCountry: () => null };
    this._derived = null;
  }
  // ---- queries ----
  has(key) { return !!this.book.items[key]; }
  get(key) { return this.book.items[key]; }
  keys(prefix) { return Object.keys(this.book.items).filter(k => k.startsWith(prefix)).map(k => k.slice(prefix.length)); }
  entries(prefix) { return Object.entries(this.book.items).filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k.slice(prefix.length), v]); }
  countries() { return this.keys('c:'); }
  states() { return this.keys('s:'); }
  cities() { return this.entries('ci:'); }
  landmarks() { return this.keys('l:'); }

  // ---- visited = logged directly OR implied by something logged inside it ----
  /** e.g. logging a city also lights up its state and country on the map */
  derived() {
    if (this._derived) return this._derived;
    const states = new Set(this.states()), countries = new Set(this.countries());
    const impliedStates = new Set(), impliedCountries = new Set();
    for (const [, c] of this.cities()) {
      if (c.s && !states.has(c.s)) impliedStates.add(c.s);
      if (c.c && !countries.has(c.c)) impliedCountries.add(c.c);
    }
    for (const sid of [...states, ...impliedStates]) { const cid = this.resolve.stateCountry(sid); if (cid && !countries.has(cid)) impliedCountries.add(cid); }
    for (const lid of this.landmarks()) { const cid = this.resolve.landmarkCountry(lid); if (cid && !countries.has(cid)) impliedCountries.add(cid); }
    return (this._derived = { states: [...states, ...impliedStates], countries: [...countries, ...impliedCountries], impliedStates, impliedCountries });
  }
  visitedStates() { return this.derived().states; }
  visitedCountries() { return this.derived().countries; }
  /** true if logged directly, or (for countries/states) implied by a city/wonder/state inside it */
  isVisited(key) {
    if (this.has(key)) return true;
    if (key.startsWith('s:')) return this.derived().impliedStates.has(key.slice(2));
    if (key.startsWith('c:')) return this.derived().impliedCountries.has(key.slice(2));
    return false;
  }
  isImpliedOnly(key) { return !this.has(key) && this.isVisited(key); }

  // ---- wishlist: same keys as the logbook, prefixed with "w:" (e.g. "w:c:JP", "w:ci:1850147") ----
  wishEntries() { return this.entries('w:'); }               // [[innerKey, data]]
  isWished(key) { return this.has('w:' + key); }
  toggleWish(key, data = {}) {
    if (this.isWished(key)) { this.remove('w:' + key); return false; }
    this.set('w:' + key, data); return true;
  }

  // ---- mutations ----
  set(key, data = {}, { silent } = {}) {
    const now = Date.now();
    const prev = this.book.items[key];
    this.book.items[key] = { ...(prev || {}), ...data, t: prev?.t || now, m: now };
    delete this.book.removed[key];
    if (!silent) this._changed([key]);
  }
  remove(key, { silent } = {}) {
    if (!this.book.items[key]) return;
    delete this.book.items[key];
    this.book.removed[key] = Date.now();
    if (!silent) this._changed([key]);
  }
  toggle(key, data, parents = []) {
    if (this.has(key)) { this.remove(key); return false; }
    this.set(key, data, { silent: true });
    const changed = [key];
    if (this.settings.autoParents) {
      for (const [pk, pdata] of parents) if (pk && !this.has(pk)) { this.set(pk, pdata || {}, { silent: true }); changed.push(pk); }
    }
    this._changed(changed);
    return true;
  }
  /** Add many places at once (never removes). entries: [[key, data, parents]] → number newly added */
  addMany(entries) {
    const changed = [];
    for (const [key, data, parents = []] of entries) {
      if (!this.has(key)) { this.set(key, data, { silent: true }); changed.push(key); }
      if (this.settings.autoParents) for (const [pk, pdata] of parents) if (pk && !this.has(pk)) { this.set(pk, pdata || {}, { silent: true }); changed.push(pk); }
    }
    if (changed.length) this._changed(changed);
    return changed.length;
  }
  setHome(home) { this.book.home = home ? { ...home, m: Date.now() } : { cleared: true, m: Date.now() }; this._changed(['home']); }
  get home() { return this.book.home && !this.book.home.cleared ? this.book.home : null; }

  setSetting(path, value) {
    if (path.startsWith('colors.')) this.settings.colors[path.slice(7)] = value;
    else this.settings[path] = value;
    safeWrite(LS_SETTINGS, this.settings);
    this.dispatchEvent(new CustomEvent('settings', { detail: { path, value } }));
  }

  _changed(keys) {
    this._derived = null;
    this.book.updated = Date.now();
    safeWrite(LS_KEY, this.book);
    this.dispatchEvent(new CustomEvent('change', { detail: { keys } }));
  }

  // ---- sync helpers ----
  snapshot() { return JSON.parse(JSON.stringify(this.book)); }
  /** Merge another logbook into this one (last-write-wins per key, tombstones respected). */
  merge(other, { silent } = {}) {
    if (!other) return false;
    const a = this.book, b = { ...emptyBook(), ...other };
    let changed = false;
    const keys = new Set([...Object.keys(a.items), ...Object.keys(a.removed), ...Object.keys(b.items || {}), ...Object.keys(b.removed || {})]);
    for (const k of keys) {
      const ta = Math.max(a.items[k]?.m || a.items[k]?.t || 0, a.removed[k] || 0);
      const tb = Math.max(b.items[k]?.m || b.items[k]?.t || 0, b.removed[k] || 0);
      if (tb <= ta) continue;
      changed = true;
      if (b.items[k] && (b.items[k].m || b.items[k].t || 0) >= (b.removed[k] || 0)) { a.items[k] = b.items[k]; delete a.removed[k]; }
      else { delete a.items[k]; a.removed[k] = b.removed[k]; }
    }
    if (b.home && (!a.home || (b.home.m || 0) > (a.home.m || 0))) { a.home = b.home; changed = true; }
    if (changed) {
      this._derived = null;
      a.updated = Date.now();
      safeWrite(LS_KEY, a);
      if (!silent) this.dispatchEvent(new CustomEvent('change', { detail: { keys: ['*'] } }));
    }
    return changed;
  }
  replaceAll(book) { this.book = { ...emptyBook(), ...book }; this._changed(['*']); }
  clear() {
    const now = Date.now();
    for (const k of Object.keys(this.book.items)) this.book.removed[k] = now;
    this.book.items = {};
    this._changed(['*']);
  }
}

export const store = new Store();
