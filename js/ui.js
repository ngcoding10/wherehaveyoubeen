// Everything outside the map canvas: panels, popups, search, passport, stats, settings, account.
import { store, DEFAULT_SETTINGS } from './store.js';
import { loadStates, DATA, UN195, country, stateMeta, loadCountryCities, loadCityIndex, flagHTML, fold, haversine, countryAt, stateAt, fmtPop, esc } from './data.js';
import { LANDMARKS, LANDMARK_BY_ID, CATEGORIES } from './landmarks.js';
import { renderSprite, renderIcon } from './sprites.js';
import { THEMES, worldZoom } from './map.js';
import { cloud, signIn, signOutUser } from './cloud.js';
import { parse as parseQuick, resolveLocal, resolveOnline, candLabel } from './quickadd.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const CONTINENTS = ['Africa', 'Asia', 'Europe', 'North America', 'South America', 'Oceania', 'Antarctica'];
const RANKS = [[0, 'Armchair Explorer', 'Every journey starts with one click.'], [1, 'Day Tripper', 'The passport has its first stamp.'],
  [3, 'Tourist', 'You know where the good snacks are.'], [6, 'Traveler', 'Packing is muscle memory now.'], [12, 'Explorer', 'Off the beaten path.'],
  [25, 'Globetrotter', 'Jet lag is a lifestyle.'], [50, 'Voyager', 'A quarter of the planet!'], [80, 'World Nomad', 'Home is wherever the Wi-Fi is.'],
  [120, 'Legend', 'Airlines know you by name.'], [195, 'Completionist', 'You have been everywhere, man.']];
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

export class UI {
  constructor(map) {
    this.map = map;
    this.tab = 'explore';
    this.sel = null;
    this.lmFilter = 'all';
    this.cityLookup = new Map();
    this.stateLmCache = new Map();
  }

  start() {
    this.applyCSSColors();
    this.drawChrome();
    this.wireTop();
    this.wireTabs();
    this.wireControls();
    this.wireSheets();
    this.wireMap();
    this.renderRibbon();
    this.renderLegend();
    this.renderPanel();
    store.addEventListener('change', e => this.onStoreChange(e.detail.keys));
    store.addEventListener('settings', e => this.onSettings(e.detail.path));
    cloud.addEventListener('user', () => { this.renderAccountBtn(); if (!$('#account-sheet').hidden) this.renderAccount(); });
    cloud.addEventListener('status', () => { this.renderAccountBtn(); if (!$('#account-sheet').hidden) this.renderAccount(); });
    this.renderAccountBtn();
    if (store.home) this.map.setMarker('home', [store.home.lon, store.home.lat], 'Home: ' + store.home.label);
  }

