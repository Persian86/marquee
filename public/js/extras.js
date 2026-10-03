/* Marquee — movie night, memories, people in photos, smart search, share links, AI subtitles,
   theme songs, voice commands, signed-in devices, library health */
'use strict';

// ---------- movie night ----------
ROUTES.movienight = async code => {
  if (code) return movieNightRoom(code.toUpperCase());
  shell('more', `<div class="page settings"><h1 class="page-title">${ICON.popcorn} Movie night</h1>${loading()}</div>`);
  const [active, genres] = await Promise.all([api('/api/movienight'), api('/api/genres?type=movie').catch(() => [])]);
  const kids = me.isKids;
  $('#main').innerHTML = `<div class="page settings"><h1 class="page-title">Movie night</h1>
    <p class="hint" style="margin-top:-6px">Everyone swipes yes or no on their own phone — in Marquee or in FamilyNest — and Marquee finds the film you all want to watch.</p>
    ${active.length ? `<div class="panel"><h2>Happening now</h2><div class="list">${active.map(a => `<div class="list-item">
      <div class="grow"><div class="t">${esc(a.host)}'s movie night <span class="pill">${esc(a.code)}</span></div><div class="s">${esc(a.members.join(', '))}${a.match ? ` · picked <b>${esc(a.match)}</b>` : ' · voting'}</div></div>
      <a class="btn small primary" href="#/movienight/${a.code}">Join</a></div>`).join('')}</div></div>` : ''}
    <div class="panel"><h2>Start one</h2>
      <div class="field"><label>Choose from</label><div class="chips" id="mnPool">
        <button class="chip on" data-v="unwatched">Haven't seen</button><button class="chip" data-v="all">Everything</button><button class="chip" data-v="mylist">Our lists</button></div></div>
      <div class="field"><label>How long have you got?</label><div class="chips" id="mnLen">
        <button class="chip on" data-v="">Any length</button><button class="chip" data-v="95">Under 1½ hours</button><button class="chip" data-v="120">Under 2 hours</button><button class="chip" data-v="150">Under 2½ hours</button></div></div>
      ${genres.length ? `<div class="field"><label>In the mood for</label><div class="chips" id="mnGenre"><button class="chip on" data-v="">Anything</button>
        ${genres.slice(0, 14).map(g => `<button class="chip" data-v="${esc(g.name)}">${esc(g.name)}</button>`).join('')}</div></div>` : ''}
      <label class="list-item" style="padding:6px 0 14px"><div class="grow"><div class="t">Family friendly</div><div class="s">Only G and PG films, so the kids can vote too</div></div>
        <span class="switch"><input type="checkbox" id="mnFam" ${kids ? 'checked disabled' : ''}><span></span></span></label>
      <button class="btn primary" id="mnGo">${ICON.popcorn} Start movie night</button></div>
    <div class="panel"><h2>Join with a code</h2>
      <form id="mnJoin" class="btn-row" style="flex-wrap:nowrap"><input class="input code-input" name="c" maxlength="4" placeholder="ABCD" autocapitalize="characters" autocomplete="off"><button class="btn">Join</button></form></div></div>`;
  const pick = id => { $$(`#${id} .chip`).forEach(c => c.onclick = () => { $$(`#${id} .chip`).forEach(x => x.classList.toggle('on', x === c)); }); };
  ['mnPool', 'mnLen', 'mnGenre'].forEach(id => $(`#${id}`) && pick(id));
  const val = id => $(`#${id} .chip.on`)?.dataset.v || '';
  $('#mnGo').onclick = async () => {
    try {
      const r = await api('/api/movienight', { body: { pool: val('mnPool'), maxRuntime: +val('mnLen') || null, genre: val('mnGenre') || null, familyFriendly: $('#mnFam').checked } });
      go(`#/movienight/${r.code}`);
    } catch (e) { toast(e.message, 4000); }
  };
  $('#mnJoin').onsubmit = e => { e.preventDefault(); const c = new FormData(e.target).get('c').trim().toUpperCase(); if (c) go(`#/movienight/${c}`); };
};

