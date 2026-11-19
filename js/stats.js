// Shared stats so the panel, the ribbon and your friends' leaderboard all count the same way.
import { store } from './store.js';
import { DATA, UN195, haversine } from './data.js';

export const CONTINENTS = ['Africa', 'Asia', 'Europe', 'North America', 'South America', 'Oceania', 'Antarctica'];

export function computeStats() {
  const cs = store.visitedCountries();
  const metaC = DATA.meta.countries;
  const totalArea = Object.values(metaC).reduce((a, c) => a + (c.area || 0), 0);
  const area = cs.reduce((a, id) => a + (metaC[id]?.area || 0), 0);
  const byCont = Object.fromEntries(CONTINENTS.map(c => [c, { got: 0, total: 0 }]));
  for (const [id, c] of Object.entries(metaC)) {
    if (!UN195.has(id) || !byCont[c.cont]) continue;
    byCont[c.cont].total++;
    if (store.isVisited('c:' + id)) byCont[c.cont].got++;
  }
  if (byCont.Antarctica) { byCont.Antarctica.total = 1; byCont.Antarctica.got = store.isVisited('c:AQ') ? 1 : 0; }
  const conts = new Set(cs.map(id => metaC[id]?.cont).filter(c => CONTINENTS.includes(c))).size;
  let far = null;
  if (store.home) for (const [, c] of store.cities()) { const d = haversine(store.home.lat, store.home.lon, c.lat, c.lon); if (!far || d > far.d) far = { n: c.n, d }; }
  return {
    un: cs.filter(id => UN195.has(id)).length, terr: cs.filter(id => !UN195.has(id)).length,
    states: store.visitedStates().length, cities: store.cities().length, lms: store.landmarks().length,
    pctWorld: totalArea ? (area / totalArea) * 100 : 0, byCont, conts, far,
  };
}
