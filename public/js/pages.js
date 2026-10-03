/* Marquee — main pages */
'use strict';

// ---------- setup & profiles ----------
ROUTES.setup = async () => {
  app.innerHTML = `<div class="who"><div class="logo">${LOGO}<span>Marquee</span></div>
    <h1>Welcome! Let's set up your server</h1>
    <form class="setup-card panel" id="f">
      <p class="hint">First, create your admin profile. You'll use it to manage libraries and family profiles. The PIN stops others from changing settings.</p>
      <div class="field"><label>Your name</label><input class="input" name="name" required maxlength="30" autocomplete="off" placeholder="e.g. Adam"></div>
      <div class="field"><label>Admin PIN (4–8 digits)</label><input class="input" name="pin" required inputmode="numeric" pattern="[0-9]{4,8}" type="password" autocomplete="new-password"></div>
      <button class="btn primary" style="width:100%">Create profile</button>
    </form></div>`;
  $('#f').onsubmit = async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api('/api/setup', { body: { name: fd.get('name'), pin: fd.get('pin') } });
      await refreshMe();
      go('#/settings');
    } catch (err) { toast(err.message); }
  };
};

ROUTES.who = async () => {
  MiniPlayer.stop();
  const profiles = await api('/api/profiles');
  if (!profiles.length) return go('#/setup', true);
  app.innerHTML = `<div class="who"><div class="logo">${LOGO}<span>${esc(me?.serverName || 'Marquee')}</span></div>
    <h1>Who's watching?</h1>
    <div class="who-grid">${profiles.map(p => `<button data-id="${p.id}">${avatar(p, 96, 24)}
      <span class="nm">${esc(p.name)}${p.hasPin ? ICON.lock : ''}</span></button>`).join('')}</div></div>`;
  $$('.who-grid button').forEach(b => b.onclick = () => {
    const p = profiles.find(x => x.id === +b.dataset.id);
    if (p.hasPin) pinPrompt(p); else login(p.id);
  });
};
async function login(profileId, pin) {
  await api('/api/login', { body: { profileId, pin }, allow401: true });
  try { window.MarqueeNative?.profileChanged?.(); } catch {} // the apps' widgets follow whoever is signed in
  await refreshMe();
  Devices.reconnect();
  go('#/');
}
function pinPrompt(p) {
  let pin = '';
  const m = modal(`<div style="text-align:center">${avatar(p, 64, 18).replace('class="avatar"', 'class="avatar" style="margin:0 auto"')}
    <h2 style="margin-top:12px">Enter ${esc(p.name)}'s PIN</h2><div class="pin-dots" id="dots"></div><p id="perr" class="hint" style="min-height:20px;margin-top:10px"></p>
    <div class="pinpad">${[1, 2, 3, 4, 5, 6, 7, 8, 9, '', 0, '⌫'].map(k => k === '' ? '<span></span>' : `<button data-k="${k}">${k}</button>`).join('')}</div>
    <button class="btn" id="pok" style="margin-top:18px;width:216px">Unlock</button></div>`);
  const draw = () => { $('#dots', m.el).innerHTML = Array.from({ length: Math.max(4, pin.length) }, (_, i) => `<i class="${i < pin.length ? 'on' : ''}"></i>`).join(''); };
  const submit = async () => {
    try { await login(p.id, pin); m.close(); }
    catch (e) { pin = ''; draw(); $('#perr', m.el).textContent = e.message; const d = $('#dots', m.el); d.classList.remove('shake'); void m.el.offsetWidth; d.classList.add('shake'); }
  };
  const press = k => { if (k === '⌫') pin = pin.slice(0, -1); else if (pin.length < 8) pin += k; draw(); };
  $$('.pinpad button', m.el).forEach(b => b.onclick = () => press(b.dataset.k));
  $('#pok', m.el).onclick = submit;
  const onKey = e => {
    if (!m.el.isConnected) return removeEventListener('keydown', onKey);
    if (/^\d$/.test(e.key)) press(e.key); else if (e.key === 'Backspace') press('⌫'); else if (e.key === 'Enter') submit();
  };
  addEventListener('keydown', onKey);
  draw();
}

// ---------- home ----------
function screenTimeBanner(st) {
  if (!st) return '';
  if (!st.ok) return `<div class="st-banner off">${ICON.moon}<div><b>${esc(st.message)}</b><span>${st.reason === 'bedtime' ? 'See you in the morning!' : 'Ask a grown-up for more time.'}</span></div></div>`;
  if (st.remaining != null) return `<div class="st-banner">${ICON.clock}<div><b>${fmtMins(st.remaining)} of watching left today</b></div></div>`;
  return '';
}

