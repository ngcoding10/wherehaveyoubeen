// End-to-end check of sign-in, cloud sync, usernames, friends and delete-my-data against the
// Firebase emulators of the shared backend (github.com/ngcoding10/backend-combination).
//
//   1. in the backend repo: start the emulators (Auth 9099, Firestore 8080, Functions 5001, project demo-apps)
//   2. here: python3 -m http.server 8000
//   3. node tools/e2e-emulator.js            (needs `npm i playwright`; WHYB_URL overrides http://localhost:8000)
//
// Every run uses new made-up people, so it can be repeated without wiping the emulators.
const { chromium } = require('playwright');

const BASE = (process.env.WHYB_URL || 'http://localhost:8000').replace(/\/$/, '');
const DOCS = 'http://127.0.0.1:8080/v1/projects/demo-apps/databases/(default)/documents';
const T = Date.now().toString(36);
const results = [];
let failed = 0;

function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 15000, step = 200) {
  const end = Date.now() + ms;
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch { /* retry */ }
    if (Date.now() > end) return null;
    await sleep(step);
  }
}

/** Read a document straight from the Firestore emulator, bypassing the rules. null if missing. */
async function doc(path) {
  const r = await fetch(`${DOCS}/${path}`, { headers: { Authorization: 'Bearer owner' } });
  if (r.status === 404) return null;
  const j = await r.json();
  const val = v => 'stringValue' in v ? v.stringValue : 'integerValue' in v ? +v.integerValue : 'doubleValue' in v ? v.doubleValue
    : 'booleanValue' in v ? v.booleanValue : 'arrayValue' in v ? (v.arrayValue.values || []).map(val)
    : 'mapValue' in v ? Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, val(x)]))
    : 'timestampValue' in v ? v.timestampValue : null;
  return Object.fromEntries(Object.entries(j.fields || {}).map(([k, v]) => [k, val(v)]));
}
async function adminSet(path, fields) {
  const r = await fetch(`${DOCS}/${path}`, { method: 'PATCH', headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' }, body: JSON.stringify({ fields }) });
  if (!r.ok) throw new Error(`admin write failed: ${r.status}`);
}

// Helpers that run inside the page. The app's own modules are imported by the same URL, so these are the live instances.
const inPage = {
  state: () => Promise.all([import('/js/cloud.js'), import('/js/social.js'), import('/js/store.js')]).then(([c, s, st]) => ({
    ready: c.cloud.ready, user: c.cloud.user, status: c.cloud.status, off: c.cloud.off, lastError: c.cloud.lastError,
    social: s.social.state, me: s.social.me, friends: [...s.social.friends.values()].map(f => f.username), incoming: s.social.incoming.length,
    places: Object.keys(st.store.book.items),
  })),
};

async function open(browser, url, log) {
  const context = await browser.newContext({ ignoreHTTPSErrors: !!process.env.WHYB_IGNORE_TLS });
  const page = await context.newPage();
  page.on('console', m => { if (['warning', 'error'].includes(m.type())) log.push(`[${m.type()}] ${m.text()}`); });
  page.on('pageerror', e => log.push(`[pageerror] ${e.message}`));
  await page.goto(url);
  await page.waitForSelector('#boot.done', { timeout: 60000 });
  return { context, page };
}
const state = page => page.evaluate(inPage.state);
const waitState = (page, fn, ms) => until(async () => { const s = await state(page); return fn(s) ? s : null; }, ms);
async function signIn(page, email, name) {
  await page.waitForFunction(() => typeof window.__emuSignIn === 'function', null, { timeout: 60000 });
  const uid = await page.evaluate(([e, n]) => window.__emuSignIn(e, n), [email, name]);
  await waitState(page, s => s.user && s.status === 'synced');
  return uid;
}
async function friendsTab(page) { await page.click('.tabs [data-tab=friends]'); }
async function claim(page, name, { rename } = {}) {
  await friendsTab(page);
  if (rename) await page.click('#f-rename');
  await page.waitForSelector('#f-name');
  await page.fill('#f-name', name);
  await page.click('#f-claim');
  // Resolves with 'OK' (the form is gone) or the message shown. One look at the page per try: looking for the
  // form and then, in a second step, for its message used to hang for 30 s whenever the form closed in between.
  return until(() => page.evaluate(() => {
    if (!document.querySelector('#f-name')) return 'OK';
    const m = document.querySelector('#f-claim-msg')?.textContent;
    return m && !/Saving|is free/.test(m) ? m : null;
  }));
}
const board = page => page.$$eval('.board .lb .nm', els => els.map(e => e.textContent.trim()));

(async () => {
  const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: 'localhost,127.0.0.1' } : undefined;
  const browser = await chromium.launch({ proxy });
  const logA = [], logB = [], logC = [], logN = [];
  const nameA = `ada.t${T}`.slice(0, 20), nameA2 = `ada.r${T}`.slice(0, 20), nameB = `bob_${T}`.slice(0, 20), nameC = `cee.${T}`.slice(0, 20);
  try {
    // ───── signed-out, no ?emulator: local-only, no Firebase traffic ─────
    {
      const context = await browser.newContext();
      // Force the "no config" case whatever js/firebase-config.js holds, so this never touches the real project.
      await context.route('**/js/firebase-config.js', r => r.fulfill({ contentType: 'application/javascript', body: 'export const firebaseConfig = null;\nexport const appCheckSiteKey = null;\n' }));
      const page = await context.newPage();
      const urls = [];
      page.on('request', r => urls.push(r.url()));
      page.on('pageerror', e => logN.push(e.message));
      await page.goto(BASE + '/');
      await page.waitForSelector('#boot.done', { timeout: 60000 });
      await page.evaluate(() => import('/js/store.js').then(m => m.store.set('c:FR')));
      await page.click('#account-btn');
      const acct = await page.textContent('#account-card');
      await page.click('#account-card [data-close]');
      await page.click('.tabs [data-tab=friends]');
      const fr = await page.textContent('#panel-body');
      await sleep(1500);
      const fb = urls.filter(u => /firebasejs|googleapis\.com\/(identitytoolkit|v1)|firestore|firebaseapp|identitytoolkit|securetoken|127\.0\.0\.1:(9099|8080|5001)/.test(u));
      const s = await page.evaluate(() => Promise.all([import('/js/cloud.js'), import('/js/store.js')]).then(([c, st]) => ({ enabled: c.cloud.enabled, has: st.store.has('c:FR'), ls: Object.keys(localStorage), ss: Object.keys(sessionStorage) })));
      check('no config, no emulator: app boots and logs a place locally', s.has && !s.enabled);
      check('no config, no emulator: no Firebase requests', fb.length === 0, fb.slice(0, 3).join(' '));
      check('no config: account sheet says sign-in is not switched on', /isn’t switched on/.test(acct) && !/Sign in with Google/.test(acct));
      check('no config: friends tab explains', /isn't switched on/.test(fr));
      check('no config: storage keys all start with whyb.', [...s.ls, ...s.ss].every(k => k.startsWith('whyb.')), JSON.stringify([...s.ls, ...s.ss]));
      check('no config: no page errors', logN.length === 0, logN.join(' | '));
      await context.close();
    }

    // ───── person A ─────
    const A = await open(browser, BASE + '/?emulator', logA);
    await A.page.click('#account-btn');
    const ready = await until(() => A.page.$eval('#g-signin', b => !b.disabled && /Sign in with Google/.test(b.textContent)), 60000);
    check('sign-in button becomes enabled once the core has loaded', ready);
    // the click must open the sign-in window by itself (nothing awaited before it)
    const popup = await Promise.all([A.page.waitForEvent('popup', { timeout: 15000 }).catch(() => null), A.page.click('#g-signin')]).then(r => r[0]);
    check('clicking "Sign in with Google" opens the sign-in window', !!popup, popup ? popup.url().slice(0, 60) : 'no popup');
    if (popup) await popup.close();
    await A.page.click('#account-card [data-close]').catch(() => {});

    const uidA = await signIn(A.page, `ada.${T}@example.com`, 'Ada Tester');
    check('A signs in (emulator Google account)', !!uidA, uidA);
    await A.page.evaluate(() => import('/js/store.js').then(({ store }) => {
      store.set('c:FR'); store.set('c:JP'); store.set('ci:2988507', { n: 'Paris', c: 'FR' }); store.set('l:eiffel-tower');
    }));
    const saved = await until(async () => { const d = await doc(`whyb_users/${uidA}`); return d && /"c:JP"/.test(d.book) ? d : null; });
    check('logbook is saved to whyb_users/{uid}', saved && /"ci:2988507"/.test(saved.book) && typeof saved.settings === 'string' && saved.name === 'Ada Tester' && !!saved.updatedAt,
      saved ? `keys: ${Object.keys(saved).sort()}` : 'no doc');

    // wipe the browser copy; after a reload the places must come back from the cloud
    await A.page.evaluate(() => localStorage.removeItem('whyb.logbook.v1'));
    await A.page.reload();
    await A.page.waitForSelector('#boot.done', { timeout: 60000 });
    const back = await waitState(A.page, s => s.user && s.places.includes('c:JP') && s.places.includes('ci:2988507'));
    check('after reload (browser copy wiped) the places come back from whyb_users', !!back, back ? back.places.join(',') : JSON.stringify(await state(A.page)));

    check('A with no account username is asked to pick one', (await waitState(A.page, s => s.social === 'need-username')) !== null);
    await friendsTab(A.page);
    const hint = await A.page.textContent('#panel-body');
    check('username hint mentions dots', /lowercase letters, numbers, dots or underscores/.test(hint));
    await A.page.fill('#f-name', 'Bad Name!');
    check('invalid username shows the validation text', /lowercase letters, numbers, dots or underscores/.test(await A.page.textContent('#f-claim-msg')));
    const rA = await claim(A.page, nameA);
    const accA = await doc(`accounts/${uidA}`), unA = await doc(`usernames/${nameA}`), profA = await until(() => doc(`whyb_profiles/${uidA}`));
    check('A claims a username containing a dot', rA === 'OK' && accA?.username === nameA && unA?.uid === uidA && profA?.username === nameA, `${rA}; account=${accA?.username}; profile=${profA?.username}`);
    check('whyb_profiles has only allowed keys', profA && Object.keys(profA).every(k => ['username', 'name', 'stats', 'visited', 'friends', 'updatedAt'].includes(k)), profA ? Object.keys(profA).join(',') : '');

    // ───── person B ─────
    const B = await open(browser, `${BASE}/?emulator&add=${encodeURIComponent(nameA)}`, logB);
    const uidB = await signIn(B.page, `bob.${T}@example.com`, 'Bob Tester');
    await waitState(B.page, s => s.social === 'need-username');
    const taken = await claim(B.page, nameA);
    check('B cannot take A\'s username', /taken/.test(taken || '') && (await doc(`usernames/${nameA}`))?.uid === uidA && !(await doc(`accounts/${uidB}`)), String(taken));
    const rB = await claim(B.page, nameB);
    check('B claims a different username', rB === 'OK' && (await doc(`accounts/${uidB}`))?.username === nameB, String(rB));
    await B.page.evaluate(() => import('/js/store.js').then(({ store }) => { store.set('c:BR'); }));

    // invite link ?add=<name with a dot> prefilled the box
    await B.page.waitForSelector('#f-add');
    const prefill = await until(() => B.page.$eval('#f-add', i => i.value));
    check('invite link ?add= accepts a username with a dot', prefill === nameA, String(prefill));
    await B.page.fill('#f-add', nameA);
    await B.page.click('#f-send');
    const req = await until(() => doc(`whyb_requests/${uidA}_${uidB}`));
    check('B sends a friend request by username (whyb_requests/{to}_{from}, fromName = username)', req && req.fromName === nameB && req.toName === nameA && req.from === uidB && req.to === uidA && !!req.createdAt, JSON.stringify(req));

    await friendsTab(A.page);
    await A.page.waitForSelector('[data-accept]', { timeout: 15000 });
    await A.page.click('[data-accept]');
    const both = await until(async () => (await board(A.page)).some(t => t.includes(nameB)) && (await board(B.page)).some(t => t.includes(nameA)), 20000);
    check('A accepts; both see each other on the leaderboard', !!both, `A: ${await board(A.page)} | B: ${await board(B.page)}`);
    check('request is gone after accepting', (await doc(`whyb_requests/${uidA}_${uidB}`)) === null);
    const bStats = await until(async () => { const p = await doc(`whyb_profiles/${uidB}`); return p?.stats?.countries >= 1 ? p : null; });
    check('profile publish works (stats and visited, including cities)', !!bStats && Array.isArray((await doc(`whyb_profiles/${uidA}`))?.visited?.ci), JSON.stringify((await doc(`whyb_profiles/${uidA}`))?.visited?.ci));

    // the rename form must stay open while friends' updates redraw the panel behind it (it used to be replaced by
    // the friends list unless the cursor was in the box), and a save in flight cannot be started a second time
    await friendsTab(A.page);
    await A.page.click('#f-rename');
    await A.page.waitForSelector('#f-name');
    const emit = () => A.page.evaluate(() => import('/js/social.js').then(m => { m.social.dispatchEvent(new CustomEvent('change')); }));
    await emit();
    check('the rename form survives a background update before typing', !!(await A.page.$('#f-name')));
    await A.page.fill('#f-name', nameA2);
    await A.page.evaluate(() => document.activeElement.blur());
    await emit();
    check('the rename form keeps the typed name through a background update', (await A.page.$eval('#f-name', i => i.value).catch(() => null)) === nameA2);
    await A.page.click('#f-cancel');
    check('cancel closes the rename form', !(await A.page.$('#f-name')) && (await doc(`accounts/${uidA}`))?.username === nameA);
    await A.page.click('#f-rename');
    await A.page.fill('#f-name', nameA);
    await A.page.focus('#f-name');
    const dbl = await A.page.evaluate(async () => {
      const { claimUsername } = await import('/js/social.js');
      const inp = document.querySelector('#f-name');
      return Promise.all([claimUsername(inp.value), claimUsername(inp.value)]);
    });
    check('two saves at once: one goes through, the other is turned away instead of racing it', dbl.filter(x => x === '').length === 1 && /Still saving/.test(dbl.join('|')), JSON.stringify(dbl));
    await A.page.click('#f-cancel');

    // rename: the profile follows, friends see the new name
    const rRen = await claim(A.page, nameA2, { rename: true });
    const accA2 = await doc(`accounts/${uidA}`), profA2 = await doc(`whyb_profiles/${uidA}`);
    check('A renames; account, usernames and whyb profile follow', rRen === 'OK' && accA2?.username === nameA2 && profA2?.username === nameA2 && (await doc(`usernames/${nameA}`)) === null && (await doc(`usernames/${nameA2}`))?.uid === uidA && (profA2.friends || []).includes(uidB),
      `${rRen}; account=${accA2?.username}; profile=${profA2?.username}`);
    check('B sees A\'s new name on the leaderboard', !!(await until(async () => (await board(B.page)).some(t => t.includes(nameA2)))), String(await board(B.page)));
    // publishing still works after the rename
    await A.page.evaluate(() => import('/js/store.js').then(({ store }) => { store.set('c:IT'); }));
    check('A can still publish after the rename', !!(await until(async () => (await doc(`whyb_profiles/${uidA}`))?.visited?.c?.includes('IT'))));

    // unfriend
    A.page.on('dialog', d => d.accept());
    await friendsTab(A.page);
    await A.page.click('.lb[data-fid]');
    await A.page.click('#f-remove');
    const gone = await until(async () => (await board(A.page)).length === 1 && (await board(B.page)).length === 1 && !((await doc(`whyb_profiles/${uidB}`)).friends || []).includes(uidA) && !((await doc(`whyb_profiles/${uidA}`)).friends || []).includes(uidB));
    check('unfriend removes both sides', !!gone, `A: ${await board(A.page)} | B: ${await board(B.page)}`);

    // too-big logbook: a clear error, not silence
    await A.page.evaluate(() => import('/js/store.js').then(({ store }) => { store.set('c:DE', { note: 'x'.repeat(960000) }); }));
    const big = await waitState(A.page, s => s.status === 'error');
    const toast = await A.page.textContent('body');
    check('a logbook over 950,000 characters shows a sync error', big && /too big/.test(big.lastError) && /Sync problem: Your logbook is too big/.test(toast), big ? big.lastError.slice(0, 80) : 'no error state');
    await A.page.evaluate(() => import('/js/store.js').then(({ store }) => { store.remove('c:DE'); store.book.removed = {}; store.set('c:ES'); }));
    check('sync recovers once the logbook is small again', !!(await waitState(A.page, s => s.status === 'synced')) && /"c:ES"/.test((await doc(`whyb_users/${uidA}`)).book));

    // ───── person C: already has an account username from "another app", no whyb profile ─────
    const C = await open(browser, BASE + '/?emulator', logC);
    const uidC = await signIn(C.page, `cee.${T}@example.com`, 'Cee Tester');
    await waitState(C.page, s => s.social === 'need-username');
    await C.page.evaluate(n => import('/js/cloud.js').then(m => m.getCore().account.claim(n)), nameC); // what another app does
    check('setup: C has an account username but no whyb profile', (await doc(`accounts/${uidC}`))?.username === nameC && (await doc(`whyb_profiles/${uidC}`)) === null);
    await friendsTab(A.page);
    await A.page.fill('#f-add', nameC);
    await A.page.click('#f-send');
    const notHere = await until(async () => { const m = await A.page.textContent('#f-msg'); return m || null; });
    check('a request to someone with a username but no profile here gives a clear message', /isn’t on Where Have You Been yet\. Send them your invite link\./.test(notHere || '') && (await doc(`whyb_requests/${uidC}_${uidA}`)) === null, String(notHere));
    await C.page.reload();
    await C.page.waitForSelector('#boot.done', { timeout: 60000 });
    const cReady = await waitState(C.page, s => s.social === 'ready' || s.social === 'need-username' || s.social === 'error');
    check('C is not asked for a username again; the whyb profile is created with it', cReady?.social === 'ready' && cReady.me?.username === nameC && (await doc(`whyb_profiles/${uidC}`))?.username === nameC, JSON.stringify({ social: cReady?.social, me: cReady?.me?.username }));

    // ───── delete my data ─────
    // C uses no other app: everything goes, including the account, the username and the sign-in
    await C.page.evaluate(() => import('/js/store.js').then(({ store }) => { store.set('c:NZ'); }));
    await until(async () => /"c:NZ"/.test((await doc(`whyb_users/${uidC}`))?.book || ''));
    await friendsTab(C.page);
    await C.page.fill('#f-add', nameA2);
    await C.page.click('#f-send');
    await friendsTab(A.page);
    await A.page.waitForSelector('[data-accept]', { timeout: 15000 });
    await A.page.click('[data-accept]');
    const acFriends = await until(async () => (await board(A.page)).some(t => t.includes(nameC)) && (await board(C.page)).some(t => t.includes(nameA2)), 20000);
    check('setup: A and C are friends before C deletes', !!acFriends && ((await doc(`whyb_profiles/${uidA}`)).friends || []).includes(uidC));
    await C.page.click('#account-btn');
    await C.page.click('#g-delete');
    check('delete asks for confirmation first', await C.page.isVisible('#g-delete-yes') && (await doc(`whyb_users/${uidC}`)) !== null);
    await C.page.click('#g-delete-yes');
    const cOut = await waitState(C.page, s => !s.user, 30000);
    await sleep(4000); // long enough for any stray save or publish to have re-created something
    check('delete-my-data (no other app): whyb data, account and username are gone, person is signed out',
      !!cOut && (await doc(`whyb_users/${uidC}`)) === null && (await doc(`whyb_profiles/${uidC}`)) === null && (await doc(`accounts/${uidC}`)) === null && (await doc(`usernames/${nameC}`)) === null,
      JSON.stringify({ signedOut: !!cOut, users: await doc(`whyb_users/${uidC}`), profile: await doc(`whyb_profiles/${uidC}`), account: await doc(`accounts/${uidC}`) }));
    check('the logbook in the browser stays after deleting', cOut && cOut.places.includes('c:NZ'));
    const aAfter = await until(async () => !((await doc(`whyb_profiles/${uidA}`)).friends || []).includes(uidC) && (await board(A.page)).length === 1);
    check('deleting while still friends: the friend\'s list and leaderboard no longer have that person', !!aAfter, `friends=${JSON.stringify((await doc(`whyb_profiles/${uidA}`)).friends)} board=${await board(A.page)}`);

    // B also uses another app (a pantry document): only the whyb data goes
    await adminSet(`pantry_users/${uidB}`, { pantry: { arrayValue: { values: [{ stringValue: 'rice' }] } } });
    await friendsTab(B.page);
    await B.page.fill('#f-add', nameA2);
    await B.page.click('#f-send');
    await until(() => doc(`whyb_requests/${uidA}_${uidB}`));
    await B.page.click('#account-btn');
    await B.page.click('#g-delete');
    await B.page.click('#g-delete-yes');
    const bOff = await waitState(B.page, s => s.off && s.status === 'off', 30000);
    await B.page.evaluate(() => import('/js/store.js').then(({ store }) => { store.set('c:PE'); })); // a change that would normally be uploaded
    await sleep(4000); // long enough for any stray save or publish to have re-created something
    const bGone = async () => (await doc(`whyb_users/${uidB}`)) === null && (await doc(`whyb_profiles/${uidB}`)) === null;
    check('delete-my-data (other app in use): whyb data and requests go, account and username stay, still signed in with sync off',
      !!bOff && !!bOff.user && bOff.social === 'off' && (await bGone()) && (await doc(`whyb_requests/${uidA}_${uidB}`)) === null
      && (await doc(`accounts/${uidB}`))?.username === nameB && (await doc(`usernames/${nameB}`))?.uid === uidB && (await doc(`pantry_users/${uidB}`)) !== null,
      JSON.stringify({ state: bOff && { user: !!bOff.user, off: bOff.off, social: bOff.social }, users: await doc(`whyb_users/${uidB}`), profile: await doc(`whyb_profiles/${uidB}`), account: await doc(`accounts/${uidB}`) }));
    check('the account sheet says the data is deleted and offers to turn sync back on', /CLOUD SYNC IS OFF/.test(await B.page.textContent('#account-card')) && await B.page.isVisible('#g-resume'));
    await B.page.reload();
    await B.page.waitForSelector('#boot.done', { timeout: 60000 });
    const bReload = await waitState(B.page, s => s.user && s.status !== 'local' && s.social !== 'loading' && s.social !== 'signed-out');
    await sleep(4000);
    check('after a reload sync is still off and nothing was uploaded again', bReload?.off && bReload.social === 'off' && bReload.places.includes('c:PE') && (await bGone()), JSON.stringify(bReload && { off: bReload.off, status: bReload.status, social: bReload.social }));
    await B.page.click('.tabs [data-tab=friends]');
    check('friends tab explains and offers to turn sync back on', await B.page.isVisible('#f-resume'));
    await B.page.click('#account-btn');
    await B.page.click('#g-resume');
    const bOn = await waitState(B.page, s => !s.off && s.status === 'synced' && s.social === 'ready');
    check('"Turn sync back on" uploads the logbook again and restores the profile with the same username', !!bOn && /"c:PE"/.test((await doc(`whyb_users/${uidB}`))?.book || '') && (await doc(`whyb_profiles/${uidB}`))?.username === nameB, JSON.stringify(bOn && { status: bOn.status, social: bOn.social }));
    await B.page.click('#account-card [data-close]').catch(() => {});

    // sign out keeps the cloud copy
    await A.page.click('#account-btn');
    await A.page.click('#g-signout');
    check('sign out works and leaves the cloud copy alone', !!(await waitState(A.page, s => !s.user)) && (await doc(`whyb_users/${uidA}`)) !== null);

    const keys = await A.page.evaluate(() => ({ localStorage: Object.keys(localStorage), sessionStorage: Object.keys(sessionStorage) }));
    console.log('\nBrowser storage keys (person A, emulator mode):', JSON.stringify(keys));
    const keysB = await B.page.evaluate(() => ({ localStorage: Object.keys(localStorage), sessionStorage: Object.keys(sessionStorage) }));
    console.log('Browser storage keys (person B, sync switched off earlier):', JSON.stringify(keysB));
    const own = [...keys.localStorage, ...keys.sessionStorage, ...keysB.localStorage].filter(k => !k.startsWith('firebase:'));
    check('the app\'s own storage keys all start with whyb.', own.every(k => k.startsWith('whyb.')), own.join(', '));

    // ───── embedded in another site's page: a failed sign-in opens the full site in a new tab ─────
    {
      const http = require('http');
      const host = http.createServer((q, r) => { r.setHeader('Content-Type', 'text/html'); r.end(`<!doctype html><title>host</title><iframe src="${BASE}/?emulator" style="width:1200px;height:800px"></iframe>`); });
      await new Promise(r => host.listen(0, 'localhost', r));
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(`http://localhost:${host.address().port}/`);
      const frame = await until(() => page.frames().find(f => f.url().startsWith(BASE)), 20000);
      await frame.waitForSelector('#boot.done', { timeout: 60000 });
      await frame.click('#account-btn');
      await until(() => frame.$eval('#g-signin', b => !b.disabled), 60000);
      const emb = await frame.evaluate(() => import('/js/cloud.js').then(m => ({ core: m.getCore().embedded, app: m.EMBEDDED, full: m.FULL_SITE })));
      check('embedded: core.embedded is true inside a frame', emb.core === true && emb.app === true);
      // make the sign-in window fail to open (as a browser that blocks it would) and record what the app opens instead
      await frame.evaluate(() => { window.__opened = []; window.open = (...a) => { window.__opened.push(a); return null; }; });
      await frame.click('#g-signin');
      const opened = await until(() => frame.evaluate(() => window.__opened.length >= 2 ? window.__opened : null), 15000);
      const all = opened || await frame.evaluate(() => window.__opened);
      console.log('   embedded: window.open calls:', JSON.stringify(all.map(a => [String(a[0]).slice(0, 70), a[1]])));
      check('embedded: a failed sign-in opens the full site in a new tab', !!opened && opened[opened.length - 1][0] === emb.full && opened[opened.length - 1][1] === '_blank', JSON.stringify(all.map(a => String(a[0]).slice(0, 60))));
      check('embedded: the person is told the full site opened', !!(await until(async () => /full site opened in a new tab/.test(await frame.textContent('body')))));
      await context.close();
      host.close();
    }

    const noise = /Failed to load resource|ERR_|net::|WebGL|maplibre|tile|font|glyph|sprite/i;
    for (const [who, log] of [['A', logA], ['B', logB], ['C', logC]]) {
      const bad = log.filter(l => !noise.test(l));
      console.log(`\nConsole warnings/errors for ${who} (${bad.length}):`);
      bad.slice(0, 12).forEach(l => console.log('   ' + l.slice(0, 300)));
    }
  } catch (e) {
    check('test run completed', false, e.stack || String(e));
  } finally {
    await browser.close();
  }
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
})();
