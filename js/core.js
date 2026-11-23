// core.js — the one piece of Firebase code every app shares. Copy this file into an app
// unchanged (see docs/STANDARD.md); do not edit the copy, edit it here and copy again.
//
// It gives an app: sign-in (Google, and email + password), the shared account (one username
// per person across all apps), Firestore, Cloud Function calls, and App Check (bot protection).
// The Firebase SDK is passed in, so the same file works with the npm package and with the CDN.
export const CORE_VERSION = '1.1.0';
export const FIREBASE_SDK_VERSION = '13.4.0'; // every app pins exactly this version
export const REGION = 'us-central1';
export const USERNAME_RE = /^[a-z0-9_.]{3,20}$/;
/** App profile collections that carry a copy of the username (kept in step when it changes). */
const PROFILE_COLLECTIONS = ['movi_profiles', 'whyb_profiles'];
const EMULATOR_CONFIG = { apiKey: 'demo-key', authDomain: 'demo-apps.firebaseapp.com', projectId: 'demo-apps', appId: 'demo' };

export const normalizeUsername = (s) => String(s ?? '').trim().replace(/^@+/, '').toLowerCase();
export const validUsername = (s) => USERNAME_RE.test(s);

/** Load the SDK from Google's CDN (apps without a build step). */
export async function loadSdkFromCdn(version = FIREBASE_SDK_VERSION) {
  const base = `https://www.gstatic.com/firebasejs/${version}`;
  const [app, auth, firestore, functions, appCheck] = await Promise.all([
    import(`${base}/firebase-app.js`), import(`${base}/firebase-auth.js`), import(`${base}/firebase-firestore.js`),
    import(`${base}/firebase-functions.js`), import(`${base}/firebase-app-check.js`),
  ]);
  return { app, auth, firestore, functions, appCheck };
}

/** True on localhost with ?emulator in the address (remembered for the tab). Used for local testing only. */
export function wantsEmulator(appName) {
  try {
    if (typeof location === 'undefined' || !['localhost', '127.0.0.1'].includes(location.hostname)) return false;
    const key = `${appName}.emulator`;
    if (new URLSearchParams(location.search).has('emulator')) sessionStorage.setItem(key, '1');
    return sessionStorage.getItem(key) === '1';
  } catch { return false; }
}

const friendly = {
  'auth/invalid-credential': 'Wrong email or password',
  'auth/wrong-password': 'Wrong email or password',
  'auth/user-not-found': 'Wrong email or password',
  'auth/invalid-email': 'That email address does not look right',
  'auth/email-already-in-use': 'There is already an account with that email. Sign in instead.',
  'auth/weak-password': 'Use a password of at least 6 characters',
  'auth/too-many-requests': 'Too many attempts. Wait a few minutes and try again.',
  'auth/network-request-failed': 'You seem to be offline',
  'auth/unauthorized-domain': 'This website address is not allowed to sign in yet',
  'auth/requires-recent-login': 'For safety, sign out and back in, then try again',
  'auth/account-exists-with-different-credential': 'That email already has an account. Sign in the way you did before.',
  'auth/popup-blocked': 'Your browser blocked the sign-in window. Allow pop-ups for this site and try again.',
};
function authError(e) {
  const err = new Error(friendly[e?.code] ?? e?.message ?? 'Sign-in failed');
  err.code = e?.code ?? 'unknown';
  return err;
}

/**
 * @param {object} o
 * @param {string} o.appName   'pantry' | 'whyb' | 'movi' | ...
 * @param {object} o.sdk       { app, auth, firestore, functions, appCheck } Firebase modules
 * @param {object|null} o.config  the public Firebase web config (null is allowed with emulator: true)
 * @param {string|null} [o.appCheckSiteKey]  reCAPTCHA Enterprise site key (public)
 * @param {boolean} [o.emulator]  talk to the local emulators instead of the real project
 * @param {boolean} [o.offlineCache]  keep a local copy of Firestore data (browser only)
 */