  // ───────────────────────── chrome ─────────────────────────
  drawChrome() {
    const plane = renderIcon('plane', '#fff', 4);
    for (const id of ['brand-plane']) { const c = $('#' + id); const ctx = c.getContext('2d'); ctx.imageSmoothingEnabled = false; ctx.clearRect(0, 0, c.width, c.height); ctx.drawImage(plane, 0, 0, c.width, c.height); }
    // pixel starfield
    const s = document.createElement('canvas'); s.width = s.height = 320;
    const x = s.getContext('2d');
    let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 90; i++) { x.fillStyle = ['#ffffff', '#ffe9a8', '#a8d8ff'][i % 3]; const sz = rnd() < 0.15 ? 2 : 1; x.globalAlpha = 0.4 + rnd() * 0.6; x.fillRect(Math.floor(rnd() * 320), Math.floor(rnd() * 320), sz, sz); }
    document.documentElement.style.setProperty('--starfield', `url(${s.toDataURL()})`);
  }

  applyCSSColors() {
    const C = store.settings.colors, r = document.documentElement.style;
    for (const k of ['country', 'state', 'city', 'landmark']) r.setProperty('--c-' + k, C[k]);
    document.documentElement.dataset.theme = store.settings.theme;
    $('meta[name=theme-color]').content = (THEMES[store.settings.theme] || THEMES.midnight).ocean;
    $$('#proj-toggle button').forEach(b => b.classList.toggle('active', b.dataset.proj === store.settings.projection));
  }

  toast(html, ms = 2600) {
    const t = $('#toast'); t.innerHTML = html; t.classList.add('show');
    clearTimeout(this._tt); this._tt = setTimeout(() => t.classList.remove('show'), ms);
  }

  // ───────────────────────── wiring ─────────────────────────
  wireTop() {
    $$('#proj-toggle button').forEach(b => b.onclick = () => { store.setSetting('projection', b.dataset.proj); });
    $('#theme-btn').onclick = () => this.openTheme();
    $('#quick-btn').onclick = () => this.openQuick();
    $('#account-btn').onclick = () => this.openAccount();
    this.wireSearch();
  }
  wireTabs() {
    $$('.tabs button').forEach(b => b.onclick = () => this.setTab(b.dataset.tab));
    $('#panel-grip').onclick = () => {
      const p = $('#panel');
      if (p.classList.contains('min')) p.classList.remove('min');
      else if (p.classList.contains('max')) { p.classList.remove('max'); p.classList.add('min'); }
      else p.classList.add('max');
    };
  }
  setTab(tab) {
    this.tab = tab;
    $$('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    $('#panel').classList.remove('min');
    this.renderPanel(true);
  }
  wireControls() {
    const m = this.map.map;
    $('#zoom-in').onclick = () => m.zoomIn();
    $('#zoom-out').onclick = () => m.zoomOut();
    $('#reset-view').onclick = () => m.flyTo({ center: [10, 25], zoom: worldZoom(store.settings.projection, this.map.container), speed: 1.6 });
    $('#locate').onclick = () => this.locate();
    const lmBtn = $('#toggle-lm');
    const syncLm = () => { const on = store.settings.showLandmarks !== false; lmBtn.classList.toggle('off', !on); lmBtn.setAttribute('aria-pressed', on); lmBtn.title = on ? 'Hide wonders' : 'Show wonders'; };
    syncLm();
    lmBtn.onclick = () => {
      store.setSetting('showLandmarks', store.settings.showLandmarks === false);
      syncLm();
      this.toast(store.settings.showLandmarks ? '🏛️ Wonders shown (zoom in a little to see them)' : '🏛️ Wonders hidden');
    };
    $('#go-home').onclick = () => {
      const h = store.home;
      if (!h) return this.toast('No home base yet — tap <b>📍</b> to find yourself, then “Set as home”.');
      this.map.flyTo(h.lon, h.lat, 9);
    };
  }
  wireMap() {
    const M = this.map;
    M.addEventListener('select', e => { const d = e.detail; this.select(d.type, d.id, { lngLat: d.lngLat, props: d.props }); });
    M.addEventListener('blank', () => { M.closePopup(); });
    M.addEventListener('marker', e => { if (e.detail.kind === 'home') this.homePopup(); else this.locate(true); });
    const tip = $('#hover-tip');
    M.addEventListener('hover', e => {
      const d = e.detail;
      if (!d.point || !d.country) { tip.hidden = true; return; }
      const f = d.feature;
      let name, sub = '';
      if (f?.layer.id === 'landmarks') { name = f.properties.name; sub = store.has('l:' + f.properties.id) ? '★ collected' : CATEGORIES[f.properties.cat]; }
      else if (f) { name = f.properties.n; sub = store.has('ci:' + f.properties.id) ? '✓ been here' : 'city'; }
      else if (d.state) { const s = stateMeta(d.state); name = s?.name; sub = country(d.country)?.name + (store.has('s:' + d.state) ? ' · ✓' : ''); }
      else { name = country(d.country)?.name; sub = store.has('c:' + d.country) ? '✓ visited' : ''; }
      tip.innerHTML = `${esc(name)}<small>${esc(sub)}</small>`;
      const r = M.container.getBoundingClientRect();
      tip.style.left = r.left + d.point.x + 'px'; tip.style.top = r.top + d.point.y + 'px';
      tip.hidden = false;
    });
  }

  // ───────────────────────── store events ─────────────────────────
  onStoreChange(keys) {
    this.map.refreshVisited();
    this.renderRibbon();
    if (this._suppressPanel) { this._suppressPanel = false; this.updateExploreCounts(); return; }
    this.renderPanel();
    if (this.sel && this.map.popup?.isOpen()) this.refreshPopup();
    if (keys.includes('home') || keys.includes('*')) {
      const h = store.home;
      this.map.setMarker('home', h ? [h.lon, h.lat] : null, h ? 'Home: ' + h.label : '');
    }
  }
  onSettings(path) {
    this.applyCSSColors();
    if (path === 'theme') this.map.applyTheme();
    if (path === 'projection') this.map.applyProjection();
    if (path === 'showLandmarks') this.map.applyLandmarkVisibility();
    if (path.startsWith('colors')) { this.map.refreshColors(); this.renderLegend(); this.renderRibbon(); }
    if (!$('#theme-sheet').hidden) this.renderThemeSheet();
  }

  // ───────────────────────── selection ─────────────────────────
  async select(type, id, { lngLat, fly, props, noPopup } = {}) {
    this.sel = { type, id };
    this.map.setSelection(this.sel);
    let info;
    try { info = await this.describe(type, id, props); } catch (e) { console.warn(e); return; }
    if (!info) return;
    this.sel.info = info;
    if (fly) this.flyToSel();
    const at = lngLat || info.lngLat;
    const phone = window.innerWidth <= 820;
    if (phone) { this.map.closePopup(); if (this.tab !== 'explore') { this.setTab('explore'); } $('#panel').classList.remove('min'); }
    else if (!noPopup && at) this.map.showPopup(at, this.popupHTML(), el => this.wirePopup(el));
    if (this.tab !== 'explore' && fly) this.setTab('explore');
    else if (this.tab === 'explore') this.renderPanel(true);
  }
  flyToSel() {
    const { type, info } = this.sel;
    if (type === 'country') this.map.fitBBox(info.meta.bbox);
    else if (type === 'state') this.map.fitBBox(info.meta.bbox, { maxZoom: 7.5 });
    else this.map.flyTo(info.lngLat[0], info.lngLat[1], type === 'landmark' ? 9 : 9.5);
  }
  refreshPopup() {
    const el = this.map.popup?.getElement(); if (!el) return;
    this.map.popup.setHTML(this.popupHTML());
    this.wirePopup(this.map.popup.getElement());
  }

  /** Normalise any place into {key, name, sub, lngLat, toggleData, parents, ...}. */
  async describe(type, id, props) {
    if (type === 'country') {
      const c = country(id); if (!c) return null;
      return { key: 'c:' + id, cid: id, name: c.name, sub: [c.sub || c.cont, c.sov !== c.name && c.type !== 'Sovereign country' ? `${c.type} · ${c.sov}` : ''].filter(Boolean).join(' · '),
        meta: c, lngLat: c.label, data: {}, parents: [] };
    }
    if (type === 'state') {
      const s = stateMeta(id); if (!s) return null;
      return { key: 's:' + id, cid: s.cid, name: s.name, sub: `${s.type || 'Region'} · ${country(s.cid)?.name}`, meta: s, lngLat: s.label,
        data: { c: s.cid }, parents: [['c:' + s.cid, {}]] };
    }
    if (type === 'landmark') {
      const l = LANDMARK_BY_ID[id]; if (!l) return null;
      await loadStates().catch(() => {});
      const sid = stateAt(l.lon, l.lat, l.cc);
      return { key: 'l:' + id, cid: l.cc, sid, name: l.name, sub: `${CATEGORIES[l.cat]} · ${country(l.cc)?.name || ''}`, lm: l, lngLat: [l.lon, l.lat],
        data: {}, parents: [sid ? ['s:' + sid, { c: l.cc }] : null, ['c:' + l.cc, {}]].filter(Boolean) };
    }
    if (type === 'city') {
      const c = await this.getCity(+id, props?.cid);
      if (!c) return null;
      const sname = c.sid ? stateMeta(c.sid)?.name : '';
      return { key: 'ci:' + c.id, cid: c.cid, sid: c.sid, name: c.n, city: c,
        sub: [sname, country(c.cid)?.name].filter(Boolean).join(', '), lngLat: [c.lon, c.lat],
        data: { n: c.n, c: c.cid, s: c.sid, lat: c.lat, lon: c.lon, p: c.p },
        parents: [c.sid ? ['s:' + c.sid, { c: c.cid }] : null, ['c:' + c.cid, {}]].filter(Boolean) };
    }
  }
  async getCity(gid, cidHint) {
    const stored = store.get('ci:' + gid);
    const cid = cidHint || stored?.c;
    if (cid) {
      const map = await this.countryCityMap(cid);
      if (map.has(gid)) return map.get(gid);
    }
    if (stored) return { id: gid, n: stored.n, cid: stored.c, sid: stored.s, lat: stored.lat, lon: stored.lon, p: stored.p };
    const idx = await loadCityIndex();
    const row = idx.find(r => r[0] === gid);
    if (row) { const map = await this.countryCityMap(row[2]); return map.get(gid); }
    return null;
  }
  async countryCityMap(cid) {
    if (this.cityLookup.has(cid)) return this.cityLookup.get(cid);
    const d = await loadCountryCities(cid);
    const map = new Map();
    for (const [gid, n, lat, lon, p, si, flag] of d.cities) map.set(gid, { id: gid, n, lat, lon, p, cid, sid: si >= 0 ? d.states[si][0] : '', cap: flag === 2 });
    this.cityLookup.set(cid, map);
    return map;
  }

  toggle(info) {
    const on = store.toggle(info.key, info.data, info.parents);
    if (on) {
      const what = info.key.startsWith('l:') ? '★ Collected' : info.key.startsWith('c:') ? 'Stamped' : 'Logged';
      this.toast(`<b>${what}</b> ${esc(info.name)}`);
      if (info.key.startsWith('c:')) this.celebrate();
    }
    return on;
  }
  celebrate() {
    // tiny pixel confetti burst
    const n = 18, root = document.body;
    for (let i = 0; i < n; i++) {
      const p = document.createElement('i');
      const C = store.settings.colors;
      p.style.cssText = `position:fixed;z-index:50;width:6px;height:6px;left:50%;top:45%;background:${[C.country, C.state, C.city, C.landmark][i % 4]};pointer-events:none;transition:transform .9s steps(9),opacity .9s steps(9)`;
      root.appendChild(p);
      requestAnimationFrame(() => { const a = (i / n) * Math.PI * 2; p.style.transform = `translate(${Math.cos(a) * (90 + Math.random() * 90)}px,${Math.sin(a) * (90 + Math.random() * 90)}px)`; p.style.opacity = 0; });
      setTimeout(() => p.remove(), 1000);
    }
  }

  // ───────────────────────── popup ─────────────────────────
  popupHTML() {
    const { type, info } = this.sel;
    const on = store.has(info.key);
    const icon = type === 'landmark' ? `<canvas data-sprite="${info.lm.sprite}"></canvas>` : flagHTML(info.cid);
    const extra = type === 'city' && info.city.p ? ` · pop. ${fmtPop(info.city.p)}` : '';
    const verb = type === 'landmark' ? (on ? '★ COLLECTED' : '☆ I’VE BEEN HERE') : (on ? '✓ BEEN HERE' : 'I’VE BEEN HERE');
    return `<div class="pop-h">${icon}<div><b>${esc(info.name)}</b><small>${esc(info.sub)}${extra}</small></div></div>
      <div class="pop-btns"><button class="pix-btn ${on ? 'primary' : ''}" data-act="toggle">${verb}</button><button class="pix-btn ghost" data-act="explore">EXPLORE ›</button></div>`;
  }
  wirePopup(el) {
    paintSprites(el);
    $('[data-act=toggle]', el).onclick = () => this.toggle(this.sel.info);
    $('[data-act=explore]', el).onclick = () => { this.map.closePopup(); this.flyToSel(); this.setTab('explore'); };
  }

  // ───────────────────────── panel ─────────────────────────
  renderPanel(resetScroll) {
    const body = $('#panel-body');
    const scroll = resetScroll ? 0 : body.scrollTop;
    const fn = { explore: this.renderExplore, logbook: this.renderLogbook, passport: this.renderPassport, landmarks: this.renderLandmarks, stats: this.renderStats }[this.tab];
    fn.call(this, body);
    paintSprites(body);
    body.scrollTop = scroll;
  }

  // ---- explore ----
  renderExplore(body) {
    if (!this.sel?.info) return this.renderWelcome(body);
    const { type, info } = this.sel;
    const on = store.has(info.key);
    const C = store.settings.colors;
    const col = { country: C.country, state: C.state, city: C.city, landmark: C.landmark }[type];
    const crumbs = [];
    if (type !== 'country') crumbs.push(`<a data-go="country:${info.cid}">${esc(country(info.cid)?.name)}</a>`);
    if ((type === 'city' || type === 'landmark') && info.sid) crumbs.push(`<a data-go="state:${info.sid}">${esc(stateMeta(info.sid)?.name)}</a>`);
    const head = type === 'landmark'
      ? `<div class="p-title"><canvas data-sprite="${info.lm.sprite}" data-scale="6"></canvas><h2>${esc(info.name)}</h2></div>`
      : `<div class="p-title">${flagHTML(info.cid)}<h2>${esc(info.name)}</h2></div>`;
    const item = store.get(info.key) || {};
    body.innerHTML = `${head}
      <div class="crumbs">${crumbs.join(' › ') || esc(info.sub)}${crumbs.length ? ' · ' + esc(type === 'landmark' ? CATEGORIES[info.lm.cat] : type === 'state' ? (info.meta.type || 'Region') : 'City') : ''}</div>
      ${type === 'landmark' ? `<p class="blurb">${esc(info.lm.blurb)}</p>` : ''}
      <div class="kv" id="kv"></div>
      <button class="pix-btn been ${on ? 'on' : ''}" style="--btn-on:${col}" id="been-btn"><span class="box">${on ? '✓' : ''}</span>${on ? (type === 'landmark' ? 'COLLECTED' : 'BEEN HERE') : 'I’VE BEEN HERE'}</button>
      ${on ? `<div class="field"><span>When (optional)</span><input type="month" id="f-date" value="${esc(item.d || '')}"></div>
             <div class="field"><span>Notes</span><textarea id="f-note" placeholder="Best meal, who you went with, what you'd do again…">${esc(item.note || '')}</textarea></div>` : ''}
      <div id="explore-extra"></div>`;
    $$('[data-go]', body).forEach(a => a.onclick = () => { const [t, i] = a.dataset.go.split(':'); this.select(t, i, { fly: true }); });
    $('#been-btn').onclick = () => this.toggle(info);
    const save = () => { this._suppressPanel = true; store.set(info.key, { d: $('#f-date').value, note: $('#f-note').value }); };
    if (on) { $('#f-date').onchange = save; $('#f-note').onchange = save; }
    this.updateExploreCounts();
    const extra = $('#explore-extra');
    if (type === 'country') this.renderCountryExtra(extra, info);
    else if (type === 'state') this.renderStateExtra(extra, info);
    else if (type === 'city') this.renderNearby(extra, info.lngLat, 80);
    else if (type === 'landmark') this.renderNearby(extra, info.lngLat, 150, info.lm.id);
  }

  updateExploreCounts() {
    const kv = $('#kv'); if (!kv || !this.sel?.info) return;
    const { type, info } = this.sel;
    const visitedCities = store.cities();
    if (type === 'country') {
      const m = info.meta;
      const st = store.states().filter(s => stateMeta(s)?.cid === info.cid).length;
      const ci = visitedCities.filter(([, c]) => c.c === info.cid).length;
      const lms = LANDMARKS.filter(l => l.cc === info.cid);
      kv.innerHTML = `<span><b>${st}</b>/${m.nstates} regions</span><span><b>${ci}</b> cities</span>${lms.length ? `<span><b>${lms.filter(l => store.has('l:' + l.id)).length}</b>/${lms.length} wonders</span>` : ''}<span>${esc(m.cont)}</span>${m.pop ? `<span>pop. ${fmtPop(m.pop)}</span>` : ''}`;
    } else if (type === 'state') {
      const ci = visitedCities.filter(([, c]) => c.s === this.sel.id).length;
      kv.innerHTML = `<span><b>${ci}</b> cities logged</span>${info.meta.iso ? `<span>${esc(info.meta.iso)}</span>` : ''}`;
    } else if (type === 'city') {
      const c = info.city;
      kv.innerHTML = `${c.p ? `<span>pop. <b>${fmtPop(c.p)}</b></span>` : ''}${c.cap ? '<span>★ capital</span>' : ''}<span>${c.lat.toFixed(2)}°, ${c.lon.toFixed(2)}°</span>${store.home ? `<span>${Math.round(haversine(store.home.lat, store.home.lon, c.lat, c.lon)).toLocaleString()} km from home</span>` : ''}`;
    } else {
      kv.innerHTML = `<span>No. ${String(LANDMARKS.indexOf(info.lm) + 1).padStart(3, '0')}</span><span>${info.lm.lat.toFixed(3)}°, ${info.lm.lon.toFixed(3)}°</span>`;
    }
    // reflect toggle state in the big button too
    const btn = $('#been-btn');
    if (btn) { const on = store.has(info.key); btn.classList.toggle('on', on); }
  }

  async renderCountryExtra(el, info) {
    const cid = info.cid;
    const lms = LANDMARKS.filter(l => l.cc === cid);
    el.innerHTML = `${lms.length ? `<div class="p-sec"><h3>WONDERS HERE <span>${lms.length}</span></h3><div class="lm-chips">${lms.map(l => lmChip(l)).join('')}</div></div>` : ''}
      <div class="p-sec"><h3>REGIONS <span>${info.meta.nstates}</span></h3><input class="filter-input" id="st-filter" placeholder="Filter regions…"><div class="ck-list" id="st-list" style="margin-top:8px"></div></div>
      <div class="p-sec"><h3>CITIES & TOWNS <span>${info.meta.ncities.toLocaleString()}</span></h3><input class="filter-input" id="ci-filter" placeholder="Find a city or town…"><div class="ck-list" id="ci-list" style="margin-top:8px"><div class="muted">Loading cities…</div></div></div>`;
    paintSprites(el);
    this.wireLmChips(el);
    const states = Object.entries(DATA.meta.states).filter(([, s]) => s.cid === cid).sort((a, b) => a[1].name.localeCompare(b[1].name));
    const C = store.settings.colors;
    const drawStates = () => {
      const q = fold($('#st-filter')?.value);
      $('#st-list').innerHTML = states.filter(([, s]) => !q || fold(s.name).includes(q)).map(([sid, s]) =>
        ckRow('s:' + sid, s.name, s.type, `--ck:${C.state}`, `state:${sid}`)).join('') || '<div class="muted">No regions</div>';
      this.wireCk($('#st-list'), key => this.describe('state', key.slice(2)));
    };
    drawStates();
    $('#st-filter').oninput = drawStates;
    const map = await this.countryCityMap(cid).catch(() => new Map());
    if (this.sel?.id !== cid) return;
    const all = [...map.values()];
    const drawCities = () => {
      const q = fold($('#ci-filter')?.value);
      let list = q ? all.filter(c => fold(c.n).includes(q)).sort((a, b) => (fold(a.n).startsWith(q) ? 0 : 1) - (fold(b.n).startsWith(q) ? 0 : 1) || b.p - a.p) : all;
      const vis = all.filter(c => store.has('ci:' + c.id));
      if (!q) list = [...vis, ...list.filter(c => !store.has('ci:' + c.id))];
      const shown = list.slice(0, this._ciLimit || 60);
      $('#ci-list').innerHTML = shown.map(c => ckRow('ci:' + c.id, c.n, [c.sid ? stateMeta(c.sid)?.name : '', fmtPop(c.p)].filter(Boolean).join(' · '), `--ck:${C.city}`, `city:${c.id}:${cid}`, c.cap))
        .join('') + (list.length > shown.length ? `<button class="pix-btn small ghost more-btn" id="ci-more">Show more (${(list.length - shown.length).toLocaleString()} left)</button>` : '') || '<div class="muted">No matches</div>';
      this.wireCk($('#ci-list'), key => this.describe('city', key.slice(3), { cid }));
      const more = $('#ci-more'); if (more) more.onclick = () => { this._ciLimit = (this._ciLimit || 60) + 150; drawCities(); };
    };
    this._ciLimit = 60;
    drawCities();
    $('#ci-filter').oninput = () => { this._ciLimit = 60; drawCities(); };
  }

  async renderStateExtra(el, info) {
    await loadStates().catch(() => {});
    const sid = this.sel.id, cid = info.cid, C = store.settings.colors;
    const lms = LANDMARKS.filter(l => l.cc === cid && this.lmState(l) === sid);
    el.innerHTML = `${lms.length ? `<div class="p-sec"><h3>WONDERS HERE</h3><div class="lm-chips">${lms.map(l => lmChip(l)).join('')}</div></div>` : ''}
      <div class="p-sec"><h3>CITIES & TOWNS <span id="st-count"></span></h3><input class="filter-input" id="ci-filter" placeholder="Find a city or town…"><div class="ck-list" id="ci-list" style="margin-top:8px"><div class="muted">Loading…</div></div></div>`;
    paintSprites(el); this.wireLmChips(el);
    const map = await this.countryCityMap(cid).catch(() => new Map());
    if (this.sel?.id !== sid) return;
    const all = [...map.values()].filter(c => c.sid === sid);
    $('#st-count').textContent = all.length.toLocaleString();
    let limit = 80;
    const draw = () => {
      const q = fold($('#ci-filter').value);
      let list = q ? all.filter(c => fold(c.n).includes(q)) : [...all.filter(c => store.has('ci:' + c.id)), ...all.filter(c => !store.has('ci:' + c.id))];
      const shown = list.slice(0, limit);
      $('#ci-list').innerHTML = shown.map(c => ckRow('ci:' + c.id, c.n, fmtPop(c.p), `--ck:${C.city}`, `city:${c.id}:${cid}`, c.cap)).join('')
        + (list.length > shown.length ? `<button class="pix-btn small ghost more-btn" id="ci-more">Show more (${(list.length - shown.length).toLocaleString()} left)</button>` : '') || '<div class="muted">No cities in our database for this region.</div>';
      this.wireCk($('#ci-list'), key => this.describe('city', key.slice(3), { cid }));
      const more = $('#ci-more'); if (more) more.onclick = () => { limit += 200; draw(); };
    };
    draw();
    $('#ci-filter').oninput = () => { limit = 80; draw(); };
  }
  lmState(l) {
    if (!this.stateLmCache.has(l.id)) this.stateLmCache.set(l.id, stateAt(l.lon, l.lat, l.cc));
    return this.stateLmCache.get(l.id);
  }
  renderNearby(el, [lon, lat], km, skip) {
    const near = LANDMARKS.filter(l => l.id !== skip).map(l => [l, haversine(lat, lon, l.lat, l.lon)]).filter(([, d]) => d < km).sort((a, b) => a[1] - b[1]).slice(0, 8);
    el.innerHTML = near.length ? `<div class="p-sec"><h3>WONDERS NEARBY</h3><div class="lm-chips">${near.map(([l, d]) => lmChip(l, `${Math.round(d)} km`)).join('')}</div></div>` : '';
    paintSprites(el); this.wireLmChips(el);
  }
  wireLmChips(el) { $$('.lm-chip', el).forEach(b => b.onclick = () => this.select('landmark', b.dataset.id, { fly: true })); }
  wireCk(list, describeFn) {
    $$('.ck', list).forEach(row => {
      row.onclick = async ev => {
        if (ev.target.closest('.go')) { const [t, id, cid] = row.dataset.go.split(':'); return this.select(t, id, { fly: true, props: { cid } }); }
        const info = await describeFn(row.dataset.key);
        if (!info) return;
        this._suppressPanel = true;
        const on = this.toggle(info);
        row.classList.toggle('on', on);
      };
    });
  }

  renderWelcome(body) {
    const n = store.countries().length;
    const recent = Object.entries(store.book.items).sort((a, b) => (b[1].t || 0) - (a[1].t || 0)).slice(0, 8);
    const day = Math.floor(Date.now() / 864e5);
    const spot = LANDMARKS[(day * 7919) % LANDMARKS.length];
    body.innerHTML = `
      <div class="p-title"><canvas data-icon="plane" style="width:56px;height:44px"></canvas><h2>${n ? 'Welcome back, traveler' : 'Start your logbook'}</h2></div>
      <p class="blurb">Click any <b>country</b> to stamp it. Zoom in and click a <b>state</b>, then the <b>city</b> dots. Hunt down all ${LANDMARKS.length} pixel <b>wonders</b>.</p>
      <div class="row-btns"><button class="pix-btn small primary" id="w-quick">＋ Quick add many places</button><button class="pix-btn small" id="w-locate">📍 Check in where I am</button><button class="pix-btn small ghost" id="w-search">🔎 Search</button></div>
      <div class="p-sec"><h3>WONDER OF THE DAY</h3>
        <button class="lm-chip" data-id="${spot.id}" style="width:100%;padding:10px"><canvas data-sprite="${spot.sprite}" style="width:72px;height:72px"></canvas>
        <span><b>${esc(spot.name)}</b><br><span class="muted">${esc(spot.blurb)}</span></span></button></div>
      ${recent.length ? `<div class="p-sec"><h3>RECENTLY LOGGED</h3>${recent.map(([k, v]) => this.recentTag(k, v)).join('')}</div>` : ''}
      <div class="p-sec"><h3>TIPS</h3><p class="muted">• Switch between 🌍 Globe and 🗺️ flat Map at the top.<br>• Change colours & map style with 🎨.<br>• Sign in with Google to save your logbook to the cloud and use it on any device.</p></div>`;
    $('#w-locate').onclick = () => this.locate();
    $('#w-quick').onclick = () => this.openQuick();
    $('#w-search').onclick = () => $('#search').focus();
    this.wireLmChips(body);
    this.wireTags(body);
  }
  recentTag(k, v) {
    const [t, id] = [k.slice(0, k.indexOf(':')), k.slice(k.indexOf(':') + 1)];
    const name = t === 'c' ? country(id)?.name : t === 's' ? stateMeta(id)?.name : t === 'ci' ? v.n : LANDMARK_BY_ID[id]?.name;
    const cls = { c: 'st', s: 'st', ci: 'ci', l: 'lm' }[t];
    const type = { c: 'country', s: 'state', ci: 'city', l: 'landmark' }[t];
    const style = t === 'c' ? 'style="--x:1"' : '';
    return `<button class="tag ${cls}" data-sel="${type}:${id}:${v.c || ''}" ${style}><i ${t === 'c' ? 'style="background:var(--c-country)"' : ''}></i>${esc(name || id)}</button>`;
  }
  wireTags(el) { $$('[data-sel]', el).forEach(b => b.onclick = () => { const [t, id, cid] = b.dataset.sel.split(':'); this.select(t, id, { fly: true, props: { cid } }); }); }

  // ---- logbook ----
  renderLogbook(body) {
    const cs = store.countries();
    if (!cs.length && !store.landmarks().length) {
      body.innerHTML = `<div class="empty"><canvas data-icon="plane" style="width:84px;height:66px"></canvas><p>Your logbook is empty.<br>Click a country on the map to stamp your first one, or add a whole list at once.</p><button class="pix-btn primary small" id="lb-quick">＋ Quick add places</button></div>`;
      $('#lb-quick').onclick = () => this.openQuick();
      return;
    }
    const byCont = {};
    for (const cid of cs) { const c = country(cid); (byCont[c?.cont || 'Other'] ||= []).push(cid); }
    const cities = store.cities(), states = store.states(), lms = store.landmarks();
    let html = `<div class="row-btns" style="margin-bottom:6px;flex-wrap:nowrap"><input class="filter-input" id="lb-filter" placeholder="Filter your logbook…"><button class="pix-btn small primary" id="lb-quick" style="white-space:nowrap">＋ Quick add</button></div>`;
    for (const cont of [...CONTINENTS, 'Seven seas (open ocean)', 'Other']) {
      const list = byCont[cont]; if (!list) continue;
      list.sort((a, b) => country(a).name.localeCompare(country(b).name));
      html += `<div class="cont-h"><span>${esc(cont.toUpperCase())}</span><span>${list.length}</span></div>`;
      for (const cid of list) {
        const c = country(cid);
        const st = states.filter(s => stateMeta(s)?.cid === cid);
        const ci = cities.filter(([, v]) => v.c === cid);
        const lm = lms.filter(l => LANDMARK_BY_ID[l]?.cc === cid);
        const d = store.get('c:' + cid)?.d;
        html += `<div class="lb-country" data-name="${esc(fold(c.name + ' ' + st.map(s => stateMeta(s)?.name).join(' ') + ' ' + ci.map(([, v]) => v.n).join(' ')))}">
          <div class="lb-row" data-cid="${cid}">${flagHTML(cid)}<span class="nm">${esc(c.name)}</span><span class="cnt">${[st.length && st.length + ' reg', ci.length && ci.length + ' cities', lm.length && lm.length + '★', d && fmtMonth(d)].filter(Boolean).join(' · ')}</span><span class="chev">›</span></div>
          <div class="lb-inner">
            <button class="pix-btn small ghost" data-sel="country:${cid}:">Open ${esc(c.name)} ›</button><div style="height:6px"></div>
            ${st.map(s => `<button class="tag st" data-sel="state:${s}:"><i></i>${esc(stateMeta(s)?.name)}</button>`).join('')}
            ${ci.sort((a, b) => a[1].n.localeCompare(b[1].n)).map(([id, v]) => `<button class="tag ci" data-sel="city:${id}:${cid}"><i></i>${esc(v.n)}</button>`).join('')}
            ${lm.map(l => `<button class="tag lm" data-sel="landmark:${l}:"><i></i>${esc(LANDMARK_BY_ID[l].name)}</button>`).join('')}
          </div></div>`;
      }
    }
    body.innerHTML = html;
    $$('.lb-row', body).forEach(r => r.onclick = () => r.parentElement.classList.toggle('open'));
    this.wireTags(body);
    $('#lb-quick').onclick = () => this.openQuick();
    $('#lb-filter').oninput = e => { const q = fold(e.target.value); $$('.lb-country', body).forEach(el => el.style.display = !q || el.dataset.name.includes(q) ? '' : 'none'); };
  }

  // ---- passport ----
  renderPassport(body) {
    const cs = Object.entries(store.book.items).filter(([k]) => k.startsWith('c:')).sort((a, b) => (sortDate(a[1]) - sortDate(b[1])));
    const lms = store.landmarks();
    const name = cloud.user?.name || 'Traveler';
    body.innerHTML = `<div class="pp-cover"><canvas data-icon="plane" style="width:56px;height:44px"></canvas><div class="t">PASSPORT</div><div class="s">${esc(name)} · ${cs.length} ${cs.length === 1 ? 'stamp' : 'stamps'}</div></div>
      <div class="passport"><div class="passport-head"><span>VISAS / ENTRIES</span><span>${cs.length}</span></div>
      ${cs.length ? `<div class="stamps">${cs.map(([k, v], i) => `<div class="stamp" data-sel="country:${k.slice(2)}:" title="${esc(country(k.slice(2))?.name)}">${stampSVG(k.slice(2), v, i)}</div>`).join('')}</div>`
        : `<div class="empty"><p>No stamps yet.<br>Every country you mark visited lands here as a stamp.</p></div>`}
      ${lms.length ? `<div class="passport-head" style="margin-top:18px"><span>WONDER STICKERS</span><span>${lms.length}</span></div>
        <div class="lm-chips">${lms.map(id => LANDMARK_BY_ID[id]).filter(Boolean).map(l => `<button class="lm-chip on" data-id="${l.id}" style="background:transparent;color:#3b2f22"><canvas data-sprite="${l.sprite}"></canvas>${esc(l.name)}</button>`).join('')}</div>` : ''}
      </div>`;
    this.wireTags(body); this.wireLmChips(body);
  }

  // ---- landmarks / wonders ----
  renderLandmarks(body) {
    const got = new Set(store.landmarks());
    const cats = ['all', 'got', ...Object.keys(CATEGORIES)];
    const label = c => c === 'all' ? 'All' : c === 'got' ? `Collected (${got.size})` : CATEGORIES[c];
    const list = LANDMARKS.filter(l => this.lmFilter === 'all' || (this.lmFilter === 'got' ? got.has(l.id) : l.cat === this.lmFilter));
    body.innerHTML = `<div class="kv"><span><b>${got.size}</b> / ${LANDMARKS.length} wonders collected</span></div>
      <div class="bar" style="--fill:var(--c-landmark);margin:-6px 0 14px"><i style="width:calc(${(got.size / LANDMARKS.length) * 100}% - 4px)"></i></div>
      <div class="filters">${cats.map(c => `<button class="chip ${this.lmFilter === c ? 'active' : ''}" data-f="${c}">${esc(label(c))}</button>`).join('')}</div>
      <div class="dex">${list.map(l => `<button class="dex-card ${got.has(l.id) ? 'on' : 'off'}" data-id="${l.id}" title="${esc(l.name)} — ${esc(country(l.cc)?.name || '')}"><span class="dex-no">${String(LANDMARKS.indexOf(l) + 1).padStart(3, '0')}</span><canvas data-sprite="${l.sprite}"></canvas>${esc(l.name)}</button>`).join('')}</div>`;
    $$('.chip', body).forEach(b => b.onclick = () => { this.lmFilter = b.dataset.f; this.renderPanel(true); });
    $$('.dex-card', body).forEach(b => b.onclick = () => this.select('landmark', b.dataset.id, { fly: true }));
  }

  // ---- stats ----
  renderStats(body) {
    const st = this.computeStats();
    const r = [...RANKS].reverse().find(([n]) => st.un >= n);
    const next = RANKS.find(([n]) => n > st.un);
    body.innerHTML = `<div class="rank"><canvas data-icon="star" style="width:60px;height:54px"></canvas><div><div class="t">${esc(r[1].toUpperCase())}</div><div class="s">${esc(r[2])}${next ? ` ${next[0] - st.un} more ${next[0] - st.un === 1 ? 'country' : 'countries'} to <b>${esc(next[1])}</b>.` : ''}</div></div></div>
      <div class="big-stats">
        <div class="bs"><b>${st.un}<small style="font-size:10px">/195</small></b><span>countries (UN + observers)</span></div>
        <div class="bs"><b>${st.pctWorld.toFixed(1)}%</b><span>of the world’s land area</span></div>
        <div class="bs"><b>${st.states}</b><span>states & regions</span></div>
        <div class="bs"><b>${st.cities}</b><span>cities & towns</span></div>
        <div class="bs"><b>${st.lms}<small style="font-size:10px">/${LANDMARKS.length}</small></b><span>pixel wonders</span></div>
        <div class="bs"><b>${st.conts}<small style="font-size:10px">/7</small></b><span>continents</span></div>
        ${st.terr ? `<div class="bs wide"><b>${st.terr}</b><span>territories & other areas (not counted in the 195)</span></div>` : ''}
        ${st.far ? `<div class="bs wide"><b style="font-size:13px">${esc(st.far.n)}</b><span>furthest logged city from home · ${Math.round(st.far.d).toLocaleString()} km</span></div>` : ''}
      </div>
      <div class="p-sec"><h3>BY CONTINENT</h3>${CONTINENTS.map(c => { const s = st.byCont[c]; const pct = s.total ? s.got / s.total : 0;
        return `<div class="cont-row"><span>${c}</span><div class="bar"><i style="width:calc(${pct * 100}% - 4px)"></i></div><span class="n">${s.got}/${s.total}</span></div>`; }).join('')}</div>
      <div class="p-sec"><h3>WONDER CATEGORIES</h3>${Object.entries(CATEGORIES).map(([k, n]) => { const all = LANDMARKS.filter(l => l.cat === k); const got = all.filter(l => store.has('l:' + l.id)).length;
        return `<div class="cont-row"><span>${n}</span><div class="bar" style="--fill:var(--c-landmark)"><i style="width:calc(${(got / all.length) * 100}% - 4px)"></i></div><span class="n">${got}/${all.length}</span></div>`; }).join('')}</div>`;
  }
  computeStats() {
    const cs = store.countries();
    const metaC = DATA.meta.countries;
    const totalArea = Object.values(metaC).reduce((a, c) => a + (c.area || 0), 0);
    const area = cs.reduce((a, id) => a + (metaC[id]?.area || 0), 0);
    const byCont = Object.fromEntries(CONTINENTS.map(c => [c, { got: 0, total: 0 }]));
    for (const [id, c] of Object.entries(metaC)) { if (!UN195.has(id) || !byCont[c.cont]) continue; byCont[c.cont].total++; if (store.has('c:' + id)) byCont[c.cont].got++; }
    if (byCont.Antarctica) { byCont.Antarctica.total = 1; byCont.Antarctica.got = store.has('c:AQ') ? 1 : 0; }
    const conts = new Set(cs.map(id => metaC[id]?.cont).filter(c => CONTINENTS.includes(c))).size;
    let far = null;
    if (store.home) for (const [, c] of store.cities()) { const d = haversine(store.home.lat, store.home.lon, c.lat, c.lon); if (!far || d > far.d) far = { n: c.n, d }; }
    return { un: cs.filter(id => UN195.has(id)).length, terr: cs.filter(id => !UN195.has(id)).length, states: store.states().length, cities: store.cities().length,
      lms: store.landmarks().length, pctWorld: totalArea ? (area / totalArea) * 100 : 0, byCont, conts, far };
  }

  renderRibbon() {
    const st = this.computeStats();
    $('#ribbon').innerHTML = [
      [st.un, 'countries', 'var(--c-country)'], [st.states, 'states', 'var(--c-state)'], [st.cities, 'cities', 'var(--c-city)'],
      [st.lms, 'wonders', 'var(--c-landmark)'], [st.pctWorld.toFixed(st.pctWorld < 10 ? 1 : 0) + '%', 'of world', 'var(--ink-3)'],
    ].map(([n, l, c]) => `<div class="rb"><b>${n}</b><span>${l}</span><i style="background:${c}"></i></div>`).join('');
    $('#brand-sub').textContent = st.un ? `${st.un} countries & counting` : 'your world logbook';
  }
  renderLegend() {
    const C = store.settings.colors;
    $('#legend').innerHTML = `<div class="lg-title">LEGEND</div>
      <div class="lg"><span class="sw" style="background:${C.country}"></span>Country visited</div>
      <div class="lg"><span class="sw" style="background:${C.state}"></span>State / region</div>
      <div class="lg"><span class="sw" style="background:${C.city}"></span>City</div>
      <div class="lg"><span class="sw" style="background:${C.landmark}"></span>Wonder collected</div>
      <div class="lg"><span class="sw" style="background:${(THEMES[store.settings.theme] || THEMES.midnight).land}"></span>Not yet</div>`;
  }

  // ───────────────────────── search ─────────────────────────
  wireSearch() {
    const input = $('#search'), box = $('#search-results');
    let active = -1, items = [], idxLoaded = false;
    const run = async () => {
      const q = fold(input.value.trim());
      if (q.length < 2) { box.hidden = true; return; }
      if (!idxLoaded) { idxLoaded = true; loadCityIndex().then(() => run()).catch(() => {}); }
      const score = n => { const f = fold(n); return f === q ? 0 : f.startsWith(q) ? 1 : f.includes(' ' + q) ? 2 : f.includes(q) ? 3 : 9; };
      const pick = (arr, nameFn, n) => arr.map(x => [x, score(nameFn(x))]).filter(([, s]) => s < 9).sort((a, b) => a[1] - b[1]).slice(0, n).map(([x]) => x);
      const cs = pick(Object.entries(DATA.meta.countries), ([, c]) => c.name + ' ' + c.long, 5);
      const ss = pick(Object.entries(DATA.meta.states), ([, s]) => s.name, 5);
      const ls = pick(LANDMARKS, l => l.name, 5);
      let ci = [];
      try { const idx = await loadCityIndex(); ci = []; for (const r of idx) { const s = score(r[1]); if (s < 9) { ci.push([r, s]); if (ci.length > 400) break; } } ci = ci.sort((a, b) => a[1] - b[1] || b[0][5] - a[0][5]).slice(0, 8).map(([r]) => r); } catch { }
      if (fold(input.value.trim()) !== q) return;
      items = [];
      let html = '';
      const groups = [];
      const grp = (title, arr, fn, best) => { if (arr.length) groups.push({ title, arr, fn, best }); };
      const best = (arr, nameFn, adj = () => 0) => Math.min(...arr.map(x => score(nameFn(x)) + adj(x)));
      grp('COUNTRIES', cs, ([id, c]) => [`${flagHTML(id)}<span>${esc(c.name)}</span><span class="sr-sub">${store.has('c:' + id) ? '✓ ' : ''}${esc(c.cont)}</span>`, ['country', id]], best(cs, ([, c]) => c.name) - 0.5);
      grp('WONDERS', ls, l => [`<canvas data-sprite="${l.sprite}"></canvas><span>${esc(l.name)}</span><span class="sr-sub">${store.has('l:' + l.id) ? '★ ' : ''}${esc(country(l.cc)?.name || '')}</span>`, ['landmark', l.id]], best(ls, l => l.name) - 1);
      grp('STATES & REGIONS', ss, ([id, s]) => [`${flagHTML(s.cid)}<span>${esc(s.name)}</span><span class="sr-sub">${store.has('s:' + id) ? '✓ ' : ''}${esc(country(s.cid)?.name)}</span>`, ['state', id]], best(ss, ([, s]) => s.name) - 0.2);
      grp('CITIES', ci, r => [`<span class="dot ${store.has('ci:' + r[0]) ? 'on' : ''}"></span><span>${esc(r[1])}</span><span class="sr-sub">${esc([r[6], country(r[2])?.name].filter(Boolean).join(', '))}</span>`, ['city', r[0], r[2]]],
        best(ci, r => r[1], r => r[5] >= 5e5 ? -1.5 : r[5] >= 1e5 ? -0.3 : 0));
      groups.sort((a, b) => a.best - b.best);
      for (const g of groups) { html += `<div class="sr-group">${g.title}</div>`; for (const x of g.arr) { const [h, sel] = g.fn(x); html += `<button class="sr-item" data-i="${items.length}">${h}</button>`; items.push(sel); } }
      box.innerHTML = html || `<div class="sr-empty">No places match “${esc(input.value)}”.<br><small>Tip: smaller towns are listed inside each country — open the country and use “Find a city”.</small></div>`;
      paintSprites(box);
      box.hidden = false; active = -1;
      $$('.sr-item', box).forEach(b => b.onmousedown = ev => { ev.preventDefault(); choose(+b.dataset.i); });
    };
    const choose = i => {
      const s = items[i]; if (!s) return;
      box.hidden = true; input.blur();
      this.select(s[0], s[1], { fly: true, props: { cid: s[2] } });
    };
    let t;
    input.oninput = () => { clearTimeout(t); t = setTimeout(run, 120); };
    input.onfocus = () => { if (input.value.trim().length >= 2) run(); };
    input.onblur = () => setTimeout(() => box.hidden = true, 150);
    input.onkeydown = e => {
      const btns = $$('.sr-item', box);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); active = (active + (e.key === 'ArrowDown' ? 1 : -1) + btns.length) % btns.length; btns.forEach((b, i) => b.classList.toggle('active', i === active)); btns[active]?.scrollIntoView({ block: 'nearest' }); }
      else if (e.key === 'Enter') choose(active >= 0 ? active : 0);
      else if (e.key === 'Escape') { box.hidden = true; input.blur(); }
    };
    document.addEventListener('keydown', e => { if (e.key === '/' && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') { e.preventDefault(); input.focus(); } });
  }

  // ───────────────────────── location ─────────────────────────
  locate(reopen) {
    if (reopen && this._here) return this.herePopup();
    if (!navigator.geolocation) return this.toast('Your browser can’t share location.');
    this.toast('Finding you… 🛰️', 8000);
    navigator.geolocation.getCurrentPosition(async pos => {
      const { longitude: lon, latitude: lat } = pos.coords;
      this.map.setMarker('you', [lon, lat], 'You are here');
      this.map.flyTo(lon, lat, 9);
      const cid = countryAt(lon, lat);
      let city = null;
      if (cid) {
        const map = await this.countryCityMap(cid).catch(() => new Map());
        let best = Infinity;
        for (const c of map.values()) { const d = haversine(lat, lon, c.lat, c.lon); const w = d - Math.log10(c.p + 10) * 1.5; if (w < best) { best = w; city = { ...c, d }; } }
      }
      this._here = { lon, lat, cid, city };
      this.toast('Found you!');
      this.herePopup();
    }, err => this.toast(err.code === 1 ? 'Location permission was denied.' : 'Couldn’t get your location.'), { enableHighAccuracy: false, timeout: 15000, maximumAge: 300000 });
  }
  herePopup() {
    const h = this._here; if (!h) return;
    const c = h.city;
    const where = c ? `${esc(c.n)}${c.sid ? ', ' + esc(stateMeta(c.sid)?.name) : ''}` : 'Somewhere wonderful';
    const html = `<div class="pop-h">${h.cid ? flagHTML(h.cid) : ''}<div><b>You’re in ${where}</b><small>${esc(country(h.cid)?.name || 'Unknown waters')}${c ? ` · ${c.d.toFixed(1)} km from centre` : ''}</small></div></div>
      <div class="pop-btns">${c ? `<button class="pix-btn primary" data-act="checkin">${store.has('ci:' + c.id) ? '✓ CHECKED IN' : '✓ CHECK IN'}</button>` : ''}<button class="pix-btn ghost" data-act="home">🏠 SET HOME</button></div>`;
    this.map.showPopup([h.lon, h.lat], html, el => {
      const ci = $('[data-act=checkin]', el);
      if (ci) ci.onclick = async () => {
        const info = await this.describe('city', c.id, { cid: h.cid });
        if (!store.has(info.key)) this.toggle(info);
        ci.textContent = '✓ CHECKED IN';
      };
      $('[data-act=home]', el).onclick = () => {
        store.setHome({ lon: +h.lon.toFixed(4), lat: +h.lat.toFixed(4), label: c ? `${c.n}, ${country(h.cid)?.name}` : 'Home', cid: h.cid || '' });
        this.toast(`🏠 Home base saved${cloud.user ? ' to your account' : ''}.`);
      };
    });
  }
  homePopup() {
    const h = store.home; if (!h) return;
    this.map.showPopup([h.lon, h.lat], `<div class="pop-h"><canvas data-icon="house" style="width:42px;height:36px"></canvas><div><b>Home base</b><small>${esc(h.label)}</small></div></div>
      <div class="pop-btns"><button class="pix-btn ghost danger" data-act="clear">REMOVE HOME</button></div>`, el => {
      paintSprites(el);
      $('[data-act=clear]', el).onclick = () => { store.setHome(null); this.map.closePopup(); };
    });
  }

  // ───────────────────────── sheets ─────────────────────────
  wireSheets() {
    $$('.sheet').forEach(s => s.addEventListener('click', e => { if (e.target === s || e.target.closest('[data-close]')) this.closeSheet(s); }));
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') $$('.sheet').forEach(s => { if (!s.hidden) this.closeSheet(s); });
      // keep Tab inside an open dialog
      if (e.key === 'Tab') {
        const open = $$('.sheet').find(s => !s.hidden); if (!open) return;
        const f = $$('button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])', open).filter(el => !el.disabled && el.offsetParent);
        if (!f.length) return;
        if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
      }
    });
    $('#auto-parents').onchange = e => store.setSetting('autoParents', e.target.checked);
    $('#export-btn').onclick = () => {
      const blob = new Blob([JSON.stringify({ app: 'where-have-you-been', exported: new Date().toISOString(), logbook: store.snapshot() }, null, 1)], { type: 'application/json' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `logbook-${new Date().toISOString().slice(0, 10)}.json`; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    };
    $('#import-file').onchange = async e => {
      const f = e.target.files[0]; if (!f) return;
      try { const j = JSON.parse(await f.text()); const book = j.logbook || j; if (!book.items) throw 0;
        // imported entries win if newer
        store.merge(book); this.toast('Logbook imported ✓');
      } catch { this.toast('That file isn’t a logbook export.'); }
      e.target.value = '';
    };
    $('#clear-btn').onclick = () => { if (confirm('Erase every place in your logbook? (Signed-in accounts sync this erase too.)')) { store.clear(); this.toast('Logbook cleared.'); } };
  }
  // ───────────────────────── quick add ─────────────────────────
  openQuick() {
    this.openSheet('quick-sheet', '#quick-text');
    if (!this._quickWired) {
      this._quickWired = true;
      $('#quick-find').onclick = () => this.runQuick();
      $('#quick-text').onkeydown = e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) this.runQuick(); };
      $('#quick-add').onclick = () => this.addQuick();
      $('#quick-clear').onclick = () => { this.qrows = []; $('#quick-text').value = ''; $('#quick-status').textContent = ''; this.renderQuick(); $('#quick-text').focus(); };
    }
  }
  async runQuick() {
    const queries = await parseQuick($('#quick-text').value);
    if (!queries.length) return;
    const run = (this._quickRun = Symbol());
    this.qrows = queries.map(q => ({ q, cands: [], pick: 0, status: 'searching', on: true }));
    $('#quick-status').textContent = 'Looking up…';
    this.renderQuick();
    await Promise.all(this.qrows.map(async r => {
      try { r.cands = await resolveLocal(r.q); } catch (e) { console.warn(e); }
      r.status = r.cands.length ? 'ok' : 'online';
    }));
    if (run !== this._quickRun) return;
    this.renderQuick();
    // anything not in our data: ask OpenStreetMap (one request per second)
    for (const r of this.qrows.filter(r => r.status === 'online')) {
      try { r.cands = await resolveOnline(r.q); } catch (e) { console.warn(e); }
      if (run !== this._quickRun) return;
      r.status = r.cands.length ? 'found-online' : 'none';
      r.on = !!r.cands.length;
      this.renderQuick();
    }
    const n = this.qrows.filter(r => r.on && r.cands.length).length;
    $('#quick-status').textContent = `${n} of ${this.qrows.length} matched`;
  }
  renderQuick() {
    const rows = this.qrows || [];
    const icon = r => r.status === 'searching' || r.status === 'online' ? '⏳' : r.status === 'none' ? '✕'
      : r.cands.length > 1 && r.cands[0].score - r.cands[1].score < 3 ? '❓' : r.status === 'found-online' ? '🌐' : '✓';
    $('#quick-results').innerHTML = rows.map((r, i) => `<div class="qr ${r.on ? '' : 'off'}" data-i="${i}">
      <span class="st" title="${r.status === 'found-online' ? 'Found on OpenStreetMap' : ''}">${icon(r)}</span>
      <span class="q" title="${esc(r.q.text + (r.q.qual ? ', ' + r.q.qual : ''))}">${esc(r.q.text)}${r.q.qual ? `<small class="muted">, ${esc(r.q.qual)}</small>` : ''}</span>
      ${r.cands.length ? `<select>${r.cands.map((c, j) => `<option value="${j}" ${j === r.pick ? 'selected' : ''}>${esc(candLabel(c))}${store.has(keyOf(c)) ? ' ✓ already logged' : ''}</option>`).join('')}</select>`
        : `<span class="nf">${r.status === 'none' ? 'Couldn’t find this place, so check the spelling' : r.status === 'online' ? 'Not in our list, so searching online…' : 'Searching…'}</span>`}
      <button class="skip" title="${r.on ? 'Skip' : 'Include'}">${r.on ? '✕' : '↺'}</button></div>`).join('');
    $$('#quick-results .qr').forEach(el => {
      const r = rows[+el.dataset.i];
      const sel = $('select', el); if (sel) sel.onchange = () => { r.pick = +sel.value; };
      $('.skip', el).onclick = () => { r.on = !r.on; this.renderQuick(); };
    });
    const n = rows.filter(r => r.on && r.cands.length).length;
    $('#quick-foot').hidden = !rows.length;
    $('#quick-add').textContent = `Add ${n} place${n === 1 ? '' : 's'} to my logbook`;
    $('#quick-add').disabled = !n;
  }
  async addQuick() {
    const picks = (this.qrows || []).filter(r => r.on && r.cands.length).map(r => r.cands[r.pick]);
    if (!picks.length) return;
    $('#quick-add').textContent = 'Adding…';
    const entries = [];
    for (const c of picks) {
      try { const info = await this.describe(c.type, c.id, { cid: c.cid }); if (info) entries.push([info.key, info.data, info.parents]); }
      catch (e) { console.warn(e); }
    }
    const added = store.addMany(entries);
    $('#quick-sheet').hidden = true;
    this.qrows = []; $('#quick-text').value = ''; this.renderQuick(); $('#quick-status').textContent = '';
    this.toast(`<b>＋ ${entries.length} place${entries.length === 1 ? '' : 's'} logged</b>${added > entries.length ? ` (plus ${added - entries.length} countries/states)` : ''}`, 3500);
    this.celebrate();
    this.setTab('logbook');
  }

  openSheet(id, focusSel) {
    const el = $('#' + id);
    this._sheetOpener = document.activeElement;
    el.hidden = false;
    (focusSel && $(focusSel, el) || $('button, input, textarea, select', el))?.focus();
  }
  closeSheet(el) {
    el.hidden = true;
    if (this._sheetOpener?.isConnected) this._sheetOpener.focus();
  }
  openTheme() { this.renderThemeSheet(); this.openSheet('theme-sheet', '.theme-card.active'); }
  renderThemeSheet() {
    const cur = store.settings.theme;
    $('#theme-grid').innerHTML = Object.entries(THEMES).map(([k, t]) => `<button class="theme-card ${k === cur ? 'active' : ''}" data-theme="${k}">
      <span class="pv" style="background:${t.ocean}"><i style="left:14%;top:22%;width:40%;height:44%;background:${t.land};box-shadow:0 0 0 2px ${t.border}"></i><i style="left:52%;top:40%;width:34%;height:40%;background:${store.settings.colors.country};box-shadow:0 0 0 2px ${t.border}"></i></span>${t.label.toUpperCase()}</button>`).join('');
    $$('.theme-card').forEach(b => b.onclick = () => store.setSetting('theme', b.dataset.theme));
    const C = store.settings.colors;
    $('#color-rows').innerHTML = [['country', 'Countries'], ['state', 'States / regions'], ['city', 'Cities'], ['landmark', 'Wonders']].map(([k, l]) =>
      `<label class="color-row"><input type="color" data-c="${k}" value="${C[k]}">${l}</label>`).join('') + `<button class="pix-btn small ghost" id="reset-colors">Reset colours</button>`;
    $$('#color-rows input').forEach(i => i.oninput = () => store.setSetting('colors.' + i.dataset.c, i.value));
    $('#reset-colors').onclick = () => { for (const [k, v] of Object.entries(DEFAULT_SETTINGS.colors)) store.setSetting('colors.' + k, v); };
    $('#auto-parents').checked = store.settings.autoParents;
  }

  renderAccountBtn() {
    const u = cloud.user;
    $('#acct-avatar').innerHTML = u?.photo ? `<img src="${esc(u.photo)}" alt="" referrerpolicy="no-referrer">` : (u ? esc((u.name || 'U')[0]) : 'G');
    $('#acct-label').innerHTML = u ? `<span class="sync-dot ${cloud.status}"></span> ${esc((u.name || 'Account').split(' ')[0])}` : 'Sign in';
  }
  openAccount() { this.renderAccount(); this.openSheet('account-sheet', '#g-signin'); }
  renderAccount() {
    const card = $('#account-card'), u = cloud.user;
    const G = `<svg viewBox="0 0 48 48"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>`;
    const head = `<div class="sheet-head"><h2>YOUR ACCOUNT</h2><button class="x" data-close>✕</button></div>`;
    if (!cloud.enabled) {
      card.innerHTML = `${head}<p class="blurb">Google sign-in isn’t switched on for this copy of the app yet. Your logbook is being <b>saved in this browser</b> in the meantime (and you can export it from 🎨).</p>
        <h3>TURN ON GOOGLE SIGN-IN (≈5 MIN, FREE)</h3>
        <ol class="setup-steps"><li>Create a project at <a href="https://console.firebase.google.com/" target="_blank" rel="noopener">console.firebase.google.com</a>.</li>
        <li><b>Build → Authentication → Sign-in method</b>: enable <b>Google</b>.</li>
        <li><b>Build → Firestore Database</b>: create a database, then paste the rules from <code>firestore.rules</code>.</li>
        <li><b>Project settings → Your apps → Web</b>: register an app and copy its config into <code>js/firebase-config.js</code>.</li>
        <li><b>Authentication → Settings → Authorized domains</b>: add the domain this site runs on.</li></ol>
        <p class="muted">After that, anything you logged here will be merged into your account the first time you sign in.</p>`;
    } else if (!u) {
      card.innerHTML = `${head}<p class="blurb">Sign in to save your logbook, home base and settings to your Google account, and keep them in sync across your phone and computer.</p>
        <button class="gbtn" id="g-signin">${G} Sign in with Google</button>
        <p class="muted" style="margin-top:16px">Places you’ve already logged on this device will be merged into your account.</p>
        ${cloud.status === 'error' ? `<p class="muted" style="color:var(--c-city)">Sign-in problem: ${esc(cloud.lastError || 'could not reach Google')}</p>` : ''}`;
      $('#g-signin').onclick = async () => {
        try { await signIn(); $('#account-sheet').hidden = true; this.toast('Signed in — syncing your logbook ☁️'); }
        catch (e) { if (e?.code !== 'auth/popup-closed-by-user' && e?.code !== 'auth/cancelled-popup-request') { cloud.lastError = e?.message; this.toast('Sign-in failed: ' + esc(e?.code || e?.message || 'unknown')); } }
      };
    } else {
      const st = { synced: 'All changes saved to your account', saving: 'Saving…', connecting: 'Connecting…', error: 'Sync problem', local: '' }[cloud.status] || '';
      const h = store.home;
      card.innerHTML = `${head}<div class="acct-head"><span class="acct-avatar">${u.photo ? `<img src="${esc(u.photo)}" alt="" referrerpolicy="no-referrer">` : esc((u.name || 'U')[0])}</span>
        <div><b style="font-size:18px">${esc(u.name || '')}</b><div class="muted">${esc(u.email || '')}</div><div class="muted" style="margin-top:4px"><span class="sync-dot ${cloud.status}"></span> ${esc(st)}</div></div></div>
        <div class="p-sec"><h3>HOME BASE</h3><p class="muted">${h ? `🏠 ${esc(h.label)} <button class="pix-btn small ghost" id="acct-home-go">Go</button>` : 'Not set — use 📍 on the map to find yourself and tap “Set home”.'}</p></div>
        <div class="row-btns" style="margin-top:20px"><button class="pix-btn small" id="g-signout">Sign out</button></div>`;
      $('#g-signout').onclick = async () => { await signOutUser(); this.toast('Signed out. Your logbook stays on this device.'); };
      const g = $('#acct-home-go'); if (g) g.onclick = () => { $('#account-sheet').hidden = true; this.map.flyTo(h.lon, h.lat, 9); };
    }
  }
}

