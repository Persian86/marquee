/* Marquee — shared helpers, layout, router */
'use strict';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const app = $('#app');
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const deviceId = store.get('mq_device') || (() => { const id = Math.random().toString(36).slice(2) + Date.now().toString(36); store.set('mq_device', id); return id; })();
const ROUTES = {};
let me = null;
let offline = false;
let cleanups = [];
const onLeave = fn => cleanups.push(fn);

const ICON = {
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/></svg>',
  film: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2.5"/><path d="M7 3v18M17 3v18M3 8h4M3 16h4M17 8h4M17 16h4M3 12h18"/></svg>',
  tv: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="6" width="19" height="13" rx="2.5"/><path d="m8 2 4 4 4-4"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.8v14.4a1 1 0 0 0 1.5.86l12-7.2a1 1 0 0 0 0-1.72l-12-7.2A1 1 0 0 0 7 4.8z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="5.5" y="4" width="4.5" height="16" rx="1.2"/><rect x="14" y="4" width="4.5" height="16" rx="1.2"/></svg>',
  back10: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><text x="12" y="15.5" font-size="7.5" font-weight="700" text-anchor="middle" fill="currentColor" stroke="none" font-family="sans-serif">10</text></svg>',
  fwd30: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/><text x="12" y="15.5" font-size="7.5" font-weight="700" text-anchor="middle" fill="currentColor" stroke="none" font-family="sans-serif">30</text></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
  arrowLeft: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 5 7 7-7 7"/></svg>',
  settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/></svg>',
  expand: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
  next: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M5 5.6v12.8a1 1 0 0 0 1.5.86L16 13.5V18a1 1 0 0 0 2 0V6a1 1 0 0 0-2 0v4.5L6.5 4.74A1 1 0 0 0 5 5.6z"/></svg>',
  prev: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 5.6v12.8a1 1 0 0 1-1.5.86L8 13.5V18a1 1 0 0 1-2 0V6a1 1 0 0 1 2 0v4.5l9.5-5.76A1 1 0 0 1 19 5.6z"/></svg>',
  folder: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 6.5A2.5 2.5 0 0 1 5.5 4h3.6a2 2 0 0 1 1.4.6L12 6h6.5A2.5 2.5 0 0 1 21 8.5v9a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/></svg>',
  lock: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 10V7a5 5 0 0 1 10 0v3h.5A1.5 1.5 0 0 1 19 11.5v8a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 19.5v-8A1.5 1.5 0 0 1 6.5 10zm2 0h6V7a3 3 0 0 0-6 0z"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 0 0-14.6-4.5L4 8M4 4v4h4M4 13a8 8 0 0 0 14.6 4.5L20 16M20 20v-4h-4"/></svg>',
  popcorn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 9h14l-1.6 11.2a1 1 0 0 1-1 .8H7.6a1 1 0 0 1-1-.8z"/><path d="M9.5 9l.5 12M14.5 9l-.5 12"/><path d="M6 9a2.5 2.5 0 0 1 1.3-4.6A3 3 0 0 1 12 3a3 3 0 0 1 4.7 1.4A2.5 2.5 0 0 1 18 9"/></svg>',
  bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>',
  grid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="2"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="2"/></svg>',
  music: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
  photo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/></svg>',
  camera: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m16 13 5.2 3.5a.5.5 0 0 0 .8-.4V7.9a.5.5 0 0 0-.8-.4L16 11"/><rect x="2" y="6" width="14" height="12" rx="2.5"/></svg>',
  bookmark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>',
  bookmarkOn: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M19 21l-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>',
  stack: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 2 10 5-10 5L2 7z"/><path d="m2 17 10 5 10-5M2 12l10 5 10-5"/></svg>',
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12m0 0-5-5m5 5 5-5M4 19h16"/></svg>',
  users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6.5 6.5 0 0 1 3.5 6"/></svg>',
  pulse: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l3-8 4 16 3-8h4"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M5 7l1 13a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1l1-13M9 7V4h6v3"/></svg>',
  shuffle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/></svg>',
  cast: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 8V6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-6"/><path d="M2 12a9 9 0 0 1 8 8M2 16a5 5 0 0 1 4 4"/><circle cx="2.5" cy="20" r=".8" fill="currentColor"/></svg>',
  pip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><rect x="12" y="11" width="8" height="7" rx="1" fill="currentColor"/></svg>',
  airplay: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 17H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-1"/><path d="m12 15 5 6H7z"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  moon: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11z"/></svg>',
  share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v13M7 8l5-5 5 5M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/></svg>',
  star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z"/></svg>',
  user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>',
};
const LOGO = '<svg class="mark" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#f0b429"/><path d="M11.5 9.5v13l11-6.5z" fill="#1a1203"/><g fill="#1a1203"><circle cx="5.5" cy="8" r="1.3"/><circle cx="5.5" cy="13.3" r="1.3"/><circle cx="5.5" cy="18.7" r="1.3"/><circle cx="5.5" cy="24" r="1.3"/><circle cx="26.5" cy="8" r="1.3"/><circle cx="26.5" cy="24" r="1.3"/></g></svg>';

