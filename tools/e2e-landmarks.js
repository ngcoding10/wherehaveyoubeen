// Checks landmarks → city → country, un-ticking, the city checklist and the "which cities?" step after
// stamping a country (at phone size). No backend needed.
//
//   python3 -m http.server 8000
//   node tools/e2e-landmarks.js          (needs `npm i playwright`; WHYB_URL overrides http://localhost:8000)
//   SHOTS=/some/dir node tools/e2e-landmarks.js    also saves screenshots of the phone flow there
const { chromium } = require('playwright');

const BASE = (process.env.WHYB_URL || 'http://localhost:8000').replace(/\/$/, '');
const SHOTS = process.env.SHOTS || '';
const PARIS = 2988507, NICE = 2990440;
let failed = 0, total = 0;
function check(name, ok, detail = '') { total++; if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 10000) { const end = Date.now() + ms; for (;;) { try { const v = await fn(); if (v) return v; } catch { } if (Date.now() > end) return null; await sleep(50); } }

async function open(browser, viewport) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, hasTouch: viewport.width < 500, isMobile: viewport.width < 500 });
  // signed out, no config: the test never touches the real project
  await context.route('**/js/firebase-config.js', r => r.fulfill({ contentType: 'application/javascript', body: 'export const firebaseConfig = null;\nexport const appCheckSiteKey = null;\n' }));
  const page = await context.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|net::|WebGL|tile|glyph/i.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  await page.goto(BASE + '/');
  await page.waitForSelector('#boot.done', { timeout: 60000 });
  await until(() => page.evaluate(async () => (await import('/js/landmarks.js')).sightsLoaded()), 20000);
  return { context, page, errors };
}
const items = page => page.evaluate(() => JSON.parse(localStorage.getItem('whyb.logbook.v1') || '{"items":{}}').items);
const toast = page => page.evaluate(() => document.querySelector('#toast')?.textContent || '');
const select = (page, type, id, cid) => page.evaluate(([t, i, c]) => window.__app.ui.select(t, i, { props: { cid: c } }), [type, id, cid]);