async function movieNightRoom(code) {
  shell('more', `<div class="page mn">${loading()}</div>`);
  let state = await api(`/api/movienight/${code}`);
  let celebrated = false;
  const es = new EventSource(`/api/movienight/${code}/events`);
  es.addEventListener('state', e => { state = JSON.parse(e.data); draw(); });
  onLeave(() => es.close());

  const people = () => `<div class="mn-people">${state.members.map(m => `<span class="mn-person" title="${esc(m.name)}">${avatar(m, 30, 15)}<small>${m.voted >= m.total ? '✓' : `${m.voted}/${m.total}`}</small></span>`).join('')}</div>`;
  const head = () => `<div class="mn-head"><a class="icon-btn" href="#/movienight" aria-label="Back">${ICON.arrowLeft}</a>
    <div class="grow"><b>Movie night</b><span>Code <b class="mn-code">${esc(state.code)}</b> · share it so others can join</span></div>
    <button class="icon-btn" id="mnShare" aria-label="Share">${ICON.share}</button></div>${people()}`;

  function draw() {
    const main = $('#main .mn');
    if (!main) return;
    if (state.match) return drawMatch(main);
    const card = state.toVote[0];
    if (!card) {
      main.innerHTML = `${head()}<div class="mn-wait">
        <div class="big-emoji">🍿</div><h2>You're done!</h2><p class="hint">Waiting for ${esc(state.members.filter(m => m.voted < m.total).map(m => m.name).join(', ') || 'others to join')}…</p>
        ${state.agreed.length ? `<h3>Looking good so far</h3><div class="scroller posters">${state.agreed.map(f => mnPoster(f)).join('')}</div>` : ''}
        <div class="btn-row" style="justify-content:center"><button class="btn" id="mnMore">${ICON.plus} Add more films</button></div></div>`;
      $('#mnMore').onclick = async () => { const r = await api(`/api/movienight/${code}/more`, { body: {} }); toast(r.added ? `${r.added} more films added` : 'No more films match'); };
    } else {
      main.innerHTML = `${head()}
        <div class="mn-stack"><div class="mn-card" id="mnCard">
          <div class="mn-art">${card.poster ? `<img src="${card.poster}" alt="">` : fallbackArt(card.title, card.year)}<div class="mn-stamp yes">YES</div><div class="mn-stamp no">NOPE</div></div>
          <div class="mn-info"><h2>${esc(card.title)}</h2>
            <div class="meta">${[card.year, card.certification && `<span class="cert">${esc(card.certification)}</span>`, card.runtime && fmtRuntime(card.runtime), card.vote && `<span class="star">★</span> ${card.vote.toFixed(1)}`].filter(Boolean).join('<span class="sep"></span>')}</div>
            ${card.genres?.length ? `<div class="s">${esc(card.genres.slice(0, 3).join(' · '))}</div>` : ''}
            ${card.overview ? `<p>${esc(card.overview)}</p>` : ''}</div>
        </div></div>
        <div class="mn-actions"><button class="mn-btn no" id="mnNo" aria-label="No">${ICON.x}</button>
          <span class="mn-left">${state.toVote.length} left</span>
          <button class="mn-btn yes" id="mnYes" aria-label="Yes">❤</button></div>`;
      const el = $('#mnCard');
      const vote = async yes => {
        el.classList.add(yes ? 'fly-yes' : 'fly-no');
        navigator.vibrate?.(15);
        try { state = await api(`/api/movienight/${code}/vote`, { body: { itemId: card.id, yes } }); } catch (e) { toast(e.message); }
        setTimeout(draw, 220);
      };
      $('#mnYes').onclick = () => vote(true);
      $('#mnNo').onclick = () => vote(false);
      swipe(el, vote);
    }
    $('#mnShare').onclick = shareCode;
  }
  function mnPoster(f) { return `<div class="card"><div class="poster">${f.poster ? `<img src="${f.poster}" alt="">` : fallbackArt(f.title, f.year)}</div><div class="cap">${esc(f.title)}</div></div>`; }
  function drawMatch(main) {
    const f = state.match.film;
    if (!celebrated) { celebrated = true; navigator.vibrate?.([30, 50, 30]); }
    const tonight = new Date(); if (tonight.getHours() >= 19) tonight.setDate(tonight.getDate() + 1); tonight.setHours(19, 0, 0, 0);
    const local = d => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    main.innerHTML = `${head()}<div class="mn-match">
      <div class="kicker">${state.match.unanimous ? "🎉 It's a match! Everyone said yes" : `🎬 The most popular pick (${state.match.yes} of ${state.match.of})`}</div>
      <div class="mn-match-poster">${f.poster ? `<img src="${f.poster}" alt="">` : fallbackArt(f.title, f.year)}</div>
      <h1>${esc(f.title)}</h1><div class="meta">${[f.year, f.runtime && fmtRuntime(f.runtime), f.vote && `★ ${f.vote.toFixed(1)}`].filter(Boolean).join(' · ')}</div>
      <div class="btn-row" style="justify-content:center"><a class="btn primary" href="#/play/${f.id}">${ICON.play} Watch now</a><a class="btn" href="#/item/${f.id}">Details</a></div>
      <div class="panel" style="text-align:left;margin-top:18px"><h2>Later?</h2>
        ${state.scheduled ? `<p>Booked for <b>${esc(new Date(state.scheduled.at).toLocaleString(undefined, { weekday: 'long', hour: 'numeric', minute: '2-digit' }))}</b> by ${esc(state.scheduled.by)}. Everyone's been told.</p>` : ''}
        <div class="btn-row" style="flex-wrap:nowrap"><input class="input" type="datetime-local" id="mnWhen" value="${local(state.scheduled ? new Date(state.scheduled.at) : tonight)}">
          <button class="btn primary" id="mnBook">${state.scheduled ? 'Change' : 'Book it'}</button></div>
        <a class="btn small" style="margin-top:10px" href="/api/movienight/${code}/event.ics" download="movie-night.ics">${ICON.clock} Add to calendar</a></div></div>`;
    $('#mnBook').onclick = async () => {
      try { state = await api(`/api/movienight/${code}/schedule`, { body: { at: new Date($('#mnWhen').value).toISOString() } }); toast('Booked — everyone has been told'); draw(); }
      catch (e) { toast(e.message); }
    };
  }
  function shareCode() {
    const url = `${location.origin}/#/movienight/${code}`;
    const text = `Movie night! Join with code ${code} in Marquee or FamilyNest: ${url}`;
    if (navigator.share) navigator.share({ title: 'Movie night', text, url }).catch(() => {});
    else navigator.clipboard?.writeText(text).then(() => toast('Copied — paste it to the family')).catch(() => toast(`Code: ${code}`));
  }
  draw();
}

// Drag a card left (no) or right (yes)
function swipe(el, done) {
  let x0 = null, dx = 0, id = null;
  el.addEventListener('pointerdown', e => { x0 = e.clientX; id = e.pointerId; el.setPointerCapture(id); el.style.transition = 'none'; });
  el.addEventListener('pointermove', e => {
    if (x0 == null || e.pointerId !== id) return;
    dx = e.clientX - x0;
    el.style.transform = `translateX(${dx}px) rotate(${dx / 18}deg)`;
    el.classList.toggle('lean-yes', dx > 40); el.classList.toggle('lean-no', dx < -40);
  });
  const end = () => {
    if (x0 == null) return;
    x0 = null; el.style.transition = '';
    if (Math.abs(dx) > Math.min(120, innerWidth * 0.25)) done(dx > 0);
    else { el.style.transform = ''; el.classList.remove('lean-yes', 'lean-no'); }
    dx = 0;
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}

// ---------- memories ----------
ROUTES.memories = async () => {
  shell('photos', `<div class="page"><h1 class="page-title">Memories</h1>${loading()}</div>`);
  const m = await api('/api/memories');
  const today = new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'long' });
  const all = [];
  const group = (g, label) => `<section class="memory"><div class="memory-head"><b>${label(g)}</b><span>${g.year}</span></div>
    <div class="photo-grid">${g.items.map(it => { const i = all.push(it) - 1; return `<button class="ph ${it.type === 'home' ? 'vid' : ''}" data-m="${i}">${it.thumb ? `<img src="${it.thumb}" alt="" loading="lazy">` : fallbackArt(it.title)}${it.type === 'home' ? `<span class="play-ico">${ICON.play}</span>` : ''}</button>`; }).join('')}</div></section>`;
  $('#main').innerHTML = `<div class="page"><a class="back-link" href="#/photos">${ICON.arrowLeft} Photos</a><h1 class="page-title">On this day · ${esc(today)}</h1>
    ${m.today.length ? m.today.map(g => group(g, x => `${x.yearsAgo} year${x.yearsAgo === 1 ? '' : 's'} ago today`)).join('') : emptyView(ICON.photo, 'No memories from today', 'Photos and home videos from this date in earlier years will appear here.')}
    ${m.week.length ? `<h2 class="search-h" style="margin-top:28px">This week, in years gone by</h2>${m.week.map(g => group(g, x => `${x.yearsAgo} year${x.yearsAgo === 1 ? '' : 's'} ago`)).join('')}` : ''}</div>`;
  const photos = all.filter(x => x.type === 'photo').map(x => ({ ...x, original: `/api/photo/${x.id}/original` }));
  $$('[data-m]').forEach(b => b.onclick = () => {
    const it = all[+b.dataset.m];
    if (it.type === 'home') go(`#/play/${it.id}`); else lightbox(photos, photos.findIndex(p => p.id === it.id));
  });
};

// ---------- people in photos ----------
async function photoPeopleRow() {
  let r;
  try { r = await api('/api/photo-people'); } catch { return ''; }
  if (!r.people.length) return '';
  return `<section class="people-row"><div class="row-head" style="padding:0"><h2>People</h2><a href="#/photo-people">See all</a></div>
    <div class="faces">${r.people.slice(0, 14).map(faceChip).join('')}</div></section>`;
}
const faceChip = p => `<a class="face-chip" href="#/photo-person/${p.id}"><img src="${p.cover}" alt="" loading="lazy"><span>${p.name ? esc(p.name) : '<i>Add a name</i>'}</span><small>${p.count}</small></a>`;

