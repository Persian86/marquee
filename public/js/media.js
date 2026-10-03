/* Marquee — music, podcasts, photos, home videos */
'use strict';

// ---------- the audio player bar: music and podcasts keep playing while you browse ----------
// Queue entries: { kind: 'track'|'podcast', id, title, artist, album, poster, duration, src?, start? }
const MiniPlayer = (() => {
  // Two <audio> elements so the next song is already loaded (near-gapless)
  const players = [new Audio(), new Audio()];
  players.forEach(a => { a.preload = 'auto'; });
  let audio = players[0];
  let queue = [], idx = -1, bar = null, sheet = null, sheetTab = 'queue', lastSave = 0, counted = false, preloadedFor = -1;
  let speed = store.get('mq_book_speed', 1), sleepAt = null, sleepTimer = null, lyrics = null;

  const cur = () => queue[idx];
  const spoken = () => cur()?.kind === 'podcast';
  const other = () => players.find(p => p !== audio);
  const srcFor = (t, transcode) => t.src || `/api/audio/${t.id}${transcode ? '?transcode=1' : ''}`;

  function playAt(i, startAt) {
    if (i < 0 || i >= queue.length) return;
    const prev = audio;
    idx = i;
    const t = cur();
    const nxt = other();
    // Already preloaded? swap to it instantly
    if (preloadedFor === i && nxt.src) { prev.pause(); audio = nxt; }
    else { audio.src = srcFor(t); audio.dataset.transcoded = ''; }
    preloadedFor = -1;
    counted = false; lyrics = null;
    audio.playbackRate = spoken() ? speed : 1;
    const begin = startAt ?? t.start ?? 0;
    if (begin > 0) audio.addEventListener('loadedmetadata', () => { audio.currentTime = begin; }, { once: true });
    audio.play().catch(() => {});
    if (prev !== audio) { prev.removeAttribute('src'); prev.load(); }
    session();
    draw();
    if (sheet && sheetTab === 'lyrics') loadLyrics();
  }
  for (const a of players) {
    a.addEventListener('error', () => {
      if (a !== audio) return;
      const t = cur();
      if (t && !t.src && !a.dataset.transcoded) { a.dataset.transcoded = '1'; a.src = srcFor(t, true); a.play().catch(() => {}); }
    });
    a.addEventListener('ended', () => { if (a !== audio) return; save(true); if (idx < queue.length - 1) playAt(idx + 1); else draw(); });
    a.addEventListener('timeupdate', () => { if (a === audio) tick(); });
    a.addEventListener('play', () => { if (a === audio) draw(); });
    a.addEventListener('pause', () => { if (a === audio) { draw(); save(true); } });
  }

  function tick() {
    drawProgress();
    const t = cur();
    if (!t) return;
    if (Date.now() - lastSave > 15000) { lastSave = Date.now(); save(); }
    if (t.kind === 'track' && !counted && audio.duration && audio.currentTime > audio.duration * 0.5) { counted = true; api(`/api/music/played/${t.id}`, { method: 'POST' }).catch(() => {}); }
    // Load the next one in the background a little before the end
    if (audio.duration && audio.duration - audio.currentTime < 12 && preloadedFor !== idx + 1 && queue[idx + 1]) {
      const nxt = other(); nxt.src = srcFor(queue[idx + 1]); nxt.load(); preloadedFor = idx + 1;
    }
    if (sleepAt === 'chapter') return;
    if (sheet && sheetTab === 'lyrics' && lyrics?.synced) highlightLyric();
  }
  function save(force) {
    const t = cur();
    if (!t || !audio.duration) return;
    if (t.kind === 'podcast') api(`/api/podcast-episodes/${t.id}/progress`, { body: { position: audio.currentTime, duration: audio.duration } }).catch(() => {});
    else if (force) api('/api/progress', { body: { itemId: t.id, position: audio.currentTime, duration: audio.duration } }).catch(() => {});
  }

  function session() {
    if (!('mediaSession' in navigator) || !cur()) return;
    const t = cur();
    try {
      navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artist || '', album: t.album || '', artwork: t.poster ? [{ src: t.poster.startsWith('http') ? t.poster : location.origin + t.poster, sizes: '600x600', type: 'image/jpeg' }] : [] });
      navigator.mediaSession.setActionHandler('play', () => audio.play());
      navigator.mediaSession.setActionHandler('pause', () => audio.pause());
      navigator.mediaSession.setActionHandler('previoustrack', prev);
      navigator.mediaSession.setActionHandler('nexttrack', next);
      navigator.mediaSession.setActionHandler('seekbackward', () => skip(-15));
      navigator.mediaSession.setActionHandler('seekforward', () => skip(30));
      navigator.mediaSession.setActionHandler('seekto', d => { audio.currentTime = d.seekTime; });
    } catch {}
  }
  function next() { if (idx < queue.length - 1) playAt(idx + 1); }
  function prev() { if (audio.currentTime > 4 || idx === 0) audio.currentTime = 0; else playAt(idx - 1); }
  function skip(s) { audio.currentTime = Math.max(0, Math.min((audio.duration || 0) - 1, audio.currentTime + s)); }
  function setSpeed(v) { speed = v; store.set('mq_book_speed', v); audio.playbackRate = v; }
  function setSleep(mins) {
    clearTimeout(sleepTimer); sleepAt = null;
    if (mins === 'chapter') { sleepAt = 'chapter'; const t = cur(); const once = () => { audio.pause(); sleepAt = null; toast('Sleep timer — paused'); }; audio.addEventListener('ended', once, { once: true }); }
    else if (mins) { sleepAt = Date.now() + mins * 60000; sleepTimer = setTimeout(() => { fadeOut(); sleepAt = null; }, mins * 60000); }
    toast(mins ? `Sleep timer: ${mins === 'chapter' ? 'end of episode' : mins + ' minutes'}` : 'Sleep timer off');
    draw();
  }
  function fadeOut() {
    const v0 = audio.volume; let n = 0;
    const t = setInterval(() => { n++; audio.volume = Math.max(0, v0 * (1 - n / 20)); if (n >= 20) { clearInterval(t); audio.pause(); audio.volume = v0; toast('Sleep timer — paused'); } }, 250);
  }

  function mount() {
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'mini hidden';
      document.body.appendChild(bar);
      bar.addEventListener('click', e => {
        const a = e.target.closest('[data-m]')?.dataset.m;
        if (a === 'toggle') audio.paused ? audio.play() : audio.pause();
        else if (a === 'next') spoken() ? skip(30) : next();
        else if (a === 'close') stop();
        else openSheet();
      });
    }
    draw();
  }
  function draw() {
    if (!bar) return;
    const t = cur();
    const hide = !t || location.hash.startsWith('#/play') || location.hash.startsWith('#/who');
    bar.classList.toggle('hidden', hide);
    document.body.classList.toggle('has-mini', !hide);
    if (!t) return;
    bar.innerHTML = `<div class="mini-prog"><i id="miniProg"></i></div>
      <div class="mini-art">${t.poster ? `<img src="${t.poster}" alt="">` : ICON.music}</div>
      <div class="mini-text"><b>${esc(t.title)}</b><span>${esc(t.artist || '')}${sleepAt ? ' · 🌙' : ''}</span></div>
      <button class="icon-btn" data-m="toggle" aria-label="Play or pause">${audio.paused ? ICON.play : ICON.pause}</button>
      <button class="icon-btn" data-m="next" aria-label="${spoken() ? 'Forward 30 seconds' : 'Next'}">${spoken() ? ICON.fwd30 : ICON.next}</button>
      <button class="icon-btn" data-m="close" aria-label="Stop">${ICON.x}</button>`;
    drawProgress();
    if (sheet) drawSheet();
  }
  function drawProgress() {
    const p = $('#miniProg');
    if (p && audio.duration) p.style.width = (audio.currentTime / audio.duration * 100) + '%';
    if (sheet) {
      const s = $('#npSeek', sheet), tt = $('#npTime', sheet);
      if (s && audio.duration && !s.matches(':active')) s.value = audio.currentTime / audio.duration * 1000;
      if (tt) tt.textContent = `${fmtTime(audio.currentTime)} / ${fmtTime(audio.duration || cur()?.duration)}${speed !== 1 && spoken() ? ` · ${speed}×` : ''}`;
    }
  }
  function openSheet() {
    const m = modal('<div id="np"></div>', { onClose: () => { sheet = null; } });
    sheet = m.el;
    drawSheet();
  }
  function drawSheet() {
    const t = cur();
    if (!t || !sheet) return;
    const book = spoken();
    $('#np', sheet).innerHTML = `<div class="np-art">${t.poster ? `<img src="${t.poster}" alt="">` : fallbackArt(t.album || t.title)}</div>
      <h2 style="margin:16px 0 2px">${esc(t.title)}</h2><p class="hint" style="margin:0 0 10px">${esc(t.artist || '')}${t.album ? ' · ' + esc(t.album) : ''}</p>
      <input type="range" min="0" max="1000" value="0" id="npSeek" class="range"><div class="np-time" id="npTime"></div>
      <div class="np-ctrl">${book ? `<button class="icon-btn" id="npB15">${ICON.back10}</button>` : `<button class="icon-btn" id="npPrev">${ICON.prev}</button>`}
        <button class="btn primary round big" id="npPlay">${audio.paused ? ICON.play : ICON.pause}</button>
        ${book ? `<button class="icon-btn" id="npF30">${ICON.fwd30}</button>` : `<button class="icon-btn" id="npNext">${ICON.next}</button>`}</div>
      ${book ? `<div class="np-extras"><select class="select" id="npSpeed">${[0.8, 1, 1.15, 1.25, 1.5, 1.75, 2].map(v => `<option value="${v}" ${v === speed ? 'selected' : ''}>${v}× speed</option>`).join('')}</select>
        <select class="select" id="npSleep"><option value="">${sleepAt ? 'Sleep timer on 🌙' : 'Sleep timer'}</option><option value="0">Off</option><option value="10">10 minutes</option><option value="20">20 minutes</option><option value="30">30 minutes</option><option value="60">1 hour</option><option value="chapter">End of episode</option></select></div>` : ''}
      <div class="np-tabs"><button class="chip ${sheetTab === 'queue' ? 'on' : ''}" data-tab="queue">Up next</button>${t.kind === 'track' ? `<button class="chip ${sheetTab === 'lyrics' ? 'on' : ''}" data-tab="lyrics">Lyrics</button><button class="chip" id="npRadio">Start radio</button><button class="chip" id="npAdd">Add to playlist</button>` : ''}</div>
      <div id="npBody"></div>`;
    $('#npSeek', sheet).oninput = e => { if (audio.duration) audio.currentTime = e.target.value / 1000 * audio.duration; };
    $('#npPlay', sheet).onclick = () => (audio.paused ? audio.play() : audio.pause());
    if ($('#npPrev', sheet)) $('#npPrev', sheet).onclick = prev;
    if ($('#npNext', sheet)) $('#npNext', sheet).onclick = next;
    if ($('#npB15', sheet)) $('#npB15', sheet).onclick = () => skip(-15);
    if ($('#npF30', sheet)) $('#npF30', sheet).onclick = () => skip(30);
    if ($('#npSpeed', sheet)) $('#npSpeed', sheet).onchange = e => setSpeed(+e.target.value);
    if ($('#npSleep', sheet)) $('#npSleep', sheet).onchange = e => { const v = e.target.value; if (v !== '') setSleep(v === 'chapter' ? 'chapter' : +v); };
    if ($('#npRadio', sheet)) $('#npRadio', sheet).onclick = async () => { const tr = await api(`/api/music/radio?track=${t.id}`); play(tr); toast(`Radio based on ${t.title}`); };
    if ($('#npAdd', sheet)) $('#npAdd', sheet).onclick = () => addToPlaylist([t.id]);
    $$('[data-tab]', sheet).forEach(b => b.onclick = () => { sheetTab = b.dataset.tab; drawSheet(); });
    if (sheetTab === 'lyrics' && t.kind === 'track') { $('#npBody', sheet).innerHTML = '<div class="lyrics" id="lyr"><p class="hint">Looking for lyrics…</p></div>'; loadLyrics(); }
    else $('#npBody', sheet).innerHTML = `<div class="tracks">${queue.map((q, i) => `<button class="track ${i === idx ? 'on' : ''}" data-i="${i}"><span class="tn">${i + 1}</span><span class="tt"><b>${esc(q.title)}</b><small>${esc(q.artist || '')}</small></span><span class="td">${fmtTime(q.duration)}</span></button>`).join('')}</div>`;
    $$('[data-i]', sheet).forEach(b => b.onclick = () => playAt(+b.dataset.i));
    drawProgress();
  }

  async function loadLyrics() {
    const t = cur();
    if (!t || t.kind !== 'track') return;
    if (!lyrics || lyrics.id !== t.id) {
      const r = await api(`/api/music/lyrics/${t.id}`).catch(() => ({ none: true }));
      lyrics = { id: t.id, ...r, lines: r.text ? parseLrc(r.text, r.synced) : [] };
    }
    const el = sheet && $('#lyr', sheet);
    if (!el) return;
    el.innerHTML = lyrics.none || !lyrics.lines.length ? '<p class="hint">No lyrics found for this song.</p>'
      : lyrics.lines.map((l, i) => `<p data-l="${i}">${esc(l.text) || '♪'}</p>`).join('') + (lyrics.source === 'lrclib' ? '<p class="hint" style="font-size:11px">Lyrics from LRCLIB</p>' : '');
    if (lyrics.synced) $$('[data-l]', el).forEach(p => p.onclick = () => { audio.currentTime = lyrics.lines[+p.dataset.l].t; });
  }
  function parseLrc(text, synced) {
    if (!synced) return text.split('\n').map(t => ({ t: null, text: t.trim() }));
    const out = [];
    for (const line of text.split('\n')) {
      const tags = [...line.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
      const words = line.replace(/\[[^\]]*\]/g, '').trim();
      for (const m of tags) out.push({ t: +m[1] * 60 + +m[2], text: words });
    }
    return out.sort((a, b) => a.t - b.t);
  }
  function highlightLyric() {
    const el = sheet && $('#lyr', sheet);
    if (!el || !lyrics?.lines.length) return;
    let k = -1;
    for (let i = 0; i < lyrics.lines.length; i++) if (lyrics.lines[i].t <= audio.currentTime + 0.2) k = i;
    const on = $('[data-l].on', el);
    if (on && +on.dataset.l === k) return;
    if (on) on.classList.remove('on');
    const p = $(`[data-l="${k}"]`, el);
    if (p) { p.classList.add('on'); p.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
  }

  function play(items, start = 0, startAt) {
    queue = items.map(t => ({ kind: 'track', ...t }));
    playAt(start, startAt);
  }
  function stop() { save(true); audio.pause(); audio.removeAttribute('src'); queue = []; idx = -1; clearTimeout(sleepTimer); sleepAt = null; draw(); }
  function pauseForVideo() { if (!audio.paused) audio.pause(); }
  addEventListener('hashchange', () => setTimeout(draw, 0));
  return { mount, play, stop, pauseForVideo, toggle: () => (audio.paused ? audio.play() : audio.pause()), skip, get playing() { return !audio.paused; }, get current() { return cur(); } };
})();