(async () => {
  const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: 'localhost,127.0.0.1' } : undefined;
  const browser = await chromium.launch({ proxy });
  try {
    // ───── desktop: Eiffel Tower → Paris → France, and un-ticking ─────
    const { context, page, errors } = await open(browser, { width: 1280, height: 800 });
    const wondersBefore = await page.evaluate(async () => (await import('/js/stats.js')).computeStats().lms);

    await select(page, 'landmark', 'eiffel');
    await page.waitForSelector('#been-btn');
    check('the Eiffel Tower panel shows Paris in its breadcrumbs', /Paris/.test(await page.textContent('.crumbs')), await page.textContent('.crumbs'));
    await page.click('#been-btn');
    await sleep(300);
    let it = await items(page);
    check('ticking the Eiffel Tower logs it', !!it['l:eiffel']);
    check('…and logs Paris', !!it['ci:' + PARIS] && it['ci:' + PARIS].n === 'Paris', JSON.stringify(it['ci:' + PARIS] || null));
    check('…and logs France', !!it['c:FR']);
    check('…and says so', /Paris/.test(await toast(page)) && /France/.test(await toast(page)), await toast(page));
    check('Paris and France are marked as added automatically', it['ci:' + PARIS]?.a === 1 && it['c:FR']?.a === 1);
    check('the Eiffel Tower item remembers its city and country', it['l:eiffel']?.ci === PARIS && it['l:eiffel']?.c === 'FR');
    const wondersAfter = await page.evaluate(async () => (await import('/js/stats.js')).computeStats().lms);
    check('the Wonders count went up by exactly one', wondersAfter === wondersBefore + 1, `${wondersBefore} → ${wondersAfter}`);

    // un-tick: what it added goes again
    await page.click('#been-btn');
    await sleep(300);
    it = await items(page);
    check('un-ticking the Eiffel Tower removes it', !it['l:eiffel']);
    check('…and Paris and France, which only it had added', !it['ci:' + PARIS] && !it['c:FR'], Object.keys(it).join(', '));

    // a city the person logged themselves is never taken away
    await select(page, 'city', PARIS, 'FR');
    await page.waitForSelector('#been-btn');
    await page.click('#been-btn');
    await sleep(300);
    await select(page, 'landmark', 'eiffel');
    await page.waitForSelector('#been-btn');
    await page.click('#been-btn');
    await sleep(300);
    it = await items(page);
    check('Paris logged by hand has no "automatic" mark', it['ci:' + PARIS] && !it['ci:' + PARIS].a);
    await page.click('#been-btn');
    await sleep(300);
    it = await items(page);
    check('un-ticking the Eiffel Tower keeps a Paris you logged yourself', !it['l:eiffel'] && !!it['ci:' + PARIS] && !!it['c:FR'], Object.keys(it).join(', '));
    check('…and says Paris stays', /Paris stays/.test(await toast(page)), await toast(page));

    // two sights in one city: un-ticking one keeps the city
    await page.evaluate(() => { localStorage.removeItem('whyb.logbook.v1'); });
    await page.reload(); await page.waitForSelector('#boot.done', { timeout: 60000 });
    await until(() => page.evaluate(async () => (await import('/js/landmarks.js')).sightsLoaded()), 20000);

    // ───── city checklist ─────
    await select(page, 'city', PARIS, 'FR');
    await page.waitForSelector('#city-lm-list .ck');
    const rows = await page.$$eval('#city-lm-list .ck', els => els.map(e => e.querySelector('.nm').textContent));
    check('Paris lists its sights as a checklist', rows.length >= 5, rows.length + ': ' + rows.slice(0, 8).join(', '));
    check('…with the Eiffel Tower, Louvre and Notre-Dame', ['Eiffel Tower', 'Louvre', 'Notre-Dame'].every(n => rows.some(r => r.includes(n))));
    const rowOf = id => `#city-lm-list .ck[data-key="l:${id}"]`;
    await page.click(rowOf('eiffel') + ' .bx');
    await sleep(300);
    await page.waitForSelector('#city-lm-list');
    await page.click(rowOf('louvre') + ' .bx');
    await sleep(300);
    it = await items(page);
    check('ticking two rows logs both sights', !!it['l:eiffel'] && !!it['l:louvre']);
    check('…and Paris and France', !!it['ci:' + PARIS] && !!it['c:FR']);
    check('the rows show as ticked', await page.$$eval('#city-lm-list .ck.on', e => e.length) >= 2);
    check('the count reads 2/…', /^2\//.test(await page.textContent('#city-lm-count')), await page.textContent('#city-lm-count'));
    check('the city button now says BEEN HERE', /BEEN HERE/.test(await page.textContent('#been-btn')) && !/I’VE/.test(await page.textContent('#been-btn')));
    await page.click(rowOf('louvre') + ' .bx');
    await sleep(300);
    it = await items(page);
    check('un-ticking one of two sights keeps Paris', !it['l:louvre'] && !!it['l:eiffel'] && !!it['ci:' + PARIS]);

    // country checklist grouped by city
    await select(page, 'country', 'FR');
    await page.waitForSelector('#sights-by-city .lm-group');
    const groups = await page.$$eval('#sights-by-city .lm-group-h', els => els.map(e => e.textContent));
    check('France lists its landmarks grouped by city, Paris first', /^Paris/.test(groups[0] || ''), groups.slice(0, 4).join(' | '));
    check('no errors on the page (desktop)', !errors.length, errors.slice(0, 3).join(' | '));
    await context.close();

    // ───── phone: stamp a country → which cities → which sights ─────
    const P = await open(browser, { width: 390, height: 844 });
    const pg = P.page;
    await select(pg, 'country', 'FR');
    await pg.waitForSelector('#been-btn');
    await pg.click('#been-btn');
    const sheet = await until(() => pg.isVisible('#trip-sheet'), 8000);
    check('stamping France opens "Which cities?"', !!sheet);
    await until(() => pg.$$eval('#trip-list .ck', e => e.length));
    const first = await pg.$$eval('#trip-list .ck .nm', els => els.slice(0, 5).map(e => e.firstChild.textContent.trim()));
    check('biggest / most-visited cities come first', first[0] === 'Paris', first.join(', '));
    const fits = await pg.evaluate(() => { const r = document.querySelector('#trip-card').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight + 1 && document.documentElement.scrollWidth <= innerWidth; });
    check('the dialog fits a 390×844 screen with no sideways scroll', fits);
    if (SHOTS) await pg.screenshot({ path: `${SHOTS}/phone-1-cities.png` });
    // typo-tolerant search
    await pg.fill('#trip-q', 'parsi');
    const firstName = () => pg.$$eval('#trip-list .ck .nm', e => e[0]?.firstChild.textContent.trim());
    await until(async () => (await firstName()) === 'Paris', 4000);
    check('searching "parsi" finds Paris', (await firstName()) === 'Paris', await firstName());
    await pg.click('#trip-list .ck[data-gid="' + PARIS + '"]');
    await pg.fill('#trip-q', 'nice');
    await until(() => pg.$(`#trip-list .ck[data-gid="${NICE}"]`), 4000);
    await pg.click(`#trip-list .ck[data-gid="${NICE}"]`);
    await pg.fill('#trip-q', '');
    check('both picks show as chips', (await pg.$$eval('#trip-picked .tag', e => e.length)) === 2);
    const nextLabel = await pg.textContent('#trip-next');
    check('the next button counts the picks', /Add 2 cities/.test(nextLabel), nextLabel);
    if (SHOTS) await pg.screenshot({ path: `${SHOTS}/phone-2-picked.png` });
    await pg.click('#trip-next');
    await pg.waitForSelector('#trip-list .lm-ck');
    it = await items(pg);
    check('the picked cities are logged', !!it['ci:' + PARIS] && !!it['ci:' + NICE]);
    check('…as places you logged yourself', !it['ci:' + PARIS].a && !it['ci:' + NICE].a);
    check('France is remembered as asked', it['c:FR']?.g === 1);
    check('the sights step starts with Paris', /Paris/.test(await pg.textContent('.trip-sub')), await pg.textContent('.trip-sub'));
    await pg.click('#trip-list .ck[data-key="l:eiffel"]');
    await pg.click('#trip-list .ck[data-key="l:louvre"]');
    await sleep(300);
    if (SHOTS) await pg.screenshot({ path: `${SHOTS}/phone-3-sights.png` });
    it = await items(pg);
    check('ticking sights in the dialog logs them', !!it['l:eiffel'] && !!it['l:louvre']);
    const footOk = await pg.evaluate(() => { const r = document.querySelector('#trip-next').getBoundingClientRect(); return r.bottom <= innerHeight && r.top > 0; });
    check('the next button is on screen', footOk);
    const hasNice = await pg.evaluate(async n => (await import('/js/landmarks.js')).cityLandmarks(n).length, NICE);
    if (hasNice) {
      await pg.click('#trip-next');
      await until(async () => /Nice/.test(await pg.textContent('.trip-sub')), 4000);
      check('then Nice', /Nice/.test(await pg.textContent('.trip-sub')));
      await pg.click('#trip-back');
      check('Back goes to Paris again', /Paris/.test(await pg.textContent('.trip-sub')));
      await pg.click('#trip-next');
    }
    await pg.click('#trip-next');   // Done
    await until(async () => !(await pg.isVisible('#trip-sheet')), 4000);
    check('Done closes the dialog', !(await pg.isVisible('#trip-sheet')));
    check('…and sums up', /Logged 2 cities and 2 sights/.test(await toast(pg)), await toast(pg));

    // not offered again for France; can be reopened from the country panel
    await select(pg, 'country', 'FR');
    await pg.waitForSelector('#trip-open');
    await pg.evaluate(() => window.__app.ui.openTrip('FR', { auto: true }));
    await sleep(400);
    check('France is not asked about again automatically', !(await pg.isVisible('#trip-sheet')));
    await pg.click('#trip-open');
    check('the country panel button reopens it', !!(await until(() => pg.isVisible('#trip-sheet'), 4000)));
    await pg.click('#trip-skip');
    check('Skip closes it', !!(await until(async () => !(await pg.isVisible('#trip-sheet')), 4000)));

    // skipping straight away is fine too
    await select(pg, 'country', 'IT');
    await pg.waitForSelector('#been-btn');
    await pg.click('#been-btn');
    await until(() => pg.isVisible('#trip-sheet'), 8000);
    await pg.click('#trip-skip');
    await sleep(300);
    it = await items(pg);
    check('skipping the step keeps the country stamp only', !!it['c:IT'] && !Object.entries(it).some(([k, v]) => k.startsWith('ci:') && v.c === 'IT'));
    check('no errors on the page (phone)', !P.errors.length, P.errors.slice(0, 3).join(' | '));
    await P.context.close();
  } catch (e) {
    console.error(e); failed++;
  } finally {
    await browser.close();
    console.log(`\n${total - failed}/${total} passed`);
    process.exit(failed ? 1 : 0);
  }
})();