ROUTES['photo-people'] = async () => {
  shell('photos', `<div class="page"><h1 class="page-title">People</h1>${loading()}</div>`);
  const r = await api('/api/photo-people');
  const named = r.people.filter(p => p.name), unnamed = r.people.filter(p => !p.name);
  const st = r.status;
  $('#main').innerHTML = `<div class="page"><a class="back-link" href="#/photos">${ICON.arrowLeft} Photos</a><h1 class="page-title">People</h1>
    ${st.running ? `<p class="hint">Looking for faces… ${st.done} of ${st.total} photos checked.</p>` : ''}
    ${!r.people.length ? emptyView(ICON.users, 'No people yet', st.enabled === false ? 'Face grouping is switched off in Settings.' : 'Marquee groups faces as it looks through your photos. This happens quietly in the background — check back later.') : ''}
    ${named.length ? `<div class="faces big">${named.map(faceChip).join('')}</div>` : ''}
    ${unnamed.length ? `<h2 class="search-h">Who are these?</h2><p class="hint">Tap a face and give it a name — Marquee will find them in your other photos too.</p><div class="faces big">${unnamed.map(faceChip).join('')}</div>` : ''}</div>`;
};

ROUTES['photo-person'] = async id => {
  shell('photos', `<div class="page">${loading()}</div>`);
  const p = await api(`/api/photo-people/${id}`);
  const canEdit = !me.isKids && !me.guest;
  $('#main').innerHTML = `<div class="page"><a class="back-link" href="#/photo-people">${ICON.arrowLeft} People</a>
    <div class="person-head"><h1 class="page-title" style="margin:0">${p.name ? esc(p.name) : 'Who is this?'}</h1>
    ${canEdit ? `<button class="btn small" id="ppName">${p.name ? 'Rename' : 'Add a name'}</button><button class="btn small" id="ppHide">Hide</button>` : ''}</div>
    <div class="btn-row" style="margin:6px 0 16px"><button class="btn small" id="ppShow">${ICON.play} Slideshow</button><span class="hint" style="margin:0">${p.photos.length} photo${p.photos.length === 1 ? '' : 's'}</span></div>
    <div class="photo-grid">${p.photos.map((x, i) => `<button class="ph" data-i="${i}"><img src="${x.thumb}" alt="" loading="lazy"></button>`).join('')}</div></div>`;
  $$('.ph').forEach(b => b.onclick = () => lightbox(p.photos, +b.dataset.i));
  $('#ppShow').onclick = () => lightbox(p.photos, 0, true);
  if (!canEdit) return;
  $('#ppName').onclick = () => {
    const m = modal(`<h2>${p.name ? 'Rename' : 'Who is this?'}</h2><form id="pf"><input class="input" name="n" value="${esc(p.name || '')}" placeholder="e.g. Zoey" maxlength="40" autocomplete="off">
      <p class="hint">Using a name that's already taken joins the two together (handy for baby photos).</p><div class="btn-row"><button class="btn primary">Save</button></div></form>`);
    $('#pf', m.el).onsubmit = async e => {
      e.preventDefault();
      const r = await api(`/api/photo-people/${p.id}`, { method: 'PATCH', body: { name: new FormData(e.target).get('n') } });
      m.close(); toast('Saved'); go(`#/photo-person/${r.id}`, true); route();
    };
  };
  $('#ppHide').onclick = async () => { await api(`/api/photo-people/${p.id}`, { method: 'PATCH', body: { hidden: true } }); toast('Hidden from People'); go('#/photo-people', true); };
};

// Faces in the photo being viewed (used by the lightbox)
const PhotoFaces = {
  async open(photo, anchor) {
    const list = await api(`/api/photo-faces/${photo.id}`).catch(() => []);
    const canEdit = !me.isKids && !me.guest;
    const m = modal(`<h2>People in this photo</h2>${list.length ? `<div class="menu-list">${list.map(f => `<button data-f="${f.id}" ${canEdit ? '' : 'disabled'}>
      <img class="face-mini" src="${f.thumb}" alt=""><span>${f.name ? esc(f.name) : '<i>Unknown</i>'}${canEdit ? '<small>Tap to change</small>' : ''}</span></button>`).join('')}</div>`
      : '<p class="hint">No faces found in this photo (yet).</p>'}`);
    $$('[data-f]', m.el).forEach(b => b.onclick = async () => {
      const f = list.find(x => x.id === +b.dataset.f);
      const n = prompt('Who is this? (leave empty if it’s nobody you know)', f.name || '');
      if (n === null) return;
      await api(`/api/faces/${f.id}`, { method: 'PATCH', body: n.trim() ? { name: n.trim() } : { personId: null } });
      m.close(); toast(n.trim() ? `Tagged as ${n.trim()}` : 'Removed');
    });
  },
};

// ---------- smart search (plain English) ----------
async function smartResults(q) {
  const r = await api(`/api/smart-search?q=${encodeURIComponent(q)}`).catch(() => null);
  if (!r || !r.items.length) return '';
  return `<div class="smart"><div class="smart-head">${ICON.star} <b>${r.similarTo ? `Like ${esc(r.similarTo.title)}` : 'Matches your description'}</b>
    <div class="chips" style="margin:0">${r.chips.map(c => `<span class="chip on">${esc(c)}</span>`).join('')}</div>${r.relaxed ? '<span class="hint" style="margin:0">(loosened a little)</span>' : ''}</div>
    <div class="grid">${r.items.slice(0, 24).map(posterCard).join('')}</div></div>`;
}