function trackList(tracks, { showAlbum = false, numbered = false } = {}) {
  return `<div class="tracks">${tracks.map((t, i) => `<div class="track-row"><button class="track" data-t="${i}">
    <span class="tn">${numbered ? (t.track || i + 1) : t.poster ? `<img src="${t.poster}" alt="" loading="lazy">` : ICON.music}</span>
    <span class="tt"><b>${esc(t.title)}</b><small>${esc(t.artist || '')}${showAlbum && t.album ? ' · ' + esc(t.album) : ''}</small></span>
    <span class="td">${fmtTime(t.duration)}</span></button><button class="icon-btn tmore" data-tm="${i}" aria-label="More">⋯</button></div>`).join('')}</div>`;
}
function bindTrackList(root, tracks, { playlistId } = {}) {
  $$('[data-t]', root).forEach(b => b.onclick = () => MiniPlayer.play(tracks, +b.dataset.t));
  $$('[data-tm]', root).forEach(b => b.onclick = () => {
    const t = tracks[+b.dataset.tm];
    const m = modal(`<h2>${esc(t.title)}</h2><p class="hint">${esc(t.artist || '')}${t.album ? ' · ' + esc(t.album) : ''}</p><div class="menu-list">
      <button data-a="next">${ICON.play}<span>Play now</span></button>
      <button data-a="playlist">${ICON.plus}<span>Add to a playlist…</span></button>
      <button data-a="radio">${ICON.shuffle}<span>Start radio from this song</span></button>
      ${t.album ? `<button data-a="album">${ICON.music}<span>Go to album</span></button>` : ''}
      ${playlistId ? `<button data-a="remove">${ICON.trash}<span>Remove from this playlist</span></button>` : ''}</div>`);
    $$('[data-a]', m.el).forEach(x => x.onclick = async () => {
      m.close();
      const a = x.dataset.a;
      if (a === 'next') MiniPlayer.play([t]);
      if (a === 'playlist') addToPlaylist([t.id]);
      if (a === 'radio') { MiniPlayer.play(await api(`/api/music/radio?track=${t.id}`)); toast('Radio started'); }
      if (a === 'album') go(`#/album?artist=${encodeURIComponent(t.albumArtist || t.artist)}&album=${encodeURIComponent(t.album)}`);
      if (a === 'remove') { await api(`/api/music/playlists/${playlistId}/items/${t.id}`, { method: 'DELETE' }); route(); }
    });
  });
}
async function addToPlaylist(itemIds) {
  const d = await api('/api/music/playlists');
  const mine = d.playlists.filter(p => p.mine || p.shared);
  const m = modal(`<h2>Add to playlist</h2><div class="menu-list">${mine.map(p => `<button data-p="${p.id}">${ICON.music}<span>${esc(p.name)} <small>${p.count} songs</small></span></button>`).join('') || '<p class="hint">No playlists yet.</p>'}</div>
    <form id="npl" class="btn-row" style="flex-wrap:nowrap;margin-top:12px"><input class="input" name="n" placeholder="New playlist name" maxlength="80"><button class="btn primary">Create</button></form>`);
  $$('[data-p]', m.el).forEach(b => b.onclick = async () => { await api(`/api/music/playlists/${b.dataset.p}/items`, { body: { itemIds } }); m.close(); toast('Added'); });
  $('#npl', m.el).onsubmit = async e => { e.preventDefault(); const n = new FormData(e.target).get('n').trim(); if (!n) return; await api('/api/music/playlists', { body: { name: n, itemIds } }); m.close(); toast(`Added to “${n}”`); };
}

