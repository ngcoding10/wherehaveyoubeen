// Checks one-tap ticking in every list of landmarks: a tap ticks without navigating, a second tap un-ticks,
// the pin button goes to the map, fast taps share one toast with an undo, and 20 taps in a row stay quick.
// At phone size. No backend needed.
//
//   python3 -m http.server 8000
//   node tools/e2e-quicktick.js          (needs `npm i playwright`; WHYB_URL overrides http://localhost:8000)
//   SHOTS=/some/dir node tools/e2e-quicktick.js    also saves two phone screenshots there
const { chromium } = require('playwright');

const BASE = (process.env.WHYB_URL || 'http://localhost:8000').replace(/\/$/, '');
const SHOTS = process.env.SHOTS || '';
const PARIS = 2988507;
let failed = 0, total = 0;
function check(name, ok, detail = '') { total++; if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 10000) { const end = Date.now() + ms; for (;;) { try { const v = await fn(); if (v) return v; } catch { } if (Date.now() > end) return null; await sleep(50); } }

const items = page => page.evaluate(() => JSON.parse(localStorage.getItem('whyb.logbook.v1') || '{"items":{}}').items);
const toast = page => page.evaluate(() => document.querySelector('#toast.show')?.textContent || '');
const state = page => page.evaluate(() => ({ tab: window.__app.ui.tab, sel: window.__app.ui.sel?.id || null }));
// Taps fired inside the page, back to back, the way a thumb does it (the headless browser draws the map in software,
// so driving each tap from outside would measure the test machine rather than the app). Resolves to ms until saved.
const burst = (page, sels) => page.evaluate(async sels => {
  const t = performance.now();
  for (const s of sels) document.querySelector(s).click();
  while (window.__app.ui._tickPending) await new Promise(r => setTimeout(r, 5));
  return Math.round(performance.now() - t);
}, sels);
// Press Undo as soon as the toast offers it (inside the page, for the same reason)
const undo = page => page.evaluate(() => { const b = document.querySelector('#toast.show [data-undo]'); if (!b) return false; b.click(); return true; });
const idle = page => until(() => page.evaluate(() => !window.__app.ui._tickPending), 15000);

