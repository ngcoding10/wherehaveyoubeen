// The map: MapLibre GL with our own vector data, globe + flat projections, pixel-art landmarks.
import { store } from './store.js';
import { DATA, loadCountryCities, cityMinZoom } from './data.js';
import { LANDMARKS } from './landmarks.js';
import { renderSprite, renderIcon } from './sprites.js';

const maplibregl = window.maplibregl;

export const THEMES = {
  midnight: { label: 'Midnight', ocean: '#0c1f38', land: '#3a4659', border: '#7d8aa3', stateLine: '#6a7891', grat: '#2a4a73',
              text: '#dfe8f5', halo: '#0c1f38', ocLabel: '#4f78ad', selected: '#ffffff', sky: '#0a1830', horizon: '#3b6fb5' },
  atlas:    { label: 'Atlas',    ocean: '#b4d4d0', land: '#d3cfc7', border: '#8c8274', stateLine: '#a69c8d', grat: '#93b9b5',
              text: '#3e352c', halo: '#efe9dc', ocLabel: '#5b8b86', selected: '#2b2118', sky: '#cfe3e0', horizon: '#f2e8d2' },
  arcade:   { label: 'Arcade',   ocean: '#170a35', land: '#46445a', border: '#8f7bff', stateLine: '#6c5fc0', grat: '#3a1f7a',
              text: '#f4eaff', halo: '#170a35', ocLabel: '#7d5cff', selected: '#00f5d4', sky: '#12062b', horizon: '#ff3ea5' },
  daylight: { label: 'Daylight', ocean: '#cfe7f5', land: '#d9dce1', border: '#ffffff', stateLine: '#b9bfc8', grat: '#b7d7ea',
              text: '#2c3440', halo: '#f4f8fb', ocLabel: '#6c9cbd', selected: '#1d2433', sky: '#bfe0f5', horizon: '#ffffff' },
};

const OCEANS = [
  ['PACIFIC OCEAN', -150, 5], ['PACIFIC OCEAN', 165, 10], ['ATLANTIC OCEAN', -38, 22], ['ATLANTIC OCEAN', -18, -22],
  ['INDIAN OCEAN', 78, -18], ['ARCTIC OCEAN', 0, 84], ['SOUTHERN OCEAN', 40, -60], ['MEDITERRANEAN SEA', 18, 34.5],
  ['CARIBBEAN SEA', -75, 15], ['ARABIAN SEA', 64, 15], ['BAY OF BENGAL', 89, 15], ['SOUTH CHINA SEA', 114, 13],
  ['GULF OF MEXICO', -90, 25], ['CORAL SEA', 155, -17], ['TASMAN SEA', 160, -38], ['NORTH SEA', 3.5, 56],
  ['BERING SEA', -178, 58], ['SEA OF JAPAN', 135, 40], ['HUDSON BAY', -85, 60], ['RED SEA', 38, 21],
];

export class WorldMap extends EventTarget {
  constructor(container) {
    super();
    this.container = container;
    this.selected = null; // {type, id}
    this.loadedCityFeatures = new Map(); // cid -> features
    this.popup = null;
  }