// ---------- music ----------
ROUTES.music = async () => {
  const tab = params().get('tab') || 'albums';
  shell('music', `<div class="page"><h1 class="page-title">Music</h1>${loading()}</div>`);
  const head = `<h1 class="page-title">Music</h1><div class="toolbar">
    ${[['albums', 'Albums'], ['artists', 'Artists'], ['playlists', 'Playlists']].map(([k, l]) => `<a class="chip ${tab === k ? 'on' : ''}" href="#/music?tab=${k}">${l}</a>`).join('')}
    <button class="btn small primary" id="shuffle" style="margin-left:auto">${ICON.shuffle} Shuffle all</button></div>`;
  if (tab === 'artists') {
    const artists = await api('/api/music/artists');
    $('#main').innerHTML = `<div class="page">${head}<div class="grid">${artists.map(a => `<a class="card person" href="#/artist?name=${encodeURIComponent(a.name)}">
      <div class="face">${a.poster ? `<img src="${a.poster}" alt="" loading="lazy">` : `<span>${esc(a.name[0])}</span>`}</div><div class="cap">${esc(a.name)}</div>
      <div class="sub">${a.albums} album${a.albums === 1 ? '' : 's'}</div></a>`).join('')}</div></div>`;
  } else if (tab === 'playlists') {
    const d = await api('/api/music/playlists');
    $('#main').innerHTML = `<div class="page">${head}
      <div class="section-head"><h2>Made for you</h2></div>
      <div class="grid">${d.smart.map(s => `<a class="card" href="#/smart/${s.key}"><div class="poster square smart-tile s-${s.key}"><span>${esc(s.name)}</span></div><div class="cap">${esc(s.name)}</div><div class="sub">${esc(s.desc)}</div></a>`).join('')}
        ${d.genres.slice(0, 6).map(g => `<a class="card" href="#/smart/genre:${encodeURIComponent(g.name)}"><div class="poster square smart-tile" style="background:linear-gradient(150deg,hsl(${hue(g.name)} 55% 40%),hsl(${(hue(g.name) + 50) % 360} 60% 18%))"><span>${esc(g.name)}</span></div><div class="cap">${esc(g.name)} mix</div><div class="sub">${g.count} songs</div></a>`).join('')}</div>
      <div class="section-head" style="margin-top:28px"><h2>Playlists</h2><button class="btn small" id="newPl">${ICON.plus} New playlist</button></div>
      ${d.playlists.length ? `<div class="grid">${d.playlists.map(p => collectionCard({ ...p, owner: p.owner }, `#/playlist/${p.id}`)).join('')}</div>` : '<p class="hint">Make playlists from any song’s ⋯ menu, or start one here.</p>'}</div>`;
    $('#newPl').onclick = async () => { const n = prompt('Playlist name'); if (n) { const r = await api('/api/music/playlists', { body: { name: n } }); go(`#/playlist/${r.id}`); } };
  } else {
    const albums = await api('/api/music/albums');
    $('#main').innerHTML = `<div class="page">${head}${albums.length ? `<div class="grid">${albums.map(albumCard).join('')}</div>` : emptyView(ICON.music, 'No music yet', 'Add a Music library in Settings.')}</div>`;
  }
  $('#shuffle').onclick = async () => MiniPlayer.play(await api('/api/music/shuffle'));
};

