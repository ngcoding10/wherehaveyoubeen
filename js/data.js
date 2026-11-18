// Data loading + geo helpers
export const DATA = { meta: null, countriesGeo: null, statesGeo: null, major: null };
const cityCache = new Map();
let indexPromise = null;

// 193 UN member states + the two UN observer states (Vatican, Palestine) = the usual "195 countries"
export const UN195 = new Set(('AF AL DZ AD AO AG AR AM AU AT AZ BS BH BD BB BY BE BZ BJ BT BO BA BW BR BN BG BF BI CV KH CM CA CF TD CL CN CO KM CG CD CR CI HR CU CY CZ DK DJ DM DO EC EG SV GQ ER EE SZ ET FJ FI FR GA GM GE DE GH GR GD GT GN GW GY HT HN HU IS IN ID IR IQ IE IL IT JM JP JO KZ KE KI KP KR KW KG LA LV LB LS LR LY LI LT LU MG MW MY MV ML MT MH MR MU MX FM MD MC MN ME MA MZ MM NA NR NP NL NZ NI NE NG MK NO OM PK PW PA PG PY PE PH PL PT QA RO RU RW KN LC VC WS SM ST SA SN RS SC SL SG SK SI SB SO ZA SS ES LK SD SR SE CH SY TJ TZ TH TL TG TO TT TN TR TM TV UG UA AE GB US UY UZ VU VE VN YE ZM ZW VA PS').split(' '));

export async function loadCore() {
  const [meta, countries, states, major] = await Promise.all([
    fetchJSON('data/meta.json'), fetchJSON('data/countries.geojson'),
    fetchJSON('data/states.geojson'), fetchJSON('data/cities_major.json'),
  ]);
  Object.assign(DATA, { meta, countriesGeo: countries, statesGeo: states, major });
  // pre-compute bboxes for point-in-polygon
  for (const f of countries.features) f._bbox = geomBBox(f.geometry);
  return DATA;
}

export async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}

/** Full city list for a country: {id, states:[[sid,name]], cities:[[gid,name,lat,lon,pop,stateIdx,flag]]} */
export function loadCountryCities(cid) {
  if (!DATA.meta.countries[cid]?.ncities) return Promise.resolve({ id: cid, states: [], cities: [] });
  if (!cityCache.has(cid)) cityCache.set(cid, fetchJSON(`data/cities/${cid}.json`).catch(e => { cityCache.delete(cid); throw e; }));
  return cityCache.get(cid);
}
export function loadedCountryIds() { return [...cityCache.keys()]; }

/** Global search index of cities with population ≥ 15k: [gid,name,cid,lat,lon,pop,stateName] */
export function loadCityIndex() {
  if (!indexPromise) indexPromise = fetchJSON('data/cities_index.json');
  return indexPromise;
}

export const country = id => DATA.meta.countries[id];
export const stateMeta = id => DATA.meta.states[id];

export function flagEmoji(cid) {
  if (!/^[A-Z]{2}$/.test(cid)) return '🏳️';
  return String.fromCodePoint(...[...cid].map(c => 0x1f1a5 + c.charCodeAt(0)));
}
export function flagURL(cid) {
  if (!/^[A-Z]{2}$/.test(cid)) return null;
  return `https://cdn.jsdelivr.net/npm/flag-icons@7.2.3/flags/4x3/${cid.toLowerCase()}.svg`;
}
export function flagHTML(cid, cls = 'flag') {
  const url = flagURL(cid);
  return url ? `<img class="${cls}" src="${url}" alt="" loading="lazy" onerror="this.replaceWith(document.createTextNode('${flagEmoji(cid)}'))">`
             : `<span class="${cls} flag-none">🏳️</span>`;
}

export function fold(s) { return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); }

export function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371, toR = Math.PI / 180;
  const dLat = (lat2 - lat1) * toR, dLon = (lon2 - lon1) * toR;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function geomBBox(g) {
  let x0 = 180, y0 = 90, x1 = -180, y1 = -90;
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  for (const p of polys) for (const [x, y] of p[0]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return [x0, y0, x1, y1];
}
function inRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function inGeom(x, y, g) {
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  return polys.some(p => inRing(x, y, p[0]) && !p.slice(1).some(h => inRing(x, y, h)));
}
/** Which country is this point in? Falls back to the nearest label point within ~300 km (coastlines are simplified). */
export function countryAt(lon, lat) {
  for (const f of DATA.countriesGeo.features) {
    const b = f._bbox;
    if (lon < b[0] || lon > b[2] || lat < b[1] || lat > b[3]) continue;
    if (inGeom(lon, lat, f.geometry)) return f.properties.id;
  }
  return null;
}
export function stateAt(lon, lat, cid) {
  for (const f of DATA.statesGeo.features) {
    if (cid && f.properties.cid !== cid) continue;
    if (!f._bbox) f._bbox = geomBBox(f.geometry);
    const b = f._bbox;
    if (lon < b[0] || lon > b[2] || lat < b[1] || lat > b[3]) continue;
    if (inGeom(lon, lat, f.geometry)) return f.properties.id;
  }
  return null;
}

/** Min zoom at which a city dot/label appears. */
export function cityMinZoom(pop, flag) {
  if (flag === 2 || pop >= 5e6) return 2;
  if (pop >= 1e6) return 3;
  if (pop >= 5e5) return 4;
  if (pop >= 2e5) return 5;
  if (pop >= 5e4) return 6;
  if (pop >= 2e4) return 7;
  if (pop >= 5e3) return 8;
  if (pop >= 1e3) return 9;
  return 10;
}

export function fmtPop(n) {
  if (!n) return '';
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
  if (n >= 1e3) return Math.round(n / 1e3) + 'k';
  return String(n);
}
export function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