  init() {
    const base = location.href.replace(/[#?].*$/, '').replace(/[^/]*$/, '');
    const proj = store.settings.projection === 'mercator' ? 'mercator' : 'globe';
    this.map = new maplibregl.Map({
      container: this.container,
      style: {
        version: 8,
        projection: { type: proj },
        glyphs: base + 'fonts/{fontstack}/{range}.pbf',
        sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': THEMES.midnight.ocean } }],
      },
      center: [10, 25], zoom: worldZoom(proj, this.container), minZoom: 0, maxZoom: 14,
      attributionControl: false, renderWorldCopies: true, dragRotate: false, pitchWithRotate: false,
      localIdeographFontFamily: "'Noto Sans', sans-serif",
    });
    this.map.touchZoomRotate.disableRotation();
    this.map.addControl(new maplibregl.AttributionControl({ compact: true,
      customAttribution: 'Borders © <a href="https://www.naturalearthdata.com/" target="_blank">Natural Earth</a> · Cities © <a href="https://www.geonames.org/" target="_blank">GeoNames</a> (CC BY 4.0)' }), 'bottom-left');
    this._applyPadding();
    window.addEventListener('resize', () => { this._applyPadding(); if (store.settings.projection === 'mercator') this.applyProjection(); });
    return new Promise(res => this.map.on('load', () => { this._build(); res(this); }));
  }
  /** Keep the map centred in the area not covered by the side panel. */
  _applyPadding() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    this.panelPad = w > 820 ? { top: 80, right: Math.min(440, w * 0.38) + 20, bottom: 0, left: 0 } : { top: 120, right: 0, bottom: h * 0.42, left: 0 };
    this.map.setPadding(this.panelPad);
  }

  _build() {
    const m = this.map;
    const meta = DATA.meta;
    // images
    for (const key of new Set(LANDMARKS.map(l => l.sprite))) this._addCanvasImage('lm-' + key, renderSprite(key, 4));
    this._makePins();

    // sources
    m.addSource('countries', { type: 'geojson', data: DATA.countriesGeo, promoteId: 'id', tolerance: 0.3 });
    m.addSource('states', { type: 'geojson', data: DATA.statesGeo, promoteId: 'id', tolerance: 0.3 });
    m.addSource('graticule', { type: 'geojson', data: graticule() });
    m.addSource('country-labels', { type: 'geojson', data: fc(Object.entries(meta.countries).map(([id, c]) =>
      pt(c.label, { id, name: c.name, area: c.area || 0, mz: c.area > 1.5e6 ? 1 : c.area > 4e5 ? 2 : c.area > 1e5 ? 3 : c.area > 2e4 ? 4 : 5 }))) });
    m.addSource('state-labels', { type: 'geojson', data: fc(Object.entries(meta.states).map(([id, s]) => pt(s.label, { id, name: s.name, cid: s.cid }))) });
    m.addSource('ocean-labels', { type: 'geojson', data: fc(OCEANS.map(([name, x, y]) => pt([x, y], { name }))) });
    m.addSource('cities', { type: 'geojson', data: fc([]) });
    m.addSource('visited-cities', { type: 'geojson', data: fc([]) });
    m.addSource('landmarks', { type: 'geojson', data: fc(LANDMARKS.map(l => pt([l.lon, l.lat], { id: l.id, name: l.name, icon: 'lm-' + l.sprite, rank: l.rank, cat: l.cat }))) });

    const T = THEMES.midnight;
    const add = l => m.addLayer(l);
    add({ id: 'graticule', type: 'line', source: 'graticule', paint: { 'line-color': T.grat, 'line-width': 1, 'line-dasharray': [2, 3] } });
    add({ id: 'countries-fill', type: 'fill', source: 'countries', paint: { 'fill-color': T.land } });
    add({ id: 'countries-visited', type: 'fill', source: 'countries', filter: ['in', ['get', 'id'], ['literal', []]], paint: {
      'fill-color': '#2ec4b6', 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 3, 0.95, 6, 0.8, 10, 0.55] } });
    add({ id: 'states-hit', type: 'fill', source: 'states', paint: { 'fill-color': '#000', 'fill-opacity': 0 } });
    add({ id: 'states-fill', type: 'fill', source: 'states', filter: ['in', ['get', 'id'], ['literal', []]], paint: { 'fill-color': '#ffb703', 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 3, 0.97, 6, 0.9, 10, 0.78] } });
    add({ id: 'states-hover', type: 'fill', source: 'states', filter: ['==', ['get', 'id'], ''], minzoom: 3, paint: { 'fill-color': '#ffffff', 'fill-opacity': 0.12 } });
    add({ id: 'states-line', type: 'line', source: 'states', minzoom: 2.2, paint: {
      'line-color': T.stateLine, 'line-width': ['interpolate', ['linear'], ['zoom'], 3, 0.4, 8, 1.2],
      'line-opacity': ['interpolate', ['linear'], ['zoom'], 2.2, 0, 3.5, 0.75] } });
    add({ id: 'countries-line', type: 'line', source: 'countries', paint: {
      'line-color': T.border, 'line-width': ['interpolate', ['linear'], ['zoom'], 0, 0.5, 4, 1.1, 8, 2] } });
    add({ id: 'countries-hover', type: 'line', source: 'countries', filter: ['==', ['get', 'id'], ''], paint: { 'line-color': T.selected, 'line-width': 1.6, 'line-opacity': 0.7 } });
    add({ id: 'sel-state', type: 'line', source: 'states', filter: ['==', ['get', 'id'], ''], paint: { 'line-color': T.selected, 'line-width': 2.5, 'line-dasharray': [2, 1] } });
    add({ id: 'sel-country', type: 'line', source: 'countries', filter: ['==', ['get', 'id'], ''], paint: { 'line-color': T.selected, 'line-width': 3 } });
    add({ id: 'ocean-labels', type: 'symbol', source: 'ocean-labels', maxzoom: 5, layout: {
      'text-field': ['get', 'name'], 'text-font': ['Noto Sans Italic'], 'text-size': ['interpolate', ['linear'], ['zoom'], 1, 9, 4, 13],
      'text-letter-spacing': 0.3, 'text-max-width': 6 }, paint: { 'text-color': T.ocLabel } });
    add({ id: 'city-dots', type: 'circle', source: 'cities', filter: ['>=', ['zoom'], ['get', 'mz']], paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 2, ['case', ['==', ['get', 'cap'], 1], 2.6, 1.8], 8, ['case', ['==', ['get', 'cap'], 1], 4.5, 3.2]],
      'circle-color': T.text, 'circle-opacity': 0.75, 'circle-stroke-color': T.halo, 'circle-stroke-width': 1 } });
    add({ id: 'city-labels', type: 'symbol', source: 'cities', filter: ['>=', ['zoom'], ['get', 'mz']], layout: {
      'text-field': ['get', 'n'], 'text-font': ['Noto Sans Regular'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 2, ['case', ['==', ['get', 'cap'], 1], 11, 10], 10, ['case', ['==', ['get', 'cap'], 1], 15, 13]],
      'text-variable-anchor': ['left', 'right', 'top', 'bottom'], 'text-radial-offset': 0.6, 'text-justify': 'auto',
      'symbol-sort-key': ['-', 0, ['get', 'p']], 'text-optional': true }, paint: { 'text-color': T.text, 'text-halo-color': T.halo, 'text-halo-width': 1.4, 'text-opacity': 0.9 } });
    add({ id: 'state-labels', type: 'symbol', source: 'state-labels', minzoom: 4.2, layout: {
      'text-field': ['get', 'name'], 'text-font': ['Noto Sans Italic'], 'text-size': ['interpolate', ['linear'], ['zoom'], 4, 9.5, 8, 13],
      'text-transform': 'uppercase', 'text-letter-spacing': 0.12, 'text-max-width': 7, 'text-padding': 6 },
      paint: { 'text-color': T.text, 'text-opacity': 0.6, 'text-halo-color': T.halo, 'text-halo-width': 1 } });
    add({ id: 'country-labels', type: 'symbol', source: 'country-labels', filter: ['>=', ['zoom'], ['get', 'mz']], maxzoom: 7.5, layout: {
      'text-field': ['get', 'name'], 'text-font': ['Noto Sans Medium'], 'text-transform': 'uppercase',
      'text-size': ['interpolate', ['linear'], ['zoom'], 1, ['case', ['>', ['get', 'area'], 3e6], 11, 9], 6, ['case', ['>', ['get', 'area'], 3e6], 20, 16]],
      'text-letter-spacing': 0.14, 'text-max-width': 7, 'symbol-sort-key': ['-', 0, ['get', 'area']], 'text-padding': 4 },
      paint: { 'text-color': T.text, 'text-halo-color': T.halo, 'text-halo-width': 1.6 } });
    add({ id: 'landmark-glow', type: 'circle', source: 'landmarks', filter: ['in', ['get', 'id'], ['literal', []]], minzoom: 1.2, paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, 9, 5, 16, 9, 24], 'circle-color': '#ffd447', 'circle-blur': 0.7, 'circle-opacity': 0.75 } });
    add({ id: 'landmarks', type: 'symbol', source: 'landmarks', minzoom: 1.2, layout: {
      'icon-image': ['get', 'icon'], 'icon-size': ['interpolate', ['linear'], ['zoom'], 1, 0.55, 4, 0.8, 9, 1.25],
      'icon-anchor': 'bottom', 'icon-padding': 1, 'symbol-sort-key': ['get', 'rank'],
      'text-field': ['step', ['zoom'], '', 5.5, ['get', 'name']], 'text-font': ['Noto Sans Medium'], 'text-size': 11,
      'text-anchor': 'top', 'text-offset': [0, 0.2], 'text-optional': true, 'text-max-width': 9 },
      paint: { 'text-color': '#ffe08a', 'text-halo-color': '#1e1830', 'text-halo-width': 1.6 } });
    add({ id: 'visited-cities', type: 'symbol', source: 'visited-cities', layout: {
      'icon-image': 'pin-city', 'icon-anchor': 'bottom', 'icon-allow-overlap': true, 'icon-size': ['interpolate', ['linear'], ['zoom'], 1, 0.55, 6, 0.85, 10, 1.1],
      'text-field': ['step', ['zoom'], '', 3.5, ['get', 'n']], 'text-font': ['Noto Sans Medium'], 'text-size': 12,
      'text-anchor': 'top', 'text-offset': [0, 0.15], 'text-optional': true }, paint: { 'text-color': T.text, 'text-halo-color': T.halo, 'text-halo-width': 1.6 } });

    m.moveLayer('country-labels'); // country names win label placement over sprites
    this.applyTheme();
    this.refreshVisited();
    this._setCities();
    this._wire();
    this.applyProjection(true);
  }

  _addCanvasImage(name, canvas) {
    const ctx = canvas.getContext('2d');
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    if (this.map.hasImage(name)) this.map.updateImage(name, img);
    else this.map.addImage(name, img, { pixelRatio: 2 });
  }
  _makePins() { this._addCanvasImage('pin-city', renderIcon('pin', store.settings.colors.city, 4)); }

  // ---------- theme / visited paint ----------
  applyTheme() {
    const T = THEMES[store.settings.theme] || THEMES.midnight;
    const m = this.map, P = (l, k, v) => m.getLayer(l) && m.setPaintProperty(l, k, v);
    P('bg', 'background-color', T.ocean);
    P('graticule', 'line-color', T.grat);
    P('states-line', 'line-color', T.stateLine);
    P('countries-line', 'line-color', T.border);
    for (const l of ['countries-hover', 'sel-state', 'sel-country']) P(l, 'line-color', T.selected);
    P('ocean-labels', 'text-color', T.ocLabel);
    P('city-dots', 'circle-color', T.text); P('city-dots', 'circle-stroke-color', T.halo);
    for (const l of ['city-labels', 'state-labels', 'country-labels', 'visited-cities']) { P(l, 'text-color', T.text); P(l, 'text-halo-color', T.halo); }
    this.theme = T;
    this.refreshVisited();
    this._applySky();
  }

  refreshVisited() {
    const m = this.map; if (!m.getLayer('countries-fill')) return;
    const C = store.settings.colors, T = this.theme || THEMES.midnight;
    const vc = store.countries(), vs = store.states(), vl = store.landmarks();
    m.setPaintProperty('countries-fill', 'fill-color', T.land);
    m.setFilter('countries-visited', ['in', ['get', 'id'], ['literal', vc]]);
    m.setPaintProperty('countries-visited', 'fill-color', C.country);
    m.setFilter('states-fill', ['in', ['get', 'id'], ['literal', vs]]);
    m.setPaintProperty('states-fill', 'fill-color', C.state);
    m.setFilter('landmark-glow', ['in', ['get', 'id'], ['literal', vl]]);
    m.setPaintProperty('landmark-glow', 'circle-color', C.landmark);
    m.setPaintProperty('landmarks', 'icon-opacity', ['case', ['in', ['get', 'id'], ['literal', vl]], 1, 0.82]);
    m.getSource('visited-cities').setData(fc(store.cities().map(([id, c]) => pt([c.lon, c.lat], { id: +id, n: c.n, cid: c.c }))));
    // hide the plain dot/label for cities already shown as pins
    const ids = store.cities().map(([id]) => +id);
    const notVisited = ['!', ['in', ['get', 'id'], ['literal', ids]]];
    m.setFilter('city-dots', ['all', ['>=', ['zoom'], ['get', 'mz']], notVisited]);
    m.setFilter('city-labels', ['all', ['>=', ['zoom'], ['get', 'mz']], notVisited]);
  }
  refreshColors() { this._makePins(); this.refreshVisited(); }

  // ---------- projection ----------
  applyProjection(initial) {
    const p = store.settings.projection === 'mercator' ? 'mercator' : 'globe';
    const m = this.map;
    m.setProjection({ type: p });
    this.container.classList.toggle('is-globe', p === 'globe');
    if (p === 'globe') m.setMinZoom(0);
    else {
      const minZ = Math.max(0, Math.log2((this.container.clientWidth - (this.panelPad?.right || 0)) / 512) - 0.05);
      m.setMinZoom(minZ);
      if (!initial && m.getZoom() < minZ) m.easeTo({ zoom: minZ });
    }
    this._applySky();
  }
  _applySky() {
    const T = this.theme || THEMES.midnight;
    try {
      this.map.setSky({ 'sky-color': T.sky, 'horizon-color': T.horizon, 'fog-color': T.horizon,
        'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 4, 0.6, 7, 0] });
    } catch { /* older engines */ }
  }

  // ---------- cities ----------
  _setCities() {
    const seen = new Set(), feats = [];
    for (const [, list] of this.loadedCityFeatures) for (const f of list) { seen.add(f.properties.id); feats.push(f); }
    for (const [gid, n, cid, lat, lon, p, cap] of DATA.major) {
      if (seen.has(gid)) continue;
      feats.push(pt([lon, lat], { id: gid, n, cid, p, cap, mz: cap ? 2 : cityMinZoom(p, 0) }));
    }
    this.map.getSource('cities').setData(fc(feats));
  }
  async ensureCities(cids) {
    const todo = cids.filter(c => !this.loadedCityFeatures.has(c) && DATA.meta.countries[c]?.ncities);
    if (!todo.length) return;
    await Promise.all(todo.map(async cid => {
      const d = await loadCountryCities(cid);
      this.loadedCityFeatures.set(cid, d.cities.map(([gid, n, lat, lon, p, si, flag]) =>
        pt([lon, lat], { id: gid, n, cid, sid: si >= 0 ? d.states[si][0] : '', p, cap: flag === 2 ? 1 : 0, mz: cityMinZoom(p, flag) })));
    }));
    // keep memory bounded
    while (this.loadedCityFeatures.size > 14) this.loadedCityFeatures.delete(this.loadedCityFeatures.keys().next().value);
    this._setCities();
  }
  _autoLoadCities() {
    const m = this.map;
    if (m.getZoom() < 3.6) return;
    const feats = m.queryRenderedFeatures({ layers: ['countries-fill'] });
    const ids = [...new Set(feats.map(f => f.properties.id))];
    if (ids.length > 10) return;
    this.ensureCities(ids).catch(console.warn);
  }

  // ---------- interaction ----------
  _wire() {
    const m = this.map;
    let hoverC = '', hoverS = '';
    const clickable = ['landmarks', 'visited-cities', 'city-dots', 'city-labels'];
    m.on('mousemove', e => {
      const z = m.getZoom();
      const top = m.queryRenderedFeatures(e.point, { layers: clickable });
      const c = m.queryRenderedFeatures(e.point, { layers: ['countries-fill'] })[0]?.properties.id || '';
      const s = z >= 3 ? this._stateAtPoint(e.point) : '';
      if (c !== hoverC) { hoverC = c; m.setFilter('countries-hover', ['==', ['get', 'id'], c]); }
      if (s !== hoverS) { hoverS = s; m.setFilter('states-hover', ['==', ['get', 'id'], s]); }
      m.getCanvas().style.cursor = top.length || c ? 'pointer' : '';
      this.dispatchEvent(new CustomEvent('hover', { detail: { country: c, state: s, point: e.point, feature: top[0] } }));
    });
    m.on('mouseout', () => { m.setFilter('countries-hover', ['==', ['get', 'id'], '']); m.setFilter('states-hover', ['==', ['get', 'id'], '']); hoverC = hoverS = '';
      this.dispatchEvent(new CustomEvent('hover', { detail: {} })); });
    m.on('click', e => {
      const pad = 6, bb = [[e.point.x - pad, e.point.y - pad], [e.point.x + pad, e.point.y + pad]];
      const hit = m.queryRenderedFeatures(bb, { layers: clickable });
      const lm = hit.find(f => f.layer.id === 'landmarks');
      if (lm) return this.emitSelect('landmark', lm.properties.id, e.lngLat);
      const city = hit.find(f => f.layer.id !== 'landmarks');
      if (city) return this.emitSelect('city', city.properties.id, e.lngLat, city.properties);
      const z = m.getZoom();
      const cid = m.queryRenderedFeatures(e.point, { layers: ['countries-fill'] })[0]?.properties.id;
      if (!cid) { this.dispatchEvent(new CustomEvent('blank')); return; }
      const sid = z >= 3 ? this._stateAtPoint(e.point) : '';
      // first click on a country selects the country; clicking inside an already-selected country picks the state
      if (sid && (z >= 4.2 || (this.selected && (this.selected.type === 'country' && this.selected.id === cid || this.selected.type === 'state'))))
        return this.emitSelect('state', sid, e.lngLat);
      this.emitSelect('country', cid, e.lngLat);
    });
    m.on('moveend', () => this._autoLoadCities());
    m.on('zoomend', () => this.dispatchEvent(new CustomEvent('zoom', { detail: m.getZoom() })));
  }
  _stateAtPoint(point) {
    return this.map.queryRenderedFeatures(point, { layers: ['states-hit'] })[0]?.properties.id || '';
  }
  emitSelect(type, id, lngLat, props) {
    this.dispatchEvent(new CustomEvent('select', { detail: { type, id, lngLat, props } }));
  }

  setSelection(sel) {
    this.selected = sel;
    const m = this.map;
    const cid = sel?.type === 'country' ? sel.id : sel?.type === 'state' ? DATA.meta.states[sel.id]?.cid : '';
    m.setFilter('sel-country', ['==', ['get', 'id'], sel?.type === 'country' ? sel.id : '']);
    m.setFilter('sel-state', ['==', ['get', 'id'], sel?.type === 'state' ? sel.id : '']);
    if (cid) this.ensureCities([cid]).catch(console.warn);
  }

  // ---------- camera ----------
  fitBBox(b, opts = {}) {
    // map padding (side panel) is already applied; this padding is added on top of it
    const small = this.container.clientWidth <= 820;
    const pad = small ? 16 : 40;
    const bounds = [[b[0], b[1]], [b[2], b[3]]];
    const cam = this.map.cameraForBounds(bounds, { padding: pad, maxZoom: opts.maxZoom || 9 });
    if (cam) this.map.flyTo({ ...cam, speed: 1.4, ...opts, maxZoom: undefined });
    else this.map.flyTo({ center: [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2], zoom: 4, speed: 1.4 });
  }
  flyTo(lon, lat, zoom = 8) {
    this.map.flyTo({ center: [lon, lat], zoom, speed: 1.4, padding: this.panelPad });
  }

  showPopup(lngLat, html, onOpen) {
    if (this.popup) this.popup.remove();
    this.popup = new maplibregl.Popup({ closeButton: true, maxWidth: '300px', offset: { top: [0, 12], bottom: [0, -22], left: [16, -6], right: [-16, -6], 'top-left': [10, 10], 'top-right': [-10, 10], 'bottom-left': [10, -16], 'bottom-right': [-10, -16], center: [0, 0] }, className: 'pix-popup', focusAfterOpen: false })
      .setLngLat(lngLat).setHTML(html).addTo(this.map);
    onOpen?.(this.popup.getElement());
    return this.popup;
  }
  closePopup() { this.popup?.remove(); this.popup = null; }

  // ---------- markers ----------
  setMarker(kind, lonlat, title) {
    this.markers = this.markers || {};
    this.markers[kind]?.remove();
    if (!lonlat) { delete this.markers[kind]; return; }
    const el = document.createElement('div');
    el.className = 'pix-marker pix-' + kind;
    el.title = title || '';
    const cv = renderIcon(kind === 'home' ? 'house' : 'you', '#fff', 3);
    el.appendChild(cv);
    this.markers[kind] = new maplibregl.Marker({ element: el, anchor: kind === 'home' ? 'bottom' : 'center' }).setLngLat(lonlat).addTo(this.map);
    el.addEventListener('click', ev => { ev.stopPropagation(); this.dispatchEvent(new CustomEvent('marker', { detail: { kind, lngLat: lonlat } })); });
  }
}

// ---------- helpers ----------
export function worldZoom(proj, el) {
  const w = el.clientWidth;
  if (proj === 'globe') return w <= 820 ? 0.7 : w < 1200 ? 1.35 : 1.75;
  return Math.max(0, Math.log2((w - (w > 820 ? Math.min(440, w * 0.38) + 20 : 0)) / 512) - 0.05);
}
function fc(features) { return { type: 'FeatureCollection', features }; }
function pt(coords, properties) { return { type: 'Feature', geometry: { type: 'Point', coordinates: coords }, properties }; }
function graticule() {
  const f = [];
  for (let x = -180; x <= 180; x += 20) { const c = []; for (let y = -80; y <= 80; y += 2) c.push([x, y]); f.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: c }, properties: {} }); }
  for (let y = -60; y <= 80; y += 20) { const c = []; for (let x = -180; x <= 180; x += 2) c.push([x, y]); f.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: c }, properties: {} }); }
  return fc(f);
}
