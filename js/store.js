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
  colors: { country: '#2ec4b6', state: '#ffb703', city: '#ff4d6d', landmark: '#ffd447' },
};

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
    this.settings = { ...DEFAULT_SETTINGS, ...s, colors: { ...DEFAULT_SETTINGS.colors, ...(s.colors || {}) } };
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
