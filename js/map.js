// The map: MapLibre GL with our own vector data, globe + flat projections, pixel-art landmarks.
import { store } from './store.js';
import { DATA, loadCountryCities, cityMinZoom, loadStates } from './data.js';
import { LANDMARKS } from './landmarks.js';
import { renderSprite, renderIcon } from './sprites.js';

const maplibregl = window.maplibregl;

export const THEMES = {
  midnight: { label: 'Midnight', road: '#5a6880', road2: '#4a566b', building: '#465063', wood: '#3f6b4f', river: '#16304f', ocean: '#0c1f38', land: '#4a4e57', border: '#7d8aa3', stateLine: '#6a7891', grat: '#2a4a73',
              text: '#dfe8f5', halo: '#0c1f38', ocLabel: '#4f78ad', selected: '#ffffff', sky: '#0a1830', horizon: '#3b6fb5' },
  atlas:    { label: 'Atlas',    road: '#f4efe4', road2: '#e8e2d5', building: '#c4bdae', wood: '#a3bb8a', river: '#9ec8c4', ocean: '#b4d4d0', land: '#d3cfc7', border: '#8c8274', stateLine: '#a69c8d', grat: '#93b9b5',
              text: '#3e352c', halo: '#efe9dc', ocLabel: '#5b8b86', selected: '#2b2118', sky: '#cfe3e0', horizon: '#f2e8d2' },
  arcade:   { label: 'Arcade',   road: '#6c62b8', road2: '#575089', building: '#555170', wood: '#3e6a5c', river: '#22104a', ocean: '#170a35', land: '#4c4b55', border: '#8f7bff', stateLine: '#6c5fc0', grat: '#3a1f7a',
              text: '#f4eaff', halo: '#170a35', ocLabel: '#7d5cff', selected: '#00f5d4', sky: '#12062b', horizon: '#ff3ea5' },
  daylight: { label: 'Daylight', road: '#ffffff', road2: '#f3f4f6', building: '#cdd1d8', wood: '#bcd9b4', river: '#bfe0f2', ocean: '#cfe7f5', land: '#d9dce1', border: '#ffffff', stateLine: '#b9bfc8', grat: '#b7d7ea',
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
    this.hd = new Map(); // cid -> high-detail state polygons
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
      center: [10, 25], zoom: worldZoom(proj, this.container), minZoom: 0, maxZoom: 17,
      attributionControl: false, renderWorldCopies: true, dragRotate: false, pitchWithRotate: false,
      localIdeographFontFamily: "'Noto Sans', sans-serif",
    });
    this.map.touchZoomRotate.disableRotation();
    this.map.addControl(new maplibregl.AttributionControl({ compact: true,
      customAttribution: 'Borders © <a href="https://www.naturalearthdata.com/" target="_blank" rel="noopener">Natural Earth</a> · Cities © <a href="https://www.geonames.org/" target="_blank" rel="noopener">GeoNames</a> (CC BY 4.0)' }), 'bottom-left');
    this._applyPadding();
    window.addEventListener('resize', () => { this._applyPadding(); if (store.settings.projection === 'mercator') this.applyProjection(); });
    return new Promise(res => this.map.on('load', () => { this._build(); res(this); }));
  }
  /** Keep the map centred in the area not covered by the side panel. */
  _applyPadding() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    this.panelPad = w > 820 ? { top: 80, right: Math.min(440, w * 0.38) + 20, bottom: 0, left: 0 }
      : { top: 70, right: 0, bottom: Math.min(this.bottomPad ?? 150, h * 0.6), left: 0 };
    this.map.setPadding(this.panelPad);
  }
  /** phones: keep the map centred in the part not covered by the bottom sheet */
  setBottomPad(px) {
    if (this.container.clientWidth > 820) return;
    this.bottomPad = px;
    this._applyPadding();
  }

  _build() {
    const m = this.map;
    const meta = DATA.meta;
    // images
    for (const key of new Set(LANDMARKS.map(l => l.sprite))) this._addCanvasImage('lm-' + key, renderSprite(key, 4));
    this._makePins();

    // sources
    m.addSource('omt', { type: 'vector', url: 'https://tiles.openfreemap.org/planet' }); // real OpenStreetMap data
    m.addSource('countries', { type: 'geojson', data: DATA.countriesGeo, promoteId: 'id', tolerance: 0.3 });
    m.addSource('states', { type: 'geojson', data: { type: 'FeatureCollection', features: [] }, promoteId: 'id', tolerance: 0.3 });
    // state borders arrive a moment after the map is visible
    loadStates().then(g => m.getSource('states').setData(g)).catch(console.warn);
    m.addSource('states-hd', { type: 'geojson', data: fc([]), tolerance: 0.2 });
    m.addSource('graticule', { type: 'geojson', data: graticule() });
    m.addSource('country-labels', { type: 'geojson', data: fc(Object.entries(meta.countries).map(([id, c]) =>
      pt(c.label, { id, name: c.name, area: c.area || 0, mz: c.area > 1.5e6 ? 1 : c.area > 4e5 ? 2 : c.area > 1e5 ? 3 : c.area > 2e4 ? 4 : 5 }))) });
    m.addSource('state-labels', { type: 'geojson', data: fc(Object.entries(meta.states).map(([id, s]) => pt(s.label, { id, name: s.name, cid: s.cid }))) });
    m.addSource('ocean-labels', { type: 'geojson', data: fc(OCEANS.map(([name, x, y]) => pt([x, y], { name }))) });
    m.addSource('cities', { type: 'geojson', data: fc([]) });
    m.addSource('visited-cities', { type: 'geojson', data: fc([]) });
    m.addSource('wish-cities', { type: 'geojson', data: fc([]) });
    m.addSource('landmarks', { type: 'geojson', data: fc(LANDMARKS.map(l => pt([l.lon, l.lat], { id: l.id, name: l.name, icon: 'lm-' + l.sprite, rank: l.rank, cat: l.cat }))) });

    const T = THEMES.midnight;
    const add = l => m.addLayer(l);
    // Latin-script names only: readable for most visitors, and matches the bundled font ranges
    const NAME = ['coalesce', ['get', 'name:en'], ['get', 'name:latin'], ''];
    const NONE = ['==', ['get', 'id'], ''];
    const fillOp = (a, b, c, d) => ['interpolate', ['linear'], ['zoom'], 3, a, 6, b, 10, c, 15, d];
    // land is the background; real OSM water is drawn on top of the visited colours, so coastlines are exact
    add({ id: 'landcover', type: 'fill', source: 'omt', 'source-layer': 'landcover', filter: ['in', ['get', 'class'], ['literal', ['wood', 'forest', 'ice', 'glacier', 'sand', 'wetland', 'grass', 'rock']]],
      paint: { 'fill-color': ['match', ['get', 'class'], ['ice', 'glacier'], '#e9f1f7', 'sand', '#d9c9a0', 'rock', '#9a9aa2', T.wood],
        'fill-opacity': ['match', ['get', 'class'], ['ice', 'glacier'], 0.55, ['wood', 'forest'], 0.28, 0.14] } });
    add({ id: 'park', type: 'fill', source: 'omt', 'source-layer': 'park', minzoom: 8, paint: { 'fill-color': T.wood, 'fill-opacity': 0.25 } });
    // our own land shapes: visible when zoomed out (so the globe still has continents if OSM tiles are slow/down),
    // invisible but still used for hit-testing when zoomed in (OSM detail takes over there)
    add({ id: 'countries-fill', type: 'fill', source: 'countries', paint: { 'fill-color': T.land, 'fill-opacity': ['step', ['zoom'], 1, 5, 0] } });
    m.moveLayer('countries-fill', 'landcover');
    add({ id: 'states-hit', type: 'fill', source: 'states', paint: { 'fill-color': '#000', 'fill-opacity': 0 } });
    add({ id: 'states-hit-hd', type: 'fill', source: 'states-hd', paint: { 'fill-color': '#000', 'fill-opacity': 0 } });
    add({ id: 'countries-visited', type: 'fill', source: 'countries', filter: NONE, paint: { 'fill-color': '#2ec4b6', 'fill-opacity': fillOp(0.92, 0.6, 0.38, 0.25) } });
    add({ id: 'countries-visited-hd', type: 'fill', source: 'states-hd', filter: NONE, paint: { 'fill-color': '#2ec4b6', 'fill-antialias': false, 'fill-opacity': fillOp(0.95, 0.75, 0.45, 0.28) } });
    add({ id: 'states-fill', type: 'fill', source: 'states', filter: NONE, paint: { 'fill-color': '#ffb703', 'fill-opacity': fillOp(0.95, 0.72, 0.48, 0.3) } });
    add({ id: 'states-fill-hd', type: 'fill', source: 'states-hd', filter: NONE, paint: { 'fill-color': '#ffb703', 'fill-opacity': fillOp(0.97, 0.85, 0.55, 0.32) } });
    add({ id: 'states-hover', type: 'fill', source: 'states', filter: NONE, minzoom: 3, paint: { 'fill-color': '#ffffff', 'fill-opacity': 0.12 } });
    add({ id: 'states-hover-hd', type: 'fill', source: 'states-hd', filter: NONE, paint: { 'fill-color': '#ffffff', 'fill-opacity': 0.12 } });
    // wishlist: light tint + diagonal stripes + dashed edge, so it never looks like a visited place
    for (const [id, src] of [['wish-c', 'countries'], ['wish-c-hd', 'states-hd'], ['wish-s', 'states'], ['wish-s-hd', 'states-hd']]) {
      add({ id: id + '-tint', type: 'fill', source: src, filter: NONE, paint: { 'fill-color': '#e879f9', 'fill-opacity': 0.13 } });
      add({ id: id + '-hatch', type: 'fill', source: src, filter: NONE, paint: { 'fill-pattern': 'wish-hatch', 'fill-opacity': 0.9 } });
    }
    add({ id: 'water', type: 'fill', source: 'omt', 'source-layer': 'water', filter: ['!=', ['get', 'brunnel'], 'tunnel'], paint: { 'fill-color': T.ocean } });
    add({ id: 'waterway', type: 'line', source: 'omt', 'source-layer': 'waterway', minzoom: 6, filter: ['!=', ['get', 'brunnel'], 'tunnel'],
      paint: { 'line-color': T.ocean, 'line-width': ['interpolate', ['exponential', 1.4], ['zoom'], 6, ['match', ['get', 'class'], 'river', 0.8, 0.3], 14, ['match', ['get', 'class'], 'river', 5, 1.5]] } });
    add({ id: 'graticule', type: 'line', source: 'graticule', maxzoom: 6, paint: { 'line-color': T.grat, 'line-width': 1, 'line-dasharray': [2, 3], 'line-opacity': 0.7 } });
    add({ id: 'building', type: 'fill', source: 'omt', 'source-layer': 'building', minzoom: 13, paint: { 'fill-color': T.building, 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 13, 0, 15, 0.7] } });
    const roadW = (minor, major) => ['interpolate', ['exponential', 1.5], ['zoom'], 5, ['match', ['get', 'class'], 'motorway', major * 0.15, 'trunk', major * 0.12, 0.1],
      10, ['match', ['get', 'class'], ['motorway', 'trunk'], major * 0.6, 'primary', major * 0.45, ['secondary', 'tertiary'], minor * 0.5, minor * 0.25],
      16, ['match', ['get', 'class'], ['motorway', 'trunk'], major * 3, 'primary', major * 2.4, ['secondary', 'tertiary'], minor * 2.2, minor * 1.6]];
    add({ id: 'road-minor', type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom: 11,
      filter: ['all', ['in', ['get', 'class'], ['literal', ['minor', 'service', 'secondary', 'tertiary']]], ['!=', ['get', 'brunnel'], 'tunnel']],
      layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': T.road2, 'line-width': roadW(3, 4), 'line-opacity': ['interpolate', ['linear'], ['zoom'], 11, 0.4, 14, 0.9] } });
    add({ id: 'road-major', type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom: 5,
      filter: ['all', ['in', ['get', 'class'], ['literal', ['motorway', 'trunk', 'primary']]], ['!=', ['get', 'brunnel'], 'tunnel']],
      layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': T.road, 'line-width': roadW(3, 4), 'line-opacity': ['interpolate', ['linear'], ['zoom'], 5, 0.35, 9, 0.85] } });
    add({ id: 'rail', type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom: 12, filter: ['==', ['get', 'class'], 'rail'],
      paint: { 'line-color': T.road2, 'line-width': 1, 'line-dasharray': [3, 2], 'line-opacity': 0.7 } });
    // borders: simplified world lines when zoomed out, real OSM boundaries when zoomed in
    add({ id: 'states-line', type: 'line', source: 'states', minzoom: 2.2, maxzoom: 5.5, paint: {
      'line-color': T.stateLine, 'line-width': ['interpolate', ['linear'], ['zoom'], 3, 0.4, 5, 0.9],
      'line-opacity': ['interpolate', ['linear'], ['zoom'], 2.2, 0, 3.5, 0.75, 5, 0.75, 5.5, 0] } });
    add({ id: 'countries-line', type: 'line', source: 'countries', maxzoom: 5.5, paint: {
      'line-color': T.border, 'line-width': ['interpolate', ['linear'], ['zoom'], 0, 0.5, 4, 1.1],
      'line-opacity': ['interpolate', ['linear'], ['zoom'], 4.8, 1, 5.5, 0] } });
    add({ id: 'osm-state-line', type: 'line', source: 'omt', 'source-layer': 'boundary', minzoom: 4.8,
      filter: ['all', ['==', ['get', 'admin_level'], 4], ['!=', ['get', 'maritime'], 1]],
      paint: { 'line-color': T.stateLine, 'line-dasharray': [3, 2], 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.8, 12, 1.8],
        'line-opacity': ['interpolate', ['linear'], ['zoom'], 4.8, 0, 5.5, 0.85] } });
    for (const disputed of [0, 1]) add({ id: disputed ? 'osm-disputed-line' : 'osm-country-line', type: 'line', source: 'omt', 'source-layer': 'boundary', minzoom: 4.8,
      filter: ['all', ['==', ['get', 'admin_level'], 2], ['!=', ['get', 'maritime'], 1], disputed ? ['==', ['get', 'disputed'], 1] : ['!=', ['get', 'disputed'], 1]],
      paint: { 'line-color': T.border, 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 1.2, 12, 3], ...(disputed ? { 'line-dasharray': [2, 2] } : {}),
        'line-opacity': ['interpolate', ['linear'], ['zoom'], 4.8, 0, 5.5, 1] } });
    add({ id: 'countries-hover', type: 'line', source: 'countries', filter: NONE, maxzoom: 6, paint: { 'line-color': T.selected, 'line-width': 1.6, 'line-opacity': 0.7 } });
    add({ id: 'sel-state', type: 'line', source: 'states', filter: NONE, paint: { 'line-color': T.selected, 'line-width': 2.5, 'line-dasharray': [2, 1] } });
    add({ id: 'sel-state-hd', type: 'line', source: 'states-hd', filter: NONE, paint: { 'line-color': T.selected, 'line-width': 2.5, 'line-dasharray': [2, 1] } });
    add({ id: 'sel-country', type: 'line', source: 'countries', filter: NONE, paint: { 'line-color': T.selected, 'line-width': 3,
      'line-opacity': ['interpolate', ['linear'], ['zoom'], 5, 1, 8, 0.25] } });
    add({ id: 'ocean-labels', type: 'symbol', source: 'ocean-labels', maxzoom: 5, layout: {
      'text-field': ['get', 'name'], 'text-font': ['Noto Sans Italic'], 'text-size': ['interpolate', ['linear'], ['zoom'], 1, 9, 4, 13],
      'text-letter-spacing': 0.3, 'text-max-width': 6 }, paint: { 'text-color': T.ocLabel } });
    for (const line of [false, true]) add({ id: line ? 'water-names-line' : 'water-names', type: 'symbol', source: 'omt', 'source-layer': line ? 'waterway' : 'water_name', minzoom: line ? 11 : 5,
      filter: line ? ['==', ['get', 'class'], 'river'] : ['all', ['!=', ['get', 'class'], 'ocean'], ['==', ['geometry-type'], 'Point']], layout: {
      'text-field': NAME, 'text-font': ['Noto Sans Italic'], 'text-size': ['interpolate', ['linear'], ['zoom'], 5, 10, 14, 14],
      'text-letter-spacing': 0.1, 'text-max-width': 7, 'symbol-placement': line ? 'line' : 'point' },
      paint: { 'text-color': T.ocLabel, 'text-halo-color': T.ocean, 'text-halo-width': 1 } });
    add({ id: 'road-names', type: 'symbol', source: 'omt', 'source-layer': 'transportation_name', minzoom: 14, layout: {
      'text-field': NAME, 'text-font': ['Noto Sans Regular'], 'text-size': 11, 'symbol-placement': 'line', 'text-max-angle': 30 },
      paint: { 'text-color': T.text, 'text-opacity': 0.75, 'text-halo-color': T.halo, 'text-halo-width': 1.2 } });
    add({ id: 'place-names', type: 'symbol', source: 'omt', 'source-layer': 'place', minzoom: 9,
      filter: ['any', ['all', ['==', ['get', 'class'], 'island'], ['>=', ['zoom'], 9]],
                      ['all', ['in', ['get', 'class'], ['literal', ['suburb', 'borough', 'quarter']]], ['>=', ['zoom'], 11]],
                      ['all', ['==', ['get', 'class'], 'neighbourhood'], ['>=', ['zoom'], 13]]],
      layout: { 'text-field': NAME, 'text-font': ['Noto Sans Medium'], 'text-transform': 'uppercase', 'text-letter-spacing': 0.12,
        'text-size': ['match', ['get', 'class'], 'island', 12, ['suburb', 'borough'], 12, 10], 'text-max-width': 8, 'text-padding': 4 },
      paint: { 'text-color': T.text, 'text-opacity': 0.7, 'text-halo-color': T.halo, 'text-halo-width': 1.4 } });
    add({ id: 'city-dots', type: 'circle', source: 'cities', filter: ['>=', ['zoom'], ['get', 'mz']], paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 2, ['case', ['==', ['get', 'cap'], 1], 2.6, 1.8], 8, ['case', ['==', ['get', 'cap'], 1], 4.5, 3.2]],
      'circle-color': T.text, 'circle-opacity': 0.75, 'circle-stroke-color': T.halo, 'circle-stroke-width': 1 } });
    add({ id: 'city-labels', type: 'symbol', source: 'cities', filter: ['>=', ['zoom'], ['get', 'mz']], layout: {
      'text-field': ['get', 'n'], 'text-font': ['Noto Sans Regular'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 2, ['case', ['==', ['get', 'cap'], 1], 11, 10], 10, ['case', ['==', ['get', 'cap'], 1], 15, 13]],
      'text-variable-anchor': ['left', 'right', 'top', 'bottom'], 'text-radial-offset': 0.6, 'text-justify': 'auto',
      'symbol-sort-key': ['-', 0, ['get', 'p']], 'text-optional': true }, paint: { 'text-color': T.text, 'text-halo-color': T.halo, 'text-halo-width': 1.4, 'text-opacity': 0.9 } });
    add({ id: 'state-labels', type: 'symbol', source: 'state-labels', minzoom: 4.2, maxzoom: 9, layout: {
      'text-field': ['get', 'name'], 'text-font': ['Noto Sans Italic'], 'text-size': ['interpolate', ['linear'], ['zoom'], 4, 9.5, 8, 13],
      'text-transform': 'uppercase', 'text-letter-spacing': 0.12, 'text-max-width': 7, 'text-padding': 6 },
      paint: { 'text-color': T.text, 'text-opacity': 0.6, 'text-halo-color': T.halo, 'text-halo-width': 1 } });
    add({ id: 'country-labels', type: 'symbol', source: 'country-labels', filter: ['>=', ['zoom'], ['get', 'mz']], maxzoom: 7.5, layout: {
      'text-field': ['get', 'name'], 'text-font': ['Noto Sans Medium'], 'text-transform': 'uppercase',
      'text-size': ['interpolate', ['linear'], ['zoom'], 1, ['case', ['>', ['get', 'area'], 3e6], 11, 9],
        6, ['case', ['>', ['get', 'area'], 3e6], 20, ['>', ['get', 'area'], 1e5], 16, ['>', ['get', 'area'], 1e4], 12, 9.5]],
      'text-letter-spacing': 0.14, 'text-max-width': 7, 'symbol-sort-key': ['-', 0, ['get', 'area']], 'text-padding': 4 },
      paint: { 'text-color': T.text, 'text-halo-color': T.halo, 'text-halo-width': 1.6 } });
    add({ id: 'wish-c-line', type: 'line', source: 'countries', filter: NONE, paint: { 'line-color': '#e879f9', 'line-width': 1.6, 'line-dasharray': [2, 2], 'line-opacity': 0.9 } });
    add({ id: 'wish-s-line', type: 'line', source: 'states', filter: NONE, minzoom: 2, paint: { 'line-color': '#e879f9', 'line-width': 1.2, 'line-dasharray': [2, 2], 'line-opacity': 0.8 } });
    add({ id: 'landmark-wish', type: 'circle', source: 'landmarks', filter: NONE, minzoom: 3, paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 12, 6, 17, 9, 24], 'circle-color': 'rgba(0,0,0,0)',
      'circle-stroke-color': '#e879f9', 'circle-stroke-width': 2.5, 'circle-stroke-opacity': 0.95 } });
    add({ id: 'landmark-glow', type: 'circle', source: 'landmarks', filter: ['in', ['get', 'id'], ['literal', []]], minzoom: 3, paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, 9, 5, 16, 9, 24], 'circle-color': '#ffd447', 'circle-blur': 0.7, 'circle-opacity': 0.75 } });
    // wonders appear once you zoom in past the whole-globe view
    add({ id: 'landmarks', type: 'symbol', source: 'landmarks', minzoom: 3, layout: {
      'icon-image': ['get', 'icon'], 'icon-size': ['interpolate', ['linear'], ['zoom'], 3, 0.6, 5, 0.8, 9, 1.25],
      'icon-anchor': 'bottom', 'icon-padding': 1, 'symbol-sort-key': ['get', 'rank'],
      'text-field': ['step', ['zoom'], '', 5.5, ['get', 'name']], 'text-font': ['Noto Sans Medium'], 'text-size': 11,
      'text-anchor': 'top', 'text-offset': [0, 0.2], 'text-optional': true, 'text-max-width': 9 },
      paint: { 'text-color': '#ffe08a', 'text-halo-color': '#1e1830', 'text-halo-width': 1.6 } });
    add({ id: 'wish-cities', type: 'symbol', source: 'wish-cities', layout: {
      'icon-image': 'pin-wish', 'icon-anchor': 'bottom', 'icon-allow-overlap': true, 'icon-size': ['interpolate', ['linear'], ['zoom'], 1, 0.5, 6, 0.8, 10, 1],
      'text-field': ['step', ['zoom'], '', 4, ['get', 'n']], 'text-font': ['Noto Sans Italic'], 'text-size': 11,
      'text-anchor': 'top', 'text-offset': [0, 0.15], 'text-optional': true }, paint: { 'icon-opacity': 0.85, 'text-color': '#f5d0fe', 'text-halo-color': '#1e1830', 'text-halo-width': 1.4 } });
    add({ id: 'visited-cities', type: 'symbol', source: 'visited-cities', layout: {
      'icon-image': 'pin-city', 'icon-anchor': 'bottom', 'icon-allow-overlap': true, 'icon-size': ['interpolate', ['linear'], ['zoom'], 1, 0.55, 6, 0.85, 10, 1.1],
      'text-field': ['step', ['zoom'], '', 3.5, ['get', 'n']], 'text-font': ['Noto Sans Medium'], 'text-size': 12,
      'text-anchor': 'top', 'text-offset': [0, 0.15], 'text-optional': true }, paint: { 'text-color': T.text, 'text-halo-color': T.halo, 'text-halo-width': 1.6 } });

    m.moveLayer('country-labels'); // country names win label placement over sprites
    this.applyLandmarkVisibility();
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
  _makePins() {
    this._addCanvasImage('pin-city', renderIcon('pin', store.settings.colors.city, 4));
    this._addCanvasImage('pin-wish', renderIcon('pin', store.settings.colors.wish, 4));
    // seamless diagonal stripes for wishlist areas
    const c = document.createElement('canvas'); c.width = c.height = 24;
    const x = c.getContext('2d'); x.fillStyle = store.settings.colors.wish;
    for (let i = 0; i < 24; i++) for (let j = 0; j < 24; j++) if ((i + j) % 12 < 3) x.fillRect(i, j, 1, 1);
    this._addCanvasImage('wish-hatch', c);
  }

  // ---------- theme / visited paint ----------
  applyTheme() {
    const T = THEMES[store.settings.theme] || THEMES.midnight;
    const m = this.map, P = (l, k, v) => m.getLayer(l) && m.setPaintProperty(l, k, v);
    P('bg', 'background-color', ['step', ['zoom'], T.ocean, 5, T.land]);
    P('countries-fill', 'fill-color', T.land);
    P('water', 'fill-color', T.ocean);
    P('waterway', 'line-color', T.ocean);
    P('landcover', 'fill-color', ['match', ['get', 'class'], ['ice', 'glacier'], '#e9f1f7', 'sand', '#d9c9a0', 'rock', '#9a9aa2', T.wood]);
    P('park', 'fill-color', T.wood);
    P('building', 'fill-color', T.building);
    P('road-major', 'line-color', T.road); P('road-minor', 'line-color', T.road2); P('rail', 'line-color', T.road2);
    P('graticule', 'line-color', T.grat);
    for (const l of ['states-line', 'osm-state-line']) P(l, 'line-color', T.stateLine);
    for (const l of ['countries-line', 'osm-country-line', 'osm-disputed-line']) P(l, 'line-color', T.border);
    for (const l of ['countries-hover', 'sel-state', 'sel-state-hd', 'sel-country']) P(l, 'line-color', T.selected);
    P('ocean-labels', 'text-color', T.ocLabel);
    for (const l of ['water-names', 'water-names-line']) { P(l, 'text-color', T.ocLabel); P(l, 'text-halo-color', T.ocean); }
    for (const l of ['road-names', 'place-names']) { P(l, 'text-color', T.text); P(l, 'text-halo-color', T.halo); }
    P('city-dots', 'circle-color', T.text); P('city-dots', 'circle-stroke-color', T.halo);
    for (const l of ['city-labels', 'state-labels', 'country-labels', 'visited-cities']) { P(l, 'text-color', T.text); P(l, 'text-halo-color', T.halo); }
    this.theme = T;
    this.refreshVisited();
    this._applySky();
  }

  refreshVisited() {
    const m = this.map; if (!m.getLayer('countries-fill')) return;
    const C = store.settings.colors, T = this.theme || THEMES.midnight;
    let vc = store.visitedCountries(), vs = store.visitedStates();
    const vl = store.landmarks();
    // comparing with a friend: colour countries by who has been there, hide states
    let fill = C.country;
    if (this.compare) {
      const mine = new Set(this.compare.mine), theirs = new Set(this.compare.theirs);
      const both = [...mine].filter(c => theirs.has(c)), onlyThem = [...theirs].filter(c => !mine.has(c));
      vc = [...new Set([...mine, ...theirs])]; vs = [];
      fill = ['case', ['in', ['coalesce', ['get', 'cid'], ['get', 'id']], ['literal', both]], '#a855f7',
                      ['in', ['coalesce', ['get', 'cid'], ['get', 'id']], ['literal', onlyThem]], '#f43f5e', C.country];
    }
    // countries whose high-detail borders are loaded draw from the HD source, the rest from the simplified one
    const hd = [...this.hd.keys()];
    const notHd = ['!', ['in', ['get', 'cid'], ['literal', hd]]];
    m.setFilter('countries-visited', ['all', ['in', ['get', 'id'], ['literal', vc]], ['!', ['in', ['get', 'id'], ['literal', hd]]]]);
    m.setFilter('countries-visited-hd', ['in', ['get', 'cid'], ['literal', vc]]);
    m.setFilter('states-fill', ['all', ['in', ['get', 'id'], ['literal', vs]], notHd]);
    m.setFilter('states-fill-hd', ['in', ['get', 'id'], ['literal', vs]]);
    for (const l of ['countries-visited', 'countries-visited-hd']) m.setPaintProperty(l, 'fill-color', fill);
    for (const l of ['states-fill', 'states-fill-hd']) m.setPaintProperty(l, 'fill-color', C.state);
    m.setFilter('landmark-glow', ['in', ['get', 'id'], ['literal', vl]]);
    // wishlist (hidden while comparing with a friend, or when switched off); places already visited drop off
    const wishOn = store.settings.showWishlist !== false && !this.compare;
    const W = wishOn ? store.wishEntries() : [];
    const vcSet = new Set(vc), vsSet = new Set(vs);
    const wc = W.filter(([k]) => k.startsWith('c:')).map(([k]) => k.slice(2)).filter(c => !vcSet.has(c));
    const ws = W.filter(([k]) => k.startsWith('s:')).map(([k]) => k.slice(2)).filter(s => !vsSet.has(s));
    const wl = W.filter(([k]) => k.startsWith('l:')).map(([k]) => k.slice(2)).filter(l => !store.has('l:' + l));
    const wci = W.filter(([k]) => k.startsWith('ci:') && !store.has(k));
    const hdIds = [...this.hd.keys()];
    for (const part of ['-tint', '-hatch']) {
      m.setFilter('wish-c' + part, ['all', ['in', ['get', 'id'], ['literal', wc]], ['!', ['in', ['get', 'id'], ['literal', hdIds]]]]);
      m.setFilter('wish-c-hd' + part, ['in', ['get', 'cid'], ['literal', wc]]);
      m.setFilter('wish-s' + part, ['all', ['in', ['get', 'id'], ['literal', ws]], ['!', ['in', ['get', 'cid'], ['literal', hdIds]]]]);
      m.setFilter('wish-s-hd' + part, ['in', ['get', 'id'], ['literal', ws]]);
    }
    for (const l of ['wish-c-tint', 'wish-c-hd-tint', 'wish-s-tint', 'wish-s-hd-tint']) m.setPaintProperty(l, 'fill-color', C.wish);
    m.setFilter('wish-c-line', ['in', ['get', 'id'], ['literal', wc]]);
    m.setFilter('wish-s-line', ['in', ['get', 'id'], ['literal', ws]]);
    for (const l of ['wish-c-line', 'wish-s-line']) m.setPaintProperty(l, 'line-color', C.wish);
    m.setFilter('landmark-wish', ['in', ['get', 'id'], ['literal', wl]]);
    m.setPaintProperty('landmark-wish', 'circle-stroke-color', C.wish);
    m.getSource('wish-cities').setData(fc(wci.filter(([, c]) => c.lat != null).map(([k, c]) => pt([c.lon, c.lat], { id: +k.slice(3), n: c.n, cid: c.c }))));
    m.setPaintProperty('landmark-glow', 'circle-color', C.landmark);
    m.setPaintProperty('landmarks', 'icon-opacity', ['case', ['in', ['get', 'id'], ['literal', vl]], 1, 0.82]);
    m.getSource('visited-cities').setData(fc(store.cities().map(([id, c]) => pt([c.lon, c.lat], { id: +id, n: c.n, cid: c.c }))));
    // hide the plain dot/label for cities already shown as pins
    const ids = store.cities().map(([id]) => +id);
    const notVisited = ['!', ['in', ['get', 'id'], ['literal', ids]]];
    m.setFilter('city-dots', ['all', ['>=', ['zoom'], ['get', 'mz']], notVisited]);
    m.setFilter('city-labels', ['all', ['>=', ['zoom'], ['get', 'mz']], notVisited]);
  }
  applyLandmarkVisibility() {
    const v = store.settings.showLandmarks === false ? 'none' : 'visible';
    for (const l of ['landmarks', 'landmark-glow']) if (this.map.getLayer(l)) this.map.setLayoutProperty(l, 'visibility', v);
  }
  setCompare(cmp) { this.compare = cmp; this.refreshVisited(); }
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
    if (m.getZoom() >= 4.3) this.ensureDetail(ids).catch(console.warn);
  }
  /** Load full-resolution Natural Earth state/province polygons for these countries. */
  async ensureDetail(cids) {
    const todo = cids.filter(c => !this.hd.has(c) && DATA.meta.countries[c]?.nstates);
    if (!todo.length) return;
    await Promise.all(todo.map(async cid => {
      try { const d = await fetch(`data/detail/${cid}.json`).then(r => r.ok ? r.json() : null); if (d) this.hd.set(cid, d.features); }
      catch { /* fall back to simplified borders */ }
    }));
    while (this.hd.size > 16) this.hd.delete(this.hd.keys().next().value);
    this.map.getSource('states-hd').setData(fc([...this.hd.values()].flat()));
    this.refreshVisited();
  }

  // ---------- interaction ----------
  _wire() {
    const m = this.map;
    let hoverC = '', hoverS = '';
    const clickable = ['landmarks', 'visited-cities', 'city-dots', 'city-labels']; // hidden layers return no hits
    m.on('mousemove', e => {
      const z = m.getZoom();
      const top = m.queryRenderedFeatures(e.point, { layers: clickable });
      const c = this._countryAtPoint(e.point);
      const s = z >= 3 ? this._stateAtPoint(e.point) : '';
      if (c !== hoverC) { hoverC = c; m.setFilter('countries-hover', ['==', ['get', 'id'], c]); }
      if (s !== hoverS) { hoverS = s; m.setFilter('states-hover', ['all', ['==', ['get', 'id'], s], ['!', ['in', ['get', 'cid'], ['literal', [...this.hd.keys()]]]]]); m.setFilter('states-hover-hd', ['==', ['get', 'id'], s]); }
      m.getCanvas().style.cursor = top.length || c ? 'pointer' : '';
      this.dispatchEvent(new CustomEvent('hover', { detail: { country: c, state: s, point: e.point, feature: top[0] } }));
    });
    m.on('mouseout', () => { m.setFilter('countries-hover', ['==', ['get', 'id'], '']); m.setFilter('states-hover', ['==', ['get', 'id'], '']); m.setFilter('states-hover-hd', ['==', ['get', 'id'], '']); hoverC = hoverS = '';
      this.dispatchEvent(new CustomEvent('hover', { detail: {} })); });
    m.on('click', e => {
      const pad = 6, bb = [[e.point.x - pad, e.point.y - pad], [e.point.x + pad, e.point.y + pad]];
      const hit = m.queryRenderedFeatures(bb, { layers: clickable });
      const lm = hit.find(f => f.layer.id === 'landmarks');
      if (lm) return this.emitSelect('landmark', lm.properties.id, e.lngLat);
      const city = hit.find(f => f.layer.id !== 'landmarks');
      if (city) return this.emitSelect('city', city.properties.id, e.lngLat, city.properties);
      const z = m.getZoom();
      const cid = this._countryAtPoint(e.point);
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
  _countryAtPoint(point) {
    return this.map.queryRenderedFeatures(point, { layers: ['states-hit-hd'] })[0]?.properties.cid
      || this.map.queryRenderedFeatures(point, { layers: ['countries-fill'] })[0]?.properties.id || '';
  }
  _stateAtPoint(point) {
    return this.map.queryRenderedFeatures(point, { layers: ['states-hit-hd'] })[0]?.properties.id
      || this.map.queryRenderedFeatures(point, { layers: ['states-hit'] })[0]?.properties.id || '';
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
    m.setFilter('sel-state', ['all', ['==', ['get', 'id'], sel?.type === 'state' ? sel.id : ''], ['!', ['in', ['get', 'cid'], ['literal', [...this.hd.keys()]]]]]);
    m.setFilter('sel-state-hd', ['==', ['get', 'id'], sel?.type === 'state' ? sel.id : '']);
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
  if (proj === 'globe') return w <= 480 ? 0.95 : w <= 820 ? 1.2 : w < 1200 ? 1.35 : 1.75;
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