// ───────────────────────── helpers ─────────────────────────
function keyOf(c) { return ({ country: 'c:', state: 's:', city: 'ci:', landmark: 'l:' })[c.type] + c.id; }
function ckRow(key, name, sub, style, go, cap) {
  return `<div class="ck ${store.has(key) ? 'on' : ''}" data-key="${key}" data-go="${go}" style="${style}"><span class="bx"></span><span class="nm">${esc(name)}${cap ? ' <span class="cap">★</span>' : ''}</span><span class="sub">${esc(sub || '')}</span><button class="go" title="Show on map">›</button></div>`;
}
function lmChip(l, extra) {
  return `<button class="lm-chip ${store.has('l:' + l.id) ? 'on' : ''}" data-id="${l.id}"><canvas data-sprite="${l.sprite}"></canvas><span>${esc(l.name)}${extra ? `<br><small class="muted">${extra}</small>` : ''}</span></button>`;
}
export function paintSprites(root) {
  for (const c of root.querySelectorAll('canvas[data-sprite]')) {
    const src = renderSprite(c.dataset.sprite, +(c.dataset.scale || 4));
    c.width = src.width; c.height = src.height; c.getContext('2d').drawImage(src, 0, 0);
    c.removeAttribute('data-sprite');
  }
  for (const c of root.querySelectorAll('canvas[data-icon]')) {
    const src = renderIcon(c.dataset.icon, '#fff', 4);
    c.width = src.width; c.height = src.height; c.getContext('2d').drawImage(src, 0, 0);
    c.removeAttribute('data-icon');
  }
}
function fmtMonth(d) { const [y, m] = (d || '').split('-'); return y ? `${MONTHS[+m - 1] || ''} ${y}` : ''; }
function sortDate(v) { if (v.d) return new Date(v.d + '-01').getTime(); return v.t || 0; }
function hash(s) { let h = 2166136261; for (const ch of s) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }

/** A rubber passport stamp as SVG, unique per country. */
function stampSVG(cid, item, i) {
  const c = country(cid); const name = (c?.name || cid).toUpperCase();
  const h = hash(cid);
  const inks = ['#b4442e', '#2b5aa8', '#2f7d4f', '#7b3f9e', '#a8741a', '#c2185b', '#00695c', '#37474f'];
  const ink = inks[h % inks.length];
  const rot = ((h >> 4) % 25) - 12;
  const shape = (h >> 9) % 4;
  const date = item.d ? fmtMonth(item.d) : (() => { const d = new Date(item.t || Date.now()); return `${String(d.getDate()).padStart(2, '0')} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`; })();
  const fs = name.length > 20 ? 6.6 : name.length > 15 ? 8 : name.length > 11 ? 9.5 : name.length > 7 ? 11.5 : 13;
  const label = ['ARRIVED', 'ENTRY', 'ADMITTED', 'VISITED'][(h >> 13) % 4];
  const plane = `<g transform="translate(52 ${shape === 1 ? 26 : 22}) scale(1.4)" fill="${ink}"><rect x="2" y="0" width="2" height="7"/><rect x="0" y="2" width="6" height="2"/><rect x="1" y="6" width="4" height="1"/></g>`;
  let frame;
  if (shape === 0) frame = `<circle cx="60" cy="60" r="54" fill="none" stroke="${ink}" stroke-width="4"/><circle cx="60" cy="60" r="46" fill="none" stroke="${ink}" stroke-width="1.5"/>`;
  else if (shape === 1) frame = `<rect x="6" y="18" width="108" height="84" rx="4" fill="none" stroke="${ink}" stroke-width="4"/><rect x="12" y="24" width="96" height="72" fill="none" stroke="${ink}" stroke-width="1.5" stroke-dasharray="4 3"/>`;
  else if (shape === 2) frame = `<ellipse cx="60" cy="60" rx="56" ry="42" fill="none" stroke="${ink}" stroke-width="4"/><ellipse cx="60" cy="60" rx="49" ry="35" fill="none" stroke="${ink}" stroke-width="1.5"/>`;
  else frame = `<polygon points="60,6 107,33 107,87 60,114 13,87 13,33" fill="none" stroke="${ink}" stroke-width="4"/><polygon points="60,14 100,37 100,83 60,106 20,83 20,37" fill="none" stroke="${ink}" stroke-width="1.5"/>`;
  return `<svg viewBox="0 0 120 120" style="transform:rotate(${rot}deg);opacity:${0.78 + ((h >> 17) % 20) / 100}">
    <defs><filter id="rough${i}"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="${h % 100}"/><feDisplacementMap in="SourceGraphic" scale="1.6"/></filter></defs>
    <g filter="url(#rough${i})">${frame}${plane}
    <text x="60" y="${shape === 1 ? 62 : 64}" text-anchor="middle" font-family="Space Grotesk, sans-serif" font-weight="700" font-size="${fs}" fill="${ink}" letter-spacing="0.5">${esc(name)}</text>
    <text x="60" y="${shape === 1 ? 77 : 80}" text-anchor="middle" font-family="Press Start 2P, monospace" font-size="6.5" fill="${ink}">${esc(date)}</text>
    <text x="60" y="${shape === 1 ? 90 : 93}" text-anchor="middle" font-family="Space Grotesk, sans-serif" font-weight="600" font-size="7.5" fill="${ink}" letter-spacing="1.5">${label} · ${esc(cid.length === 2 ? cid : '')}</text></g></svg>`;
}
