# HANDOVER: Where Have You Been (for the merge chat)

Written 2026-11-23 by the chat that built this app. It describes the app exactly as it is on `main` today.
Nothing about the backend was changed while writing it. No secret values appear anywhere in this file.

---

## 1. Branches, build and deploy

| | |
|---|---|
| Repo | `ngcoding10/wherehaveyoubeen` (old name `nicorgutierrez08-eng/wherehaveyoubeen` still redirects) |
| Live branch | **`main`**. GitHub Pages: Settings → Pages → Deploy from a branch → `main` / root |
| Live URL | https://ngcoding10.github.io/wherehaveyoubeen/ |
| Build | **None.** Plain static HTML/CSS/ES modules. Every push to `main` is live within 1–2 minutes |
| Other branches | `claude/relaxed-johnson-lrmw34` (dev branch, same content as `main`). Nothing unmerged |
| Data rebuild | `tools/build_data.py` regenerates `data/` from Natural Earth + GeoNames (see `tools/README.md`). Not needed for the merge |

**Unfinished or half-done items:**
- **ascoding pull request `ASCoding11/ASCoding11.github.io#284`** was still open, not merged, at last check. It adds `where-have-you-been/index.html` to ascoding. That page iframes the live app from ngcoding10.github.io, which has a different origin from ascoding, so its sign-in is **not** shared with ascoding.
  - The branch is `add-where-have-you-been` in the fork `ngcoding10/ASCoding11.github.io`.
  - Under the new plan, this iframe should become a copy served from the same origin as the other apps.
- **Firestore rules for Friends were NOT published** to `where-have-you-been-f130a` when this was written. The live project probably still has only the older `users/{uid}` rule.
  - So on the live site, Friends most likely fails with `permission-denied`, and the app shows "The friends database isn't switched on yet".
  - Expect `profiles`, `usernames` and `requests` to be empty or nearly empty in production.
- **API key website restriction:** a Google Cloud website restriction on the browser key was being set up. Whether it was saved is not confirmed.

## 2. Every place the front end talks to a backend

The app works fully offline and without an account. The backend is only Firebase Auth plus Firestore, loaded lazily from `https://www.gstatic.com/firebasejs/12.6.0/` (modular SDK, ES modules, no npm).

| File | What | Reads / writes | When |
|---|---|---|---|
| `js/firebase-config.js` | Web config (project `where-have-you-been-f130a`) | none | imported at boot |
| `js/cloud.js` `load()` | `initializeApp`, `getAuth`, `getFirestore` | none | `initCloud()` at the end of boot (`js/main.js`) |
| `js/cloud.js` `initCloud()` | `onAuthStateChanged`, `getRedirectResult` | none | boot |
| `js/cloud.js` `signIn()` | Google sign-in: `signInWithPopup`. Falls back to `signInWithRedirect` if the popup is blocked. Inside an iframe it opens the full site in a new tab instead | Auth | user taps "Sign in with Google" |
| `js/cloud.js` `onUser()` | Load and merge the private logbook | **read** `users/{uid}` once (`getDoc`), then **write** it (`setDoc`), then **listen** (`onSnapshot`) | each sign-in |
| `js/cloud.js` `push()` | Save the private logbook (whole document, overwrite) | **write** `users/{uid}` | 1.2 s after any logbook or settings change, while signed in |
| `js/social.js` `start()` | Load my friends profile | **read** `profiles/{uid}` | after every sign-in |
| `js/social.js` `listen()` | Live updates | **listen** `profiles/{me}`; `requests` where `to == me`; `requests` where `from == me` | while signed in with a username |
| `js/social.js` `syncFriendSubs()` | Friends' maps and stats | **listen** `profiles/{friendUid}` for every friend (retries up to 4 times on permission errors) | whenever my `friends[]` changes |
| `js/social.js` `schedulePublish()` | Republish my public profile | **write** `profiles/{me}` (`setDoc` with merge) | 2.5 s after any logbook change, when I have a username |
| `js/social.js` `isUsernameFree()` | Check availability | **read** `usernames/{name}` | claiming a name |
| `js/social.js` `claimUsername()` | Claim or rename | **batch**: set `profiles/{me}`, set `usernames/{new}`, delete `usernames/{old}` | Friends tab → Save |
| `js/social.js` `sendRequest()` | Friend request by username | **read** `usernames/{name}`; **write** `requests/{to}_{from}` (or accept if they already asked) | Add friend, or an invite link `?add=name` |
| `js/social.js` `acceptRequest()` | Accept | **batch**: `arrayUnion` on both `profiles.friends`, delete the request | Accept button |
| `js/social.js` `deleteRequest()` | Decline or cancel | **delete** `requests/{id}` | buttons |
| `js/social.js` `removeFriend()` | Unfriend | **batch** `arrayRemove` on both profiles. Falls back to my side only | Remove friend |

**Other network calls (not part of our backend; no keys or accounts):**
- `js/quickadd.js` → `https://nominatim.openstreetmap.org/search`. Only used for Quick-add names that aren't in the bundled data, throttled to 1 request per second.
- `js/map.js` → OpenFreeMap vector tiles.
- `js/data.js` → flag SVGs from jsDelivr (`flag-icons`).
- Google Fonts.
- Everything else (`data/*.json`, `fonts/`, `vendor/maplibre`) is served from this repo.