function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('on'), ms);
}

class ApiError extends Error { constructor(msg, status, data) { super(msg); this.status = status; this.data = data; } }
async function api(path, opts = {}) {
  const init = { method: opts.method || (opts.body ? 'POST' : 'GET'), headers: {}, credentials: 'same-origin' };
  if (opts.body) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(opts.body); }
  if (opts.keepalive) init.keepalive = true;
  let res;
  try { res = await fetch(path, init); }
  catch (e) { throw new ApiError("Can't reach your server", 0); }
  if (res.status === 401 && !opts.allow401) { me = null; go('#/who'); throw new ApiError('Signed out', 401); }
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new ApiError((data && data.error) || `Request failed (${res.status})`, res.status, data);
  return data;
}
function go(hash, replace) { if (replace) location.replace(hash); else location.hash = hash; }
function back(fallback = '#/') { if (history.length > 1) history.back(); else go(fallback, true); }

const fmtTime = s => {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
};
const fmtRuntime = min => (!min ? '' : min >= 60 ? `${Math.floor(min / 60)}h ${min % 60 ? (min % 60) + 'm' : ''}`.trim() : `${min}m`);
const fmtBytes = b => (!b ? '0 MB' : b > 1e12 ? (b / 1e12).toFixed(1) + ' TB' : b > 1e9 ? (b / 1e9).toFixed(1) + ' GB' : (b / 1e6).toFixed(0) + ' MB');
const fmtMins = s => { const m = Math.round((s || 0) / 60); return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m} min`; };
const fmtDate = (t, opts = { day: 'numeric', month: 'short', year: 'numeric' }) => (t ? new Date(t).toLocaleDateString(undefined, opts) : '');
const ago = t => { const s = (Date.now() - t) / 1000; return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : fmtDate(t); };
const hue = s => [...String(s)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % 360;
const epCode = i => (i.season != null && i.episode != null ? `S${i.season} · E${i.episode}` : i.season === 0 ? 'Special' : '');
const avatar = (p, size = 32, radius = 9) => `<span class="avatar" style="background:${p.color};width:${size}px;height:${size}px;border-radius:${radius}px;font-size:${Math.round(size * .45)}px">${esc((p.name || '?')[0].toUpperCase())}</span>`;

function fallbackArt(title, sub) {
  const h = hue(title);
  return `<div class="fallback" style="background:linear-gradient(160deg,hsl(${h} 42% 30%),hsl(${(h + 40) % 360} 48% 12%))">${esc(title)}${sub ? `<small>${esc(sub)}</small>` : ''}</div>`;
}

// ---------- big grids ----------
// Drawing thousands of posters at once makes phones crawl, so grids start with a screenful and add more as you scroll.
function growGrid(grid, items, render, first = 90, step = 120) {
  if (!grid) return;
  let shown = Math.min(first, items.length);
  grid.innerHTML = items.slice(0, shown).map(render).join('');
  if (shown >= items.length) return;
  const more = document.createElement('div');
  more.className = 'grid-more';
  grid.after(more);
  const add = () => {
    if (!more.isConnected) return io.disconnect();
    const next = Math.min(items.length, shown + step);
    grid.insertAdjacentHTML('beforeend', items.slice(shown, next).map(render).join(''));
    shown = next;
    if (shown >= items.length) { io.disconnect(); more.remove(); }
  };
  const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) add(); }, { rootMargin: '1200px 0px' });
  io.observe(more);
}

// ---------- cards ----------
function posterCard(item) {
  if (item.type === 'home') return wideCard(item);
  const watched = item.progress?.watched || (item.type === 'show' && item.episodeCount && item.unwatched === 0);
  const pct = item.progress && !item.progress.watched && item.progress.position > 0 && item.progress.duration ? Math.min(100, item.progress.position / item.progress.duration * 100) : 0;
  const badge = item.type === 'show' && item.unwatched > 0 ? `<span class="badge">${item.unwatched}</span>` : watched ? `<span class="badge done">${ICON.check}</span>` : '';
  const sub = item.character ? item.character : item.type === 'show' ? (item.seasonCount ? `${item.seasonCount} season${item.seasonCount === 1 ? '' : 's'}` : `${item.episodeCount || 0} episodes`) : item.year || '';
  return `<a class="card" href="#/item/${item.id}">
    <div class="poster">${item.poster ? `<img src="${item.poster}" alt="" loading="lazy">` : fallbackArt(item.title, item.year)}${badge}${pct ? `<div class="bar"><i style="width:${pct}%"></i></div>` : ''}</div>
    <div class="cap">${esc(item.title)}</div>
    <div class="sub">${esc(sub)}</div>
  </a>`;
}
function wideCard(item) {
  const img = item.still || item.backdrop || item.show?.backdrop || item.poster || item.show?.poster;
  const pct = item.progress && item.progress.duration && !item.progress.watched ? Math.min(100, item.progress.position / item.progress.duration * 100) : 0;
  const title = item.show ? item.show.title : item.title;
  const sub = item.show ? [epCode(item), item.title].filter(Boolean).join(' · ')
    : item.type === 'home' ? [fmtDate(item.takenAt), item.duration && fmtTime(item.duration)].filter(Boolean).join(' · ')
    : (item.progress?.duration && pct ? `${fmtTime(item.progress.duration - item.progress.position)} left` : item.year || '');
  return `<a class="card" href="#/play/${item.id}">
    <div class="thumb">${img ? `<img src="${img}" alt="" loading="lazy">` : fallbackArt(title)}
      <span class="play-ico">${ICON.play}</span>${pct ? `<div class="bar"><i style="width:${pct}%"></i></div>` : ''}</div>
    <div class="cap">${esc(title)}</div><div class="sub">${esc(sub)}</div>
  </a>`;
}
function collectionCard(c, href) {
  const art = c.poster || (c.covers && c.covers[0]);
  return `<a class="card" href="${href}">
    <div class="poster stackcard">${c.covers && c.covers.length > 1 ? `<div class="mosaic">${c.covers.slice(0, 4).map(u => `<img src="${u}" alt="" loading="lazy">`).join('')}</div>`
      : art ? `<img src="${art}" alt="" loading="lazy">` : fallbackArt(c.name)}<span class="badge">${c.count}</span></div>
    <div class="cap">${esc(c.name)}</div><div class="sub">${c.owner ? `by ${esc(c.owner)}` : 'Collection'}</div>
  </a>`;
}
function personCard(p) {
  return `<a class="card person" href="#/person/${p.id}">
    <div class="face">${p.photo ? `<img src="${p.photo}" alt="" loading="lazy">` : `<span>${esc(p.name.split(' ').map(x => x[0]).slice(0, 2).join(''))}</span>`}</div>
    <div class="cap">${esc(p.name)}</div><div class="sub">${esc(p.role === 'director' ? 'Director' : p.role === 'creator' ? 'Creator' : p.character || '')}</div>
  </a>`;
}
function albumCard(a) {
  return `<a class="card" href="#/album?artist=${encodeURIComponent(a.artist)}&album=${encodeURIComponent(a.album)}">
    <div class="poster square">${a.poster ? `<img src="${a.poster}" alt="" loading="lazy">` : fallbackArt(a.album)}</div>
    <div class="cap">${esc(a.album)}</div><div class="sub">${esc(a.artist)}${a.year ? ' · ' + a.year : ''}</div></a>`;
}
function row(title, items, kind = 'posters', link, render) {
  if (!items || !items.length) return '';
  const fn = render || (kind === 'wide' ? wideCard : kind === 'people' ? personCard : kind === 'albums' ? albumCard : posterCard);
  return `<section class="row"><div class="row-head"><h2>${esc(title)}</h2>${link ? `<a href="${link}">See all</a>` : ''}</div>
    <div class="scroller ${kind}">${items.map(fn).join('')}</div></section>`;
}

// ---------- layout ----------
function navItems() {
  const s = me?.sections || {};
  const items = [['home', '#/', ICON.home, 'Home']];
  if (s.movies || !me?.isKids) items.push(['movies', '#/movies', ICON.film, 'Movies']);
  if (s.shows || !me?.isKids) items.push(['shows', '#/shows', ICON.tv, 'TV Shows']);
  if (s.music) items.push(['music', '#/music', ICON.music, 'Music']);
  if (s.photos) items.push(['photos', '#/photos', ICON.photo, 'Photos']);
  if (s.home) items.push(['homevideos', '#/home-videos', ICON.camera, 'Home Videos']);
  if (s.podcasts && !me?.isKids) items.push(['podcasts', '#/podcasts', ICON.bell, 'Podcasts']);
  return items;
}
function shell(active, inner, { transparent = false } = {}) {
  const kids = me?.isKids;
  const nav = navItems();
  const tab = ([id, href, icon, label]) => `<a href="${href}" class="${active === id ? 'active' : ''}">${icon}<span>${label}</span></a>`;
  const mobileTabs = kids
    ? nav.slice(0, 4).concat([['who', '#/who', ICON.user, 'Switch']])
    : [nav[0], nav[1], nav[2], ['search', '#/search', ICON.search, 'Search'], ['more', '#/more', ICON.grid, 'More']];
  app.innerHTML = `
    <header class="topbar ${transparent ? '' : 'solid'} ${kids ? 'kids' : ''}" id="topbar">
      <a class="logo" href="#/">${LOGO}<span>${esc(me?.serverName || 'Marquee')}</span></a>
      <nav class="nav-links">${nav.map(([id, href, , label]) => `<a href="${href}" class="${active === id ? 'active' : ''}">${label}</a>`).join('')}
        ${kids ? '' : `<a href="#/collections" class="${active === 'collections' ? 'active' : ''}">Collections</a>`}</nav>
      <div class="spacer"></div>
      ${kids ? '' : `<a class="icon-btn" href="#/search" aria-label="Search">${ICON.search}</a>
      <a class="icon-btn bell" href="#/notifications" aria-label="What's new">${ICON.bell}${unreadCount() ? '<i class="dot"></i>' : ''}</a>`}
      <a href="${kids ? '#/who' : '#/settings'}" aria-label="${kids ? 'Switch profile' : 'Settings and profile'}">${avatar(me || { name: '?', color: '#888' })}</a>
    </header>
    ${offline ? '<div class="offline-bar">You’re offline — showing your downloads</div>' : ''}
    <main id="main" class="${kids ? 'kids' : ''}">${inner}</main>
    <nav class="tabbar ${kids ? 'kids' : ''}" style="grid-template-columns:repeat(${mobileTabs.length},1fr)">${mobileTabs.map(tab).join('')}</nav>`;
  if (transparent) {
    const bar = $('#topbar');
    const onScroll = () => bar.classList.toggle('solid', scrollY > 60);
    addEventListener('scroll', onScroll, { passive: true });
    onLeave(() => removeEventListener('scroll', onScroll));
  }
  MiniPlayer.mount();
}
function unreadCount() { return (me && me.unread) || 0; }
const meUrl = () => `/api/me?since=${store.get('mq_seen_notes', 0)}`;
const loading = () => `<div class="center"><div class="spinner"></div></div>`;
function errorView(e) {
  return `<div class="empty"><h2>Something went wrong</h2><p>${esc(e.message)}</p><button class="btn" onclick="location.reload()">Try again</button></div>`;
}
function emptyView(icon, title, text, action = '') {
  return `<div class="empty">${icon}<h2>${esc(title)}</h2><p>${text}</p>${action}</div>`;
}

// ---------- modal ----------
function modal(html, { onClose, wide } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'modal-wrap';
  wrap.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog">${html}</div>`;
  const close = () => { if (!wrap.isConnected) return; wrap.remove(); onClose && onClose(); };
  wrap.addEventListener('click', e => { if (e.target === wrap) close(); });
  document.body.appendChild(wrap);
  onLeave(close);
  const first = $('input, button, select, a', wrap.firstChild);
  if (first && !matchMedia('(pointer:coarse)').matches) setTimeout(() => first.focus(), 50);
  return { el: $('.modal', wrap), close };
}
function confirmTwice(btn, label) {
  if (btn.dataset.confirm === '1') return true;
  btn.dataset.confirm = '1';
  btn.textContent = label || 'Tap again to confirm';
  return false;
}