(async () => {
  const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: 'localhost,127.0.0.1' } : undefined;
  const browser = await chromium.launch({ proxy });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true });
    await context.route('**/js/firebase-config.js', r => r.fulfill({ contentType: 'application/javascript', body: 'export const firebaseConfig = null;\nexport const appCheckSiteKey = null;\n' }));
    const page = await context.newPage();
    const errors = [];
    page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|net::|WebGL|tile|glyph/i.test(m.text())) errors.push(m.text()); });
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    await page.goto(BASE + '/');
    await page.waitForSelector('#boot.done', { timeout: 60000 });
    await until(() => page.evaluate(async () => (await import('/js/landmarks.js')).sightsLoaded()), 20000);

    // ───── Wonders grid ─────
    await page.click('.tabs [data-tab=landmarks]');
    await page.waitForSelector('.dex-card');
    await page.evaluate(() => window.__app.ui.setSheet('full'));
    await sleep(400);
    const card = id => `.dex-card[data-key="l:${id}"]`;
    const dim = await page.$eval(card('eiffel'), el => getComputedStyle(el.querySelector('canvas')).filter);
    check('an unticked wonder shows its real sprite, dimmed (not a black silhouette)', /grayscale/.test(dim) && !/brightness\(0\)/.test(dim), dim);
    const painted = await page.$eval(card('eiffel') + ' canvas', c => { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i + 3] && (d[i] !== d[i + 1] || d[i + 1] !== d[i + 2])) n++; return n; });
    check('…the sprite itself is drawn in colour underneath', painted > 50, painted + ' coloured pixels');
    if (SHOTS) { await page.evaluate(() => { document.querySelector('#panel-body').scrollTop = 0; }); await page.screenshot({ path: `${SHOTS}/phone-wonders-before.png` }); }

    const before = await state(page);
    await page.tap(card('eiffel'));
    await idle(page);
    let it = await items(page);
    const after = await state(page);
    check('one tap on a wonder ticks it', !!it['l:eiffel']);
    check('…and logs its city and country as before', !!it['ci:' + PARIS] && !!it['c:FR']);
    check('…without navigating: still on the Wonders tab, nothing selected', after.tab === 'landmarks' && after.sel === before.sel, JSON.stringify(after));
    check('…the card lights up', await page.$eval(card('eiffel'), el => el.classList.contains('on') && el.getAttribute('aria-pressed') === 'true'));
    check('…the counter goes up', (await page.textContent('#lm-got')) === '1', await page.textContent('#lm-got'));
    check('…and the toast says so, with an undo', /Eiffel Tower/.test(await toast(page)) && /Paris/.test(await toast(page)) && !!(await page.$('#toast.show [data-undo]')), await toast(page));

    // fast taps: one toast for the lot
    const ids = await page.$$eval('.dex-card:not(.on)', els => els.slice(0, 20).map(e => e.dataset.key.slice(2)));
    await burst(page, ids.slice(0, 3).map(card));
    it = await items(page);
    check('three quick taps tick three more', ids.slice(0, 3).every(id => it['l:' + id]));
    const tt = await toast(page);
    check('…and share one toast: "4 wonders logged"', /4 wonders logged/.test(tt) && (tt.match(/logged/g) || []).length === 1, tt);
    check('…which lists what else was logged once', /also/.test(tt), tt);

    // undo the whole run
    check('the toast has an Undo to press', await undo(page));
    await idle(page); await sleep(200);
    it = await items(page);
    check('Undo takes back the whole run', !it['l:eiffel'] && ids.slice(0, 3).every(id => !it['l:' + id]) && !it['ci:' + PARIS] && !it['c:FR'], Object.keys(it).join(', '));
    check('…and the cards go dark again', await page.$eval(card('eiffel'), el => !el.classList.contains('on')));

    // tap, then tap again
    await page.tap(card('eiffel'));
    await idle(page);
    await page.tap(card('eiffel'));
    await idle(page);
    it = await items(page);
    check('a second tap un-ticks it (and what it added)', !it['l:eiffel'] && !it['ci:' + PARIS] && !it['c:FR'], Object.keys(it).join(', '));
    check('…still without navigating', (await state(page)).tab === 'landmarks');

    // speed: 20 taps in a row
    await until(async () => !(await toast(page)), 8000);   // start a fresh run
    const allMs = await burst(page, ids.map(card));
    it = await items(page);
    check('20 taps in a row all land', ids.every(id => it['l:' + id]), ids.filter(id => !it['l:' + id]).join(','));
    check('…and stay quick: all 20 saved within 1.5 s', allMs < 1500, `${allMs} ms`);
    check('…one short toast for all 20', /20 wonders logged/.test(await toast(page)) && /more/.test(await toast(page)) && (await toast(page)).length < 140, await toast(page));
    const lit = await page.$$eval('.dex-card.on', e => e.length);
    check('…all 20 cards lit', lit === 20, lit);
    const peek = await until(async () => { const t = await page.textContent('#sheet-peek'); return /20\s*wonders/i.test(t) && t; }, 8000);
    check('…and the stats at the top catch up (20 wonders)', !!peek, await page.textContent('#sheet-peek'));
    if (SHOTS) {
      await page.evaluate(() => { document.querySelector('#panel-body').scrollTop = 0; });
      await burst(page, [card(ids[0])]);                                // un-tick one, let that toast go…
      await until(async () => !(await toast(page)), 8000);
      await burst(page, [card(ids[0])]);                                // …and tick it again, so the shot has a fresh toast
      await page.waitForTimeout(100);
      await page.screenshot({ path: `${SHOTS}/phone-wonders-ticked.png` });
    }

    // the pin goes to the map
    await page.tap(`.dex-loc[data-loc="${ids[0]}"]`);
    await until(async () => (await state(page)).sel === ids[0], 5000);
    const s = await state(page);
    check('the pin button opens the wonder on the map', s.sel === ids[0] && s.tab === 'explore', JSON.stringify(s));

    // ───── city checklist ─────
    await page.evaluate(id => window.__app.ui.select('city', id, { props: { cid: 'FR' } }), PARIS);
    await page.waitForSelector('#city-lm-list .ck');
    const row = id => `#city-lm-list .ck[data-key="l:${id}"]`;
    await page.tap(row('louvre'));
    await idle(page);
    it = await items(page);
    check('city checklist: a tap ticks the Louvre', !!it['l:louvre'] && (await state(page)).sel === PARIS);
    await page.tap(row('louvre'));
    await idle(page);
    it = await items(page);
    check('city checklist: a second tap un-ticks it', !it['l:louvre']);
    await page.tap(row('louvre') + ' .loc');
    await until(async () => (await state(page)).sel === 'louvre', 5000);
    check('city checklist: the pin opens the Louvre', (await state(page)).sel === 'louvre');

    // ───── country: wonder chips and sights by city ─────
    await page.evaluate(() => window.__app.ui.select('country', 'IT'));
    await page.waitForSelector('#explore-extra .lm-chip:not(.on)');
    const chipKey = await page.$eval('#explore-extra .lm-chip:not(.on)', e => e.dataset.key);
    await page.tap(`#explore-extra .lm-chip[data-key="${chipKey}"]`);
    await idle(page);
    it = await items(page);
    check('country panel: tapping a wonder chip ticks it, and stays on Italy', !!it[chipKey] && (await state(page)).sel === 'IT', chipKey);
    const both = await page.$$eval(`[data-key="${chipKey}"]`, els => els.map(e => e.classList.contains('on')));
    check('…and every place it is listed lights up', both.length >= 1 && both.every(Boolean), JSON.stringify(both));

    // ───── City sights tab ─────
    await page.click('.tabs [data-tab=landmarks]');
    await page.click('[data-lmm=sights]');
    await page.waitForSelector('.sg-c[data-cc=GB] .sg-row');
    await page.tap('.sg-c[data-cc=GB] .sg-row');
    await page.waitForSelector('.sg-c[data-cc=GB] .lm-ck');
    await page.tap('.sg-c[data-cc=GB] .lm-ck[data-key="l:british-museum"]');
    await idle(page);
    it = await items(page);
    check('City sights: open a country and tap a sight to tick it, on the same screen', !!it['l:british-museum'] && (await state(page)).tab === 'landmarks');
    check('…the country count updates', /^1\//.test(await page.textContent('.sg-c[data-cc=GB] .cnt')), await page.textContent('.sg-c[data-cc=GB] .cnt'));

    check('no errors on the page', !errors.length, errors.slice(0, 3).join(' | '));
    await context.close();
  } catch (e) {
    console.error(e); failed++;
  } finally {
    await browser.close();
    console.log(`\n${total - failed}/${total} passed`);
    process.exit(failed ? 1 : 0);
  }
})();