async function trackPage(title, kicker, tracks, opts = {}) {
  $('#main').innerHTML = `<div class="page"><div class="hero-kicker">${esc(kicker)}</div><h1 class="page-title">${esc(title)}</h1>
    <div class="btn-row" style="margin-bottom:18px">${tracks.length ? `<button class="btn primary" id="playAll">${ICON.play} Play</button><button class="btn ghost" id="shuf">${ICON.shuffle} Shuffle</button>` : ''}
    ${opts.mine ? '<button class="btn small" id="ren">Rename</button><button class="btn small danger" id="del">Delete</button>' : ''}</div>
    ${tracks.length ? trackList(tracks, { showAlbum: true }) : '<p class="hint">Nothing here yet — add songs from their ⋯ menu.</p>'}</div>`;
  bindTrackList($('#main'), tracks, { playlistId: opts.playlistId });
  if ($('#playAll')) { $('#playAll').onclick = () => MiniPlayer.play(tracks); $('#shuf').onclick = () => MiniPlayer.play([...tracks].sort(() => Math.random() - .5)); }
  if (opts.mine) {
    $('#ren').onclick = async () => { const n = prompt('Playlist name', title); if (n) { await api(`/api/music/playlists/${opts.playlistId}`, { method: 'PATCH', body: { name: n } }); route(); } };
    $('#del').onclick = async e => { if (!confirmTwice(e.target, 'Tap again to delete')) return; await api(`/api/music/playlists/${opts.playlistId}`, { method: 'DELETE' }); go('#/music?tab=playlists', true); };
  }
}
ROUTES.playlist = async id => {
  shell('music', `<div class="page">${loading()}</div>`);
  const p = await api(`/api/music/playlists/${id}`);
  trackPage(p.name, 'Playlist', p.tracks, { mine: p.mine, playlistId: p.id });
};
ROUTES.smart = async key => {
  shell('music', `<div class="page">${loading()}</div>`);
  const p = await api(`/api/music/smart/${encodeURIComponent(decodeURIComponent(key))}`);
  trackPage(p.name, 'Smart playlist', p.tracks);
};