ROUTES[''] = async () => {
  shell('home', loading(), { transparent: !me.isKids });
  const d = await api('/api/home');
  const main = $('#main');
  if (me.isKids) return kidsHome(d, main);
  if (!d.counts.movies && !d.counts.shows && !d.counts.other) {
    main.innerHTML = `<div class="page">${emptyView(ICON.popcorn, d.scanning ? 'Scanning your media…' : d.libraries ? 'Nothing to show yet' : 'Add your media',
      d.scanning ? 'Movies and shows will appear here as they’re found. This page refreshes automatically.' :
        me.isAdmin ? (d.libraries ? 'Your libraries are empty, or nothing matches this profile’s rating limit. Check Settings.' : 'Point Marquee at your Movies and TV folders to get started.') :
        'Ask the admin to add libraries, or check this profile’s rating limit.',
      me.isAdmin ? '<a class="btn primary" href="#/settings">Open settings</a>' : '')}</div>`;
    if (d.scanning) { const t = setTimeout(() => route(), 4000); onLeave(() => clearTimeout(t)); }
    return;
  }
  const f = d.featured;
  main.innerHTML = `
    ${f.length ? `<section class="hero" id="hero">
      ${f.map((x, i) => `<div class="hero-slide ${i ? '' : 'on'}"><img src="${x.backdrop}" alt=""></div>`).join('')}
      <div class="hero-info" id="heroInfo"></div></section>` : '<div style="height:76px"></div>'}
    <div id="mnBanner"></div>
    ${row('Continue watching', d.continueWatching, 'wide')}
    ${row('Next up', d.nextUp, 'wide')}
    <div id="listenRows"></div>
    <div id="discoverTop"></div>
    ${row('My List', d.myList, 'posters', '#/my-list')}
    ${row('Recently added movies', d.recentMovies, 'posters', '#/movies?sort=added')}
    ${row('Recently added shows', d.recentShows, 'posters', '#/shows?sort=added')}
    ${row('Collections', d.collections, 'posters', '#/collections', c => collectionCard(c, `#/collection/${c.id}`))}
    ${row('Home videos', d.recentHome, 'wide', '#/home-videos')}
    <div id="discoverMore"></div>`;
  loadDiscovery();
  api('/api/movienight').then(list => {
    const a = list.find(x => !x.match);
    if (a && $('#mnBanner')) $('#mnBanner').innerHTML = `<a class="mn-banner" href="#/movienight/${a.code}">${ICON.popcorn}<div><b>${esc(a.host)} started a movie night</b><span>${esc(a.members.join(', '))} ${a.members.length === 1 ? 'is' : 'are'} voting — tap to join</span></div>${ICON.chevron}</a>`;
  }).catch(() => {});
  if (f.length) {
    let idx = 0, timer;
    const show = i => {
      idx = i;
      $$('.hero-slide').forEach((s, k) => s.classList.toggle('on', k === i));
      const x = f[i];
      $('#heroInfo').innerHTML = `<div class="hero-kicker">${x.type === 'show' ? 'Series' : 'Movie'} · From your library</div>
        <h1>${esc(x.title)}</h1>
        <div class="meta">${metaLine(x)}</div>
        <p>${esc(x.overview || '')}</p>
        <div class="btn-row"><a class="btn primary" href="#/item/${x.id}?play=1">${ICON.play} Play</a><a class="btn ghost" href="#/item/${x.id}">More info</a></div>
        ${f.length > 1 ? `<div class="hero-dots">${f.map((_, k) => `<button data-k="${k}" class="${k === i ? 'on' : ''}" aria-label="Slide ${k + 1}"></button>`).join('')}</div>` : ''}`;
      $$('.hero-dots button').forEach(b => b.onclick = () => { show(+b.dataset.k); restart(); });
    };
    const restart = () => { clearInterval(timer); timer = setInterval(() => show((idx + 1) % f.length), 8000); };
    show(0); restart();
    onLeave(() => clearInterval(timer));
  }
};

// Personal rows load after the page so it appears instantly
async function loadDiscovery() {
  const [disc, pods] = await Promise.all([
    api('/api/discover').catch(() => null),
    me.sections?.podcasts ? api('/api/podcasts').catch(() => null) : null,
  ]);
  const listen = $('#listenRows');
  if (listen) {
    listen.innerHTML =
      (pods?.latest?.length ? row('New podcast episodes', pods.latest.slice(0, 12), 'albums', '#/podcasts', e => `<a class="card" href="#/podcast/${e.podcast_id}">
        <div class="poster square">${e.image || e.podcast_image ? `<img src="${esc(e.image || e.podcast_image)}" alt="" loading="lazy">` : fallbackArt(e.podcast)}</div>
        <div class="cap">${esc(e.title)}</div><div class="sub">${esc(e.podcast)}</div></a>`) : '');
  }
  if (!disc) return;
  const top = $('#discoverTop'), more = $('#discoverMore');
  if (top && disc.onThisDay?.length) top.innerHTML = row('On this day', disc.onThisDay.slice(0, 12), 'wide', '#/memories', x => `<a class="card" href="${x.type === 'home' ? `#/play/${x.id}` : '#/photos'}">
    <div class="thumb">${x.thumb || x.still ? `<img src="${x.thumb || x.still}" alt="" loading="lazy">` : ''}${x.type === 'home' ? `<span class="play-ico">${ICON.play}</span>` : ''}</div>
    <div class="cap">${x.yearsAgo} year${x.yearsAgo === 1 ? '' : 's'} ago today</div><div class="sub">${esc(x.folder || fmtDate(x.takenAt))}</div></a>`);
  if (more) more.innerHTML = [...disc.because, ...disc.smart].map(r => row(r.title, r.items, 'posters', r.link)).join('');
}

function kidsHome(d, main) {
  const all = [...(d.allShows || []), ...(d.allMovies || [])];
  main.innerHTML = `<div class="page kids-page">
    <h1 class="kids-hello">Hi ${esc(me.name)}! 👋</h1>
    ${screenTimeBanner(d.screenTime)}
    ${d.continueWatching.length || d.nextUp.length ? `<h2 class="kids-h">Keep watching</h2><div class="kids-grid wide">${[...d.continueWatching, ...d.nextUp].slice(0, 6).map(wideCard).join('')}</div>` : ''}
    ${d.allShows?.length ? `<h2 class="kids-h">Shows</h2><div class="kids-grid">${d.allShows.map(posterCard).join('')}</div>` : ''}
    ${d.allMovies?.length ? `<h2 class="kids-h">Movies</h2><div class="kids-grid">${d.allMovies.map(posterCard).join('')}</div>` : ''}
    ${d.recentHome?.length ? `<h2 class="kids-h">Family videos</h2><div class="kids-grid wide">${d.recentHome.map(wideCard).join('')}</div>` : ''}
    ${!all.length && !d.recentHome?.length ? emptyView(ICON.popcorn, 'Nothing here yet', 'Ask a grown-up to add some shows for you.') : ''}
  </div>`;
}

// ---------- browse grids ----------
function metaLine(x) {
  return [x.year, x.certification && `<span class="cert">${esc(x.certification)}</span>`,
    x.type === 'movie' ? fmtRuntime(x.runtime || Math.round((x.duration || 0) / 60)) : x.seasons ? `${x.seasons.filter(s => s.season !== 0).length || 1} season${(x.seasons.filter(s => s.season !== 0).length || 1) === 1 ? '' : 's'}` : '',
    x.vote ? `<span class="star">★</span> ${x.vote.toFixed(1)}` : '',
    x.video && x.video.height ? `${x.video.height >= 2000 ? '4K' : x.video.height >= 1000 ? 'HD' : x.video.height >= 700 ? '720p' : 'SD'}` : '',
  ].filter(Boolean).join('<span class="sep"></span>');
}

async function pageLibrary(kind) {
  const ps = params();
  const sort = ps.get('sort') || store.get(`mq_sort_${kind}`, 'title');
  const genre = ps.get('genre') || '';
  const unwatched = ps.get('unwatched') === '1';
  const title = kind === 'movies' ? 'Movies' : 'TV Shows';
  shell(kind, `<div class="page"><h1 class="page-title">${title}</h1>${loading()}</div>`);
  const qs = new URLSearchParams({ sort, ...(genre && { genre }), ...(unwatched && { unwatched: '1' }) });
  const [items, genres] = await Promise.all([api(`/api/${kind}?${qs}`), api(`/api/genres?type=${kind === 'movies' ? 'movie' : 'show'}`)]);
  const link = p => `#/${kind}?${new URLSearchParams(Object.fromEntries(Object.entries({ sort, genre, unwatched: unwatched ? '1' : '', ...p }).filter(([, v]) => v)))}`;
  $('#main').innerHTML = `<div class="page"><h1 class="page-title">${title}</h1>
    ${genres.length ? `<div class="chips"><a class="chip ${!genre ? 'on' : ''}" href="${link({ genre: '' })}">All</a>
      ${genres.map(g => `<a class="chip ${genre === g.name ? 'on' : ''}" href="${link({ genre: g.name })}">${esc(g.name)}</a>`).join('')}</div>` : ''}
    <div class="toolbar">
      <select class="select" id="sort">${[['title', 'A–Z'], ['added', 'Recently added'], ['year', 'Release year'], ['rating', 'Top rated']].map(([k, l]) => `<option value="${k}" ${k === sort ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <a class="chip ${unwatched ? 'on' : ''}" href="${link({ unwatched: unwatched ? '' : '1' })}">Unwatched</a>
      <span class="count">${items.length} ${kind === 'movies' ? (items.length === 1 ? 'movie' : 'movies') : (items.length === 1 ? 'show' : 'shows')}</span>
    </div>
    ${items.length ? `<div class="grid" id="libGrid"></div>` : emptyView('', 'Nothing here', genre || unwatched ? 'Try clearing the filters.' : 'No titles found for this profile yet.')}
  </div>`;
  growGrid($('#libGrid'), items, posterCard);
  $('#sort').onchange = e => { store.set(`mq_sort_${kind}`, e.target.value); go(link({ sort: e.target.value }), true); };
}
ROUTES.movies = () => pageLibrary('movies');
ROUTES.shows = () => pageLibrary('shows');

// ---------- details ----------
ROUTES.item = async id => {
  shell('', loading(), { transparent: true });
  const ps = params();
  let x = await api(`/api/items/${id}`);
  if (x.type === 'episode') return go(`#/item/${x.parentId}`, true);
  if (x.type === 'home') return go(`#/play/${x.id}`, true);
  if (ps.get('play') === '1') {
    const target = x.type === 'show' ? x.nextEpisode?.id : x.id;
    history.replaceState(null, '', `#/item/${id}`);
    if (target) return go(`#/play/${target}`);
  }
  let current = null;
  const reload = async () => { x = await api(`/api/items/${x.id}`); render(); };
  const render = () => {
    const resumeAt = x.type === 'movie' && x.progress && !x.progress.watched && x.progress.position > 30 ? x.progress.position : 0;
    const ne = x.nextEpisode;
    const neResume = ne?.progress && !ne.progress.watched && ne.progress.position > 30;
    const playBtn = x.type === 'movie'
      ? `<a class="btn primary" href="#/play/${x.id}">${ICON.play} ${resumeAt ? `Resume ${fmtTime(resumeAt)}` : 'Play'}</a>${resumeAt ? `<a class="btn ghost" href="#/play/${x.id}?t=0">Start over</a>` : ''}`
      : ne ? `<a class="btn primary" href="#/play/${ne.id}">${ICON.play} ${neResume ? 'Resume' : 'Play'} ${ne.season ? `S${ne.season} E${ne.episode}` : ''}</a>` : '';
    const watched = x.type === 'movie' ? x.progress?.watched : x.unwatched === 0;
    const dl = (x.downloads || []).find(v => v.status === 'ready');
    $('#main').innerHTML = `
      <section class="detail-hero ${x.backdrop ? '' : 'nobg'}">
        <div class="bg">${x.backdrop ? `<img src="${x.backdrop}" alt="">` : `<div style="position:absolute;inset:0;background:linear-gradient(160deg,hsl(${hue(x.title)} 35% 22%),var(--bg))"></div>`}</div>
        <div class="detail-head">
          <div class="poster">${x.poster ? `<img src="${x.poster}" alt="">` : fallbackArt(x.title, x.year)}</div>
          <div style="min-width:0">
            <h1>${esc(x.title)}</h1>
            ${x.tagline ? `<p class="tagline">${esc(x.tagline)}</p>` : ''}
            <div class="meta">${metaLine(x)}${x.edition ? `<span class="sep"></span><span class="cert">${esc(x.edition)}</span>` : ''}</div>
            ${starRating(x.myRating)}
            <div class="btn-row">${playBtn}
              ${x.trailer ? `<button class="btn ghost" id="trailerBtn">Trailer</button>` : ''}
              <button class="btn ghost round" id="listBtn" title="${x.inList ? 'Remove from My List' : 'Add to My List'}" style="${x.inList ? 'color:var(--accent)' : ''}">${x.inList ? ICON.bookmarkOn : ICON.bookmark}</button>
              <button class="btn ghost round" id="watchedBtn" title="${watched ? 'Mark unwatched' : 'Mark watched'}" style="${watched ? 'color:var(--accent)' : ''}">${ICON.check}</button>
              <button class="btn ghost round" id="moreBtn" title="More">⋯</button>
            </div>
          </div>
        </div>
      </section>
      <div class="detail-body">
        ${x.genres?.length ? `<div class="genres">${x.genres.map(g => `<a href="#/${x.type === 'show' ? 'shows' : 'movies'}?genre=${encodeURIComponent(g)}">${esc(g)}</a>`).join('')}</div>` : ''}
        ${x.overview ? `<p class="overview">${esc(x.overview)}</p>` : `<p class="overview" style="color:var(--muted)">No description yet.${me.isAdmin && !x.tmdbId ? ' Add a TMDB key in Settings to fetch posters and info.' : ''}</p>`}
        ${x.collection ? `<a class="coll-link" href="#/collection/${x.collection.id}">${ICON.stack}<span>Part of <b>${esc(x.collection.name)}</b> · ${x.collection.count} films</span>${ICON.chevron}</a>` : ''}
        ${x.type === 'movie' && x.video ? `<div class="facts"><b>File</b><span>${esc(x.video.width)}×${esc(x.video.height)} · ${esc((x.video.codec || '').toUpperCase())} · ${esc((x.video.audio || '').toUpperCase())} · ${fmtBytes(x.video.size)}</span>
          ${x.versions ? `<b>Copies</b><span>${x.versions.map(v => `<a href="#/item/${v.id}" style="${v.id === x.id ? 'color:var(--text)' : 'color:var(--accent)'}">${esc(v.label)}</a>`).join(' · ')}</span>` : ''}
          ${dl ? `<b>Ready offline</b><span>${esc(dl.quality)}p copy prepared (${fmtBytes(dl.size)})</span>` : ''}</div>` : ''}
      </div>
      ${x.type === 'show' ? `<div class="seasons" id="seasons"></div><div class="episodes" id="episodes"></div>` : ''}
      ${row('Cast & crew', x.cast, 'people')}
      ${x.more?.length ? row('More like this', x.more) : ''}`;
    $('#watchedBtn').onclick = async () => {
      await api(`/api/items/${x.id}/watched`, { body: { watched: !watched } });
      toast(watched ? 'Marked as unwatched' : 'Marked as watched');
      reload();
    };
    $('#listBtn').onclick = async () => {
      await api(`/api/watchlist/${x.id}`, { method: x.inList ? 'DELETE' : 'POST' });
      toast(x.inList ? 'Removed from My List' : 'Added to My List');
      reload();
    };
    if ($('#trailerBtn')) $('#trailerBtn').onclick = () => trailer(x);
    bindStars(x, reload);
    // More than one copy/edition: let them choose before playing
    if (x.versions?.length > 1) {
      const pb = $('.detail-head .btn.primary');
      if (pb) pb.onclick = e => {
        e.preventDefault();
        const resume = pb.getAttribute('href');
        const m = modal(`<h2>Which version?</h2><div class="menu-list">${x.versions.map(v => `<button data-v="${v.id}">${ICON.film}<span>${esc(v.label)}<small>${esc(v.file)}</small></span>${v.id === x.id ? ICON.check : ''}</button>`).join('')}</div>`);
        $$('[data-v]', m.el).forEach(b => b.onclick = () => { m.close(); go(+b.dataset.v === x.id ? resume : `#/play/${b.dataset.v}`); });
      };
    }
    $('#moreBtn').onclick = () => itemMenu(x, reload);
    if (x.type === 'show') renderSeasons();
    if (x.theme && !themeStarted) { themeStarted = true; ThemeMusic.start(x); }
  };
  let themeStarted = false;
  const renderSeasons = () => {
    if (!x.seasons.length) return;
    if (current == null || !x.seasons.find(s => s.season === current)) current = (x.nextEpisode && x.nextEpisode.season) ?? x.seasons[0].season;
    $('#seasons').innerHTML = x.seasons.map(s => `<button class="chip ${s.season === current ? 'on' : ''}" data-s="${s.season}">${esc(s.title)}</button>`).join('') +
      `<button class="chip" id="seasonWatched">Mark season watched</button>` +
      `<button class="chip ${Downloads.smartFor(x.id) ? 'on' : ''}" id="smartDl">${ICON.download} ${Downloads.smartFor(x.id) ? `Keeping next ${Downloads.smartFor(x.id).count} downloaded` : 'Auto-download'}</button>`;
    const season = x.seasons.find(s => s.season === current);
    $('#episodes').innerHTML = season.episodes.map(e => {
      const pct = e.progress && !e.progress.watched && e.progress.duration ? e.progress.position / e.progress.duration * 100 : 0;
      const img = e.still || x.backdrop;
      const saved = Downloads.isSaved(e.id);
      return `<div class="ep">
        <a class="thumb" href="#/play/${e.id}">${img ? `<img src="${img}" alt="" loading="lazy">` : fallbackArt(e.title)}<span class="play-ico">${ICON.play}</span>${pct ? `<div class="bar"><i style="width:${pct}%"></i></div>` : ''}</a>
        <a class="ep-text" href="#/play/${e.id}"><div class="ep-meta">${e.episode != null ? `Episode ${e.episode}` : 'Extra'}${e.duration ? ` · ${Math.round(e.duration / 60)}m` : ''}${e.airDate ? ` · ${fmtDate(e.airDate)}` : ''}${saved ? ' · <span style="color:var(--accent)">Downloaded</span>' : ''}</div>
          <h3>${esc(e.title)}</h3>${e.overview ? `<p>${esc(e.overview)}</p>` : ''}</a>
        <div class="ep-actions"><button class="check dl" data-dl="${e.id}" aria-label="Download">${ICON.download}</button>
        <button class="check ${e.progress?.watched ? 'on' : ''}" data-id="${e.id}" aria-label="Toggle watched">${ICON.check}</button></div>
      </div>`;
    }).join('');
    $$('#seasons [data-s]').forEach(b => b.onclick = () => { current = +b.dataset.s; renderSeasons(); });
    $('#smartDl').onclick = () => Downloads.smartSetup(x, renderSeasons);
    $('#seasonWatched').onclick = async () => {
      const all = season.episodes.every(e => e.progress?.watched);
      await api(`/api/items/${x.id}/watched`, { body: { watched: !all, season: current } });
      reload();
    };
    $$('#episodes [data-id]').forEach(b => b.onclick = async () => {
      const on = b.classList.contains('on');
      await api(`/api/items/${b.dataset.id}/watched`, { body: { watched: !on } });
      reload();
    });
    $$('#episodes [data-dl]').forEach(b => b.onclick = () => {
      const e = season.episodes.find(z => z.id === +b.dataset.dl);
      Downloads.start({ ...e, show: { id: x.id, title: x.title, poster: x.poster } });
    });
  };
  render();
};

// ★★★★★ with half stars (stored 1–10)
function starRating(v) {
  return `<div class="stars" id="stars" title="Your rating">${[1, 2, 3, 4, 5].map(i => `<button data-r="${i * 2}" class="${v >= i * 2 ? 'full' : v === i * 2 - 1 ? 'half' : ''}" aria-label="${i} stars">★</button>`).join('')}${v ? '<button class="clear" data-r="0" aria-label="Clear rating">×</button>' : ''}</div>`;
}
function bindStars(x, reload) {
  $$('#stars [data-r]').forEach(b => b.onclick = async e => {
    let r = +b.dataset.r;
    const rect = b.getBoundingClientRect();
    if (r && e.clientX && e.clientX < rect.left + rect.width / 2) r -= 1; // left half = half star
    await api(`/api/ratings/${x.id}`, { body: { rating: r } });
    toast(r ? `Rated ${r / 2} star${r === 2 ? '' : 's'}` : 'Rating cleared');
    reload();
  });
}

function editDetails(x, reload) {
  const m = modal(`<h2>Edit details</h2><p class="hint">Changes are kept even when info is refreshed from the internet.</p>
    <div class="field"><label>Title</label><input class="input" id="et" value="${esc(x.title)}"></div>
    <div class="two"><div class="field"><label>Year</label><input class="input" id="ey" inputmode="numeric" value="${esc(x.year || '')}"></div>
      <div class="field"><label>Age rating</label><input class="input" id="ec" value="${esc(x.certification || '')}" placeholder="G, PG, M, MA15+…"></div></div>
    ${x.type === 'movie' ? `<div class="field"><label>Edition</label><input class="input" id="ee" value="${esc(x.edition || '')}" placeholder="e.g. Director's Cut"></div>` : ''}
    <div class="field"><label>Genres (comma separated)</label><input class="input" id="eg" value="${esc((x.genres || []).join(', '))}"></div>
    <div class="field"><label>Tagline</label><input class="input" id="etl" value="${esc(x.tagline || '')}"></div>
    <div class="field"><label>Description</label><textarea class="input" id="eo" rows="5">${esc(x.overview || '')}</textarea></div>
    <div class="btn-row"><button class="btn primary" id="es">Save</button><button class="btn" id="eu">Undo my edits</button></div>`);
  $('#es', m.el).onclick = async () => {
    const body = { title: $('#et', m.el).value, year: $('#ey', m.el).value, certification: $('#ec', m.el).value, genres: $('#eg', m.el).value, tagline: $('#etl', m.el).value, overview: $('#eo', m.el).value };
    if ($('#ee', m.el)) body.edition = $('#ee', m.el).value;
    await api(`/api/admin/items/${x.id}`, { method: 'PATCH', body }); m.close(); toast('Saved'); reload();
  };
  $('#eu', m.el).onclick = async () => { await api(`/api/admin/items/${x.id}`, { method: 'PATCH', body: { unlock: true } }); m.close(); toast('Refreshing from the internet…'); setTimeout(reload, 3000); };
}

async function chooseArt(x, reload) {
  const m = modal(`<h2>Choose artwork</h2><div class="chips" style="margin:0 0 12px"><button class="chip on" data-k="poster">Posters</button><button class="chip" data-k="backdrop">Backgrounds</button>
    <label class="chip">Upload my own…<input type="file" accept="image/*" id="upl" hidden></label></div><div id="artg" class="art-grid">${loading()}</div>`, { wide: false });
  let kind = 'poster', data = null;
  const draw = () => {
    const list = data ? (kind === 'poster' ? data.posters : data.backdrops) : [];
    $('#artg', m.el).className = 'art-grid ' + kind;
    $('#artg', m.el).innerHTML = list.length ? list.map((a, i) => `<button data-a="${i}"><img src="${a.preview}" alt="" loading="lazy"></button>`).join('') : '<p class="hint">Nothing found.</p>';
    $$('[data-a]', m.el).forEach(b => b.onclick = async () => {
      await api(`/api/admin/items/${x.id}/image`, { body: { kind, path: list[+b.dataset.a].path } }); m.close(); toast('Artwork updated'); reload();
    });
  };
  $$('[data-k]', m.el).forEach(b => b.onclick = () => { kind = b.dataset.k; $$('[data-k]', m.el).forEach(c => c.classList.toggle('on', c === b)); draw(); });
  $('#upl', m.el).onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    const dataUrl = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(f); });
    try { await api(`/api/admin/items/${x.id}/image`, { body: { kind, dataUrl } }); m.close(); toast('Artwork updated'); reload(); } catch (err) { toast(err.message); }
  };
  try { data = await api(`/api/admin/items/${x.id}/images`); draw(); } catch (e) { $('#artg', m.el).innerHTML = `<p class="hint">${esc(e.message)} You can still upload your own picture.</p>`; }
}