// ---------- router ----------
const KIDS_BLOCKED = ['settings', 'activity', 'duplicates', 'search', 'notifications', 'requests'];
async function route() {
  cleanups.splice(0).forEach(fn => { try { fn(); } catch {} });
  const hash = location.hash || '#/';
  const [p] = hash.slice(1).split('?');
  const parts = p.split('/').filter(Boolean);
  if (parts[0] !== 'play') scrollTo(0, 0);
  try {
    if (!me && !['who', 'setup', 'downloads', 'offline', 'invite'].includes(parts[0])) {
      let st;
      try { st = await api('/api/status'); }
      catch (e) {
        if (e.status === 0 && Downloads.saved().length) { offline = true; return go('#/downloads', true); }
        throw e;
      }
      offline = false;
      if (st.needsSetup) return go('#/setup', true);
      try { me = await api(meUrl(), { allow401: true }); }
      catch { return go('#/who', true); }
    }
    const handler = ROUTES[parts[0] || ''] || ROUTES[''];
    if (me?.isKids && KIDS_BLOCKED.includes(parts[0])) { toast('That’s for grown-ups — switch to a grown-up profile to open it'); return go('#/', true); }
    await handler(...parts.slice(1));
  } catch (e) {
    if (e.message === 'Signed out') return;
    console.error(e);
    const main = $('#main') || app;
    main.innerHTML = `<div class="page">${errorView(e)}</div>`;
  }
}
async function refreshMe() { me = await api(meUrl()); return me; }
function params() { return new URLSearchParams(location.hash.split('?')[1] || ''); }