// ---------- guest share links ----------
async function shareItem(x) {
  const target = x.type === 'show' ? x.nextEpisode : x;
  if (!target) return toast('Nothing to share yet');
  const m = modal(`<h2>Share ${esc(x.type === 'show' ? `${x.title} · ${epCode(target)}` : x.title)}</h2>
    <p class="hint">Anyone with the link can watch this one ${target.type === 'episode' ? 'episode' : 'video'} — nothing else. No Tailscale or sign-in needed.</p>
    <div class="two"><div class="field"><label>Works for</label><select class="select" id="shDays"><option value="1">1 day</option><option value="3">3 days</option><option value="7" selected>1 week</option><option value="30">30 days</option></select></div>
    <div class="field"><label>Views</label><select class="select" id="shViews"><option value="">As many as they like</option><option value="1">1 view</option><option value="3">3 views</option><option value="5">5 views</option></select></div></div>
    <div class="field"><label>A note (optional)</label><input class="input" id="shNote" maxlength="200" placeholder="You've got to see this!"></div>
    <div class="btn-row"><button class="btn primary" id="shGo">${ICON.share} Create link</button><a class="btn" href="#/shares">My shared links</a></div><div id="shOut"></div>`);
  $('#shGo', m.el).onclick = async () => {
    try {
      const r = await api('/api/shares', { body: { itemId: target.id, days: +$('#shDays', m.el).value, maxViews: +$('#shViews', m.el).value || null, note: $('#shNote', m.el).value } });
      const full = r.url.startsWith('http') ? r.url : location.origin + r.url;
      $('#shOut', m.el).innerHTML = `<div class="share-link"><input class="input" readonly value="${esc(full)}"><div class="btn-row">${navigator.share ? '<button class="btn primary" id="shSend">Send…</button>' : ''}<button class="btn" id="shCopy">Copy</button></div>
        ${r.url.startsWith('http') ? '' : `<p class="hint">${me.isAdmin ? 'This link only works on your home network or Tailscale until you set up public share links in Settings → Share links.' : 'Ask the admin to turn on public share links so this works for anyone.'}</p>`}</div>`;
      $('#shGo', m.el).disabled = true;
      if ($('#shSend', m.el)) $('#shSend', m.el).onclick = () => navigator.share({ title: x.title, text: `Watch ${x.title} — from ${me.name}`, url: full }).catch(() => {});
      $('#shCopy', m.el).onclick = () => navigator.clipboard.writeText(full).then(() => toast('Link copied')).catch(() => toast('Copy failed — select the link instead'));
    } catch (e) { toast(e.message, 4000); }
  };
}
ROUTES.shares = async () => {
  shell('more', `<div class="page settings"><h1 class="page-title">Shared links</h1>${loading()}</div>`);
  const draw = async () => {
    const r = await api('/api/shares');
    $('#main').innerHTML = `<div class="page settings"><h1 class="page-title">Shared links</h1>
      ${!r.publicBase ? `<p class="hint">${me.isAdmin ? 'Links only work at home or on Tailscale right now. To let anyone open them, set up <b>Share links</b> in Settings.' : 'Links only work at home or on Tailscale until the admin sets up public share links.'}</p>` : ''}
      ${r.shares.length ? `<div class="panel"><div class="list">${r.shares.map(s => `<div class="list-item">
        <div class="grow"><div class="t">${esc(s.title)} ${s.active ? '<span class="pill accent">Active</span>' : '<span class="pill">Ended</span>'}</div>
        <div class="s">${me.isAdmin ? `By ${esc(s.by)} · ` : ''}${s.views} view${s.views === 1 ? '' : 's'}${s.maxViews ? ` of ${s.maxViews}` : ''} · ${s.active ? `until ${fmtDate(s.expiresAt, { weekday: 'short', day: 'numeric', month: 'short' })}` : 'no longer works'}${s.note ? ` · “${esc(s.note)}”` : ''}</div></div>
        ${s.active ? `<button class="btn small" data-c="${esc(s.url)}">Copy</button><button class="btn small" data-x="${s.id}">Stop</button>` : ''}</div>`).join('')}</div></div>`
        : emptyView(ICON.share, 'Nothing shared yet', 'Open a movie or episode, tap ⋯ and choose <b>Share a link</b>.')}</div>`;
    $$('[data-c]').forEach(b => b.onclick = () => { const u = b.dataset.c; navigator.clipboard?.writeText(u.startsWith('http') ? u : location.origin + u).then(() => toast('Link copied')); });
    $$('[data-x]').forEach(b => b.onclick = async () => { if (!confirmTwice(b, 'Stop it?')) return; await api(`/api/shares/${b.dataset.x}`, { method: 'DELETE' }); toast('Link stopped'); draw(); });
  };
  await draw();
};

// ---------- AI subtitles ----------
async function aiSubsMenu(x, reload) {
  const target = x.type === 'show' ? x.nextEpisode : x;
  if (!target) return;
  const r = await api(`/api/ai-subs/${target.id}`);
  const job = t => r.jobs.find(j => j.task === t);
  const label = (t, idle) => { const j = job(t); return !j ? idle : j.status === 'ready' ? `${idle} <small>Done — pick it from the subtitles menu</small>` : j.status === 'failed' ? `${idle} <small>Didn't work: ${esc(j.error || '')}</small>` : `${idle} <small>${j.status === 'working' ? `Working… ${Math.round(j.progress * 100)}%` : 'Waiting its turn'}</small>`; };
  const m = modal(`<h2>Subtitles made by AI</h2><p class="hint">Marquee listens to the ${target.type === 'episode' ? 'episode' : 'video'} on your ZimaOS box and writes subtitles. Nothing is uploaded. It takes a while on small boxes — roughly as long as the video itself.</p>
    ${r.available ? `<div class="menu-list"><button data-t="transcribe">${ICON.pulse}<span>${label('transcribe', 'Make subtitles')}</span></button>
      <button data-t="translate">${ICON.pulse}<span>${label('translate', 'Translate into English subtitles')}</span></button></div>`
      : `<p class="hint">${me.isAdmin ? 'This server image was built without the speech engine. Rebuild Marquee with the latest files (see the setup guide).' : 'Not available on this server yet.'}</p>`}`);
  $$('[data-t]', m.el).forEach(b => b.onclick = async () => {
    try { await api(`/api/ai-subs/${target.id}`, { body: { task: b.dataset.t } }); m.close(); toast('Started — it’ll appear in the subtitles menu when done'); reload && reload(); }
    catch (e) { toast(e.message, 4000); }
  });
}

// ---------- theme songs ----------
const ThemeMusic = (() => {
  let audio = null, fade = null;
  function stop() {
    if (!audio) return;
    const a = audio; audio = null;
    clearInterval(fade);
    fade = setInterval(() => { a.volume = Math.max(0, a.volume - 0.03); if (a.volume <= 0.01) { clearInterval(fade); a.pause(); a.src = ''; } }, 60);
  }
  function start(x) {
    stop();
    if (!x.theme || !me?.themeMusic || MiniPlayer.playing) return;
    const a = new Audio(`/api/items/${x.id}/theme`);
    a.volume = 0;
    audio = a;
    a.play().then(() => { let v = 0; const up = setInterval(() => { if (audio !== a) return clearInterval(up); v = Math.min(0.28, v + 0.02); a.volume = v; if (v >= 0.28) clearInterval(up); }, 80); })
      .catch(() => { audio = null; }); // the browser wants a tap first — no problem
    a.onended = () => { if (audio === a) audio = null; };
    onLeave(stop);
  }
  return { start, stop };
})();
async function uploadTheme(x, reload) {
  const m = modal(`<h2>Theme song</h2><p class="hint">Plays quietly on the ${x.type === 'show' ? 'show' : 'movie'} page. You can also drop a <b>theme.mp3</b> into its folder.</p>
    <div class="btn-row"><label class="btn primary">Choose a song…<input type="file" accept="audio/*" id="thF" hidden></label>${x.theme ? '<button class="btn" id="thX">Remove</button>' : ''}</div>`);
  $('#thF', m.el).onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    const data = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(f); });
    try { await api(`/api/admin-theme/${x.id}`, { body: { type: f.type || 'audio/mpeg', data } }); m.close(); toast('Theme song added'); reload(); } catch (err) { toast(err.message); }
  };
  if ($('#thX', m.el)) $('#thX', m.el).onclick = async () => { await api(`/api/admin-theme/${x.id}`, { method: 'DELETE' }); m.close(); toast('Removed'); reload(); };
}

