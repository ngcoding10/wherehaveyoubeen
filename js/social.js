// Friends: unique usernames, mutual friend requests, and a friends-only profile with your stats
// and visited places (never your notes, dates or home base). Backed by Firestore (whyb_profiles,
// whyb_requests). The username is the shared account's: one per person across every app on the backend,
// claimed and looked up through the core (accounts/usernames are never written here).
import { cloud, getCore } from './cloud.js';
import { normalizeUsername, validUsername } from './core.js';
import { store } from './store.js';
import { computeStats } from './stats.js';
import { isWonder } from './landmarks.js';

export const social = new EventTarget();
social.state = 'signed-out'; // signed-out | off (signed in, cloud sync switched off) | loading | need-username | ready | error
social.error = '';
social.me = null;            // my profile doc
social.friends = new Map();  // uid -> profile
social.incoming = [];        // requests to me
social.outgoing = [];        // requests from me

export const normalizeName = normalizeUsername;
export const validName = validUsername; // ^[a-z0-9_.]{3,20}$
export const NAME_HINT = 'Use 3–20 characters: lowercase letters, numbers, dots or underscores';
const PROFILES = 'whyb_profiles', REQUESTS = 'whyb_requests';

let unsubs = [], friendSubs = new Map(), retries = new Map(), publishTimer = null, uid = null;
const emit = () => social.dispatchEvent(new CustomEvent('change'));
function setState(s, err = '') { social.state = s; social.error = err; emit(); }
function friendlyError(e) {
  if (e?.code === 'permission-denied') return 'The server refused that. Reload the page and try again.';
  if (e?.code === 'unavailable') return 'You seem to be offline.';
  return e?.message || String(e);
}

cloud.addEventListener('user', () => start());
// the account's cloud data is being deleted: stop listening and publishing so nothing is written back
cloud.addEventListener('pause', () => { stop(); uid = null; setState('signed-out'); });

async function start() {
  stop();
  if (!cloud.user) { uid = null; setState('signed-out'); return; }
  if (cloud.off) { uid = null; setState('off'); return; } // cloud data was deleted: no profile until sync is back on
  const me = uid = cloud.user.uid;
  setState('loading');
  const core = getCore(), { db, F } = core;
  try {
    const ref = F.doc(db, PROFILES, me);
    let snap = await F.getDoc(ref);
    if (uid !== me) return;
    if (!snap.exists() || !snap.data().username) {
      // Someone who already has a username (picked here before, or in another app) is not asked again:
      // their profile for this app is created with that name.
      const account = await core.account.get(me);
      if (uid !== me) return;
      if (!account?.username) { social.me = null; setState('need-username'); return; }
      await F.setDoc(ref, { ...publicPayload(), username: account.username, friends: [], updatedAt: F.serverTimestamp() });
      snap = await F.getDoc(ref);
      if (uid !== me) return;
    }
    social.me = snap.data();
    listen();
    setState('ready');
    schedulePublish(0);
  } catch (e) { console.warn(e); setState('error', friendlyError(e)); }
}

function stop() {
  clearTimeout(publishTimer);
  unsubs.forEach(u => u()); unsubs = [];
  friendSubs.forEach(u => u()); friendSubs.clear();
  social.friends.clear(); social.incoming = []; social.outgoing = []; social.me = null;
}

function listen() {
  const { db, F } = getCore();
  const onErr = e => { console.warn(e); setState('error', friendlyError(e)); };
  unsubs.push(F.onSnapshot(F.doc(db, PROFILES, uid), { includeMetadataChanges: true }, s => {
    // wait until our own writes (e.g. accepting a request) are saved before reading friends' profiles
    if (!s.exists() || s.metadata.hasPendingWrites) return;
    social.me = s.data();
    syncFriendSubs(social.me.friends || []);
    emit();
  }, onErr));
  const reqs = F.collection(db, REQUESTS);
  unsubs.push(F.onSnapshot(F.query(reqs, F.where('to', '==', uid)), qs => { social.incoming = qs.docs.map(d => ({ id: d.id, ...d.data() })); emit(); }, onErr));
  unsubs.push(F.onSnapshot(F.query(reqs, F.where('from', '==', uid)), qs => { social.outgoing = qs.docs.map(d => ({ id: d.id, ...d.data() })); emit(); }, onErr));
}

function syncFriendSubs(list) {
  const { db, F } = getCore();
  for (const [fid, u] of friendSubs) if (!list.includes(fid)) { u(); friendSubs.delete(fid); social.friends.delete(fid); }
  for (const fid of list) {
    if (friendSubs.has(fid)) continue;
    friendSubs.set(fid, F.onSnapshot(F.doc(db, PROFILES, fid),
      s => { if (s.exists()) social.friends.set(fid, { uid: fid, ...s.data() }); emit(); },
      () => {
        // not allowed (yet): they removed you, or their side of the friendship is still saving. Retry a few times.
        social.friends.delete(fid); friendSubs.delete(fid); emit();
        const tries = (retries.get(fid) || 0) + 1; retries.set(fid, tries);
        if (tries <= 4) setTimeout(() => { if ((social.me?.friends || []).includes(fid)) syncFriendSubs(social.me.friends); }, 1500 * tries);
      }));
  }
}