ROUTES.album = async () => {
  const ps = params();
  shell('music', `<div class="page">${loading()}</div>`);
  const a = await api(`/api/music/album?artist=${encodeURIComponent(ps.get('artist'))}&album=${encodeURIComponent(ps.get('album'))}`);
  $('#main').innerHTML = `<div class="page"><div class="album-head">
    <div class="poster square">${a.poster ? `<img src="${a.poster}" alt="">` : fallbackArt(a.album)}</div>
    <div><div class="hero-kicker">Album</div><h1 class="page-title" style="margin:4px 0">${esc(a.album)}</h1>
    <p class="hint"><a href="#/artist?name=${encodeURIComponent(a.artist)}">${esc(a.artist)}</a>${a.year ? ' · ' + a.year : ''} · ${a.tracks.length} songs · ${fmtMins(a.duration)}</p>
    <div class="btn-row"><button class="btn primary" id="playAll">${ICON.play} Play</button><button class="btn ghost" id="shuf">${ICON.shuffle} Shuffle</button><button class="btn ghost" id="addAll">${ICON.plus} Playlist</button></div></div></div>
    ${trackList(a.tracks, { numbered: true })}</div>`;
  bindTrackList($('#main'), a.tracks);
  $('#playAll').onclick = () => MiniPlayer.play(a.tracks);
  $('#shuf').onclick = () => MiniPlayer.play([...a.tracks].sort(() => Math.random() - .5));
  $('#addAll').onclick = () => addToPlaylist(a.tracks.map(t => t.id));
};

ROUTES.artist = async () => {
  const name = params().get('name');
  shell('music', `<div class="page">${loading()}</div>`);
  const a = await api(`/api/music/artist?name=${encodeURIComponent(name)}`);
  $('#main').innerHTML = `<div class="page"><h1 class="page-title">${esc(a.name)}</h1>
    <div class="btn-row" style="margin-bottom:20px"><button class="btn primary" id="shuf">${ICON.shuffle} Shuffle ${esc(a.name)}</button><button class="btn ghost" id="radio">Artist radio</button></div>
    <h2 class="search-h">Albums</h2><div class="grid">${a.albums.map(albumCard).join('')}</div></div>`;
  $('#shuf').onclick = () => MiniPlayer.play(a.tracks);
  $('#radio').onclick = async () => { MiniPlayer.play(await api(`/api/music/radio?artist=${encodeURIComponent(a.name)}`)); toast(`${a.name} radio — plus similar music`); };
};

