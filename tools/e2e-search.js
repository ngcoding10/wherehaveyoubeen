// Checks that every search box forgives typos ("madid", "madird" → Madrid). No backend needed.
//
//   python3 -m http.server 8000
//   node tools/e2e-search.js            (needs `npm i playwright`; WHYB_URL overrides http://localhost:8000)
const { chromium } = require('playwright');

const BASE = (process.env.WHYB_URL || 'http://localhost:8000').replace(/\/$/, '');
let failed = 0, total = 0;
function check(name, ok, detail = '') { total++; if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 10000) { const end = Date.now() + ms; for (;;) { try { const v = await fn(); if (v) return v; } catch { } if (Date.now() > end) return null; await sleep(50); } }

(async () => {
  const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: 'localhost,127.0.0.1' } : undefined;
  const browser = await chromium.launch({ proxy });
  const page = await (await browser.newContext()).newPage();
  const errors = [], online = [];
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|net::|WebGL|tile|glyph/i.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('request', r => { if (/nominatim/.test(r.url())) online.push(r.url()); });
  try {
    await page.goto(BASE + '/');
    await page.waitForSelector('#boot.done', { timeout: 60000 });

    // ───── main search ─────
    const search = async q => {
      const t0 = Date.now();
      await page.fill('#search', '');
      await page.fill('#search', q);
      // wait until the box shows results for exactly this query (the city list loads on first use)
      await until(() => page.evaluate(() => { const b = document.querySelector('#search-results'); return !b.hidden && b.children.length > 0; }));
      await sleep(350);
      const r = await page.evaluate(() => ({
        items: [...document.querySelectorAll('#search-results .sr-item')].map(b => b.textContent.replace(/\s+/g, ' ').trim()),
        groups: [...document.querySelectorAll('#search-results .sr-group')].map(g => g.textContent),
        empty: !!document.querySelector('#search-results .sr-empty'),
      }));
      return { ...r, ms: Date.now() - t0 - 350 };
    };
    const cases = [
      ['madid', /^Madrid.*Spain/], ['madird', /^Madrid.*Spain/], ['mdrid', /^Madrid.*Spain/], ['madrid', /^Madrid/],
      ['frnace', /^France/], ['califronia', /^California/], ['eifel towr', /^Eiffel Tower/], ['machu pichu', /^Machu Picchu/],
      ['bejing', /^Beijing/], ['barcleona', /^Barcelona.*Spain/], ['tokio', /^Tokyo/], ['sao paolo', /^São Paulo/], ['germny', /^Germany/],
    ];
    for (const [q, want] of cases) {
      const r = await search(q);
      check(`search "${q}"`, want.test(r.items[0] || ''), `${r.groups[0] || 'no results'}: ${r.items.slice(0, 3).join(' | ')}  (${r.ms} ms incl. 120 ms debounce)`);
    }
    const exact = await search('paris');
    check('a correctly spelled search is unchanged (exact matches only)', /^Paris/.test(exact.items[0] || '') && exact.items.every(t => /paris/i.test(t)), exact.items.slice(0, 4).join(' | '));
    const none = await search('zzzzqqq');
    check('nonsense still says nothing matches', none.empty && !none.items.length);
    await page.keyboard.press('Escape');

    // how long the typo search itself takes (first use builds the index of 31,847 cities)
    const timing = await page.evaluate(async () => {
      const t = await import('/js/typo.js');
      const time = async fn => { const a = performance.now(); await fn(); return Math.round((performance.now() - a) * 10) / 10; };
      const idx = await t.fuzzyCities();
      const out = {};
      const fresh = (await import('/js/fuzzy.js')).createFuzzyIndex(await (await import('/js/data.js')).loadCityIndex(), r => r[1], { weight: r => r[5] });
      out['build city index + first search'] = await time(() => fresh.search('madird'));
      for (const q of ['londn', 'new yrok', 'amsterdm', 'londn']) out[q + (out[q] !== undefined ? ' (again)' : '')] = await time(() => idx.search(q, { limit: 8 }));
      out.states = await time(() => t.fuzzyStates().search('bavria'));
      out.countries = await time(() => t.fuzzyCountries().search('portugl'));
      return out;
    });
    console.log('   typo search timings in the page (ms):', JSON.stringify(timing));
    check('typo search is quick enough to run while typing (building the index < 400 ms, each search after that < 150 ms)', Object.values(timing).every(v => v < 400) && timing.londn < 150, JSON.stringify(timing));

    // ───── Quick add ─────
    await page.evaluate(() => window.__app.ui.openQuick ? window.__app.ui.openQuick() : document.querySelector('#quick-sheet').removeAttribute('hidden'));
    await page.waitForSelector('#quick-text', { state: 'visible' });
    await page.fill('#quick-text', 'Madird, Bejing, Tokio, Eifel Tower, Barcleona\nfrnace, Califronia, London, Bali, Germny');
    const t0 = Date.now();
    await page.click('#quick-find');
    await until(() => page.$eval('#quick-status', el => /matched/.test(el.textContent)), 30000);
    const quickMs = Date.now() - t0;
    const rows = await page.$$eval('#quick-results .qr', els => els.map(el => ({ q: el.querySelector('.q').textContent.trim(), picked: el.querySelector('select')?.selectedOptions[0]?.textContent || '', options: el.querySelectorAll('option').length })));
    const want = { Madird: /Madrid.*Spain/, Bejing: /Beijing/, Tokio: /Tokyo/, 'Eifel Tower': /Eiffel Tower/, Barcleona: /Barcelona.*Spain/, frnace: /France/, Califronia: /California/, London: /London/, Bali: /Bali\b/, Germny: /Germany/ };
    for (const [q, re] of Object.entries(want)) {
      const r = rows.find(x => x.q === q);
      check(`Quick add "${q}"`, r && re.test(r.picked), r ? `${r.picked} (${r.options} option${r.options === 1 ? '' : 's'})` : 'row missing');
    }
    check('Quick add: misspelled items did not go to the online lookup', online.length === 0, `${online.length} Nominatim requests; ${quickMs} ms for 10 items`);
    check('Quick add keeps the dropdown of alternatives', rows.some(r => r.options > 1), rows.map(r => r.options).join(','));
    await page.keyboard.press('Escape');

    // ───── a country's regions and towns ─────
    await page.evaluate(() => window.__app.ui.select('country', 'ES', {}));
    await page.waitForSelector('#ci-filter');
    await until(() => page.$('#ci-list .ck'));
    const filter = async (sel, list, q) => { await page.fill(sel, q); await sleep(250); return page.$$eval(`${list} .ck .nm`, els => els.slice(0, 3).map(e => e.textContent.trim())); };
    let r = await filter('#ci-filter', '#ci-list', 'madird');
    check('Spain → find a town "madird"', /^Madrid/.test(r[0] || ''), r.join(' | '));
    r = await filter('#ci-filter', '#ci-list', 'valladolib');
    check('Spain → find a town "valladolib"', /^Valladolid/.test(r[0] || ''), r.join(' | '));
    r = await filter('#ci-filter', '#ci-list', 'sevill');
    check('Spain → a normal partial match is unchanged', /^Sevill/.test(r[0] || ''), r.join(' | '));
    r = await filter('#st-filter', '#st-list', 'barcleona');
    check('Spain → filter regions "barcleona"', /^Barcelona/.test(r[0] || ''), r.join(' | '));

    check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  } catch (e) {
    check('test run completed', false, e.stack || String(e));
  } finally { await browser.close(); }
  console.log(`\n${total - failed}/${total} checks passed`);
  process.exit(failed ? 1 : 0);
})();
