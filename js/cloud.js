// Optional cloud sync: Google sign-in + Firestore, through the shared core (js/core.js).
// The logbook is stored at whyb_users/{uid} as a JSON string and merged per-place,
// so you can log trips on your phone and laptop and both stay in sync live.
// The backend (security rules, Cloud Functions) lives in github.com/ngcoding10/backend-combination.
import { firebaseConfig, appCheckSiteKey } from './firebase-config.js';
import { createCore, loadSdkFromCdn, wantsEmulator } from './core.js';
import { store } from './store.js';

const APP = 'whyb';
const MAX_BOOK = 950000, MAX_SETTINGS = 20000; // limits in the backend's rules
/** Local testing only: localhost + ?emulator in the address talks to the Firebase emulators. */
const emulator = wantsEmulator(APP);

export const cloud = new EventTarget();
cloud.enabled = !!firebaseConfig || emulator;
cloud.ready = false;    // true once the core is loaded: only then can the sign-in button work
cloud.failed = false;   // the Firebase SDK could not be loaded
cloud.user = null;
cloud.status = 'local'; // local | connecting | synced | saving | error | off
cloud.off = false;      // signed in, but cloud sync is switched off (after "delete my data") until they turn it back on
cloud.lastError = '';

let core = null, loading = null, unsubDoc = null, saveTimer = null, applyingRemote = false, paused = false, pushing = null;

function setStatus(s, msg = '') {
  cloud.status = s; cloud.lastError = s === 'error' ? msg : '';
  cloud.dispatchEvent(new CustomEvent('status', { detail: { status: s, msg } }));
}
const fire = name => cloud.dispatchEvent(new CustomEvent(name));

// After deleting their cloud data a person can stay signed in (another app uses the same sign-in). Sync then
// stays off for them, also after a reload, so nothing is uploaded again until they ask for it.
const LS_SYNC_OFF = 'whyb.syncOff';
const syncOffFor = uid => { try { return localStorage.getItem(LS_SYNC_OFF) === uid; } catch { return false; } };
function setSyncOff(uid) { try { if (uid) localStorage.setItem(LS_SYNC_OFF, uid); else localStorage.removeItem(LS_SYNC_OFF); } catch { /* private mode */ } }

/** The shared core ({ db, F, A, account, … }), or null until initCloud() has finished loading it. */
export const getCore = () => core;

/** Load Firebase once, at startup, so that sign-in can open straight from a click. */
export function initCloud() {
  if (!cloud.enabled) return Promise.resolve(null);
  if (loading) return loading;
  cloud.failed = false;
  loading = (async () => {
    try {
      core = createCore({ appName: APP, sdk: await loadSdkFromCdn(), config: firebaseConfig, appCheckSiteKey, emulator });
      if (emulator) window.__emuSignIn = (email, name) => core.emulatorSignIn(email, name).then(u => u.uid);
      cloud.ready = true; fire('ready');
      core.onUser(user => onUser(user));
    } catch (e) {
      console.warn('Firebase failed to load', e);
      loading = null; cloud.failed = true;
      setStatus('error', 'Could not reach Google sign-in');
      fire('ready');
    }
    return core;
  })();
  return loading;
}

/** True when the app is shown inside another site's page (an iframe), e.g. on ascoding. */
export const EMBEDDED = (() => { try { return window.self !== window.top; } catch { return true; } })();
export const FULL_SITE = location.origin + location.pathname.replace(/index\.html$/, '');

/**
 * Google sign-in. Call it directly from the click handler: nothing is awaited before the sign-in
 * window opens (browsers block it otherwise). Resolves with the person, or null if they closed the window.
 */
export function signIn() {
  if (!core) { const e = new Error('Sign-in is still loading. Try again in a moment.'); e.code = 'not-ready'; return Promise.reject(e); }
  setSyncOff(null); // signing in is asking for sync
  return core.signInWithGoogle().catch(e => {
    if (core.embedded ?? EMBEDDED) {
      // Inside another site (e.g. ascoding): some browsers (Safari) block sign-in in embedded pages, and
      // Google refuses to load inside a frame, so open the full site in a new tab instead.
      window.open(FULL_SITE, '_blank', 'noopener');
      const err = new Error('Sign-in opened in a new tab'); err.code = 'embed/opened-full-site'; throw err;
    }
    throw e;
  });
}

export async function signOutUser() {
  setSyncOff(null);
  if (core) await core.signOut();
}

/** Turn cloud sync back on after it was switched off by deleting the cloud data. */
export function resumeSync() {
  setSyncOff(null);
  if (core?.user) return onUser(core.user);
}