## 3. Data model

Rules file: **`firestore.rules`** (repo root). The emulator config is `firebase.json`.

### `users/{uid}`: private logbook (owner only)
Rule: read and write only if `request.auth.uid == uid`.

| Field | Type | Meaning |
|---|---|---|
| `book` | **string** (JSON) | The whole logbook, see below |
| `settings` | string (JSON) | `{ theme, projection, autoParents, showLandmarks, showWishlist, colors{country,state,city,landmark,wish} }` |
| `name` | string | Google display name at the last save |
| `updatedAt` | server timestamp | |

`book` (parsed) = `{ items: {key: data}, removed: {key: ms}, home: {...}|null, updated: ms }`, defined in `js/store.js`.

**Item keys:**

| Key | Meaning | `data` fields |
|---|---|---|
| `c:<ISO-A2 or NE id>` | country (e.g. `c:US`) | `d` (visit date), `note` |
| `s:<Natural Earth adm1_code>` | state or region (e.g. `s:USA-3536`) | `d`, `note` |
| `ci:<GeoNames id>` | city | `n` name, `c` country, `s` state, `lat`, `lon`, `p` population, `d`, `note` |
| `l:<landmark id>` | wonder (ids in `js/landmarks.js`, e.g. `l:eiffel`) | `d`, `note` |
| `w:<any key above>` | wishlist (e.g. `w:c:JP`, `w:ci:1850147`) | same as above |

- Every item also has `t` (first added, ms) and `m` (last modified, ms).
- `removed` holds tombstones, so deletions sync between devices.
- `home` = `{ lon, lat, label, cid, m }` or `{ cleared: true, m }`.
- Merging is last-write-wins per key (`Store.merge`).

### `profiles/{uid}`: what friends see
**Rules:**
- **Read:** the owner, or anyone in `resource.data.friends`.
- **Owner create or update:** allowed if `friends` is a list, `username` is a string, and `usernames/{username}.uid == uid` (checked with `getAfter`).
- **Someone else's update:** only the `friends` field may change, and only by
  - adding **themselves**, when `requests/{them}_{owner}` exists (i.e. the owner sent them a request and they are accepting), or
  - removing **themselves**.

| Field | Type |
|---|---|
| `username` | string, `^[a-z0-9_]{3,20}$` |
| `name` | first name only, ≤ 30 characters |
| `friends` | array of uids (mutual) |
| `stats` | `{ countries, territories, states, cities, wonders, world (% land, 1 decimal), continents }` |
| `visited` | `{ c: [countryIds], s: [stateIds], l: [landmarkIds], ci: [[geonameId, name, countryId], …] }`; `ci` is capped at 4000 |
| `updatedAt` | server timestamp |

Notes, dates and home base are **never** copied here.

### `usernames/{name}`: unique name index
Fields: `{ uid }` only.

**Rules:**
- Read: any signed-in user.
- Create: only for yourself, name must match the regex, and in the same batch your profile must have `username == name`.
- Delete: only the owner.

### `requests/{to}_{from}`: friend requests
Fields: `{ from, to, fromName, toName, createdAt }` (no other keys allowed).

**Rules:**
- Read and delete: either person.
- Create: `from == me`, `to != me`, and the document id must equal `to + '_' + me`.

Queries used: `where('to','==',uid)` and `where('from','==',uid)`. These are single-field queries, so no composite indexes are needed.

## 4. Server code
**None.** No Cloud Functions, no other server, no secrets, no environment variables. The only key is the public Firebase web config in `js/firebase-config.js`.

## 5. Sign-in, usernames, friends
- **Methods:** Google only, through Firebase Auth. A popup is used, with a redirect fallback when popups are blocked. Inside an iframe, the full site opens in a new tab.
  - Email/password exists **only** in emulator mode (`localhost/?emulator=1`, `window.__emuSignIn`) for tests.
- **Signed-out use is fully supported.** On first sign-in, the local logbook is merged into the cloud one.
- **Usernames:** optional, and only needed for Friends.
  - Picked in the Friends tab.
  - Lowercased; `@` is stripped; `^[a-z0-9_]{3,20}$`; unique through `usernames/{name}`.
  - Renaming frees the old name in the same batch.
- **Friends:** mutual (not one-way follows).
  - A sends a request, B accepts, and both `friends[]` arrays update in one batch.
  - Invite link: `<site>?add=<username>` (`js/friends-ui.js`). It opens the Friends tab with the request ready to send.
  - **Features:** leaderboard (you plus friends, by countries, states, cities, wonders or % of the world), head-to-head, an overlap list, and an overlap map (purple = both, blue = only you, pink = only them).

## 6. Real users today
- **Not known exactly.** Check Firebase console → `where-have-you-been-f130a` → Authentication → Users.
  - Expected: about 1 real account (Nico) plus possibly a few testers.
  - Friends data is probably empty because its rules were never published.
