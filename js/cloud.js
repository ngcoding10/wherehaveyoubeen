// Optional cloud sync with Firebase Auth (Google) + Firestore.
// The logbook is stored at users/{uid} as a JSON string and merged per-place,
// so you can log trips on your phone and laptop and both stay in sync live.
import { firebaseConfig } from './firebase-config.js';
import { store } from './store.js';

const V = '12.6.0';
const CDN = `https://www.gstatic.com/firebasejs/${V}`;

export const cloud = new EventTarget();
cloud.enabled = !!firebaseConfig;
cloud.user = null;
cloud.status = 'local'; // local | connecting | synced | saving | error

let fb = null, unsubDoc = null, saveTimer = null, applyingRemote = false;

function setStatus(s, msg) { cloud.status = s; cloud.dispatchEvent(new CustomEvent('status', { detail: { status: s, msg } })); }

async function load() {
  if (fb) return fb;
  const [app, auth, fs] = await Promise.all([
    import(`${CDN}/firebase-app.js`), import(`${CDN}/firebase-auth.js`), import(`${CDN}/firebase-firestore.js`),
  ]);
  const a = app.initializeApp(firebaseConfig);
  fb = { app: a, auth: auth.getAuth(a), db: fs.getFirestore(a), A: auth, F: fs };
  // local testing only: http://localhost:…/?emulator=1 talks to the Firebase emulators instead of the real project
  if (location.hostname === 'localhost' && new URLSearchParams(location.search).has('emulator')) {
    auth.connectAuthEmulator(fb.auth, 'http://127.0.0.1:9099', { disableWarnings: true });
    fs.connectFirestoreEmulator(fb.db, '127.0.0.1', 8080);
    window.__emuSignIn = async (email, name) => {
      const pw = 'test-password-123';
      let cred;
      try { cred = await auth.signInWithEmailAndPassword(fb.auth, email, pw); }
      catch { cred = await auth.createUserWithEmailAndPassword(fb.auth, email, pw); await auth.updateProfile(cred.user, { displayName: name || email }); }
      return cred.user.uid;
    };
  }
  return fb;
}
/** The loaded Firebase SDK + app instances (for other modules such as friends). */
export const getFirebase = load;

export async function initCloud() {
  if (!cloud.enabled) return;
  try {
    const { auth, A } = await load();
    A.onAuthStateChanged(auth, user => onUser(user));
    // finish a redirect sign-in (used on mobile where popups get blocked)
    A.getRedirectResult(auth).catch(() => {});
  } catch (e) {
    console.warn('Firebase failed to load', e);
    setStatus('error', 'Could not reach Google sign-in');
  }
}

export async function signIn() {
  if (!cloud.enabled) throw new Error('not-configured');
  const { auth, A } = await load();
  const provider = new A.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  try { await A.signInWithPopup(auth, provider); }
  catch (e) {
    if (e?.code === 'auth/popup-blocked' || e?.code === 'auth/operation-not-supported-in-this-environment') {
      await A.signInWithRedirect(auth, provider);
    } else throw e;
  }
}

export async function signOutUser() {
  if (!fb) return;
  await fb.A.signOut(fb.auth);
}

async function onUser(user) {
  cloud.user = user ? { uid: user.uid, name: user.displayName, email: user.email, photo: user.photoURL } : null;
  cloud.dispatchEvent(new CustomEvent('user', { detail: cloud.user }));
  if (unsubDoc) { unsubDoc(); unsubDoc = null; }
  if (!user) { setStatus('local'); return; }
  setStatus('connecting');
  const { db, F } = fb;
  const ref = F.doc(db, 'users', user.uid);
  try {
    const snap = await F.getDoc(ref);
    if (snap.exists()) {
      const remote = parse(snap.data());
      applyingRemote = true; store.merge(remote.book); applyingRemote = false;
      if (remote.settings) mergeSettings(remote.settings);
    }
    await push(); // upload the merged result (also creates the doc on first sign-in)
    unsubDoc = F.onSnapshot(ref, s => {
      if (s.metadata.hasPendingWrites || !s.exists()) return;
      const remote = parse(s.data());
      applyingRemote = true; store.merge(remote.book); applyingRemote = false;
      setStatus('synced');
    }, err => setStatus('error', err.message));
    setStatus('synced');
  } catch (e) {
    console.warn(e);
    setStatus('error', e.code === 'permission-denied' ? 'Firestore rules blocked the save (see README)' : e.message);
  }
}

function parse(d) {
  try { return { book: JSON.parse(d.book || 'null'), settings: d.settings ? JSON.parse(d.settings) : null }; }
  catch { return { book: null }; }
}
function mergeSettings(s) {
  // only adopt cloud colours/theme if this browser never customised them
  try { if (!localStorage.getItem('whyb.settings.v1') && s) for (const [k, v] of Object.entries(s)) if (k !== 'colors') store.setSetting(k, v); } catch {}
}

async function push() {
  if (!fb || !cloud.user) return;
  const { db, F } = fb;
  setStatus('saving');
  await F.setDoc(F.doc(db, 'users', cloud.user.uid), {
    book: JSON.stringify(store.snapshot()),
    settings: JSON.stringify(store.settings),
    name: cloud.user.name || '', updatedAt: F.serverTimestamp(),
  });
  setStatus('synced');
}

function schedulePush() {
  if (!cloud.user || applyingRemote) return;
  clearTimeout(saveTimer);
  setStatus('saving');
  saveTimer = setTimeout(() => push().catch(e => setStatus('error', e.message)), 1200);
}
store.addEventListener('change', schedulePush);
store.addEventListener('settings', schedulePush);