function trailer(x) {
  modal(`<div class="trailer"><iframe src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(x.trailer)}?autoplay=1&rel=0" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe></div>`, { wide: true });
}

function itemMenu(x, reload) {
  const canDl = x.type === 'movie';
  const m = modal(`<h2>${esc(x.title)}</h2><div class="menu-list">
    ${canDl ? `<button data-a="download">${ICON.download}<span>Download for offline</span></button>` : ''}
    <button data-a="list">${ICON.stack}<span>Add to a family list…</span></button>
    <button data-a="party">${ICON.users}<span>Start a watch party</span></button>
    <button data-a="send">${ICON.cast}<span>Play on another device…</span></button>
    ${!me.isKids && !me.guest && x.type !== 'show' || (!me.isKids && !me.guest && x.nextEpisode) ? `<button data-a="share">${ICON.share}<span>Share a link with someone…</span></button>
    <button data-a="aisubs">${ICON.pulse}<span>Subtitles made by AI…</span></button>` : ''}
    ${me.isAdmin ? `<button data-a="edit">${ICON.settings}<span>Edit details</span></button>
    ${['movie', 'show'].includes(x.type) ? `<button data-a="art">${ICON.photo}<span>Choose poster & background</span></button>` : ''}
    <button data-a="fix">${ICON.refresh}<span>Fix match / refresh info</span></button>
    ${['movie', 'show'].includes(x.type) ? `<button data-a="theme">${ICON.music}<span>${x.theme ? 'Change theme song' : 'Add a theme song'}</span></button>` : ''}
    ${x.type !== 'show' ? `<button data-a="prep">${ICON.pulse}<span>Prepare phone-friendly copy</span></button>` : `<button data-a="prep">${ICON.pulse}<span>Prepare phone-friendly copies of every episode</span></button>`}` : ''}
  </div>`);
  $$('[data-a]', m.el).forEach(b => b.onclick = async () => {
    m.close();
    const a = b.dataset.a;
    if (a === 'download') Downloads.start(x);
    if (a === 'list') addToList(x, reload);
    if (a === 'fix') fixMatch(x);
    if (a === 'edit') editDetails(x, reload);
    if (a === 'art') chooseArt(x, reload);
    if (a === 'share') shareItem(x);
    if (a === 'aisubs') aiSubsMenu(x, reload);
    if (a === 'theme') uploadTheme(x, reload);
    if (a === 'send') {
      const target = x.type === 'show' ? x.nextEpisode : x;
      if (!target) return toast('Nothing to play yet');
      Devices.pick(`Play ${x.title} on…`, async dev => {
        await api(`/api/devices/${dev.clientId}/command`, { body: { type: 'open', itemId: target.id, position: target.progress && !target.progress.watched ? target.progress.position : 0 } });
        toast(`Playing on ${dev.name}`);
      });
    }
    if (a === 'party') {
      const target = x.type === 'show' ? x.nextEpisode?.id : x.id;
      if (!target) return toast('Nothing to play yet');
      const { code } = await api('/api/rooms', { body: { itemId: target } });
      go(`#/play/${target}?room=${code}&host=1`);
    }
    if (a === 'prep') {
      try { const r = await api('/api/admin/versions', { body: { itemId: x.id, quality: '720' } }); toast(`${r.queued} copy${r.queued === 1 ? '' : ' copies'} queued — see Settings → Prepared copies`); }
      catch (e) { toast(e.message); }
    }
  });
}