- **Must not be lost:** `users/{uid}.book` (places, wishlist, notes, dates, home base) and `users/{uid}.settings`.
- **Can be rebuilt:**
  - `profiles` republishes itself automatically from the logbook.
  - `usernames` would need re-claiming.
  - `requests` is disposable.
- **Watch out:** people who never signed in have their logbook **only in their browser's localStorage on `ngcoding10.github.io`**. If the app moves to another origin (e.g. ascoding), that data does not follow.
  - Options: keep the old URL live with a "move your data" notice, or redirect through a one-time export/import. Export/import JSON already exists in the settings sheet (🎨); the format is `{ app: 'where-have-you-been', exported, logbook }`.

## 7. Browser storage
| Key | Where | What |
|---|---|---|
| `whyb.logbook.v1` | localStorage | the `book` object above |
| `whyb.settings.v1` | localStorage | the settings object above |
| `firebaseLocalStorageDb` | IndexedDB (written by the Firebase SDK) | signed-in session, keyed by API key |

No cookies, no sessionStorage, and no Firestore offline cache (the default memory cache is used).

## 8. Tests
Tests are dev-only and not loaded by the site. They need Node and Java (for the Firebase emulator).

```bash
cd tests && npm install
npm run test:rules     # 28 security-rule checks against the emulator: privacy, forged requests, username theft, unfriending
npm run test:friends   # two-browser Playwright run in the emulator: claim, request, accept, leaderboard, compare, live update, unfriend
```

- Both passed on 2026-11-23: 28/28, and the end-to-end run had 0 errors.
- `firebase.json` at the root configures the emulators (auth 9099, firestore 8080).
- `tests/friends.e2e.cjs` serves the repo itself on port 8770 and opens `/?emulator=1`.
- There are no automated tests for the map UI. Earlier checks were manual Playwright runs at desktop and iPhone sizes.

## 9. Known bugs and limits; nothing was in progress
- **Friends rules unpublished:** see §1.
- **One document per logbook:** the whole logbook is a JSON string in one document, so it is subject to Firestore's **1 MiB limit**.
  - That is roughly 5–8k logged places with notes, which is fine for now.
  - Tombstones in `removed` are never pruned.
  - Every change rewrites the whole document (debounced 1.2 s).
- **Profile republishes on every logbook change** (debounced 2.5 s). Each friend is listening, so reads grow as friends × edits.
- **No "delete my account".** `users`, `profiles` and `usernames` documents stay behind, and requests never expire.
- **Settings sync is one-way-ish:** cloud settings are adopted only if this browser never saved its own.
- **Coloured fills follow Natural Earth shapes,** so at street zoom they can sit slightly off the OpenStreetMap border lines.
- **Nominatim** has a fair-use policy. Heavy Quick-add use could get rate-limited; the app then falls back to local matches only.
- **Unused `measurementId`:** the config has one, but Analytics is never loaded.

## 10. Questions from the merge plan

### What breaks if every collection gets a `whyb_` prefix?
Nothing outside this repo. Code and rules must change together:
- `js/cloud.js`: `'users'` (2 places).
- `js/social.js`: `'profiles'`, `'usernames'`, `'requests'` (18 string literals). Best done by putting them in one constants object.
- `firestore.rules`: the four `match` paths **and** the paths inside `getAfter(...)` and `exists(...)`. These are easy to miss, and if they are left unchanged, every username claim and every accept is silently denied.
- `tests/rules.test.mjs` and `tests/friends.e2e.cjs`: collection names.
- Document ids and field names don't change: `{to}_{from}` request ids, usernames, uids.
- localStorage keys and invite links are unaffected.
- Existing data must be copied into the renamed collections. It is not renamed in place.

### Can this app use one shared account record (uid, username, display name, photo)?
**Yes, with two conditions:**
1. **Username:** the friends code can use a shared `usernames` index instead of its own, if
   - the shared rule keeps names unique and lowercase (this app uses `^[a-z0-9_]{3,20}$`; a looser shared pattern is fine, the UI just validates differently), and
   - `whyb_profiles` rules point their `getAfter` check at the shared username record.

   Existing WHYB usernames, probably 0–1, would need to fit the shared rules.
2. **Privacy:** the shared record must not expose more than this app does today. Friends see only the **first name**; this app never shows the photo or email.

**What stays app-specific:**
- `whyb_profiles` (stats, visited lists, `friends[]`) and the private `whyb_users` logbook.
- WHYB friends are **mutual**, while Movi has one-way **follows**. Merging the social graph into one would change how both apps work, so keep them separate unless that is decided deliberately.

### Migrating this app's accounts
- `firebase auth:export` from `where-have-you-been-f130a`, then `firebase auth:import` into the new project, **keeps the same uids** and the Google provider links. After that, copy `users/{uid}` into `whyb_users/{uid}` with the Admin SDK.
- **Clash to watch:** if the same Google email also has an account in the Pantry or Movi project, the new project can hold only one account per email (the default setting). The merge chat must pick one uid and remap the other app's documents to it.
- **New project setup needed:**
  - enable the Google provider;
  - add every serving domain under Authorized domains;
  - publish the merged rules;
  - replace `js/firebase-config.js`.