// ---------- "Ask Marquee": voice or typed commands ----------
function askMarquee() {
  const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
  const m = modal(`<h2>Ask Marquee</h2><p class="hint">Try “play Bluey on the lounge TV”, “pause”, “what's new”, or “something funny under 90 minutes”.</p>
    <form id="askF" class="btn-row" style="flex-wrap:nowrap"><input class="input" name="q" placeholder="What would you like?" autocomplete="off">${Rec ? `<button type="button" class="btn round" id="askMic" aria-label="Speak">🎤</button>` : ''}<button class="btn primary">Go</button></form>
    <div id="askOut" class="ask-out"></div>`);
  const run = async text => {
    $('#askOut', m.el).innerHTML = '<div class="spinner" style="margin:14px auto"></div>';
    const r = await api('/api/assistant', { body: { text } }).catch(e => ({ ok: false, speech: e.message }));
    $('#askOut', m.el).innerHTML = `<p class="${r.ok ? '' : 'hint'}">${esc(r.speech)}</p>`;
    try { if ('speechSynthesis' in window) speechSynthesis.speak(Object.assign(new SpeechSynthesisUtterance(r.speech), { rate: 1.05 })); } catch {}
    const a = r.action;
    if (a?.type === 'play') setTimeout(() => { m.close(); go(`#/play/${a.itemId}`); }, 900);
    else if (a?.type === 'suggest' || a?.type === 'open') $('#askOut', m.el).insertAdjacentHTML('beforeend', `<a class="btn small" href="#/item/${a.itemId}">Open</a>`);
    else if (a?.type === 'movienight') setTimeout(() => { m.close(); go(`#/movienight/${a.code}`); }, 900);
  };
  $('#askF', m.el).onsubmit = e => { e.preventDefault(); const q = new FormData(e.target).get('q').trim(); if (q) run(q); };
  if ($('#askMic', m.el)) $('#askMic', m.el).onclick = () => {
    const rec = new Rec();
    rec.lang = navigator.language || 'en-AU';
    rec.interimResults = false;
    $('#askMic', m.el).classList.add('listening');
    rec.onresult = e => { const t = e.results[0][0].transcript; $('input[name=q]', m.el).value = t; run(t); };
    rec.onend = () => $('#askMic', m.el)?.classList.remove('listening');
    rec.onerror = () => toast("Didn't catch that — try typing");
    rec.start();
  };
}

// ---------- signed-in devices (everyone) & security (admins) ----------
ROUTES.devices = async () => {
  shell('more', `<div class="page settings"><h1 class="page-title">Signed-in devices</h1>${loading()}</div>`);
  const draw = async () => {
    const r = await api('/api/sessions');
    $('#main').innerHTML = `<div class="page settings"><a class="back-link" href="#/settings">${ICON.arrowLeft} Settings</a><h1 class="page-title">Signed-in devices</h1>
      <div class="panel"><p class="hint">Every phone, tablet, TV and browser signed in to ${me.isAdmin ? 'Marquee' : 'your profile'}. Don't recognise one? Sign it out.</p><div class="list">
      ${r.sessions.map(s => `<div class="list-item">${avatar({ name: s.profile, color: s.color }, 32, 9)}
        <div class="grow"><div class="t">${esc(s.device)}${s.current ? ' <span class="pill accent">This device</span>' : ''}${s.guest ? ' <span class="pill">Guest</span>' : ''}</div>
        <div class="s">${me.isAdmin ? `${esc(s.profile)} · ` : ''}last used ${ago(s.lastSeen)}${s.ip ? ` · ${esc(s.ip)}` : ''} · since ${fmtDate(s.createdAt)}</div></div>
        ${s.current ? '' : `<button class="btn small" data-x="${s.id}">Sign out</button>`}</div>`).join('')}</div></div>
      ${me.isAdmin && r.blocked.length ? `<div class="panel"><h2>Blocked for wrong PINs</h2><div class="list">${r.blocked.map(b => `<div class="list-item"><div class="grow"><div class="t">${esc(b.ip)}</div><div class="s">until ${new Date(b.until).toLocaleTimeString()}</div></div><button class="btn small" data-u="${esc(b.ip)}">Unblock</button></div>`).join('')}</div></div>` : ''}
      ${me.isAdmin ? `<div class="panel"><h2>Recent sign-ins</h2><div class="list">${r.signins.map(s => `<div class="list-item"><div class="grow"><div class="t">${s.ok ? '✓' : '<span style="color:#e0533d">✕</span>'} ${esc(s.profile || 'Unknown')} · ${esc(s.device)}</div>
        <div class="s">${ago(s.at)} · ${esc(s.ip || '')}${s.reason ? ` · ${esc(s.reason)}` : ''}</div></div></div>`).join('') || '<p class="hint">Nothing yet.</p>'}</div>
        <p class="hint">Marquee blocks an address after 10 wrong PINs in 15 minutes and tells you. Each profile also locks for longer after every 5 wrong tries.</p></div>` : ''}</div>`;
    $$('[data-x]').forEach(b => b.onclick = async () => { if (!confirmTwice(b, 'Sign out?')) return; await api(`/api/sessions/${b.dataset.x}`, { method: 'DELETE' }); toast('Signed out'); draw(); });
    $$('[data-u]').forEach(b => b.onclick = async () => { await api('/api/sessions/unblock', { body: { ip: b.dataset.u } }); toast('Unblocked'); draw(); });
  };
  await draw();
};

// ---------- library health (admins) ----------
ROUTES.health = async () => {
  shell('more', `<div class="page settings"><h1 class="page-title">Library health</h1>${loading()}</div>`);
  const draw = async fresh => {
    const h = await api(`/api/admin/health${fresh ? '?fresh=1' : ''}`);
    const sec = (key, title, help, fix) => {
      const list = h[key];
      if (!list.length) return '';
      return `<div class="panel"><h2>${title} <span class="pill">${list.length}</span></h2><p class="hint">${help}</p><div class="list">${list.slice(0, 60).map(x => `<div class="list-item">
        <div class="grow"><div class="t">${esc(x.title)}</div><div class="s">${esc(x.problem)}${x.path ? ` · <span style="opacity:.7">${esc(x.path)}</span>` : ''}</div></div>${fix(x)}</div>`).join('')}
        ${list.length > 60 ? `<p class="hint">…and ${list.length - 60} more</p>` : ''}</div></div>`;
    };
    const open = x => `<a class="btn small" href="#/item/${x.id}">Open</a>`;
    const ok = !h.summary.total && !h.artwork.length;
    $('#main').innerHTML = `<div class="page settings"><a class="back-link" href="#/settings">${ICON.arrowLeft} Settings</a><h1 class="page-title">Library health</h1>
      <div class="btn-row" style="margin:-6px 0 16px"><span class="hint" style="margin:0">Checked ${ago(h.at)}</span><button class="btn small" id="hRe">${ICON.refresh} Check again</button></div>
      ${ok ? emptyView(ICON.check, 'All good', 'No broken files, missing episodes or doubtful matches.') : ''}
      ${sec('missing', 'Missing files', 'These are in Marquee but the file has gone. A library scan removes them.', () => '')}
      ${sec('broken', "Files that won't play properly", 'Damaged, still copying, or missing a picture or sound track.', x => (x.type === 'photo' ? '' : `<a class="btn small" href="#/play/${x.id}">Try</a>`))}
      ${sec('gaps', 'Missing episodes', 'Episodes that have aired but aren’t in your library.', open)}
      ${sec('matches', 'Check these matches', 'Marquee may have picked the wrong film or show — open it, tap ⋯ → Fix match.', open)}
      ${sec('duplicates', 'Duplicates', 'More than one copy of the same edition.', () => '<a class="btn small" href="#/duplicates">Review</a>')}
      ${sec('artwork', 'Missing posters', 'Open it and tap ⋯ → Choose poster.', open)}
      ${h.notes.map(n => `<p class="hint">${esc(n)}</p>`).join('')}</div>`;
    $('#hRe').onclick = () => { $('#main .page').insertAdjacentHTML('beforeend', loading()); draw(true); };
  };
  await draw(false);
};

