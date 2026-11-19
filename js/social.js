// Friends: unique usernames, mutual friend requests, and a friends-only profile with your stats
// and visited places (never your notes, dates or home base). Backed by Firestore; see firestore.rules.
import { cloud, getFirebase } from './cloud.js';
import { store } from './store.js';
import { computeStats } from './stats.js';

export const social = new EventTarget();
social.state = 'signed-out'; // signed-out | loading | need-username | ready | error
social.error = '';
social.me = null;            // my profile doc
social.friends = new Map();  // uid -> profile
social.incoming = [];        // requests to me
social.outgoing = [];        // requests from me

const NAME_RE = /^[a-z0-9_]{3,20}$/;
export const normalizeName = s => (s || '').trim().replace(/^@+/, '').toLowerCase();
export const validName = s => NAME_RE.test(s);

let unsubs = [], friendSubs = new Map(), retries = new Map(), publishTimer = null, uid = null;
const emit = () => social.dispatchEvent(new CustomEvent('change'));
function setState(s, err = '') { social.state = s; social.error = err; emit(); }
function friendlyError(e) {
  if (e?.code === 'permission-denied') return 'The friends database isn’t switched on yet. The site owner needs to publish the new Firestore rules (see README → Friends).';
  if (e?.code === 'unavailable') return 'You seem to be offline.';
  return e?.message || String(e);
}

cloud.addEventListener('user', () => start());

async function start() {
  stop();
  if (!cloud.user) { uid = null; setState('signed-out'); return; }
  uid = cloud.user.uid;
  setState('loading');
  const { db, F } = await getFirebase();
  try {
    const snap = await F.getDoc(F.doc(db, 'profiles', uid));
    if (!snap.exists() || !snap.data().username) { social.me = null; setState('need-username'); return; }
    social.me = snap.data();
    listen();
    setState('ready');
    schedulePublish(0);
  } catch (e) { console.warn(e); setState('error', friendlyError(e)); }
}

function stop() {
  unsubs.forEach(u => u()); unsubs = [];
  friendSubs.forEach(u => u()); friendSubs.clear();
  social.friends.clear(); social.incoming = []; social.outgoing = []; social.me = null;
}

async function listen() {
  const { db, F } = await getFirebase();
  const onErr = e => { console.warn(e); setState('error', friendlyError(e)); };
  unsubs.push(F.onSnapshot(F.doc(db, 'profiles', uid), { includeMetadataChanges: true }, s => {
    // wait until our own writes (e.g. accepting a request) are saved before reading friends' profiles
    if (!s.exists() || s.metadata.hasPendingWrites) return;
    social.me = s.data();
    syncFriendSubs(social.me.friends || []);
    emit();
  }, onErr));
  const reqs = F.collection(db, 'requests');
  unsubs.push(F.onSnapshot(F.query(reqs, F.where('to', '==', uid)), qs => { social.incoming = qs.docs.map(d => ({ id: d.id, ...d.data() })); emit(); }, onErr));
  unsubs.push(F.onSnapshot(F.query(reqs, F.where('from', '==', uid)), qs => { social.outgoing = qs.docs.map(d => ({ id: d.id, ...d.data() })); emit(); }, onErr));
}

async function syncFriendSubs(list) {
  const { db, F } = await getFirebase();
  for (const [fid, u] of friendSubs) if (!list.includes(fid)) { u(); friendSubs.delete(fid); social.friends.delete(fid); }
  for (const fid of list) {
    if (friendSubs.has(fid)) continue;
    friendSubs.set(fid, F.onSnapshot(F.doc(db, 'profiles', fid),
      s => { if (s.exists()) social.friends.set(fid, { uid: fid, ...s.data() }); emit(); },
      () => {
        // not allowed (yet): they removed you, or their side of the friendship is still saving. Retry a few times.
        social.friends.delete(fid); friendSubs.delete(fid); emit();
        const tries = (retries.get(fid) || 0) + 1; retries.set(fid, tries);
        if (tries <= 4) setTimeout(() => { if ((social.me?.friends || []).includes(fid)) syncFriendSubs(social.me.friends); }, 1500 * tries);
      }));
  }
}

/** What friends can see about you. */
function publicPayload() {
  const st = computeStats();
  return {
    username: social.me?.username,
    name: (cloud.user?.name || '').split(' ')[0].slice(0, 30),
    stats: { countries: st.un, territories: st.terr, states: st.states, cities: st.cities, wonders: st.lms,
             world: Math.round(st.pctWorld * 10) / 10, continents: st.conts },
    visited: { c: store.visitedCountries(), s: store.visitedStates(), l: store.landmarks(),
               ci: store.cities().slice(0, 4000).map(([id, c]) => [+id, c.n, c.c]) },
  };
}