export function createCore({ appName, sdk, config, appCheckSiteKey = null, emulator = false, offlineCache = true }) {
  const A = sdk.auth, F = sdk.firestore, FN = sdk.functions;
  if (!config && !emulator) throw new Error('Firebase is not configured');
  const browser = typeof window !== 'undefined';
  const embedded = browser && (() => { try { return window.self !== window.top; } catch { return true; } })();
  // One Firebase app per page, shared session across the apps on the same site.
  const fbApp = sdk.app.initializeApp(emulator ? EMULATOR_CONFIG : config);

  if (appCheckSiteKey && !emulator && browser) {
    // On localhost, print a debug token to register in the Firebase console (App Check → Apps → Manage debug tokens).
    if (['localhost', '127.0.0.1'].includes(location.hostname)) self.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
    sdk.appCheck.initializeAppCheck(fbApp, { provider: new sdk.appCheck.ReCaptchaEnterpriseProvider(appCheckSiteKey), isTokenAutoRefreshEnabled: true });
  }

  const auth = A.getAuth(fbApp);
  let db;
  try {
    db = browser && offlineCache && !emulator
      ? F.initializeFirestore(fbApp, { localCache: F.persistentLocalCache({ tabManager: F.persistentMultipleTabManager() }) })
      : F.getFirestore(fbApp);
  } catch { db = F.getFirestore(fbApp); }
  const functions = FN.getFunctions(fbApp, REGION);

  if (emulator) {
    A.connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
    F.connectFirestoreEmulator(db, '127.0.0.1', 8080);
    FN.connectFunctionsEmulator(functions, '127.0.0.1', 5001);
  }

  // ───────── who is signed in ─────────
  const toUser = (u) => (u ? {
    uid: u.uid, name: u.displayName ?? '', email: u.email ?? '', photo: u.photoURL ?? '', emailVerified: !!u.emailVerified,
    providers: u.providerData.map((p) => p.providerId), // 'google.com', 'password'
  } : null);
  const listeners = new Set();
  let current = null, known = false, resolveReady;
  const ready = new Promise((r) => { resolveReady = r; });
  A.onAuthStateChanged(auth, (u) => {
    current = toUser(u); known = true; resolveReady(current);
    for (const l of [...listeners]) l(current);
  });
  if (browser) A.getRedirectResult(auth).catch(() => {});

  const provider = () => { const p = new A.GoogleAuthProvider(); p.setCustomParameters({ prompt: 'select_account' }); return p; };

  const core = {
    appName, emulator, embedded, app: fbApp, auth, db, functions, F, A,
    /** Resolves with the signed-in person (or null) once Firebase knows. */
    ready,
    get user() { return current; },
    /** Calls back now (if known) and on every sign-in or sign-out. Returns a function that stops it. */
    onUser(cb) { listeners.add(cb); if (known) cb(current); return () => listeners.delete(cb); },

    /**
     * Google sign-in. CALL THIS DIRECTLY FROM THE CLICK HANDLER, with nothing awaited before it:
     * browsers only allow the sign-in window to open in direct response to a click.
     */
    signInWithGoogle() {
      return A.signInWithPopup(auth, provider()).then((c) => toUser(c.user), async (e) => {
        if (['auth/popup-closed-by-user', 'auth/cancelled-popup-request', 'auth/user-cancelled'].includes(e?.code)) return null;
        // Inside another site's frame (an embed) a redirect cannot work: let the app open the full site instead.
        if (e?.code === 'auth/operation-not-supported-in-this-environment' && !embedded) { await A.signInWithRedirect(auth, provider()); return null; }
        throw authError(e);
      });
    },
    async signInWithEmail(email, password) {
      try { return toUser((await A.signInWithEmailAndPassword(auth, email, password)).user); } catch (e) { throw authError(e); }
    },
    async signUpWithEmail(email, password, displayName = '') {
      try {
        const c = await A.createUserWithEmailAndPassword(auth, email, password);
        if (displayName) await A.updateProfile(c.user, { displayName });
        A.sendEmailVerification(c.user).catch(() => {});
        current = toUser(c.user);
        return current;
      } catch (e) { throw authError(e); }
    },
    async resetPassword(email) { try { await A.sendPasswordResetEmail(auth, email); } catch (e) { if (e?.code !== 'auth/user-not-found') throw authError(e); } },
    async updatePassword(password) { try { await A.updatePassword(auth.currentUser, password); } catch (e) { throw authError(e); } },
    async signOut() { await A.signOut(auth); },

    /** Local testing only: sign in to the Auth emulator as a made-up Google account. */
    async emulatorSignIn(email, name = email.split('@')[0]) {
      if (!emulator) throw new Error('emulator only');
      const token = JSON.stringify({ sub: `g-${email}`, email, email_verified: true, name });
      return toUser((await A.signInWithCredential(auth, A.GoogleAuthProvider.credential(token))).user);
    },

    // ───────── the shared account: one username per person, for every app ─────────
    account: {
      normalize: normalizeUsername,
      valid: validUsername,
      /** { username, displayName } or null */
      async get(uid = current?.uid) {
        if (!uid) return null;
        const s = await F.getDoc(F.doc(db, 'accounts', uid));
        return s.exists() ? { uid, username: s.get('username'), displayName: s.get('displayName') } : null;
      },
      /** Who owns a username: uid or null */
      async ownerOf(name) {
        const n = normalizeUsername(name);
        if (!validUsername(n)) return null;
        const s = await F.getDoc(F.doc(db, 'usernames', n));
        return s.exists() ? s.get('uid') : null;
      },
      async isFree(name) {
        const n = normalizeUsername(name);
        if (!validUsername(n)) return false;
        const owner = await core.account.ownerOf(n);
        return owner === null || owner === current?.uid;
      },
      /** A free username built from a name or email, e.g. "sam.lee" or "sam.lee482". */
      async suggest(seed) {
        let base = normalizeUsername(String(seed ?? '').split('@')[0]).replace(/\s+/g, '.').replace(/[^a-z0-9_.]/g, '').slice(0, 16);
        if (base.length < 3) base = `user${base}`;
        if (await core.account.isFree(base)) return base;
        for (let i = 0; i < 20; i++) {
          const candidate = `${base}${Math.floor(100 + Math.random() * 9900)}`.slice(0, 20);
          if (await core.account.isFree(candidate)) return candidate;
        }
        return `${base.slice(0, 8)}${Date.now().toString(36)}`.slice(0, 20);
      },
      /**
       * Claim or change the signed-in person's username (and optionally their display name).
       * `extra(batch)` lets an app add its own writes to the same all-or-nothing batch.
       * Throws an Error with a message that is fine to show.
       */
      async claim(rawName, { displayName, extra } = {}) {
        const uid = current?.uid ?? auth.currentUser?.uid;
        if (!uid) throw new Error('Sign in first');
        const name = normalizeUsername(rawName);
        if (!validUsername(name)) throw new Error('Use 3–20 characters: lowercase letters, numbers, dots or underscores');
        const accRef = F.doc(db, 'accounts', uid);
        const acc = await F.getDoc(accRef);
        const old = acc.exists() ? acc.get('username') : null;
        const shownName = String(displayName ?? (acc.exists() ? acc.get('displayName') : current?.name) ?? '').slice(0, 40);
        const batch = F.writeBatch(db);
        if (acc.exists()) batch.update(accRef, { username: name, displayName: shownName, updatedAt: F.serverTimestamp() });
        else batch.set(accRef, { username: name, displayName: shownName, createdAt: F.serverTimestamp(), updatedAt: F.serverTimestamp() });
        if (old !== name) {
          if ((await core.account.ownerOf(name)) !== null) throw new Error(`@${name} is taken, so try another`);
          batch.set(F.doc(db, 'usernames', name), { uid });
          if (old) batch.delete(F.doc(db, 'usernames', old));
          for (const coll of PROFILE_COLLECTIONS) {
            const ref = F.doc(db, coll, uid);
            const snap = await F.getDoc(ref).catch(() => null);
            if (snap?.exists()) batch.update(ref, { username: name });
          }
        }
        if (extra) await extra(batch);
        try { await batch.commit(); } catch (e) {
          if (e?.code === 'permission-denied') throw new Error(`@${name} is taken, so try another`);
          throw e;
        }
        return { uid, username: name, displayName: shownName };
      },
    },

    /** Call a Cloud Function. Errors carry a message that is fine to show, and a `code`. */
    async call(name, data, { timeout = 120_000 } = {}) {
      try {
        return (await FN.httpsCallable(functions, name, { timeout })(data)).data;
      } catch (e) {
        const code = String(e?.code ?? '').replace(/^functions\//, '');
        const said = String(e?.message ?? '').replace(/\s*\[\d{3}\]$/, ''); // the SDK appends the HTTP status
        const msg = code === 'unauthenticated' ? (said || 'Sign in first.')
          : code === 'not-found' ? 'This feature is not switched on yet.'
          : code === 'deadline-exceeded' ? 'That took too long. Try again.'
          : (said && code !== 'internal' ? said : 'Something went wrong. Try again.');
        const err = new Error(msg); err.code = code || 'unknown';
        throw err;
      }
    },

    /** Delete this person's data for one app ('pantry' | 'whyb' | 'movi') or 'all'. */
    async deleteMyData(app = appName) {
      const res = await core.call('accountDeleteMyData', { app });
      if (res.accountDeleted) await A.signOut(auth).catch(() => {});
      return res;
    },
  };
  return core;
}
