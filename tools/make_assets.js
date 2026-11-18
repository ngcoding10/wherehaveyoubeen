// Renders share image + icons into assets/.  usage: node tools/make_assets.js  (needs playwright)
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const root = path.resolve(__dirname, '..');
const types = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.geojson': 'application/json', '.png': 'image/png' };
const srv = http.createServer((q, s) => {
  let p = path.join(root, decodeURIComponent(q.url.split('?')[0]));
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p += '/index.html';
  if (!fs.existsSync(p)) { s.writeHead(404); return s.end(); }
  s.writeHead(200, { 'content-type': types[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(s);
}).listen(8799);
(async () => {
  fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  // 1. a globe with a few countries coloured in
  const pg = await b.newPage({ viewport: { width: 1000, height: 1000 } });
  await pg.addInitScript(() => {
    const t = Date.now(), items = {};
    for (const c of ['US', 'CA', 'MX', 'BR', 'PE', 'GB', 'FR', 'ES', 'IT', 'DE', 'MA', 'EG', 'ZA', 'IS', 'NO', 'GR', 'TR']) items['c:' + c] = { t, m: t };
    for (const s of ['USA-3521', 'USA-3559', 'USA-3536', 'USA-3542']) items['s:' + s] = { t, m: t, c: 'US' };
    localStorage.setItem('whyb.logbook.v1', JSON.stringify({ items, removed: {}, home: null, updated: t }));
    localStorage.setItem('whyb.settings.v1', JSON.stringify({ theme: 'midnight', projection: 'globe', showLandmarks: true }));
  });
  await pg.goto('http://localhost:8799/');
  await pg.waitForFunction(() => window.__app, null, { timeout: 60000 });
  await pg.addStyleTag({ content: '.topbar,.ribbon,.legend,.map-ctrls,.panel,.maplibregl-control-container,.toast,.hover-tip{display:none!important} #stars{background:#050b18!important}' });
  await pg.evaluate(() => { const m = __app.map.map; m.setPadding({ top: 0, right: 0, bottom: 0, left: 0 }); m.jumpTo({ center: [-25, 30], zoom: 1.55 }); });
  await pg.waitForTimeout(6000);
  const tmpGlobe = path.join(root, 'assets', '_globe.png');
  await pg.screenshot({ path: tmpGlobe, clip: { x: 200, y: 200, width: 600, height: 600 } });
  // 2. share card
  const card = await b.newPage({ viewport: { width: 1200, height: 630 } });
  await card.goto('http://localhost:8799/tools/make_assets.html?globe=../assets/_globe.png');
  await card.waitForFunction(() => window.ready); await card.waitForTimeout(1500);
  await card.locator('#card').screenshot({ path: path.join(root, 'assets/share.png') });
  // 3. icons
  for (const [name, size, pad] of [['icon-512.png', 512, 0.3], ['icon-192.png', 192, 0.3], ['apple-touch-icon.png', 180, 0.3], ['favicon-32.png', 32, 0.15]]) {
    const url = await card.evaluate(([s, p]) => window.makeIcon(s, p), [size, pad]);
    fs.writeFileSync(path.join(root, 'assets', name), Buffer.from(url.split(',')[1], 'base64'));
  }
  fs.unlinkSync(tmpGlobe);
  await b.close(); srv.close();
  console.log('assets written');
})().catch(e => { console.error(e); process.exit(1); });