async function addToList(x, reload) {
  const lists = await api('/api/lists');
  const m = modal(`<h2>Add to a list</h2>
    <div class="menu-list">${lists.map(l => `<button data-l="${l.id}">${ICON.stack}<span>${esc(l.name)} <small>${l.count} · ${l.shared ? 'family' : 'just me'}</small></span>${(x.lists || []).includes(l.id) ? ICON.check : ''}</button>`).join('') || '<p class="hint">No lists yet — make the first one.</p>'}</div>
    <form id="nl" class="btn-row" style="flex-wrap:nowrap;margin-top:12px"><input class="input" name="n" placeholder="New list, e.g. Friday movie night" maxlength="60"><button class="btn primary">Create</button></form>`);
  $$('[data-l]', m.el).forEach(b => b.onclick = async () => {
    const inIt = (x.lists || []).includes(+b.dataset.l);
    await api(inIt ? `/api/lists/${b.dataset.l}/items/${x.id}` : `/api/lists/${b.dataset.l}/items`, inIt ? { method: 'DELETE' } : { body: { itemId: x.id } });
    m.close(); toast(inIt ? 'Removed from list' : 'Added to list'); reload && reload();
  });
  $('#nl', m.el).onsubmit = async e => {
    e.preventDefault();
    const n = new FormData(e.target).get('n').trim();
    if (!n) return;
    await api('/api/lists', { body: { name: n, itemId: x.id } });
    m.close(); toast(`Added to “${n}”`); reload && reload();
  };
}