/** What friends can see about you (the username is kept in step with the account, never set here). */
function publicPayload() {
  const st = computeStats();
  return {
    name: (cloud.user?.name || '').split(' ')[0].slice(0, 30),
    stats: { countries: st.un, territories: st.terr, states: st.states, cities: st.cities, wonders: st.lms,
             world: Math.round(st.pctWorld * 10) / 10, continents: st.conts },
    visited: { c: store.visitedCountries(), s: store.visitedStates(), l: store.landmarks().filter(isWonder),
               ci: store.cities().slice(0, 4000).map(([id, c]) => ({ i: +id, n: c.n || '', c: c.c || '' })) },
  };
}

export function schedulePublish(delay = 2500) {
  if (social.state !== 'ready') return;
  clearTimeout(publishTimer);
  publishTimer = setTimeout(async () => {
    if (social.state !== 'ready' || !uid) return;
    try {
      const { db, F } = getCore();
      await F.setDoc(F.doc(db, PROFILES, uid), { ...publicPayload(), updatedAt: F.serverTimestamp() }, { merge: true });
    } catch (e) { console.warn('publish failed', e); }
  }, delay);
}
store.addEventListener('change', () => schedulePublish());

/** Is this username free (or already mine)? */
export const isUsernameFree = name => getCore().account.isFree(name);
/** A free username built from the person's name or email, e.g. "sam.lee". */
export const suggestUsername = () => getCore().account.suggest(cloud.user?.name || cloud.user?.email || '');

/** Claim (or change) your username. Returns an error message, or '' on success. */
let claiming = false;
export async function claimUsername(raw) {
  const name = normalizeName(raw);
  if (!validName(name)) return NAME_HINT;
  // Two claims at once would race each other: the second reads the account before the first is saved
  // and is then refused (or undoes it). One at a time.
  if (claiming) return 'Still saving your username. Try again in a moment.';
  const core = getCore(), { db, F } = core;
  claiming = true;
  try {
    // Friends only ever see a first name here, so a new shared account gets the first name too
    // (an existing account keeps whatever display name it already has).
    const existing = await core.account.get();
    await core.account.claim(name, {
      displayName: existing?.displayName ?? (cloud.user?.name || '').split(' ')[0].slice(0, 30),
      // our own profile goes in the same all-or-nothing batch as the account and the username
      async extra(batch) {
        const ref = F.doc(db, PROFILES, uid);
        const mine = { ...publicPayload(), updatedAt: F.serverTimestamp() };
        if ((await F.getDoc(ref)).exists()) batch.set(ref, mine, { merge: true }); // the core has already renamed it
        else batch.set(ref, { ...mine, username: name, friends: [] });
      },
    });
    if (social.state !== 'ready') { await start(); } else { social.me = { ...social.me, username: name }; emit(); }
    return '';
  } catch (e) { console.warn(e); return e?.code ? friendlyError(e) : (e?.message || String(e)); }
  finally { claiming = false; }
}

/** Send a friend request by username. Returns { ok, msg }. */
export async function sendRequest(raw) {
  const name = normalizeName(raw);
  if (!validName(name)) return { ok: false, msg: 'That isn’t a valid username.' };
  if (name === social.me?.username) return { ok: false, msg: 'That’s you! 😄' };
  const core = getCore(), { db, F } = core;
  try {
    const to = await core.account.ownerOf(name);
    if (!to) return { ok: false, msg: `No one has the username @${name} yet.` };
    if (to === uid) return { ok: false, msg: 'That’s you! 😄' };
    if ((social.me.friends || []).includes(to)) return { ok: false, msg: `You’re already friends with @${name}.` };
    const theirs = social.incoming.find(r => r.from === to);
    if (theirs) { await acceptRequest(theirs); return { ok: true, msg: `@${name} had already asked, so you’re now friends!` }; }
    try {
      await F.setDoc(F.doc(db, REQUESTS, `${to}_${uid}`), { from: uid, to, fromName: social.me.username, toName: name, createdAt: F.serverTimestamp() });
    } catch (e) {
      // the name exists (maybe from another app) but the rules only allow requests to people who use this app
      if (e?.code === 'permission-denied') return { ok: false, msg: `@${name} isn’t on Where Have You Been yet. Send them your invite link.` };
      throw e;
    }
    return { ok: true, msg: `Request sent to @${name}. You’ll see each other’s maps once they accept.` };
  } catch (e) { console.warn(e); return { ok: false, msg: friendlyError(e) }; }
}

export async function acceptRequest(r) {
  const { db, F } = getCore();
  const batch = F.writeBatch(db);
  batch.update(F.doc(db, PROFILES, uid), { friends: F.arrayUnion(r.from) });
  batch.update(F.doc(db, PROFILES, r.from), { friends: F.arrayUnion(uid) });
  batch.delete(F.doc(db, REQUESTS, r.id));
  await batch.commit();
}
export async function deleteRequest(r) {
  const { db, F } = getCore();
  await F.deleteDoc(F.doc(db, REQUESTS, r.id));
}
export async function removeFriend(fid) {
  const { db, F } = getCore();
  const batch = F.writeBatch(db);
  batch.update(F.doc(db, PROFILES, uid), { friends: F.arrayRemove(fid) });
  batch.update(F.doc(db, PROFILES, fid), { friends: F.arrayRemove(uid) });
  try { await batch.commit(); }
  catch { await F.updateDoc(F.doc(db, PROFILES, uid), { friends: F.arrayRemove(fid) }); } // their profile may be gone
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
