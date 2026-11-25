const { chromium } = require('playwright'); const http = require('http'), fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..'), out = require('os').tmpdir();
const srv = http.createServer((q, s) => { let p = path.join(root, decodeURIComponent(q.url.split('?')[0])); if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p += '/index.html'; if (!fs.existsSync(p)) { s.writeHead(404); return s.end(); }
  const t = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.geojson': 'application/json' }[path.extname(p)] || 'application/octet-stream'; s.writeHead(200, { 'content-type': t }); fs.createReadStream(p).pipe(s); }).listen(8770);
(async () => {
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const errs = [];
  async function person(email, name, countries, w = 1440, h = 900) {
    const ctx = await b.newContext({ viewport: { width: w, height: h } }); const pg = await ctx.newPage();
    pg.on('pageerror', e => errs.push(name + ' PAGEERR ' + e.message));
    pg.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|GL Driver/.test(m.text())) errs.push(name + ' ' + m.text().slice(0, 160)); });
    await pg.goto('http://localhost:8770/?emulator=1'); await pg.waitForFunction(() => window.__app && window.__emuSignIn, null, { timeout: 60000 });
    await pg.evaluate(async ([cs]) => { const { store } = await import('/js/store.js'); for (const c of cs) store.set('c:' + c, {}, { silent: true }); store.set('l:eiffel', {}); }, [countries]);
    await pg.evaluate(([e, n]) => window.__emuSignIn(e, n), [email, name]);
    await pg.waitForTimeout(2500);
    return pg;
  }
  const say = (...a) => console.log(...a);
  const A = await person('alice@test.dev', 'Alice Smith', ['US', 'FR', 'IT', 'JP', 'MX', 'ES', 'GB']);
  await A.click('.tabs [data-tab=friends]'); await A.waitForTimeout(800);
  say('Alice sees:', (await A.textContent('#panel-body')).replace(/\s+/g, ' ').slice(0, 60));
  await A.fill('#f-name', 'alice'); await A.click('#f-claim'); await A.waitForTimeout(2500);
  say('Alice after claim:', (await A.textContent('.me-card')).replace(/\s+/g, ' ').trim());
  const B = await person('bob@test.dev', 'Bob Jones', ['US', 'CA', 'BR', 'FR', 'JP', 'AU', 'TH', 'IT', 'EG'], 390, 844);
  await B.click('.tabs [data-tab=friends]'); await B.waitForTimeout(800);
  await B.fill('#f-name', 'alice'); await B.click('#f-claim'); await B.waitForTimeout(2000);
  say('Bob tries @alice:', await B.textContent('#f-claim-msg'));
  await B.fill('#f-name', 'bob'); await B.click('#f-claim'); await B.waitForTimeout(2500);
  await B.fill('#f-add', '@nobody_here'); await B.click('#f-send'); await B.waitForTimeout(1500);
  say('Bob adds unknown:', await B.textContent('#f-msg'));
  await B.fill('#f-add', 'Alice'); await B.click('#f-send'); await B.waitForTimeout(2000);
  say('Bob adds @alice:', await B.textContent('#f-msg'));
  await A.waitForTimeout(1500);
  say('Alice tab badge:', await A.getAttribute('.tabs [data-tab=friends]', 'data-badge'));
  await A.screenshot({ path: out + '/f1-alice-request.png' });
  await A.click('[data-accept]');
  for (const t of [500, 2000, 4000]) { await A.waitForTimeout(t); say('  alice state', t, await A.evaluate(async () => { const { social } = await import('/js/social.js'); return JSON.stringify({ myFriends: social.me?.friends, loaded: [...social.friends.keys()], state: social.state, tab: __app.ui.tab, active: document.activeElement?.tagName }); })); }
  say('Alice leaderboard:', (await A.textContent('.board')).replace(/\s+/g, ' ').trim());
  await B.waitForTimeout(2000);
  say('Bob leaderboard:', (await B.textContent('.board')).replace(/\s+/g, ' ').trim());
  await B.screenshot({ path: out + '/f2-bob-board.png' });
  await B.click('.lb[data-fid]'); await B.waitForTimeout(1200);
  await B.screenshot({ path: out + '/f3-bob-compare.png' });
  say('Bob compare:', (await B.textContent('.vs-head')).replace(/\s+/g, ' ').trim(), '|', (await B.$$eval('.p-sec h3', hs => hs.map(h => h.textContent.replace(/\s+/g, ' ')).join(' / '))));
  await A.click('.lb[data-fid]'); await A.waitForTimeout(1000); await A.click('#f-map'); await A.waitForTimeout(4000);
  await A.screenshot({ path: out + '/f4-alice-overlap-map.png' });
  say('compare bar:', (await A.textContent('#compare-bar')).replace(/\s+/g, ' '));
  // live update: Bob logs a new country; Alice's view should update
  await B.evaluate(async () => { const { store } = await import('/js/store.js'); store.set('c:PE', {}); });
  await B.waitForTimeout(5000);
  await A.click('#cmp-exit'); await A.click('#f-back'); await A.waitForTimeout(1500);
  say('Alice board after Bob logs Peru:', (await A.textContent('.board')).replace(/\s+/g, ' ').trim());
  // unfriend
  await A.click('.lb[data-fid]'); await A.waitForTimeout(800); A.once('dialog', d => d.accept()); await A.click('#f-remove'); await A.waitForTimeout(3000);
  say('Alice after removing:', (await A.textContent('.board')).replace(/\s+/g, ' ').trim());
  await B.waitForTimeout(2000); await B.click('#f-back').catch(() => {}); await B.waitForTimeout(1000);
  say('Bob after being removed:', (await B.textContent('.board')).replace(/\s+/g, ' ').trim());
  say('errors:', errs.length); errs.slice(0, 10).forEach(e => say('  ', e));
  await b.close(); srv.close();
})().catch(e => { console.log('E2E ERR', e.message.slice(0, 500)); process.exit(1); });