/**
 * Delete everything this app keeps in the cloud for the signed-in person (logbook, friends profile,
 * friend requests). The copy of the logbook in this browser stays. The sign-in itself is removed (and the
 * person signed out) only when they use no other app on the shared backend. Otherwise they stay signed in
 * with cloud sync off, so nothing is uploaded again until they turn it back on.
 */
export async function deleteMyCloudData() {
  if (!core || !cloud.user) throw new Error('Sign in first');
  paused = true; clearTimeout(saveTimer);
  if (unsubDoc) { unsubDoc(); unsubDoc = null; }
  fire('pause'); // friends stop listening and publishing, so nothing is written back while deleting
  try {
    await pushing?.catch(() => {});
    const uid = cloud.user.uid;
    const res = await core.deleteMyData(APP); // signs out by itself when the whole account went
    paused = false;
    if (!res?.accountDeleted && core.user?.uid === uid) { setSyncOff(uid); onUser(core.user); }
    return res;
  } catch (e) {
    paused = false; onUser(core.user); // carry on as before
    throw e;
  }
}

async function onUser(user) {
  if (paused && user) return;
  cloud.user = user ? { uid: user.uid, name: user.name, email: user.email, photo: user.photo } : null;
  cloud.off = !!user && syncOffFor(user.uid);
  cloud.dispatchEvent(new CustomEvent('user', { detail: cloud.user }));
  if (unsubDoc) { unsubDoc(); unsubDoc = null; }
  clearTimeout(saveTimer);
  if (!user) { setStatus('local'); return; }
  if (cloud.off) { setStatus('off'); return; } // nothing is read or written until they turn sync back on
  setStatus('connecting');
  const { db, F } = core;
  const ref = F.doc(db, 'whyb_users', user.uid);
  try {
    const snap = await F.getDoc(ref);
    if (cloud.user?.uid !== user.uid) return; // signed out (or switched) while loading
    if (snap.exists()) {
      const remote = parse(snap.data());
      applyingRemote = true; store.merge(remote.book); applyingRemote = false;
      if (remote.settings) mergeSettings(remote.settings);
    }
    await push(); // upload the merged result (also creates the doc on first sign-in)
    if (cloud.user?.uid !== user.uid || paused) return;
    unsubDoc = F.onSnapshot(ref, s => {
      if (s.metadata.hasPendingWrites || !s.exists()) return;
      const remote = parse(s.data());
      applyingRemote = true; store.merge(remote.book); applyingRemote = false;
      if (cloud.status !== 'error') setStatus('synced');
    }, err => setStatus('error', syncError(err)));
  } catch (e) {
    console.warn(e);
    setStatus('error', syncError(e));
  }
}

function syncError(e) {
  if (e?.code === 'too-big') return e.message;
  if (e?.code === 'permission-denied') return 'The server refused to save your logbook. Try signing out and back in.';
  if (e?.code === 'unavailable') return 'You seem to be offline. Your logbook is safe in this browser.';
  return e?.message || String(e);
}

function parse(d) {
  try { return { book: JSON.parse(d.book || 'null'), settings: d.settings ? JSON.parse(d.settings) : null }; }
  catch { return { book: null }; }
}
function mergeSettings(s) {
  // only adopt cloud colours/theme if this browser never customised them
  try { if (!localStorage.getItem('whyb.settings.v1') && s) for (const [k, v] of Object.entries(s)) if (k !== 'colors') store.setSetting(k, v); } catch {}
}

function push() {
  if (!core || !cloud.user || paused || cloud.off) return Promise.resolve();
  const { db, F } = core, uid = cloud.user.uid;
  const book = JSON.stringify(store.snapshot());
  let settings = JSON.stringify(store.settings);
  if (settings.length > MAX_SETTINGS) settings = '{}';
  if (book.length > MAX_BOOK) {
    const e = new Error(`Your logbook is too big to save to your account (${book.length.toLocaleString('en')} of ${MAX_BOOK.toLocaleString('en')} characters). It is still saved in this browser. Shorten some notes, or export a backup from 🎨.`);
    e.code = 'too-big';
    return Promise.reject(e);
  }
  setStatus('saving');
  pushing = F.setDoc(F.doc(db, 'whyb_users', uid), {
    book, settings, name: (cloud.user.name || '').slice(0, 200), updatedAt: F.serverTimestamp(),
  }).then(() => { if (cloud.user?.uid === uid) setStatus('synced'); });
  return pushing;
}

function schedulePush() {
  if (!cloud.user || applyingRemote || paused || cloud.off) return;
  clearTimeout(saveTimer);
  if (cloud.status !== 'error') setStatus('saving');
  saveTimer = setTimeout(() => push().catch(e => { console.warn(e); setStatus('error', syncError(e)); }), 1200);
}
store.addEventListener('change', schedulePush);
store.addEventListener('settings', schedulePush);