function fixMatch(x) {
  const m = modal(`<h2>Fix match</h2><p class="hint">Search The Movie Database and pick the right ${x.type === 'show' ? 'show' : 'movie'}.</p>
    <form id="mf" class="btn-row" style="margin-bottom:12px;flex-wrap:nowrap"><input class="input" name="q" value="${esc(x.title)}"><button class="btn primary">Search</button></form>
    <div class="match-list" id="ml"></div>
    <div class="btn-row" style="margin-top:14px"><button class="btn small" id="refreshOne">${ICON.refresh} Just refresh info</button></div>`);
  const search = async q => {
    $('#ml', m.el).innerHTML = '<div class="center" style="min-height:120px"><div class="spinner"></div></div>';
    try {
      const res = await api(`/api/admin/match/${x.id}?q=${encodeURIComponent(q)}`);
      $('#ml', m.el).innerHTML = res.length ? res.map(r => `<button data-id="${r.tmdb_id}">${r.poster ? `<img src="${r.poster}" alt="">` : '<span class="noimg"></span>'}
        <span><b>${esc(r.title)}</b> <span style="color:var(--muted)">${esc(r.year)}</span><p>${esc(r.overview)}</p></span></button>`).join('') : '<p class="hint">No results.</p>';
      $$('#ml button', m.el).forEach(b => b.onclick = async () => {
        b.disabled = true;
        try { await api(`/api/admin/match/${x.id}`, { body: { tmdbId: +b.dataset.id } }); m.close(); toast('Updated'); route(); }
        catch (e) { toast(e.message); b.disabled = false; }
      });
    } catch (e) { $('#ml', m.el).innerHTML = `<p class="hint">${esc(e.message)}</p>`; }
  };
  $('#mf', m.el).onsubmit = e => { e.preventDefault(); search(new FormData(e.target).get('q')); };
  $('#refreshOne', m.el).onclick = async () => { await api('/api/admin/refresh', { body: { itemId: x.id } }); m.close(); toast('Refreshing — check back in a moment'); };
  search(x.title);
}

// ---------- My List, collections, lists, people ----------
ROUTES['my-list'] = async () => {
  shell('mylist', `<div class="page"><h1 class="page-title">My List</h1>${loading()}</div>`);
  const items = await api('/api/watchlist');
  $('#main').innerHTML = `<div class="page"><h1 class="page-title">My List</h1>
    ${items.length ? `<div class="grid">${items.map(posterCard).join('')}</div>` : emptyView(ICON.bookmark, 'Your list is empty', 'Tap the bookmark on any movie or show to save it here for later.')}</div>`;
};

ROUTES.collections = async () => {
  shell('collections', `<div class="page"><h1 class="page-title">Collections</h1>${loading()}</div>`);
  const d = await api('/api/collections');
  $('#main').innerHTML = `<div class="page"><h1 class="page-title">Collections</h1>
    <div class="section-head"><h2>Family lists</h2><button class="btn small" id="newList">${ICON.plus} New list</button></div>
    ${d.lists.length ? `<div class="grid">${d.lists.map(l => collectionCard(l, `#/list/${l.id}`)).join('')}</div>` : '<p class="hint">Make lists like “Friday movie night” or “Zoey’s favourites” — tap ⋯ on any title to add it.</p>'}
    <div class="section-head" style="margin-top:30px"><h2>Movie collections</h2></div>
    ${d.collections.length ? `<div class="grid">${d.collections.map(c => collectionCard(c, `#/collection/${c.id}`)).join('')}</div>` : '<p class="hint">Film series (like Toy Story or Harry Potter) appear here automatically when you have two or more of them.</p>'}
  </div>`;
  $('#newList').onclick = () => {
    const m = modal(`<h2>New list</h2><form id="nl"><div class="field"><label>Name</label><input class="input" name="n" maxlength="60" placeholder="e.g. Friday movie night"></div>
      <label style="display:flex;gap:10px;align-items:center;margin-bottom:16px;color:var(--muted)"><input type="checkbox" name="s" checked> Share with the whole family</label>
      <button class="btn primary" style="width:100%">Create</button></form>`);
    $('#nl', m.el).onsubmit = async e => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const r = await api('/api/lists', { body: { name: fd.get('n'), shared: !!fd.get('s') } });
      m.close(); go(`#/list/${r.id}`);
    };
  };
};

