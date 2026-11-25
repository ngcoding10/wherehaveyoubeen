// Friends tab: username setup, requests, leaderboard, head-to-head, overlap on the map.
import { social, claimUsername, sendRequest, acceptRequest, deleteRequest, removeFriend, leaderboard, overlap, normalizeName, validName, isUsernameFree, suggestUsername, NAME_HINT } from './social.js';
import { cloud, signIn, resumeSync } from './cloud.js';
import { DATA, flagHTML, esc } from './data.js';
import { LANDMARK_BY_ID } from './landmarks.js';
import { paintSprites } from './ui.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const METRICS = [['countries', 'Countries'], ['states', 'States'], ['cities', 'Cities'], ['wonders', 'Wonders'], ['world', '% World']];
const MEDALS = ['🥇', '🥈', '🥉'];
const SITE = location.origin + location.pathname.replace(/index\.html$/, '');

export class FriendsUI {
  constructor(ui) {
    this.ui = ui; this.metric = 'countries'; this.compareWith = null; this.msg = null;
    // the username form: open for a rename, what has been typed, saving, and the last message.
    // Kept here (not in the page) so the form survives the panel being redrawn by a background update.
    this.renaming = false; this.claimDraft = null; this.claimBusy = false; this.claimMsg = '';
    // invite links: …/?add=username (usernames may contain dots)
    const invite = normalizeName(new URLSearchParams(location.search).get('add') || '');
    this.pendingInvite = validName(invite) ? invite : '';
    social.addEventListener('change', () => this.onChange());
    cloud.addEventListener('ready', () => { if (this.ui.tab === 'friends' && social.state === 'signed-out') this.ui.renderPanel(); });
  }
  onChange() {
    const n = social.incoming.length;
    const tab = $('.tabs [data-tab=friends]');
    if (tab) tab.dataset.badge = n ? String(n) : '';
    if (this.pendingInvite && social.state === 'ready') {
      const name = this.pendingInvite; this.pendingInvite = '';
      if (name !== social.me?.username) { this.prefill = name; this.ui.setTab('friends'); this.ui.toast(`Tap <b>Send request</b> to add @${esc(name)} as a friend`, 4000); }
    }
    if (this.compareWith && !social.friends.has(this.compareWith)) this.exitCompare();
    if (social.state === 'signed-out' || social.state === 'off') { this.renaming = false; this.claimDraft = null; this.claimMsg = ''; }
    if (this.ui.tab !== 'friends') return;
    // don't wipe what someone is typing
    const a = document.activeElement;
    if (a && a.closest('#panel-body') && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA')) { this._dirty = true; return; }
    this.ui.renderPanel();
  }

  render(body) {
    if (!cloud.enabled) { body.innerHTML = `<div class="empty"><p>Friends needs Google sign-in, which isn't switched on for this copy of the app yet.</p></div>`; return; }
    if (this.pendingInvite && social.state === 'signed-out') this.prefill = this.pendingInvite;
    const st = social.state;
    if (st === 'signed-out') return this.renderSignedOut(body);
    if (st === 'off') {
      body.innerHTML = `<div class="p-title"><h2>Compete with friends</h2></div>
        <p class="blurb">Your Where Have You Been data was deleted from your account, so cloud sync and friends are off. Your logbook is still saved in this browser.</p>
        <button class="pix-btn primary" id="f-resume">Turn sync back on</button>`;
      $('#f-resume').onclick = () => resumeSync();
      return;
    }
    if (st === 'loading') { body.innerHTML = `<p class="muted">Loading your friends…</p>`; return; }
    if (st === 'error') { body.innerHTML = `<div class="empty"><p>${esc(social.error)}</p></div>`; return; }
    if (st === 'need-username') return this.renderClaim(body);
    if (this.renaming) return this.renderClaim(body, true);
    if (this.compareWith && social.friends.has(this.compareWith)) return this.renderCompare(body, social.friends.get(this.compareWith));
    this.renderHome(body);
  }

  renderSignedOut(body) {
    body.innerHTML = `<div class="p-title"><h2>Compete with friends</h2></div>
      <p class="blurb">Pick a username, add friends, and see who's been the most places. Compare countries side by side and see everywhere you've both been on the map.</p>
      ${this.pendingInvite ? `<p class="muted">You were invited to add <b>@${esc(this.pendingInvite)}</b>. Sign in first.</p>` : ''}
      <button class="gbtn" id="f-signin" ${cloud.ready && !cloud.failed ? '' : 'disabled'}>${cloud.failed ? 'Sign-in is unavailable. Reload to try again.' : cloud.ready ? 'Sign in with Google' : 'Loading…'}</button>
      <p class="muted" style="margin-top:14px">Your friends only see your username, your stats and the places you've been, never your notes, dates or home base.</p>`;
    // signIn() is called straight from the click, with nothing awaited first, so the browser lets the window open
    $('#f-signin').onclick = () => {
      signIn().catch(e => {
        if (e?.code === 'embed/opened-full-site') this.ui.toast('This browser blocks Google sign-in inside other websites, so the full site opened in a new tab. Sign in there.', 7000);
        else this.ui.toast('Sign-in failed: ' + esc(e?.message || e?.code));
      });
    };
  }

  renderClaim(body, changing) {
    const cur = social.me?.username || '';
    body.innerHTML = `<div class="p-title"><h2>${changing ? 'Change your username' : 'Pick a username'}</h2></div>
      <p class="blurb">Friends add you by this name, and it is your username in every app you sign in to with this account. ${NAME_HINT}.</p>
      <div class="add-row"><span class="at">@</span><input class="filter-input" id="f-name" maxlength="20" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="yourname" value="${esc(this.claimDraft ?? (cur || suggestName()))}">
      <button class="pix-btn primary" id="f-claim" ${this.claimBusy ? 'disabled' : ''}>${changing ? 'Save' : 'Claim'}</button></div>
      <p class="muted" id="f-claim-msg">${esc(this.claimBusy ? 'Saving…' : this.claimMsg)}</p>${changing ? `<button class="pix-btn small ghost" id="f-cancel">Cancel</button>` : ''}`;
    const inp = $('#f-name'), msg = $('#f-claim-msg');
    let check = 0;
    inp.oninput = () => {
      this.claimDraft = inp.value; // survives the panel being redrawn
      this.claimMsg = '';
      if (this.claimBusy) return;
      const n = normalizeName(inp.value), id = ++check;
      msg.textContent = n && !validName(n) ? NAME_HINT + '.' : '';
      if (!validName(n) || n === cur) return;
      // say whether the name is free, once they pause typing
      setTimeout(async () => {
        if (id !== check) return;
        const free = await isUsernameFree(n).catch(() => null);
        if (id === check && !this.claimBusy && free !== null) msg.textContent = free ? `@${n} is free` : `@${n} is taken, so try another`;
      }, 400);
    };
    // offer a name nobody has yet (e.g. "sam.lee"), unless they have started typing
    if (!cur && this.claimDraft == null) suggestUsername().then(n => { if (n && this.claimDraft == null && inp.isConnected && document.activeElement !== inp) inp.value = n; }).catch(() => {});
    const btn = $('#f-claim');
    const go = async () => {
      if (this.claimBusy) return; // one save at a time (Enter pressed twice, or Enter then the button)
      const typed = inp.value;
      check++; this.claimBusy = true; this.claimMsg = ''; btn.disabled = true; msg.textContent = 'Saving…';
      const err = await claimUsername(typed);
      this.claimBusy = false;
      if (err) {
        // the panel may have been redrawn while saving, so write to the form that is on screen now
        this.claimMsg = err;
        const b = $('#f-claim'), m = $('#f-claim-msg');
        if (b) b.disabled = false;
        if (m) m.textContent = err;
        return;
      }
      this.renaming = false; this.claimDraft = null;
      this.ui.toast(`You're <b>@${esc(normalizeName(typed))}</b>`);
      if (this.ui.tab === 'friends') this.ui.renderPanel(true);
    };
    btn.onclick = go; inp.onkeydown = e => { if (e.key === 'Enter') go(); };
    if ($('#f-cancel')) $('#f-cancel').onclick = () => { this.renaming = false; this.claimDraft = null; this.claimMsg = ''; this.ui.renderPanel(true); };
  }

  renderHome(body) {
    const me = social.me, rows = leaderboard();
    const m = this.metric;
    rows.sort((a, b) => (b.stats[m] || 0) - (a.stats[m] || 0) || (b.stats.countries || 0) - (a.stats.countries || 0));
    const max = Math.max(1, ...rows.map(r => r.stats[m] || 0));
    const myRank = rows.findIndex(r => r.me) + 1;
    const ahead = rows[myRank - 2];
    body.innerHTML = `
      <div class="me-card"><div class="avatar" style="${avatarStyle(me.username)}">${esc(me.username[0].toUpperCase())}</div>
        <div><b>@${esc(me.username)}</b><div class="muted">${rows.length > 1 ? `#${myRank} of ${rows.length} in ${METRICS.find(x => x[0] === m)[1].toLowerCase()}` : 'Add friends to start competing'}</div></div>
        <button class="pix-btn small ghost" id="f-rename" title="Change username">Edit</button></div>
      <div class="p-sec"><h3>ADD A FRIEND</h3>
        <div class="add-row"><span class="at">@</span><input class="filter-input" id="f-add" maxlength="21" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="their username" value="${esc(this.prefill || '')}">
        <button class="pix-btn primary" id="f-send">Send request</button></div>
        <p class="muted f-msg ${this.msg?.ok === false ? 'bad' : ''}" id="f-msg">${this.msg ? esc(this.msg.msg) : ''}</p>
        <button class="pix-btn small" id="f-invite">🔗 Share my invite link</button></div>
      ${social.incoming.length ? `<div class="p-sec"><h3>FRIEND REQUESTS <span>${social.incoming.length}</span></h3>${social.incoming.map(r => `
        <div class="req"><div class="avatar sm" style="${avatarStyle(r.fromName)}">${esc((r.fromName || '?')[0].toUpperCase())}</div><b>@${esc(r.fromName)}</b>
        <button class="pix-btn small primary" data-accept="${esc(r.id)}">Accept</button><button class="pix-btn small ghost" data-decline="${esc(r.id)}">Decline</button></div>`).join('')}</div>` : ''}
      ${social.outgoing.length ? `<div class="p-sec"><h3>WAITING FOR <span>${social.outgoing.length}</span></h3>${social.outgoing.map(r => `
        <div class="req"><b>@${esc(r.toName)}</b><span class="muted">sent</span><button class="pix-btn small ghost" data-cancel="${esc(r.id)}">Cancel</button></div>`).join('')}</div>` : ''}
      <div class="p-sec"><h3>LEADERBOARD</h3>
        <div class="filters">${METRICS.map(([k, l]) => `<button class="chip ${k === m ? 'active' : ''}" data-metric="${k}">${l}</button>`).join('')}</div>
        <div class="board">${rows.map((r, i) => `
          <button class="lb ${r.me ? 'me' : ''}" ${r.me ? 'disabled' : `data-fid="${esc(r.uid)}"`}>
            <span class="rk">${MEDALS[i] || '#' + (i + 1)}</span>
            <span class="avatar sm" style="${avatarStyle(r.username)}">${esc((r.username || '?')[0].toUpperCase())}</span>
            <span class="nm">@${esc(r.username)}${r.me ? ' <small>(you)</small>' : ''}</span>
            <span class="val">${fmt(r.stats[m], m)}</span>
            <span class="bar"><i style="width:${((r.stats[m] || 0) / max) * 100}%"></i></span>
          </button>`).join('')}</div>
        ${rows.length === 1 ? `<p class="muted">Add a friend by username, or share your invite link, to start the race.</p>`
          : ahead ? `<p class="muted">@${esc(ahead.username)} is ${fmt((ahead.stats[m] || 0) - (rows[myRank - 1].stats[m] || 0), m)} ${METRICS.find(x => x[0] === m)[1].toLowerCase()} ahead of you. Tap a friend to compare.</p>`
          : `<p class="muted">🏆 You're in the lead! Tap a friend to compare.</p>`}
      </div>`;
    $('#f-rename').onclick = () => { this.renaming = true; this.claimDraft = null; this.claimMsg = ''; this.ui.renderPanel(true); };
    const inp = $('#f-add');
    const send = async () => {
      const v = inp.value; if (!v.trim()) return;
      const b = $('#f-send'); if (b) b.disabled = true;
      this.msg = await sendRequest(v);
      this.prefill = this.msg.ok ? '' : v;
      if (this.msg.ok) inp.value = '';
      this._dirty = false; inp.blur();
      this.ui.renderPanel();
    };
    $('#f-send').onclick = send; inp.onkeydown = e => { if (e.key === 'Enter') send(); };
    inp.oninput = () => { this.prefill = inp.value; };
    inp.onblur = () => { if (this._dirty) { this._dirty = false; setTimeout(() => this.ui.renderPanel(), 0); } };
    $('#f-invite').onclick = () => this.share();
    $$('[data-accept]', body).forEach(b => b.onclick = async () => { b.disabled = true; const r = social.incoming.find(x => x.id === b.dataset.accept); try { await acceptRequest(r); this.ui.toast(`🎉 You're now friends with <b>@${esc(r.fromName)}</b>`); } catch (e) { this.ui.toast('Couldn’t accept: ' + esc(e.message)); b.disabled = false; } });
    $$('[data-decline]', body).forEach(b => b.onclick = () => deleteRequest(social.incoming.find(x => x.id === b.dataset.decline)));
    $$('[data-cancel]', body).forEach(b => b.onclick = () => deleteRequest(social.outgoing.find(x => x.id === b.dataset.cancel)));
    $$('[data-metric]', body).forEach(b => b.onclick = () => { this.metric = b.dataset.metric; this.ui.renderPanel(); });
    $$('.lb[data-fid]', body).forEach(b => b.onclick = () => { this.compareWith = b.dataset.fid; this.ui.renderPanel(true); });
  }

  renderCompare(body, f) {
    const me = leaderboard()[0];
    const fv = f.visited || { c: [], s: [], l: [], ci: [] }, fs = f.stats || {};
    const oc = overlap(me.visited.c, fv.c), ol = overlap(me.visited.l, fv.l);
    const wins = METRICS.filter(([k]) => (me.stats[k] || 0) > (fs[k] || 0)).length, losses = METRICS.filter(([k]) => (me.stats[k] || 0) < (fs[k] || 0)).length;
    const flags = list => list.length ? `<div class="flag-wall">${list.slice().sort((a, b) => cname(a).localeCompare(cname(b))).map(c => `<span title="${esc(cname(c))}">${flagHTML(c)}</span>`).join('')}</div>` : '<p class="muted">None yet.</p>';
    const comparing = this.ui.map.compare?.uid === f.uid;
    body.innerHTML = `<button class="pix-btn small ghost" id="f-back">‹ All friends</button>
      <div class="vs-head"><div><div class="avatar" style="${avatarStyle(me.username)}">${esc(me.username[0].toUpperCase())}</div><b>You</b></div>
        <div class="vs">${wins}<small>–</small>${losses}</div>
        <div><div class="avatar" style="${avatarStyle(f.username)}">${esc(f.username[0].toUpperCase())}</div><b>@${esc(f.username)}</b></div></div>
      <p class="muted" style="text-align:center">${wins > losses ? 'You win this matchup 🏆' : wins < losses ? `@${esc(f.username)} wins this matchup, so time to travel ✈️` : 'Dead even!'}</p>
      <div class="h2h">${METRICS.map(([k, l]) => { const a = me.stats[k] || 0, b = fs[k] || 0, t = Math.max(1, a + b);
        return `<div class="h2h-row"><b class="${a > b ? 'win' : ''}">${fmt(a, k)}</b><div class="h2h-bar"><i class="a" style="width:${a / t * 100}%"></i><i class="b" style="width:${b / t * 100}%"></i></div><b class="${b > a ? 'win' : ''}">${fmt(b, k)}</b><span>${l}</span></div>`; }).join('')}</div>
      <button class="pix-btn primary been" id="f-map">${comparing ? 'Hide overlap on map' : '🗺️ Show overlap on map'}</button>
      <div class="p-sec"><h3>BOTH BEEN TO <span>${oc.both.length}</span></h3>${flags(oc.both)}</div>
      <div class="p-sec"><h3>ONLY YOU <span>${oc.onlyA.length}</span></h3>${flags(oc.onlyA)}</div>
      <div class="p-sec"><h3>ONLY @${esc(f.username.toUpperCase())} <span>${oc.onlyB.length}</span></h3>${flags(oc.onlyB)}</div>
      ${ol.both.length ? `<div class="p-sec"><h3>WONDERS YOU'VE BOTH SEEN <span>${ol.both.length}</span></h3><div class="lm-chips">${ol.both.map(id => LANDMARK_BY_ID[id]).filter(Boolean).map(l => `<button class="lm-chip on" data-id="${l.id}"><canvas data-sprite="${l.sprite}"></canvas>${esc(l.name)}</button>`).join('')}</div></div>` : ''}
      <div class="p-sec"><button class="pix-btn small danger" id="f-remove">Remove @${esc(f.username)} as a friend</button></div>`;
    paintSprites(body);
    $$('.lm-chip', body).forEach(b => b.onclick = () => this.ui.select('landmark', b.dataset.id, { fly: true }));
    $('#f-back').onclick = () => { this.compareWith = null; this.ui.renderPanel(true); };
    $('#f-map').onclick = () => { if (comparing) this.exitCompare(); else this.showCompare(f); this.ui.renderPanel(); };
    $('#f-remove').onclick = async () => {
      if (!confirm(`Remove @${f.username}? You'll stop seeing each other's maps.`)) return;
      this.exitCompare(); this.compareWith = null; await removeFriend(f.uid); this.ui.renderPanel(true);
    };
  }

  showCompare(f) {
    const me = leaderboard()[0];
    this.ui.map.setCompare({ uid: f.uid, mine: me.visited.c, theirs: (f.visited || {}).c || [] });
    const bar = $('#compare-bar');
    bar.innerHTML = `<span><i class="sw both"></i>Both</span><span><i class="sw you"></i>Only you</span><span><i class="sw them"></i>Only @${esc(f.username)}</span><button id="cmp-exit" aria-label="Stop comparing">✕</button>`;
    bar.hidden = false;
    $('#cmp-exit').onclick = () => { this.exitCompare(); if (this.ui.tab === 'friends') this.ui.renderPanel(); };
    this.ui.map.map.flyTo({ center: [10, 25], zoom: this.ui.isPhone() ? 0.95 : 1.6, speed: 1.6 });
    if (this.ui.isPhone()) this.ui.setSheet('peek');
  }
  exitCompare() { this.ui.map.setCompare(null); $('#compare-bar').hidden = true; }

  async share() {
    const url = `${SITE}?add=${encodeURIComponent(social.me.username)}`;
    const text = `Add me on Where Have You Been? I'm @${social.me.username}. Let's see who's been more places 🌍`;
    try {
      if (navigator.share) { await navigator.share({ title: 'Where Have You Been?', text, url }); return; }
      await navigator.clipboard.writeText(`${text} ${url}`); this.ui.toast('Invite link copied 🔗');
    } catch (e) { if (e?.name !== 'AbortError') this.ui.toast(esc(url), 6000); }
  }
}

function cname(id) { return DATA.meta.countries[id]?.name || id; }
function fmt(v, m) { v = v || 0; return m === 'world' ? (Math.round(v * 10) / 10) + '%' : String(Math.round(v)); }
function hash(s) { let h = 7; for (const ch of s || '') h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h; }
function avatarStyle(name) { const hues = [205, 145, 45, 330, 270, 15, 175, 95]; return `background:hsl(${hues[hash(name) % hues.length]} 65% 45%)`; }
function suggestName() { return normalizeName((cloud.user?.name || '').split(' ')[0]).replace(/[^a-z0-9_.]/g, '').slice(0, 15); }
