import { initializeApp, deleteApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, createUserWithEmailAndPassword } from 'firebase/auth';
import { getFirestore, connectFirestoreEmulator, doc, getDoc, setDoc, writeBatch, updateDoc, deleteDoc, arrayUnion, arrayRemove, collection, query, where, getDocs, serverTimestamp } from 'firebase/firestore';
const cfg = { apiKey: 'demo', projectId: 'where-have-you-been-f130a', authDomain: 'x' };
let n = 0, pass = 0, fail = 0;
async function user(email) {
  const app = initializeApp(cfg, 'a' + (n++)); const auth = getAuth(app); connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  const db = getFirestore(app); connectFirestoreEmulator(db, '127.0.0.1', 8080);
  const c = await createUserWithEmailAndPassword(auth, email, 'pw123456'); return { uid: c.user.uid, db };
}
async function expect(label, shouldPass, fn) {
  try { await fn(); if (shouldPass) { pass++; console.log('  ok   ', label); } else { fail++; console.log('  FAIL ', label, '(was allowed but should be denied)'); } }
  catch (e) { if (!shouldPass && /permission|PERMISSION/.test(e.code + e.message)) { pass++; console.log('  ok   ', label, '(denied)'); } else { fail++; console.log('  FAIL ', label, e.code || e.message); } }
}
async function claim(u, name, friends = []) {
  const b = writeBatch(u.db);
  b.set(doc(u.db, 'profiles', u.uid), { username: name, friends, stats: { countries: 3 }, visited: { c: ['US'] } }, { merge: true });
  b.set(doc(u.db, 'usernames', name), { uid: u.uid }); await b.commit();
}
const A = await user('alice@test.dev'), B = await user('bob@test.dev'), M = await user('mallory@test.dev');
console.log('usernames');
await expect('Alice claims @alice', true, () => claim(A, 'alice'));
await expect('Bob claims @bob', true, () => claim(B, 'bob'));
await expect('Mallory cannot take @alice', false, () => claim(M, 'alice'));
await expect('Mallory cannot claim a name for Bob', false, () => setDoc(doc(M.db, 'usernames', 'bob2'), { uid: B.uid }));
await expect('Mallory cannot claim a bare name without her profile', false, () => setDoc(doc(M.db, 'usernames', 'mal'), { uid: M.uid }));
await expect('Invalid name rejected', false, () => claim(M, 'Bad Name!'));
await expect('Mallory claims @mallory', true, () => claim(M, 'mallory'));
await expect('Anyone signed in can look up a username', true, async () => { const s = await getDoc(doc(M.db, 'usernames', 'alice')); if (s.data().uid !== A.uid) throw new Error('wrong uid'); });
console.log('privacy');
await expect('Mallory cannot read Alice’s profile', false, () => getDoc(doc(M.db, 'profiles', A.uid)));
await expect('Mallory cannot read Alice’s private logbook', false, () => getDoc(doc(M.db, 'users', A.uid)));
await expect('Mallory cannot add herself to Alice’s friends uninvited', false, () => updateDoc(doc(M.db, 'profiles', A.uid), { friends: arrayUnion(M.uid) }));
console.log('friend request flow');
await expect('Alice sends Bob a request', true, () => setDoc(doc(A.db, 'requests', `${B.uid}_${A.uid}`), { from: A.uid, to: B.uid, fromName: 'alice', toName: 'bob', createdAt: serverTimestamp() }));
await expect('Mallory cannot forge a request from Alice', false, () => setDoc(doc(M.db, 'requests', `${B.uid}_${A.uid}x`), { from: A.uid, to: B.uid, fromName: 'alice', toName: 'bob' }));
await expect('Bob sees the incoming request', true, async () => { const q = await getDocs(query(collection(B.db, 'requests'), where('to', '==', B.uid))); if (q.size !== 1) throw new Error('size ' + q.size); });
await expect('Mallory cannot list Bob’s requests', false, () => getDocs(query(collection(M.db, 'requests'), where('to', '==', B.uid))));
await expect('Mallory cannot use Alice’s request to join Alice’s friends', false, () => updateDoc(doc(M.db, 'profiles', A.uid), { friends: arrayUnion(M.uid) }));
await expect('Bob accepts (both lists + delete request)', true, async () => {
  const b = writeBatch(B.db);
  b.update(doc(B.db, 'profiles', B.uid), { friends: arrayUnion(A.uid) });
  b.update(doc(B.db, 'profiles', A.uid), { friends: arrayUnion(B.uid) });
  b.delete(doc(B.db, 'requests', `${B.uid}_${A.uid}`)); await b.commit();
});
await expect('Alice can now read Bob’s profile', true, () => getDoc(doc(A.db, 'profiles', B.uid)));
await expect('Bob can now read Alice’s profile', true, () => getDoc(doc(B.db, 'profiles', A.uid)));
await expect('Bob still cannot read Alice’s private logbook', false, () => getDoc(doc(B.db, 'users', A.uid)));
await expect('Bob cannot edit Alice’s stats', false, () => updateDoc(doc(B.db, 'profiles', A.uid), { stats: { countries: 0 } }));
await expect('Bob cannot add Mallory to Alice’s friends', false, () => updateDoc(doc(B.db, 'profiles', A.uid), { friends: arrayUnion(M.uid) }));
await expect('Alice publishes new stats (merge)', true, () => setDoc(doc(A.db, 'profiles', A.uid), { username: 'alice', stats: { countries: 9 } }, { merge: true }));
await expect('Alice cannot point her profile at Bob’s username', false, () => setDoc(doc(A.db, 'profiles', A.uid), { username: 'bob' }, { merge: true }));
console.log('rename + unfriend');
await expect('Alice renames to @alice_travels', true, async () => { const b = writeBatch(A.db); b.set(doc(A.db, 'profiles', A.uid), { username: 'alice_travels' }, { merge: true }); b.set(doc(A.db, 'usernames', 'alice_travels'), { uid: A.uid }); b.delete(doc(A.db, 'usernames', 'alice')); await b.commit(); });
await expect('Old name @alice is free again (Mallory can see it’s gone)', true, async () => { const s = await getDoc(doc(M.db, 'usernames', 'alice')); if (s.exists()) throw new Error('still exists'); });
await expect('Bob unfriends Alice (both lists)', true, async () => { const b = writeBatch(B.db); b.update(doc(B.db, 'profiles', B.uid), { friends: arrayRemove(A.uid) }); b.update(doc(B.db, 'profiles', A.uid), { friends: arrayRemove(B.uid) }); await b.commit(); });
await expect('Alice can no longer read Bob’s profile', false, () => getDoc(doc(A.db, 'profiles', B.uid)));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