ROUTES.collection = async id => {
  shell('collections', loading(), { transparent: true });
  const c = await api(`/api/collections/${id}`);
  $('#main').innerHTML = `<section class="detail-hero ${c.backdrop ? '' : 'nobg'}"><div class="bg">${c.backdrop ? `<img src="${c.backdrop}" alt="">` : ''}</div>
    <div class="detail-head"><div class="poster">${c.poster ? `<img src="${c.poster}" alt="">` : fallbackArt(c.name)}</div>
    <div><div class="hero-kicker">Collection</div><h1>${esc(c.name)}</h1><div class="meta">${c.items.length} films in your library</div>
    ${c.items[0] ? `<div class="btn-row"><a class="btn primary" href="#/play/${(c.items.find(i => !i.progress?.watched) || c.items[0]).id}">${ICON.play} Play ${esc((c.items.find(i => !i.progress?.watched) || c.items[0]).title)}</a></div>` : ''}</div></div></section>
    <div class="page" style="padding-top:20px"><div class="grid">${c.items.map(posterCard).join('')}</div></div>`;
};

ROUTES.list = async id => {
  shell('collections', `<div class="page">${loading()}</div>`);
  const draw = async () => {
    const l = await api(`/api/lists/${id}`);
    $('#main').innerHTML = `<div class="page"><div class="hero-kicker">${l.shared ? 'Family list' : 'Private list'} · by ${esc(l.owner)}</div>
      <h1 class="page-title">${esc(l.name)}</h1>
      ${l.mine ? `<div class="btn-row" style="margin-bottom:18px"><button class="btn small" id="ren">Rename</button><button class="btn small" id="shr">${l.shared ? 'Make private' : 'Share with family'}</button><button class="btn small danger" id="del">Delete list</button></div>` : ''}
      ${l.items.length ? `<div class="grid">${l.items.map(i => `<div class="list-cell">${posterCard(i)}<button class="rm" data-rm="${i.id}" aria-label="Remove">${ICON.x}</button></div>`).join('')}</div>`
        : emptyView(ICON.stack, 'Nothing in this list yet', 'Open any movie or show, tap ⋯ and choose “Add to a family list”.')}</div>`;
    $$('[data-rm]').forEach(b => b.onclick = async () => { await api(`/api/lists/${id}/items/${b.dataset.rm}`, { method: 'DELETE' }); draw(); });
    if (l.mine) {
      $('#ren').onclick = async () => { const n = prompt('List name', l.name); if (n) { await api(`/api/lists/${id}`, { method: 'PATCH', body: { name: n } }); draw(); } };
      $('#shr').onclick = async () => { await api(`/api/lists/${id}`, { method: 'PATCH', body: { shared: !l.shared } }); draw(); };
      $('#del').onclick = async e => { if (!confirmTwice(e.target, 'Tap again to delete')) return; await api(`/api/lists/${id}`, { method: 'DELETE' }); go('#/collections', true); };
    }
  };
  await draw();
};

ROUTES.person = async id => {
  shell('', `<div class="page">${loading()}</div>`);
  const p = await api(`/api/people/${id}`);
  $('#main').innerHTML = `<div class="page"><div class="person-head"><div class="face big">${p.photo ? `<img src="${p.photo}" alt="">` : `<span>${esc(p.name[0])}</span>`}</div>
    <div><h1 class="page-title" style="margin:0">${esc(p.name)}</h1><p class="hint">${p.items.length} title${p.items.length === 1 ? '' : 's'} in your library</p></div></div>
    <div class="grid">${p.items.map(posterCard).join('')}</div></div>`;
};

// ---------- search ----------
ROUTES.search = async () => {
  const q0 = store.get('mq_lastq', '');
  shell('search', `<div class="page"><div class="search-box">${ICON.search}<input class="input" id="q" type="search" placeholder="Search, or describe it: “funny movies under 90 minutes”" value="${esc(q0)}" autocomplete="off"></div><div id="results"></div></div>`);
  const input = $('#q');
  let t, seq = 0;
  const section = (title, html, cols) => html ? `<h2 class="search-h">${title}</h2><div class="grid" ${cols ? `style="grid-template-columns:${cols}"` : ''}>${html}</div>` : '';
  const run = async () => {
    const q = input.value.trim();
    store.set('mq_lastq', q);
    const mine = ++seq;
    if (!q) { $('#results').innerHTML = emptyView(ICON.search, '', 'Search your whole library — titles, actors, songs and home videos.'); return; }
    const natural = q.split(/\s+/).length >= 2;
    const [r, smart] = await Promise.all([api(`/api/search?q=${encodeURIComponent(q)}`), natural ? smartResults(q) : '']);
    if (mine !== seq) return;
    const any = Object.values(r).some(v => v.length);
    $('#results').innerHTML = smart + (!any ? (smart ? '' : emptyView('', 'No matches', `Nothing called “${esc(q)}” in your library. Try describing it — “funny movies under 90 minutes”.`)) :
      section('Movies', r.movies.map(posterCard).join('')) + section('TV Shows', r.shows.map(posterCard).join('')) +
      section('People', r.people.map(personCard).join('')) +
      section('Episodes', r.episodes.map(wideCard).join(''), 'repeat(auto-fill,minmax(220px,1fr))') +
      section('Albums', r.albums.map(albumCard).join('')) +
      (r.tracks.length ? `<h2 class="search-h">Songs</h2>${trackList(r.tracks, { showAlbum: true })}` : '') +
      section('Home videos', r.home.map(wideCard).join(''), 'repeat(auto-fill,minmax(220px,1fr))') +
      section('Podcasts', (r.podcasts || []).map(p => `<a class="card" href="#/podcast/${p.id}"><div class="poster square">${p.image ? `<img src="${esc(p.image)}" alt="">` : fallbackArt(p.title)}</div><div class="cap">${esc(p.title)}</div><div class="sub">${esc(p.author || '')}</div></a>`).join('')));
    bindTrackList($('#results'), r.tracks);
  };
  input.oninput = () => { clearTimeout(t); t = setTimeout(run, 220); };
  run();
  if (!matchMedia('(pointer:coarse)').matches || !q0) input.focus();
};

// ---------- notifications ----------
ROUTES.notifications = async () => {
  shell('', `<div class="page"><h1 class="page-title">What's new</h1>${loading()}</div>`);
  const list = await api('/api/notifications');
  store.set('mq_seen_notes', Date.now());
  if (me) me.unread = 0;
  $('#main').innerHTML = `<div class="page settings"><h1 class="page-title">What's new</h1>
    ${list.length ? list.map(n => `<div class="note">
      <div class="note-head"><b>${esc(n.body)}</b><span>${ago(n.at)}</span></div>
      ${n.items.length ? `<div class="scroller posters" style="padding-left:0;padding-right:0">${n.items.map(posterCard).join('')}</div>` : ''}</div>`).join('')
      : emptyView(ICON.bell, 'Nothing new yet', 'When new movies, episodes or family videos arrive, they’ll show up here.')}
    <p class="hint" style="margin-top:20px">Want a notification on your phone? Turn it on in <a href="#/settings">Settings</a>.</p></div>`;
};

