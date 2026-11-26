import { loadCore } from './data.js';
import { WorldMap } from './map.js';
import { UI } from './ui.js';
import { initCloud } from './cloud.js';
import { renderIcon } from './sprites.js';
import { store } from './store.js';
import { DATA } from './data.js';
import { lmById, loadSights } from './landmarks.js';

const bar = document.getElementById('boot-progress');
const msg = document.getElementById('boot-msg');
const step = (pct, text) => { bar.style.width = pct + '%'; if (text) msg.textContent = text; };

(async () => {
  const bp = document.getElementById('boot-plane');
  bp.getContext('2d').drawImage(renderIcon('plane', '#fff', 6), 0, 0);
  try {
    if (!window.maplibregl) throw new Error('Map engine failed to load');
    step(15, 'Unfolding the map…');
    await loadCore();
    store.resolve = {
      stateCountry: sid => DATA.meta.states[sid]?.cid,
      landmarkCountry: lid => lmById(lid)?.cc,
      landmarkPlace: lid => { const l = lmById(lid); return l ? { c: l.cc, s: l.sid, ci: l.gid } : null; },
    };
    step(60, 'Drawing 258 countries & 4,596 regions…');
    const map = await new WorldMap(document.getElementById('map')).init();
    step(90, 'Placing the wonders…');
    const ui = new UI(map);
    ui.start();
    window.__app = { map, ui };
    initCloud();
    // city sights (~250 KB) arrive after the map is on screen
    loadSights().then(() => { store._derived = null; map.addSights(); ui.onSightsLoaded(); }).catch(console.warn);
    step(100, 'Bon voyage!');
    setTimeout(() => document.getElementById('boot').classList.add('done'), 250);
  } catch (e) {
    console.error(e);
    msg.textContent = 'Something went wrong loading the map: ' + e.message + (location.protocol === 'file:' ? ' — open it through a local web server (see README).' : '');
  }
})();