// ---------- podcasts ----------
ROUTES.podcasts = async () => {
  shell('podcasts', `<div class="page"><h1 class="page-title">Podcasts</h1>${loading()}</div>`);
  const d = await api('/api/podcasts');
  $('#main').innerHTML = `<div class="page"><h1 class="page-title">Podcasts</h1>
    ${me.isKids ? '' : `<form id="pf" class="search-box">${ICON.search}<input class="input" name="q" placeholder="Find a podcast, or paste its RSS link" autocomplete="off"></form><div id="pres"></div>`}
    ${d.latest.length ? `<h2 class="search-h">Latest episodes</h2>${episodeList(d.latest, true)}` : ''}
    <h2 class="search-h">Your podcasts</h2>
    ${d.podcasts.length ? `<div class="grid">${d.podcasts.map(p => `<a class="card" href="#/podcast/${p.id}"><div class="poster square">${p.image ? `<img src="${esc(p.image)}" alt="" loading="lazy">` : fallbackArt(p.title)}${p.unplayed ? `<span class="badge">${p.unplayed}</span>` : ''}</div>
      <div class="cap">${esc(p.title)}</div><div class="sub">${esc(p.author || '')}</div></a>`).join('')}</div>` : '<p class="hint">Search above to follow your first podcast. New episodes are checked every few hours.</p>'}</div>`;
  bindEpisodes($('#main'), d.latest);
  if ($('#pf')) $('#pf').onsubmit = async e => {
    e.preventDefault();
    const q = new FormData(e.target).get('q').trim();
    if (!q) return;
    const out = $('#pres');
    if (/^https?:\/\//.test(q)) {
      try { const r = await api('/api/podcasts', { body: { feedUrl: q } }); toast('Following'); go(`#/podcast/${r.id}`); } catch (err) { toast(err.message, 4000); }
      return;
    }
    out.innerHTML = loading();
    try {
      const res = await api(`/api/podcasts/search?q=${encodeURIComponent(q)}`);
      out.innerHTML = res.length ? `<div class="menu-list" style="margin-bottom:18px">${res.map((p, i) => `<button data-sub="${i}"><img src="${esc(p.image)}" alt="" class="pod-thumb"><span>${esc(p.title)} <small>${esc(p.author)}</small></span>${p.subscribed ? ICON.check : ICON.plus}</button>`).join('')}</div>` : '<p class="hint">No podcasts found.</p>';
      $$('[data-sub]', out).forEach(b => b.onclick = async () => {
        b.disabled = true;
        try { const r = await api('/api/podcasts', { body: { feedUrl: res[+b.dataset.sub].feedUrl } }); toast('Following'); go(`#/podcast/${r.id}`); } catch (err) { toast(err.message, 4000); b.disabled = false; }
      });
    } catch (err) { out.innerHTML = `<p class="hint">${esc(err.message)}</p>`; }
  };
};
function episodeList(eps, showPodcast) {
  return `<div class="episodes-list">${eps.map((e, i) => `<div class="pod-ep ${e.played ? 'played' : ''}">
    <button class="pod-play" data-pe="${i}" aria-label="Play">${ICON.play}</button>
    <div class="grow"><div class="t">${esc(e.title)}</div><div class="s">${showPodcast ? esc(e.podcast) + ' · ' : ''}${fmtDate(e.pub_date)}${e.duration ? ' · ' + fmtMins(e.duration) : ''}${e.position && !e.played ? ` · ${fmtMins(e.duration - e.position)} left` : ''}${e.played ? ' · Played' : ''}</div>
      ${e.description ? `<p class="pod-desc">${esc(e.description.slice(0, 220))}</p>` : ''}</div>
    <button class="check ${e.played ? 'on' : ''}" data-pd="${e.id}" aria-label="Mark played">${ICON.check}</button></div>`).join('')}</div>`;
}
function bindEpisodes(root, eps, podcast) {
  const items = eps.map(e => ({ kind: 'podcast', id: e.id, title: e.title, artist: podcast?.title || e.podcast, poster: e.image || podcast?.image || e.podcast_image, duration: e.duration, src: e.audio_url, start: e.played ? 0 : e.position || 0 }));
  $$('[data-pe]', root).forEach(b => b.onclick = () => MiniPlayer.play(items, +b.dataset.pe));
  $$('[data-pd]', root).forEach(b => b.onclick = async () => { await api(`/api/podcast-episodes/${b.dataset.pd}/played`, { body: { played: !b.classList.contains('on') } }); b.classList.toggle('on'); });
}
ROUTES.podcast = async id => {
  shell('podcasts', `<div class="page">${loading()}</div>`);
  const p = await api(`/api/podcasts/${id}`);
  $('#main').innerHTML = `<div class="page"><div class="album-head"><div class="poster square">${p.image ? `<img src="${esc(p.image)}" alt="">` : fallbackArt(p.title)}</div>
    <div><div class="hero-kicker">Podcast</div><h1 class="page-title" style="margin:4px 0">${esc(p.title)}</h1><p class="hint">${esc(p.author || '')} · ${p.episodes.length} episodes</p>
    ${me.isAdmin ? '<div class="btn-row"><button class="btn small danger" id="unsub">Unfollow</button></div>' : ''}</div></div>
    ${p.description ? `<p class="overview">${esc(p.description.slice(0, 600))}</p>` : ''}
    ${episodeList(p.episodes, false)}</div>`;
  bindEpisodes($('#main'), p.episodes, p);
  if ($('#unsub')) $('#unsub').onclick = async e => { if (!confirmTwice(e.target, 'Tap again to unfollow')) return; await api(`/api/podcasts/${id}`, { method: 'DELETE' }); go('#/podcasts', true); };
};