// ---------- more ----------
ROUTES.ask = async () => { go('#/more', true); setTimeout(askMarquee, 200); };
ROUTES.more = async () => {
  const s = me.sections || {};
  const tiles = [
    ['#/my-list', ICON.bookmark, 'My List'], ['#/collections', ICON.stack, 'Collections'],
    s.requests && ['#/requests', ICON.plus, 'Request a movie or show'],
    s.music && ['#/music', ICON.music, 'Music'], s.podcasts && ['#/podcasts', ICON.bell, 'Podcasts'],
    s.photos && ['#/photos', ICON.photo, 'Photos'], s.home && ['#/home-videos', ICON.camera, 'Home Videos'],
    ['#/movienight', ICON.popcorn, 'Movie night'], s.photos && ['#/memories', ICON.photo, 'Memories'],
    ['#/downloads', ICON.download, 'Downloads'], ['#/remote', ICON.cast, 'Remote control'], ['#/party', ICON.users, 'Join a watch party'],
    ['#/ask', ICON.search, 'Ask Marquee'], !me.guest && ['#/shares', ICON.share, 'Shared links'],
    ['#/wrapped', ICON.star || ICON.pulse, 'Your year'], ['#/notifications', ICON.bell, "What's new"],
    me.isAdmin && ['#/activity', ICON.pulse, 'Activity'], ['#/settings', ICON.settings, 'Settings'],
  ].filter(Boolean)
    // Kids profiles can't open these, so don't show them (they used to bounce back to Home with no explanation)
    .filter(([h]) => !me.isKids || !KIDS_BLOCKED.includes(h.slice(2)));
  if (me.isKids) tiles.push(['#/who', ICON.users, 'Switch profile']);
  shell('more', `<div class="page"><h1 class="page-title">More</h1>
    <div class="tiles">${tiles.map(([h, i, l]) => `<a class="tile" href="${h}">${i}<span>${l}</span></a>`).join('')}</div></div>`);
};

// ---------- watch party join ----------
ROUTES.party = async () => {
  shell('more', `<div class="page settings"><h1 class="page-title">Watch together</h1>
    <div class="panel"><h2>Join a watch party</h2><p class="hint">Enter the code someone shared with you. Everyone's playback stays in sync — when one person pauses, everyone pauses.</p>
    <form id="jf" class="btn-row" style="flex-wrap:nowrap"><input class="input code-input" name="c" maxlength="5" placeholder="ABC12" autocapitalize="characters" autocomplete="off"><button class="btn primary">Join</button></form></div>
    <div class="panel"><h2>Start one</h2><p class="hint">Open any movie or show, tap ⋯ and choose <b>Start a watch party</b>, or use the sliders button while watching.</p></div></div>`);
  const code = params().get('code');
  if (code) $('input[name=c]').value = code;
  $('#jf').onsubmit = async e => {
    e.preventDefault();
    const c = new FormData(e.target).get('c').trim().toUpperCase();
    try { const r = await api(`/api/rooms/${c}`); go(`#/play/${r.itemId}?room=${r.code}`); }
    catch (err) { toast(err.message, 3500); }
  };
};


// ---------- invite links ----------
ROUTES.invite = async token => {
  app.innerHTML = `<div class="who"><div class="logo">${LOGO}<span>Marquee</span></div><h1>Welcome!</h1><div class="center" style="min-height:80px"><div class="spinner"></div></div></div>`;
  try {
    const r = await api(`/api/invite/${encodeURIComponent(token)}`, { method: 'POST', allow401: true });
    await refreshMe();
    toast(`Hi ${r.name}! You're all set.`, 4000);
    go('#/', true);
  } catch (e) {
    app.innerHTML = `<div class="who"><div class="logo">${LOGO}<span>Marquee</span></div><h1>That link didn't work</h1><p class="hint">${esc(e.message)}</p></div>`;
  }
};

// ---------- requests ----------
ROUTES.requests = async () => {
  shell('more', `<div class="page"><h1 class="page-title">Requests</h1>${loading()}</div>`);
  const STATUS = { pending: 'Waiting for approval', approved: 'On its way', available: 'Ready to watch', declined: 'Declined', failed: 'Problem' };
  const draw = async (q = '') => {
    const [mine, results] = await Promise.all([api('/api/requests'), api(`/api/requests/search?q=${encodeURIComponent(q)}`).catch(e => ({ error: e.message }))]);
    $('#main').innerHTML = `<div class="page"><h1 class="page-title">Requests</h1>
      <p class="hint">Find a movie or show you'd like, and it'll be downloaded to the server automatically${me.isAdmin ? '' : ' once a grown-up approves it'}.</p>
      <form id="rq" class="search-box">${ICON.search}<input class="input" name="q" value="${esc(q)}" placeholder="Search movies and TV shows" autocomplete="off"></form>
      ${mine.requests.length ? `<h2 class="search-h">${me.isAdmin ? 'All requests' : 'Your requests'}</h2><div class="list">${mine.requests.map(r => `<div class="list-item">
        <div class="np-poster">${r.poster ? `<img src="${r.poster}" alt="">` : ICON.film}</div>
        <div class="grow"><div class="t">${esc(r.title)} ${r.year ? `<span style="color:var(--muted)">(${r.year})</span>` : ''}</div>
          <div class="s"><span class="pill ${r.status === 'available' ? 'accent' : r.status === 'failed' || r.status === 'declined' ? 'bad' : ''}">${STATUS[r.status]}</span>${me.isAdmin ? ` · ${esc(r.who)}` : ''} · ${ago(r.at)}</div>
          ${r.note ? `<div class="s">${esc(r.note)}</div>` : ''}</div>
        ${r.libraryId ? `<a class="btn small primary" href="#/item/${r.libraryId}">${ICON.play}</a>` : ''}
        ${me.isAdmin && ['pending', 'failed'].includes(r.status) ? `<button class="btn small primary" data-ok="${r.id}">${r.status === 'failed' ? 'Retry' : 'Approve'}</button><button class="btn small" data-no="${r.id}">Decline</button>` : ''}
        ${!me.isAdmin && r.status === 'pending' ? `<button class="btn small" data-del="${r.id}">Cancel</button>` : ''}</div>`).join('')}</div>` : ''}
      <h2 class="search-h">${q ? 'Results' : 'Trending this week'}</h2>
      ${results.error ? `<p class="hint">${esc(results.error)}</p>` : `<div class="grid">${results.map((x, i) => `<div class="card req-card">
        <div class="poster">${x.poster ? `<img src="${esc(x.poster)}" alt="" loading="lazy">` : fallbackArt(x.title, x.year)}
          ${x.libraryId ? '<span class="badge done">' + ICON.check + '</span>' : ''}</div>
        <div class="cap">${esc(x.title)}</div><div class="sub">${x.type === 'tv' ? 'TV · ' : ''}${x.year || ''}</div>
        ${x.libraryId ? `<a class="btn small" href="#/item/${x.libraryId}">In library</a>` : x.request ? `<span class="pill">${STATUS[x.request.status]}</span>`
          : `<button class="btn small primary" data-req="${i}">Request</button>`}</div>`).join('')}</div>`}</div>`;
    $('#rq').onsubmit = e => { e.preventDefault(); draw(new FormData(e.target).get('q').trim()); };
    $$('[data-req]').forEach(b => b.onclick = async () => {
      const x = results[+b.dataset.req];
      b.disabled = true;
      try { await api('/api/requests', { body: { tmdbId: x.tmdbId, type: x.type } }); toast(me.isAdmin ? 'Sent to the downloader' : 'Requested — a grown-up will approve it'); draw(q); }
      catch (e) { toast(e.message, 4000); b.disabled = false; }
    });
    $$('[data-ok]').forEach(b => b.onclick = async () => { b.disabled = true; try { await api(`/api/requests/${b.dataset.ok}/approve`, { method: 'POST' }); toast('Approved'); } catch (e) { toast(e.message, 5000); } draw(q); });
    $$('[data-no]').forEach(b => b.onclick = async () => { const note = prompt('Reason (optional)') ?? null; if (note === null) return; await api(`/api/requests/${b.dataset.no}/decline`, { body: { note } }); draw(q); });
    $$('[data-del]').forEach(b => b.onclick = async () => { await api(`/api/requests/${b.dataset.del}`, { method: 'DELETE' }); draw(q); });
  };
  await draw();
};