// ---------- Settings → panels for the newer features (admins) ----------
async function loadExtrasPanels() {
  const el = $('#extrasPanels');
  if (!el) return;
  let x;
  try { x = await api('/api/admin/extras'); } catch (e) { el.innerHTML = `<p class="hint">${esc(e.message)}</p>`; return; }
  const s = x.settings, f = x.faces, a = x.aiSubs, ss = x.spaceSaver;
  const tokens = await api('/api/app-tokens').catch(() => []);
  const profiles = (await api('/api/profiles').catch(() => []));
  const sw = (id, on) => `<label class="switch"><input type="checkbox" id="${id}" ${on ? 'checked' : ''}><span></span></label>`;
  const hours = (id, v) => `<select class="select" id="${id}">${Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${+v === h ? 'selected' : ''}>${new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: 'numeric' })}</option>`).join('')}</select>`;
  const kindName = { familynest: 'FamilyNest', assistant: 'Voice assistant', widget: 'Home-screen widget', device: 'Marquee app (widgets & car)' };
  el.innerHTML = `
    <div class="panel"><h2>Faces in photos</h2>
      <p class="hint">Groups photos by who's in them so you can name people and see every photo of them. Runs on your ZimaOS box only — no photos leave the house.</p>
      ${f.available ? `<div class="list-item"><div class="grow"><div class="t">Find faces</div><div class="s">${f.running ? `Working… ${f.done} of ${f.total} photos` : `${f.checked} of ${f.photos} photos checked · ${f.faces} faces · ${f.people} people`}${f.error ? ` · <span style="color:#ff9a87">${esc(f.error)}</span>` : ''}</div></div>${sw('xFaces', s.facesEnabled)}</div>
        <div class="btn-row" style="margin-top:10px"><a class="btn small" href="#/photo-people">${ICON.users} People</a><button class="btn small" id="xFacesRedo">Start again from scratch</button></div>`
      : '<p class="hint">Not available — rebuild Marquee with the latest files to add it.</p>'}</div>

    <div class="panel"><h2>Subtitles made by AI</h2>
      <p class="hint">Listens to a video on your ZimaOS box and writes subtitles — great for home videos, or foreign films (it can translate into English). Open anything, tap ⋯ → <b>Subtitles made by AI</b>.</p>
      ${a.available ? `<div class="list-item"><div class="grow"><div class="t">Accuracy</div><div class="s">${a.modelReady ? 'Ready' : 'Downloads once on first use'}${a.download ? ` · downloading ${a.download.pct}%` : ''}</div></div>
          <select class="select" id="xAiModel">${Object.entries(a.models).map(([k, m]) => `<option value="${k}" ${a.model === k ? 'selected' : ''}>${k[0].toUpperCase() + k.slice(1)} · ${m.size} — ${m.note}</option>`).join('')}</select></div>
        <div class="list-item"><div class="grow"><div class="t">Do it automatically</div><div class="s">For new videos that arrive with no subtitles at all</div></div>
          <select class="select" id="xAiAuto">${[['off', 'Off'], ['home', 'Home videos'], ['missing', 'Everything without subtitles']].map(([k, l]) => `<option value="${k}" ${s.aiSubsAuto === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        ${a.recent.length ? `<h3 class="sub-h">Recent</h3><div class="list">${a.recent.slice(0, 8).map(j => `<div class="list-item"><div class="grow"><div class="t">${esc(j.title)} <span class="pill">${j.task === 'translate' ? 'Translate' : 'Subtitles'}</span></div>
          <div class="s">${j.status === 'working' ? `Working… ${Math.round(j.progress * 100)}%` : j.status === 'failed' ? `Didn't work: ${esc(j.error || '')}` : j.status === 'ready' ? 'Done' : 'Waiting'}</div></div></div>`).join('')}</div>` : ''}`
      : '<p class="hint">The speech engine isn\'t in this server image yet — rebuild Marquee with the latest files (the setup guide shows how).</p>'}</div>

    <div class="panel"><h2>Smarter search</h2>
      <p class="hint">Search already understands things like “funny movies under 90 minutes”, “80s action” or “something like Moana”. For trickier requests it can ask an AI model to help.</p>
      <div class="list-item"><div class="grow"><div class="t">Help from AI</div></div>
        <select class="select" id="xAiProv">${[['none', 'Off (built-in rules)'], ['ollama', 'Ollama on my network (private)'], ['anthropic', 'Claude (your API key)']].map(([k, l]) => `<option value="${k}" ${s.aiProvider === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div id="xOllama" ${s.aiProvider === 'ollama' ? '' : 'hidden'}><div class="two"><div class="field"><label>Ollama address</label><input class="input" id="xOlUrl" value="${esc(s.ollamaUrl)}" placeholder="http://192.168.1.20:11434"></div>
        <div class="field"><label>Model</label><input class="input" id="xOlModel" value="${esc(s.ollamaModel)}" placeholder="llama3.2"></div></div></div>
      <div id="xClaude" ${s.aiProvider === 'anthropic' ? '' : 'hidden'}><div class="field"><label>Claude API key</label><input class="input" id="xAnKey" type="password" autocomplete="off" placeholder="${s.anthropicKeySet ? 'Saved — paste to replace' : 'sk-ant-…'}"></div>
        <p class="hint">Only the words you search for are sent — never your library or files.</p></div>
      <div class="btn-row"><button class="btn small primary" id="xAiSave">Save</button><button class="btn small" id="xAiTest">Test it</button></div></div>

    <div class="panel"><h2>Cinema mode & theme songs</h2>
      <p class="hint">Each person turns cinema mode on for themselves (Settings, top of this page). Trailers come from films in your library — your own trailer files (“Movie-trailer.mp4” or a Trailers folder) or YouTube.
        For your own “feature presentation” intro, put a video in <b>/DATA/AppData/marquee/config/prerolls</b>.${x.prerolls.length ? ` Found: ${x.prerolls.map(esc).join(', ')}.` : ''}
        Theme songs: put <b>theme.mp3</b> in a show's folder, or open the show → ⋯ → Add a theme song.</p>
      <div class="list-item"><div class="grow"><div class="t">Trailers before a movie</div></div><select class="select" id="xTrailers">${[0, 1, 2, 3].map(n => `<option ${s.cinemaTrailers === n ? 'selected' : ''} value="${n}">${n || 'None'}</option>`).join('')}</select></div></div>

    <div class="panel"><h2>Memories</h2>
      <div class="list-item"><div class="grow"><div class="t">Morning “On this day” notification</div><div class="s">When there are photos or home videos from this date in earlier years</div></div>${hours('xMemHour', s.memoriesHour)}${sw('xMem', s.memoriesNotify)}</div></div>

    <div class="panel"><h2>Space saver</h2>
      <p class="hint">Overnight, re-encodes big older-format videos to HEVC — usually <b>40–50% smaller</b> with no visible difference. It replaces files in the folders you made writable, pauses whenever someone is watching, checks every new file before swapping it in, and keeps the original in a hidden <b>.marquee-originals</b> folder for ${s.spaceSaverKeepDays} days. Leave this off unless you mean to rewrite those files.</p>
      ${ss.readOnly.length ? `<div class="st-banner off" style="margin-bottom:12px">${ICON.lock}<div><b>Some media folders are read-only</b><span>Space saver can only work where Marquee may write. In docker-compose.yml remove <b>:ro</b> from: ${ss.readOnly.map(esc).join(', ')}</span></div></div>` : ''}
      <div class="stats" style="margin:4px 0 12px"><div class="stat"><b>${fmtBytes(ss.potentialBytes)}</b><span>could be saved (${ss.candidates} files)</span></div><div class="stat"><b>${fmtBytes(ss.savedBytes)}</b><span>saved so far</span></div></div>
      <div class="list-item"><div class="grow"><div class="t">Run overnight</div><div class="s">${ss.running ? (ss.paused || `Working on ${esc(ss.current?.title || '…')}`) : ss.paused || (ss.hw ? 'Uses the graphics chip — quick' : 'Uses the processor — slower, but fine overnight')}</div></div>${sw('xSs', s.spaceSaver)}</div>
      <div class="list-item"><div class="grow"><div class="t">Between</div></div>${hours('xSsStart', s.spaceSaverStart)}<span class="hint" style="margin:0 6px">and</span>${hours('xSsEnd', s.spaceSaverEnd)}</div>
      <div class="list-item"><div class="grow"><div class="t">Only files bigger than</div></div><select class="select" id="xSsMin">${[0.5, 1, 2, 4, 8].map(g => `<option ${s.spaceSaverMinGb === g ? 'selected' : ''} value="${g}">${g} GB</option>`).join('')}</select></div>
      <div class="list-item"><div class="grow"><div class="t">Keep originals for</div></div><select class="select" id="xSsKeep">${[1, 3, 7, 14, 30].map(d => `<option ${s.spaceSaverKeepDays === d ? 'selected' : ''} value="${d}">${d} day${d === 1 ? '' : 's'}</option>`).join('')}</select></div>
      ${ss.top.length ? `<h3 class="sub-h">Biggest wins</h3><div class="list">${ss.top.slice(0, 6).map(t => `<div class="list-item"><div class="grow"><div class="t">${esc(t.title)}</div><div class="s">${fmtBytes(t.size)} · ${esc((t.codec || '').toUpperCase())} · save about ${fmtBytes(t.saving)}</div></div><button class="btn small" data-ssq="${t.id}">Shrink now</button></div>`).join('')}</div>` : ''}
      ${ss.recent.length ? `<h3 class="sub-h">Done</h3><div class="list">${ss.recent.slice(0, 8).map(r => `<div class="list-item"><div class="grow"><div class="t">${esc(r.title)}</div>
        <div class="s">${r.status === 'done' ? `${fmtBytes(r.old_size)} → ${fmtBytes(r.new_size)}` : r.status === 'working' ? `Working… ${Math.round(r.progress * 100)}%` : r.status === 'queued' ? 'Waiting' : esc(r.error || r.status)}</div></div>
        ${r.status === 'done' ? `<button class="btn small" data-ssr="${r.item_id}">Put original back</button>` : ''}</div>`).join('')}</div>` : ''}
      <div class="btn-row" style="margin-top:10px"><button class="btn small" id="xSsRun">Run now</button>${ss.running ? '<button class="btn small" id="xSsStop">Stop</button>' : ''}</div></div>

    <div class="panel"><h2>Share links</h2>
      <p class="hint">Send one movie or episode to anyone — they don't need Tailscale. Share links are served on a separate port (${s.sharePort || 'off'}) that knows nothing else about Marquee, so the rest stays private.
        To make them work from anywhere, run this once on the ZimaOS box (see the setup guide):<br><code>tailscale funnel --bg --https=8443 ${s.sharePort || 8421}</code></p>
      <div class="field"><label>Public address for links</label><input class="input" id="xShUrl" value="${esc(s.shareUrl)}" placeholder="https://zimaos.tail1234.ts.net:8443"></div>
      <div class="list-item"><div class="grow"><div class="t">Quality for guests</div></div><select class="select" id="xShQ">${[['1080', '1080p'], ['720', '720p'], ['480', '480p'], ['original', 'Original']].map(([k, l]) => `<option ${s.shareQuality === k ? 'selected' : ''} value="${k}">${l}</option>`).join('')}</select></div>
      <div class="btn-row"><button class="btn small primary" id="xShSave">Save</button><a class="btn small" href="#/shares">All shared links</a></div></div>

    <div class="panel"><h2>Connected apps</h2>
      <p class="hint">Keys that let other apps use Marquee: <b>FamilyNest</b> (movie night voting), <b>voice assistants</b> like JARVIS or Siri Shortcuts, and <b>home-screen widgets</b>. Each key acts as one profile. Remove a key and that app stops working straight away.</p>
      <div class="list">${tokens.map(t => `<div class="list-item"><div class="grow"><div class="t">${esc(t.name)} <span class="pill">${esc(kindName[t.kind] || t.kind)}</span></div>
        <div class="s">As ${esc(t.profile)} · key ${esc(t.hint)} · ${t.last_used ? `used ${ago(t.last_used)}` : 'not used yet'}</div></div><button class="btn small" data-tx="${t.id}">Remove</button></div>`).join('') || '<p class="hint">None yet.</p>'}</div>
      <div class="btn-row" style="margin-top:10px"><button class="btn small primary" data-tn="familynest">${ICON.plus} Connect FamilyNest</button><button class="btn small" data-tn="assistant">${ICON.plus} Voice assistant key</button><button class="btn small" data-tn="widget">${ICON.plus} Widget key</button></div></div>

    <div class="panel"><h2>Android app updates</h2>
      <p class="hint">Upload the newest <b>marquee.apk</b> here and every Android phone, tablet and TV offers to update itself. Fire TV and Android TV can also install it from <b>${esc(location.origin)}/app.apk</b>.</p>
      <div class="list-item"><div class="grow"><div class="t">${x.android && !x.android.error ? `Version ${esc(x.android.versionName || '?')} (${x.android.versionCode})` : 'No app uploaded yet'}</div>
        <div class="s">${x.android?.uploadedAt ? `Uploaded ${ago(x.android.uploadedAt)} · ${fmtBytes(x.android.size)}` : x.android?.error ? esc(x.android.error) : ''}</div></div>
        <label class="btn small primary">Upload APK…<input type="file" accept=".apk,application/vnd.android.package-archive" id="xApk" hidden></label></div></div>`;

  const put = async body => { try { await api('/api/admin/extras', { method: 'PUT', body }); toast('Saved'); } catch (e) { toast(e.message, 4500); } };
  const on = (id, fn) => { const n = $(`#${id}`); if (n) n.onchange = e => fn(e.target); };
  on('xFaces', t => put({ facesEnabled: t.checked }));
  if ($('#xFacesRedo')) $('#xFacesRedo').onclick = async e => { if (!confirmTwice(e.target, 'Forget all names and start again?')) return; await api('/api/admin/faces/reset', { body: {} }); toast('Starting again'); };
  on('xAiModel', t => put({ aiSubsModel: t.value }));
  on('xAiAuto', t => put({ aiSubsAuto: t.value }));
  on('xAiProv', t => { $('#xOllama').hidden = t.value !== 'ollama'; $('#xClaude').hidden = t.value !== 'anthropic'; });
  $('#xAiSave').onclick = () => put({ aiProvider: $('#xAiProv').value, ollamaUrl: $('#xOlUrl').value, ollamaModel: $('#xOlModel').value, ...($('#xAnKey').value ? { anthropicKey: $('#xAnKey').value } : {}) });
  $('#xAiTest').onclick = async () => {
    await put({ aiProvider: $('#xAiProv').value, ollamaUrl: $('#xOlUrl').value, ollamaModel: $('#xOlModel').value, ...($('#xAnKey').value ? { anthropicKey: $('#xAnKey').value } : {}) });
    try { const r = await api('/api/admin/extras/test-ai', { body: {} }); toast(`Working — understood: ${r.understood.join(', ') || 'nothing special'}`, 5000); } catch (e) { toast(e.message, 5000); }
  };
  on('xTrailers', t => put({ cinemaTrailers: +t.value }));
  on('xMem', t => put({ memoriesNotify: t.checked }));
  on('xMemHour', t => put({ memoriesHour: +t.value }));
  on('xSs', t => {
    if (t.checked && !confirm('Space saver will replace video files in the writable media folders, overnight. Originals are kept for a few days. Turn it on?')) {
      t.checked = false;
      return;
    }
    put({ spaceSaver: t.checked });
  });
  on('xSsStart', t => put({ spaceSaverStart: +t.value }));
  on('xSsEnd', t => put({ spaceSaverEnd: +t.value }));
  on('xSsMin', t => put({ spaceSaverMinGb: +t.value }));
  on('xSsKeep', t => put({ spaceSaverKeepDays: +t.value }));
  $$('[data-ssq]').forEach(b => b.onclick = async () => { await api(`/api/admin/space-saver/queue/${b.dataset.ssq}`, { body: {} }); await api('/api/admin/space-saver/run', { body: {} }); toast('Shrinking now — this can take a while'); setTimeout(loadExtrasPanels, 1500); });
  $$('[data-ssr]').forEach(b => b.onclick = async () => { if (!confirmTwice(b, 'Put the original back?')) return; try { await api(`/api/admin/space-saver/restore/${b.dataset.ssr}`, { body: {} }); toast('Original restored'); loadExtrasPanels(); } catch (e) { toast(e.message); } });
  $('#xSsRun').onclick = async () => { await api('/api/admin/space-saver/run', { body: {} }); toast('Running now — even outside the night window'); setTimeout(loadExtrasPanels, 1500); };
  if ($('#xSsStop')) $('#xSsStop').onclick = async () => { await api('/api/admin/space-saver/stop', { body: {} }); toast('Stopped'); setTimeout(loadExtrasPanels, 1000); };
  $('#xShSave').onclick = () => put({ shareUrl: $('#xShUrl').value, shareQuality: $('#xShQ').value });
  $$('[data-tx]').forEach(b => b.onclick = async () => { if (!confirmTwice(b, 'Remove?')) return; await api(`/api/app-tokens/${b.dataset.tx}`, { method: 'DELETE' }); toast('Removed'); loadExtrasPanels(); });
  $$('[data-tn]').forEach(b => b.onclick = () => newAppKey(b.dataset.tn, profiles));
  on('xApk', async t => {
    const file = t.files[0]; if (!file) return;
    toast('Uploading…', 10000);
    const data = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(file); });
    try { const r = await api('/api/admin/app-upload', { body: { data } }); toast(`Version ${r.versionName} is ready for every device`, 4000); loadExtrasPanels(); } catch (e) { toast(e.message, 5000); }
  });
}