export function schedulePublish(delay = 2500) {
  if (social.state !== 'ready') return;
  clearTimeout(publishTimer);
  publishTimer = setTimeout(async () => {
    try {
      const { db, F } = await getFirebase();
      await F.setDoc(F.doc(db, 'profiles', uid), { ...publicPayload(), updatedAt: F.serverTimestamp() }, { merge: true });
    } catch (e) { console.warn('publish failed', e); }
  }, delay);
}
store.addEventListener('change', () => schedulePublish());

export async function isUsernameFree(name) {
  const { db, F } = await getFirebase();
  const s = await F.getDoc(F.doc(db, 'usernames', name));
  return !s.exists() || s.data().uid === uid;
}

/** Claim (or change) your username. Returns an error message, or '' on success. */
export async function claimUsername(raw) {
  const name = normalizeName(raw);
  if (!validName(name)) return 'Use 3–20 characters: lowercase letters, numbers or _';
  const { db, F } = await getFirebase();
  try {
    if (!(await isUsernameFree(name))) return `@${name} is taken, so try another`;
    const old = social.me?.username;
    const batch = F.writeBatch(db);
    const payload = { ...publicPayload(), username: name, friends: social.me?.friends || [], updatedAt: F.serverTimestamp() };
    batch.set(F.doc(db, 'profiles', uid), payload, { merge: true });
    batch.set(F.doc(db, 'usernames', name), { uid });
    if (old && old !== name) batch.delete(F.doc(db, 'usernames', old));
    await batch.commit();
    if (social.state !== 'ready') { await start(); } else { social.me = { ...social.me, username: name }; emit(); }
    return '';
  } catch (e) { console.warn(e); return friendlyError(e); }
}

/** Send a friend request by username. Returns { ok, msg }. */
export async function sendRequest(raw) {
  const name = normalizeName(raw);
  if (!validName(name)) return { ok: false, msg: 'That isn’t a valid username.' };
  if (name === social.me?.username) return { ok: false, msg: 'That’s you! 😄' };
  const { db, F } = await getFirebase();
  try {
    const u = await F.getDoc(F.doc(db, 'usernames', name));
    if (!u.exists()) return { ok: false, msg: `No one has the username @${name} yet.` };
    const to = u.data().uid;
    if ((social.me.friends || []).includes(to)) return { ok: false, msg: `You’re already friends with @${name}.` };
    const theirs = social.incoming.find(r => r.from === to);
    if (theirs) { await acceptRequest(theirs); return { ok: true, msg: `@${name} had already asked, so you’re now friends!` }; }
    await F.setDoc(F.doc(db, 'requests', `${to}_${uid}`), { from: uid, to, fromName: social.me.username, toName: name, createdAt: F.serverTimestamp() });
    return { ok: true, msg: `Request sent to @${name}. You’ll see each other’s maps once they accept.` };
  } catch (e) { console.warn(e); return { ok: false, msg: friendlyError(e) }; }
}

export async function acceptRequest(r) {
  const { db, F } = await getFirebase();
  const batch = F.writeBatch(db);
  batch.update(F.doc(db, 'profiles', uid), { friends: F.arrayUnion(r.from) });
  batch.update(F.doc(db, 'profiles', r.from), { friends: F.arrayUnion(uid) });
  batch.delete(F.doc(db, 'requests', r.id));
  await batch.commit();
}
export async function deleteRequest(r) {
  const { db, F } = await getFirebase();
  await F.deleteDoc(F.doc(db, 'requests', r.id));
}
export async function removeFriend(fid) {
  const { db, F } = await getFirebase();
  const batch = F.writeBatch(db);
  batch.update(F.doc(db, 'profiles', uid), { friends: F.arrayRemove(fid) });
  batch.update(F.doc(db, 'profiles', fid), { friends: F.arrayRemove(uid) });
  try { await batch.commit(); }
  catch { await F.updateDoc(F.doc(db, 'profiles', uid), { friends: F.arrayRemove(fid) }); } // their profile may be gone
}

/** You + friends, as comparable rows. */
export function leaderboard() {
  const mine = publicPayload();
  const rows = [{ uid, me: true, username: social.me?.username, name: mine.name, stats: mine.stats, visited: mine.visited }];
  for (const f of social.friends.values()) rows.push({ uid: f.uid, username: f.username, name: f.name, stats: f.stats || {}, visited: f.visited || { c: [], s: [], l: [], ci: [] } });
  return rows;
}

export function overlap(a, b) {
  const A = new Set(a), B = new Set(b);
  return { both: [...A].filter(x => B.has(x)), onlyA: [...A].filter(x => !B.has(x)), onlyB: [...B].filter(x => !A.has(x)) };
}