// ---------- photos ----------
ROUTES.photos = async () => {
  shell('photos', `<div class="page"><h1 class="page-title">Photos</h1>${loading()}</div>`);
  const [albums, disc, pins] = await Promise.all([api('/api/photos/albums'), api('/api/discover').catch(() => ({ onThisDay: [] })), api('/api/photos/map').catch(() => [])]);
  const otd = disc.onThisDay || [];
  $('#main').innerHTML = `<div class="page"><h1 class="page-title">Photos</h1>
    <div class="btn-row" style="margin:-4px 0 16px"><button class="btn small primary" id="weekShow">${ICON.play} This week on the TV</button><a class="btn small" href="#/memories">${ICON.clock} Memories</a><a class="btn small" href="#/photo-people">${ICON.users} People</a>${pins.length ? `<a class="btn small" href="#/photo-map">${ICON.photo} Map · ${pins.length} places</a>` : ''}</div>
    <div id="peopleRow"></div>
    ${otd.length ? `<h2 class="search-h">On this day</h2><div class="scroller wide" style="margin:0 calc(-1 * var(--gutter)) 18px">${otd.map((x, i) => `<button class="card" data-otd="${i}" style="text-align:left">
      <div class="thumb">${x.thumb ? `<img src="${x.thumb}" alt="" loading="lazy">` : x.still ? `<img src="${x.still}" alt="">` : ''}${x.type === 'home' ? `<span class="play-ico">${ICON.play}</span>` : ''}</div>
      <div class="cap">${x.yearsAgo} year${x.yearsAgo === 1 ? '' : 's'} ago</div><div class="sub">${esc(x.folder || '')}</div></button>`).join('')}</div>` : ''}
    ${albums.length ? `<div class="grid albums">${albums.map(a => `<a class="card" href="#/photo-album?library=${a.library}&folder=${encodeURIComponent(a.folder)}&name=${encodeURIComponent(a.name)}">
      <div class="poster square"><img src="${a.cover}" alt="" loading="lazy"><span class="badge">${a.count}</span></div>
      <div class="cap">${esc(a.name)}</div><div class="sub">${fmtDate(a.latest, { month: 'short', year: 'numeric' })}</div></a>`).join('')}</div>`
      : emptyView(ICON.photo, 'No photos yet', 'Add a Photos library in Settings.')}</div>`;
  photoPeopleRow().then(h => { if ($('#peopleRow')) $('#peopleRow').innerHTML = h; });
  const otdPhotos = otd.filter(x => x.type === 'photo').map(x => ({ ...x, display: `/api/photo/${x.id}/display`, original: `/api/photo/${x.id}/original` }));
  $$('[data-otd]').forEach(b => b.onclick = () => {
    const x = otd[+b.dataset.otd];
    if (x.type === 'home') go(`#/play/${x.id}`);
    else lightbox(otdPhotos, otdPhotos.findIndex(p => p.id === x.id));
  });
  $('#weekShow').onclick = async () => {
    const since = Date.now() - 7 * 86400000;
    const photos = await api(`/api/photos?since=${since}&limit=200`);
    if (!photos.length) return toast('No photos from the last 7 days');
    lightbox(photos, 0, true);
  };
};

// Photo map (OpenStreetMap via Leaflet, loaded only on this page)
function loadLeaflet() {
  if (window.L?.markerClusterGroup) return Promise.resolve();
  const css = href => new Promise(r => { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = href; l.onload = r; l.onerror = r; document.head.appendChild(l); });
  const js = src => new Promise((r, j) => { const s = document.createElement('script'); s.src = src; s.onload = r; s.onerror = j; document.head.appendChild(s); });
  return Promise.all([css('https://unpkg.com/leaflet@1.9.4/dist/leaflet.css'), css('https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.css'), css('https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.Default.css')])
    .then(() => js('https://unpkg.com/leaflet@1.9.4/dist/leaflet.js')).then(() => js('https://unpkg.com/leaflet.markercluster@1.5.3/dist/leaflet.markercluster.js'));
}
ROUTES['photo-map'] = async () => {
  shell('photos', `<div class="page"><a class="back-link" href="#/photos">${ICON.arrowLeft} Photos</a><h1 class="page-title">Where your photos were taken</h1><div id="map" class="photo-map">${loading()}</div></div>`);
  const pins = await api('/api/photos/map');
  try { await loadLeaflet(); } catch { $('#map').innerHTML = emptyView('', 'Map unavailable', 'The map tiles come from the internet. This TV or phone cannot reach them right now.'); return; }
  if (!pins.length) { $('#map').innerHTML = emptyView('', 'No places yet', 'Photos need a location in the file. Phone pictures usually have one.'); return; }
  $('#map').innerHTML = '';
  const map = L.map('map', { zoomControl: true });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
  const cluster = L.markerClusterGroup({ showCoverageOnHover: false });
  pins.forEach((p, i) => {
    const m = L.marker([p.lat, p.lon], { icon: L.divIcon({ className: 'map-pin', html: `<img src="${p.thumb}" alt="">`, iconSize: [46, 46] }) });
    m.on('click', () => lightbox(pins, i));
    cluster.addLayer(m);
  });
  map.addLayer(cluster);
  if (pins.length) map.fitBounds(cluster.getBounds(), { padding: [30, 30], maxZoom: 14 }); else map.setView([-37.81, 144.96], 9);
  onLeave(() => map.remove());
};