function newAppKey(kind, profiles) {
  const names = { familynest: 'FamilyNest', assistant: 'JARVIS', widget: 'Widget' };
  const m = modal(`<h2>${kind === 'familynest' ? 'Connect FamilyNest' : kind === 'assistant' ? 'Voice assistant key' : 'Widget key'}</h2>
    <p class="hint">${kind === 'familynest' ? 'FamilyNest uses this to show movie night voting. People vote under their own names, and anyone whose name matches a Marquee profile (like Zoey) gets that profile’s age limits.'
      : kind === 'assistant' ? 'Paste this into JARVIS (or a Siri Shortcut / Tasker) so it can say “play Bluey on the lounge TV”.'
      : 'The Marquee apps make widget keys for themselves — you only need this for something custom.'}</p>
    <div class="field"><label>Name</label><input class="input" id="akN" value="${names[kind]}" maxlength="60"></div>
    <div class="field"><label>Acts as</label><select class="select" id="akP">${profiles.map(p => `<option value="${p.id}" ${p.id === me.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>
    <div class="btn-row"><button class="btn primary" id="akGo">Create key</button></div><div id="akOut"></div>`);
  $('#akGo', m.el).onclick = async () => {
    try {
      const r = await api('/api/app-tokens', { body: { kind, name: $('#akN', m.el).value, profileId: +$('#akP', m.el).value } });
      $('#akGo', m.el).disabled = true;
      $('#akOut', m.el).innerHTML = `<div class="field" style="margin-top:14px"><label>Your key — copy it now, it won't be shown again</label><input class="input" readonly value="${esc(r.token)}"></div>
        <div class="field"><label>Server address</label><input class="input" readonly value="${esc(location.origin)}"></div>
        <div class="btn-row"><button class="btn small" id="akCopy">Copy key</button></div>`;
      $('#akCopy', m.el).onclick = () => navigator.clipboard?.writeText(r.token).then(() => toast('Copied'));
      loadExtrasPanels();
    } catch (e) { toast(e.message, 4000); }
  };
}