// ---------- Your year / Family Wrapped ----------
ROUTES.wrapped = async () => {
  const ps = params();
  const year = +ps.get('year') || new Date().getFullYear();
  const who = ps.get('who') || (me.isAdmin ? 'all' : '');
  shell('more', `<div class="page">${loading()}</div>`);
  const [st, ov] = await Promise.all([api(`/api/stats?year=${year}${who ? `&profileId=${who}` : ''}`), me.isAdmin ? api('/api/admin/overview') : null]);
  const max = Math.max(1, ...st.months);
  const M = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];
  const link = p => `#/wrapped?${new URLSearchParams({ year, who, ...p })}`;
  $('#main').innerHTML = `<div class="page wrapped">
    <div class="toolbar">${[year - 1, year].map(y => `<a class="chip ${y === year ? 'on' : ''}" href="${link({ year: y })}">${y}</a>`).join('')}
      ${ov ? `<select class="select" id="who"><option value="all" ${who === 'all' ? 'selected' : ''}>The whole family</option>${ov.profiles.filter(p => !p.hidden).map(p => `<option value="${p.id}" ${String(p.id) === who ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>` : ''}</div>
    <div class="wr-hero"><div class="hero-kicker">${who === 'all' ? 'Family' : esc(ov?.profiles.find(p => String(p.id) === who)?.name || me.name)} · ${year} wrapped</div>
      <div class="wr-big">${st.hours}<small> hours</small></div><p>of watching across ${st.sessions} sessions${st.favouriteDay ? ` — ${st.favouriteDay}s were the favourite` : ''}.</p></div>
    <div class="wr-grid">
      <div class="panel"><h2>Month by month</h2><div class="usage tall">${st.months.map((h, i) => `<div title="${h} h"><i style="height:${h / max * 100}%"></i><span>${M[i]}</span></div>`).join('')}</div></div>
      ${st.top.length ? `<div class="panel"><h2>Most watched</h2><div class="list">${st.top.slice(0, 5).map((t, i) => `<a class="list-item" href="#/item/${t.id}"><span class="wr-rank">${i + 1}</span>
        <div class="np-poster">${t.poster ? `<img src="${t.poster}" alt="">` : ICON.film}</div><div class="grow"><div class="t">${esc(t.title)}</div><div class="s">${t.hours} h${t.type === 'show' ? ` · ${t.parts} episodes` : ''}</div></div></a>`).join('')}</div></div>` : ''}
      ${st.genres.length ? `<div class="panel"><h2>Favourite genres</h2>${st.genres.map(g => `<div class="wr-bar"><span>${esc(g.name)}</span><div class="progress-line"><i style="width:${g.hours / st.genres[0].hours * 100}%"></i></div><b>${g.hours} h</b></div>`).join('')}</div>` : ''}
      ${st.binge ? `<div class="panel wr-binge"><h2>Biggest binge</h2><div class="wr-big small">${st.binge.episodes}<small> episodes</small></div><p>of <b>${esc(st.binge.show)}</b> on ${fmtDate(st.binge.day)} (${st.binge.hours} h)</p></div>` : ''}
      ${st.people.length ? `<div class="panel"><h2>Who watched most</h2>${st.people.map(p => `<div class="wr-bar">${avatar(p, 24, 7)}<span>${esc(p.name)}</span><div class="progress-line"><i style="width:${p.hours / Math.max(0.1, st.people[0].hours) * 100}%"></i></div><b>${p.hours} h</b></div>`).join('')}</div>` : ''}
      ${st.music.length ? `<div class="panel"><h2>Top artists</h2>${st.music.map((m, i) => `<div class="wr-bar"><span class="wr-rank">${i + 1}</span><span>${esc(m.artist)}</span><b>${m.plays} plays</b></div>`).join('')}</div>` : ''}
    </div>
    ${!st.hours ? emptyView(ICON.pulse, 'Nothing watched yet this year', 'Come back once the family has watched a few things.') : ''}</div>`;
  if ($('#who')) $('#who').onchange = e => go(link({ who: e.target.value }), true);
};

// ---------- remote control ----------
ROUTES.remote = async () => {
  shell('more', `<div class="page settings"><h1 class="page-title">Remote control</h1><div id="rem">${loading()}</div></div>`);
  const draw = async () => {
    const list = await api(`/api/devices?except=${encodeURIComponent(Devices.clientId)}`);
    const el = $('#rem');
    if (!el) return;
    el.innerHTML = list.length ? list.map(d => `<div class="panel remote-card"><div class="section-head"><h2>${esc(d.name)}</h2><span class="hint" style="margin:0">${esc(d.profileName)}</span></div>
      ${d.state?.title ? `<div class="t">${esc(d.state.title)}</div><div class="s hint">${d.state.playing ? 'Playing' : 'Paused'} · ${fmtTime(d.state.position)} / ${fmtTime(d.state.duration)}</div>
        <div class="progress-line"><i style="width:${d.state.duration ? d.state.position / d.state.duration * 100 : 0}%"></i></div>
        <div class="remote-btns"><button class="icon-btn" data-c="seek:-10" data-d="${d.clientId}">${ICON.back10}</button>
        <button class="btn primary round big" data-c="toggle" data-d="${d.clientId}">${d.state.playing ? ICON.pause : ICON.play}</button>
        <button class="icon-btn" data-c="seek:30" data-d="${d.clientId}">${ICON.fwd30}</button><button class="icon-btn" data-c="next" data-d="${d.clientId}">${ICON.next}</button>
        <button class="btn small" data-c="stop" data-d="${d.clientId}">Stop</button><button class="btn small" data-c="here" data-d="${d.clientId}">Watch here instead</button></div>`
        : '<p class="hint">Not playing anything. Open a movie and choose ⋯ → Play on another device.</p>'}</div>`).join('')
      : emptyView(ICON.cast, 'No other devices', 'Open Marquee on your TV, tablet or another phone and it will appear here.');
    $$('[data-c]', el).forEach(b => b.onclick = async () => {
      const [type, arg] = b.dataset.c.split(':');
      const d = list.find(x => x.clientId === b.dataset.d);
      if (type === 'here') {
        await api(`/api/devices/${d.clientId}/command`, { body: { type: 'stop' } });
        return go(`#/play/${d.state.itemId}?t=${Math.floor(d.state.position)}`);
      }
      await api(`/api/devices/${d.clientId}/command`, { body: type === 'seek' ? { type: 'seekBy', by: +arg } : { type } });
      setTimeout(draw, 700);
    });
  };
  await draw();
  const t = setInterval(draw, 3000);
  onLeave(() => clearInterval(t));
};