ROUTES['photo-album'] = async () => {
  const ps = params();
  shell('photos', `<div class="page">${loading()}</div>`);
  const photos = await api(`/api/photos?library=${ps.get('library')}&folder=${encodeURIComponent(ps.get('folder') || '')}`);
  // group by month
  const groups = [];
  for (const p of photos) {
    const key = fmtDate(p.takenAt, { month: 'long', year: 'numeric' });
    if (!groups.length || groups[groups.length - 1].key !== key) groups.push({ key, items: [] });
    groups[groups.length - 1].items.push(p);
  }
  let n = 0;
  $('#main').innerHTML = `<div class="page"><a class="back-link" href="#/photos">${ICON.arrowLeft} Photos</a><h1 class="page-title">${esc(ps.get('name') || 'Album')}</h1>
    <div class="btn-row" style="margin-bottom:16px"><button class="btn small" id="slides">${ICON.play} Slideshow</button><span class="hint" style="margin:0">${photos.length} photos</span></div>
    ${groups.map(g => `<h3 class="month">${esc(g.key)}</h3><div class="photo-grid">${g.items.map(p => `<button class="ph" data-i="${n++}"><img src="${p.thumb}" alt="" loading="lazy"></button>`).join('')}</div>`).join('')}</div>`;
  $$('.ph').forEach(b => b.onclick = () => lightbox(photos, +b.dataset.i));
  $('#slides').onclick = () => lightbox(photos, 0, true);
};

function lightbox(photos, start, slideshow = false) {
  let i = start, timer = null;
  const wrap = document.createElement('div');
  wrap.className = 'lightbox';
  wrap.innerHTML = `<img id="lbImg" alt=""><div class="lb-top"><span id="lbInfo"></span><div style="display:flex;gap:6px">
    <button class="icon-btn" id="lbFaces" aria-label="Who's in this photo">${ICON.users}</button><button class="icon-btn" id="lbPlay" aria-label="Slideshow">${ICON.play}</button><a class="icon-btn" id="lbDl" aria-label="Download original" download>${ICON.download}</a>
    <button class="icon-btn" id="lbX" aria-label="Close">${ICON.x}</button></div></div>
    <button class="lb-nav l" id="lbL" aria-label="Previous">${ICON.arrowLeft}</button><button class="lb-nav r" id="lbR" aria-label="Next">${ICON.chevron}</button>`;
  document.body.appendChild(wrap);
  const show = k => {
    i = (k + photos.length) % photos.length;
    const p = photos[i];
    const img = $('#lbImg', wrap);
    img.classList.add('fading');
    const pre = new Image();
    pre.onload = () => { img.src = pre.src; img.classList.remove('fading'); };
    pre.src = p.display;
    $('#lbInfo', wrap).textContent = `${fmtDate(p.takenAt, { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' })} · ${i + 1} of ${photos.length}`;
    $('#lbDl', wrap).href = p.original;
    new Image().src = photos[(i + 1) % photos.length].display;
  };
  const close = () => { clearInterval(timer); wrap.remove(); removeEventListener('keydown', key); };
  const toggleShow = () => {
    if (timer) { clearInterval(timer); timer = null; $('#lbPlay', wrap).innerHTML = ICON.play; }
    else { timer = setInterval(() => show(i + 1), 4500); $('#lbPlay', wrap).innerHTML = ICON.pause; }
  };
  const key = e => { if (e.key === 'ArrowRight') show(i + 1); else if (e.key === 'ArrowLeft') show(i - 1); else if (e.key === 'Escape') close(); else return; e.preventDefault(); };
  addEventListener('keydown', key);
  $('#lbX', wrap).onclick = close;
  $('#lbL', wrap).onclick = () => show(i - 1);
  $('#lbR', wrap).onclick = () => show(i + 1);
  $('#lbPlay', wrap).onclick = toggleShow;
  $('#lbFaces', wrap).onclick = () => { if (timer) toggleShow(); PhotoFaces.open(photos[i]); };
  let sx = null;
  wrap.addEventListener('touchstart', e => { sx = e.touches[0].clientX; }, { passive: true });
  wrap.addEventListener('touchend', e => { if (sx == null) return; const dx = e.changedTouches[0].clientX - sx; if (Math.abs(dx) > 50) show(i + (dx < 0 ? 1 : -1)); sx = null; });
  onLeave(close);
  show(i);
  if (slideshow) toggleShow();
}

// ---------- home videos ----------
ROUTES['home-videos'] = async () => {
  shell('homevideos', `<div class="page"><h1 class="page-title">Home Videos</h1>${loading()}</div>`);
  const vids = await api('/api/home-videos');
  const by = params().get('by') || 'date';
  const groups = new Map();
  for (const v of vids) {
    const key = by === 'folder' ? (v.folder || 'Other') : fmtDate(v.takenAt, { month: 'long', year: 'numeric' });
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(v);
  }
  $('#main').innerHTML = `<div class="page"><h1 class="page-title">Home Videos</h1>
    <div class="toolbar"><a class="chip ${by === 'date' ? 'on' : ''}" href="#/home-videos?by=date">By date</a><a class="chip ${by === 'folder' ? 'on' : ''}" href="#/home-videos?by=folder">By folder</a></div>
    ${vids.length ? [...groups].map(([k, list]) => `<h3 class="month">${esc(k)}</h3><div class="grid wide">${list.map(wideCard).join('')}</div>`).join('')
      : emptyView(ICON.camera, 'No home videos yet', 'Add a Home Videos library in Settings — great for phone videos and family clips.')}</div>`;
};
