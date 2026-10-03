// Sign-in, browsing, details, playback.
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, getSetting, setSetting } = require('../db');
const C = require('../common');
const scanner = require('../scanner');
const tmdb = require('../tmdb');
const stream = require('../stream');
const activity = require('../features/activity');
const versions = require('../features/versions');
const cast = require('../features/cast');
const notify = require('../features/notify');
const rooms = require('../features/rooms');
const trakt = require('../features/trakt');
const subtitles = require('../features/subtitles');
const requestsF = require('../features/requests');
const trickplay = require('../features/trickplay');
const security = require('../features/security');

const { now, formatItem, visible, showList, movieList, getVisibleItem, PROGRESS_COLS, PROGRESS_JOIN, EP_ORDER, wrap } = C;
const r = express.Router();

// ---------- public ----------
r.get('/status', (req, res) => {
  const count = db.prepare('SELECT COUNT(*) AS n FROM profiles').get().n;
  res.json({ needsSetup: count === 0, name: getSetting('server_name', 'Marquee') });
});

r.post('/setup', (req, res) => {
  if (db.prepare('SELECT COUNT(*) AS n FROM profiles').get().n > 0) return res.status(400).json({ error: 'Already set up' });
  const { name, pin } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name required' });
  if (!pin || !/^\d{4,8}$/.test(String(pin))) return res.status(400).json({ error: 'Admin PIN must be 4–8 digits' });
  const x = db.prepare('INSERT INTO profiles(name, color, pin_hash, is_admin, is_kids, max_level, created_at) VALUES (?, ?, ?, 1, 0, 4, ?)')
    .run(String(name).trim().slice(0, 30), C.COLORS[0], C.hashPin(pin), now());
  const p0 = db.prepare('SELECT * FROM profiles WHERE id = ?').get(Number(x.lastInsertRowid));
  C.createSession(res, p0.id, req, { deviceId: security.succeeded(req, res, p0) });
  res.json({ ok: true });
});

function cookieSession(req) {
  const token = C.parseCookies(req).mq_session;
  return token ? db.prepare('SELECT * FROM sessions WHERE token = ?').get(token) : null;
}
r.get('/profiles', (req, res) => {
  const sess = cookieSession(req);
  const rows = sess?.guest ? db.prepare('SELECT * FROM profiles WHERE id = ?').all(sess.profile_id) : db.prepare('SELECT * FROM profiles WHERE hidden = 0 ORDER BY is_admin DESC, id').all();
  res.json(rows.map(p => {
    const { id, name, color, hasPin, isKids } = C.publicProfile(p);
    return { id, name, color, hasPin, isKids };
  }));
});

r.post('/login', (req, res) => {
  const { profileId, pin } = req.body || {};
  const p = db.prepare('SELECT * FROM profiles WHERE id = ?').get(profileId);
  if (!p) return res.status(404).json({ error: 'Profile not found' });
  // A device signed in through an invite link can't hop to family profiles
  const sess = cookieSession(req);
  if (sess?.guest && sess.profile_id !== p.id) return res.status(403).json({ error: 'This device was invited as a guest' });
  if (p.hidden && !sess?.guest) return res.status(404).json({ error: 'Profile not found' });
  const block = security.blocked(req, p.id);
  if (block) return res.status(429).json({ error: block });
  if (!C.checkPin(pin, p.pin_hash)) { security.failed(req, p); return res.status(401).json({ error: 'Wrong PIN' }); }
  const deviceId = security.succeeded(req, res, p);
  if (sess) db.prepare('DELETE FROM sessions WHERE token = ?').run(sess.token); // switching profile replaces this device's old sign-in
  C.createSession(res, p.id, req, { deviceId, guest: !!sess?.guest });
  res.json(C.publicProfile(p));
});

// Invite links for friends & family outside the house
r.post('/invite/:token', (req, res) => {
  const inv = db.prepare('SELECT * FROM invites WHERE token = ?').get(req.params.token);
  if (!inv || (inv.expires_at && inv.expires_at < now())) return res.status(404).json({ error: 'This invite link has expired — ask for a new one' });
  const p = db.prepare('SELECT * FROM profiles WHERE id = ?').get(inv.profile_id);
  if (!p) return res.status(404).json({ error: 'This invite is no longer valid' });
  db.prepare('UPDATE invites SET uses = uses + 1 WHERE token = ?').run(inv.token);
  security.log(req, p.id, true, 'invite link');
  C.createSession(res, p.id, req, { guest: true });
  res.json({ ok: true, name: p.name });
});

// ---------- signed in from here ----------
function auth(req, res, next) {
  const token = C.parseCookies(req).mq_session;
  const row = token && db.prepare('SELECT p.*, s.guest AS is_guest, s.created_at AS s_created, s.last_seen AS s_last_seen FROM sessions s JOIN profiles p ON p.id = s.profile_id WHERE s.token = ?').get(token);
  if (!row) {
    // The Marquee apps' own background parts (widgets, Android Auto) sign in with a device key instead of a cookie
    const h = req.headers.authorization || '';
    const key = h.startsWith('Bearer mq_') ? h.slice(7).trim() : null;
    const dev = key && db.prepare("SELECT p.*, 0 AS is_guest FROM app_tokens t JOIN profiles p ON p.id = t.profile_id WHERE t.token = ? AND t.kind = 'device'").get(key);
    if (!dev) return res.status(401).json({ error: 'Not signed in' });
    req.profile = dev;
    req.token = null;
    if (Math.random() < 0.05) db.prepare('UPDATE app_tokens SET last_used = ? WHERE token = ?').run(now(), key);
    return next();
  }
  if (row.is_guest && now() - (row.s_created || 0) > 1000 * 60 * 60 * 24 * 30) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return res.status(401).json({ error: 'This guest sign-in has expired — ask for a new invite' });
  }
  req.profile = row;
  req.token = token;
  if (now() - (row.s_last_seen || 0) > 60000) db.prepare('UPDATE sessions SET last_seen = ?, ip = ? WHERE token = ?').run(now(), String(req.ip || '').replace(/^::ffff:/, ''), token);
  next();
}
r.use((req, res, next) => (req.path === '/status' || req.path.startsWith('/invite/') ? next() : auth(req, res, next)));

// Signed-in devices: see them and sign any out
r.get('/sessions', (req, res) => res.json({ sessions: security.sessions(req.profile, req.token), signins: req.profile.is_admin ? security.recentSignins(60) : [], blocked: req.profile.is_admin ? security.blockedAddresses() : [] }));
r.delete('/sessions/:id', (req, res) => res.json({ ok: security.revoke(req.profile, req.params.id) }));
r.post('/sessions/unblock', (req, res) => { if (req.profile.is_admin) security.unblock(String(req.body?.ip || '')); res.json({ ok: true }); });

r.post('/logout', (req, res) => {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(req.token);
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `mq_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
  res.json({ ok: true });
});

function sections(p) {
  const count = sql => db.prepare(`SELECT COUNT(*) AS n FROM items i JOIN libraries l ON l.id = i.library_id WHERE ${sql} AND ${visible(p)}`).get().n;
  return {
    movies: count("i.type = 'movie'") > 0, shows: count("i.type = 'show'") > 0, home: count("i.type = 'home'") > 0,
    music: count("i.type = 'track'") > 0, photos: count("i.type = 'photo'") > 0,
    podcasts: !p.is_kids || db.prepare('SELECT COUNT(*) AS n FROM podcasts').get().n > 0,
    requests: (requestsF.configured('radarr') || requestsF.configured('sonarr')) && !p.is_guest, subtitles: subtitles.configured(),
  };
}

r.get('/me', (req, res) => {
  const p = req.profile;
  res.json({
    ...C.publicProfile(p), guest: !!p.is_guest, serverName: getSetting('server_name', 'Marquee'), sections: sections(p),
    screenTime: activity.check(p), usedToday: activity.usedToday(p.id), limitToday: activity.limitFor(p),
    pushKey: notify.publicKey(), unread: db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE created_at > ?').get(+req.query.since || 0).n,
  });
});
r.patch('/me', (req, res) => {
  if (req.body?.autoSkipIntro != null) db.prepare('UPDATE profiles SET auto_skip_intro = ? WHERE id = ?').run(req.body.autoSkipIntro ? 1 : 0, req.profile.id);
  if (req.body?.autoSubs != null) db.prepare('UPDATE profiles SET auto_subs = ? WHERE id = ?').run(req.body.autoSubs ? 1 : 0, req.profile.id);
  if (req.body?.cinemaMode != null) db.prepare('UPDATE profiles SET cinema_mode = ? WHERE id = ?').run(req.body.cinemaMode ? 1 : 0, req.profile.id);
  if (req.body?.themeMusic != null) db.prepare('UPDATE profiles SET theme_music = ? WHERE id = ?').run(req.body.themeMusic ? 1 : 0, req.profile.id);
  if (req.body?.subLang && /^[a-z]{2}(-[a-z]{2})?$/i.test(req.body.subLang)) db.prepare('UPDATE profiles SET sub_lang = ? WHERE id = ?').run(req.body.subLang.toLowerCase(), req.profile.id);
  res.json({ ok: true });
});

// ---------- home ----------
function nextEpisodeFor(profile, showId, onlyIfStarted = false) {
  const eps = db.prepare(`SELECT i.*, ${PROGRESS_COLS}, pr.updated_at AS pupdated, s.title AS show_title, s.poster AS show_poster, s.backdrop AS show_backdrop
    FROM items i JOIN items s ON s.id = i.parent_id ${PROGRESS_JOIN}
    WHERE i.parent_id = ? ORDER BY ${EP_ORDER}`).all(profile.id, showId);
  if (!eps.length) return null;
  let lastIdx = -1, lastTime = 0;
  eps.forEach((e, idx) => { if (e.pupdated && e.pupdated > lastTime) { lastTime = e.pupdated; lastIdx = idx; } });
  if (lastIdx === -1) return onlyIfStarted ? null : formatItem(eps.find(e => e.season !== 0) || eps[0]);
  const last = eps[lastIdx];
  if (!last.watched && last.position > 30) return formatItem(last);
  for (let k = lastIdx + 1; k < eps.length; k++) if (!eps[k].watched) return formatItem(eps[k]);
  return onlyIfStarted ? null : formatItem(eps.find(e => !e.watched) || eps[0]);
}
function nextUp(profile, limit = 20) {
  const shows = db.prepare(`SELECT s.id, MAX(pr.updated_at) AS last FROM progress pr
      JOIN items e ON e.id = pr.item_id JOIN items s ON s.id = e.parent_id JOIN libraries l ON l.id = s.library_id
      WHERE pr.profile_id = ? AND e.type = 'episode' AND ${visible(profile, 's.level')}
      GROUP BY s.id ORDER BY last DESC LIMIT 50`).all(profile.id);
  const out = [];
  for (const s of shows) {
    const n = nextEpisodeFor(profile, s.id, true);
    if (n) out.push(n);
    if (out.length >= limit) break;
  }
  return out;
}
function collectionsFor(p, limit = 50, id = null) {
  return db.prepare(`SELECT c.*, COUNT(i.id) AS n FROM collections c JOIN items i ON i.collection_id = c.id AND i.type = 'movie'
    JOIN libraries l ON l.id = i.library_id WHERE ${visible(p)} AND ${C.NOT_DUP} ${id ? 'AND c.id = ?' : ''}
    GROUP BY c.id HAVING n >= ${id ? 1 : 2} ORDER BY c.name LIMIT ${limit | 0}`).all(...(id ? [id] : []))
    .map(c => ({ id: c.id, name: c.name, count: c.n, poster: c.poster ? `/img/${c.poster}` : null, backdrop: c.backdrop ? `/img/${c.backdrop}` : null }));
}

r.get('/home', (req, res) => {
  const p = req.profile;
  const cont = db.prepare(`SELECT i.*, ${PROGRESS_COLS}, s.title AS show_title, s.poster AS show_poster, s.backdrop AS show_backdrop
    FROM progress pr JOIN items i ON i.id = pr.item_id LEFT JOIN items s ON s.id = i.parent_id
    JOIN libraries l ON l.id = i.library_id
    WHERE pr.profile_id = ? AND pr.watched = 0 AND pr.position > 30 AND (pr.duration IS NULL OR pr.position < pr.duration * 0.92)
      AND i.type IN ('movie','episode','home') AND ${visible(p, 'COALESCE(s.level, i.level)')}
    ORDER BY pr.updated_at DESC LIMIT 20`).all(p.id).map(formatItem);
  const contIds = new Set(cont.map(c => c.id));
  const up = nextUp(p).filter(e => !contIds.has(e.id));
  const featuredPool = movieList(p, 'i.backdrop IS NOT NULL AND (pr.watched IS NULL OR pr.watched = 0)', 'RANDOM()', 6)
    .concat(showList(p, 'i.backdrop IS NOT NULL', 'RANDOM()', 4));
  const listIds = db.prepare('SELECT item_id FROM watchlist WHERE profile_id = ? ORDER BY added_at DESC LIMIT 30').all(p.id).map(x => x.item_id);
  res.json({
    featured: featuredPool.sort(() => Math.random() - 0.5).slice(0, 5),
    continueWatching: cont,
    nextUp: up,
    myList: C.itemsByIds(p, listIds),
    recentMovies: movieList(p, '1=1', 'i.added_at DESC', 24),
    recentShows: showList(p, '1=1', 'i.added_at DESC', 24),
    collections: collectionsFor(p, 20),
    recentHome: db.prepare(`SELECT i.* FROM items i JOIN libraries l ON l.id = i.library_id WHERE i.type = 'home' AND ${visible(p)} ORDER BY i.added_at DESC LIMIT 12`).all().map(formatItem),
    allMovies: p.is_kids ? movieList(p, '1=1', 'i.sort_title', 200, [], C.formatCard) : undefined,
    allShows: p.is_kids ? showList(p, '1=1', 'i.sort_title', 200, [], C.formatCard) : undefined,
    tonight: C.itemsByIds(p, tonightIds()),
    counts: {
      movies: db.prepare(`SELECT COUNT(*) AS n FROM items i JOIN libraries l ON l.id = i.library_id WHERE i.type = 'movie' AND ${visible(p)}`).get().n,
      shows: db.prepare(`SELECT COUNT(*) AS n FROM items i JOIN libraries l ON l.id = i.library_id WHERE i.type = 'show' AND ${visible(p)}`).get().n,
      other: db.prepare(`SELECT COUNT(*) AS n FROM items i JOIN libraries l ON l.id = i.library_id WHERE i.type IN ('home','track','photo') AND ${visible(p)}`).get().n,
    },
    screenTime: activity.check(p),
    libraries: db.prepare('SELECT COUNT(*) AS n FROM libraries').get().n,
    scanning: scanner.status.running,
  });
});

function tonightIds() {
  try { return JSON.parse(getSetting('tonight', '[]')).map(n => n | 0).filter(Boolean); } catch { return []; }
}
r.post('/tonight', (req, res) => {
  if (!req.profile.is_admin) return res.status(403).json({ error: 'Only an admin can set Tonight' });
  const id = req.body?.itemId | 0;
  if (!id) return res.status(400).json({ error: 'Nothing to add' });
  let ids = tonightIds().filter(n => n !== id);
  if (req.body?.on !== false) ids.unshift(id);
  setSetting('tonight', JSON.stringify(ids.slice(0, 24)));
  res.json({ ok: true, ids });
});

const SORTS = { title: 'i.sort_title', added: 'i.added_at DESC', year: 'i.year DESC, i.sort_title', rating: 'i.vote DESC NULLS LAST, i.sort_title' };
r.get('/movies', (req, res) => {
  const sort = SORTS[req.query.sort] || SORTS.title;
  const where = [], params = [];
  if (req.query.genre) { where.push(`(', ' || i.genres || ', ') LIKE ?`); params.push(`%, ${req.query.genre}, %`); }
  if (req.query.unwatched === '1') where.push('(pr.watched IS NULL OR pr.watched = 0)');
  res.json(movieList(req.profile, where.join(' AND ') || '1=1', sort, 20000, params, C.formatCard));
});
r.get('/shows', (req, res) => {
  const sort = SORTS[req.query.sort] || SORTS.title;
  const where = [], params = [];
  if (req.query.genre) { where.push(`(', ' || i.genres || ', ') LIKE ?`); params.push(`%, ${req.query.genre}, %`); }
  let list = showList(req.profile, where.join(' AND ') || '1=1', sort, 20000, params, C.formatCard);
  if (req.query.unwatched === '1') list = list.filter(s => s.unwatched > 0);
  res.json(list);
});
r.get('/genres', (req, res) => {
  const type = req.query.type === 'show' ? 'show' : 'movie';
  const rows = db.prepare(`SELECT i.genres FROM items i JOIN libraries l ON l.id = i.library_id WHERE i.type = ? AND i.genres IS NOT NULL AND ${visible(req.profile)}`).all(type);
  const counts = {};
  for (const x of rows) for (const g of x.genres.split(', ')) counts[g] = (counts[g] || 0) + 1;
  res.json(Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })));
});

r.get('/search', (req, res) => {
  const q = String(req.query.q || '').trim();
  const empty = { movies: [], shows: [], episodes: [], people: [], albums: [], tracks: [], home: [], podcasts: [] };
  if (!q) return res.json(empty);
  const like = `%${q.replace(/[%_]/g, '')}%`;
  const p = req.profile;
  res.json({
    movies: movieList(p, 'i.title LIKE ?', 'i.sort_title', 40, [like]),
    shows: showList(p, 'i.title LIKE ?', 'i.sort_title', 40, [like]),
    episodes: db.prepare(`SELECT i.*, ${PROGRESS_COLS}, s.title AS show_title, s.poster AS show_poster FROM items i
      JOIN items s ON s.id = i.parent_id JOIN libraries l ON l.id = s.library_id ${PROGRESS_JOIN}
      WHERE i.type = 'episode' AND i.title LIKE ? AND ${visible(p, 's.level')} ORDER BY s.sort_title, ${EP_ORDER} LIMIT 30`).all(p.id, like).map(formatItem),
    people: db.prepare(`SELECT DISTINCT pe.id, pe.name, pe.photo FROM people pe JOIN credits c ON c.person_id = pe.id JOIN items i ON i.id = c.item_id
      JOIN libraries l ON l.id = i.library_id WHERE pe.name LIKE ? AND ${visible(p)} LIMIT 20`).all(like)
      .map(x => ({ id: x.id, name: x.name, photo: x.photo ? `/img/${x.photo}` : null })),
    albums: db.prepare(`SELECT i.album, i.album_artist, MIN(i.poster) AS poster, COUNT(*) AS n FROM items i JOIN libraries l ON l.id = i.library_id
      WHERE i.type = 'track' AND (i.album LIKE ? OR i.album_artist LIKE ?) AND ${visible(p)} GROUP BY i.album_artist, i.album LIMIT 20`).all(like, like)
      .map(a => ({ album: a.album, artist: a.album_artist, poster: C.img(a.poster), count: a.n })),
    tracks: db.prepare(`SELECT i.* FROM items i JOIN libraries l ON l.id = i.library_id WHERE i.type = 'track' AND (i.title LIKE ? OR i.artist LIKE ?) AND ${visible(p)} LIMIT 30`).all(like, like).map(formatItem),
    home: db.prepare(`SELECT i.* FROM items i JOIN libraries l ON l.id = i.library_id WHERE i.type = 'home' AND (i.title LIKE ? OR i.folder LIKE ?) AND ${visible(p)} LIMIT 20`).all(like, like).map(formatItem),
    podcasts: db.prepare('SELECT id, title, author, image FROM podcasts WHERE title LIKE ? OR author LIKE ? LIMIT 20').all(like, like),
  });
});

// ---------- item details ----------
r.get('/items/:id', (req, res) => {
  const p = req.profile;
  const row = getVisibleItem(p, req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const item = formatItem(row);
  item.inList = !!db.prepare('SELECT 1 FROM watchlist WHERE profile_id = ? AND item_id = ?').get(p.id, row.id);
  item.tonight = tonightIds().includes(row.id);
  item.lists = db.prepare('SELECT list_id FROM list_items WHERE item_id = ?').all(row.id).map(x => x.list_id);
  item.trailer = row.trailer || null;
  item.myRating = db.prepare('SELECT rating FROM ratings WHERE profile_id = ? AND item_id = ?').get(p.id, row.id)?.rating || 0;
  item.edition = row.edition || null;
  item.trickplay = row.trickplay === 1;
  item.theme = !!row.theme && (p.theme_music !== 0);
  item.localTrailer = !!row.local_trailer;
  if (['movie', 'episode', 'home'].includes(row.type)) item.aiSubs = require('../features/aisubs').jobsFor(row.id);
  if (row.type === 'movie') item.creditsStart = row.credits_start || null;
  if (row.type === 'show') {
    const eps = db.prepare(`SELECT i.*, ${PROGRESS_COLS} FROM items i ${PROGRESS_JOIN} WHERE i.parent_id = ? ORDER BY ${EP_ORDER}`).all(p.id, row.id).map(formatItem);
    const seasons = {};
    for (const e of eps) (seasons[e.season] = seasons[e.season] || []).push(e);
    item.seasons = Object.keys(seasons).map(Number).sort((a, b) => (a === 0) - (b === 0) || a - b)
      .map(n => ({ season: n, title: n === 0 ? 'Specials' : `Season ${n}`, episodes: seasons[n] }));
    item.nextEpisode = nextEpisodeFor(p, row.id);
    item.episodeCount = eps.length;
    item.unwatched = eps.filter(e => !e.progress?.watched).length;
  } else if (row.type === 'episode') {
    const sibs = db.prepare(`SELECT i.id FROM items i WHERE i.parent_id = ? ORDER BY ${EP_ORDER}`).all(row.parent_id).map(x => x.id);
    const idx = sibs.indexOf(row.id);
    item.nextId = idx >= 0 && idx < sibs.length - 1 ? sibs[idx + 1] : null;
    item.prevId = idx > 0 ? sibs[idx - 1] : null;
    item.intro = row.intro_end ? { start: row.intro_start || 0, end: row.intro_end } : null;
    item.recap = row.recap_end ? { start: row.recap_start || 0, end: row.recap_end } : null;
    item.creditsStart = row.credits_start || null;
  } else if (row.type === 'home') {
    const sibs = db.prepare(`SELECT i.id FROM items i WHERE i.library_id = ? AND i.type = 'home' AND COALESCE(i.folder, '') = ? ORDER BY i.taken_at, i.sort_title`).all(row.library_id, row.folder || '').map(x => x.id);
    const idx = sibs.indexOf(row.id);
    item.nextId = idx >= 0 && idx < sibs.length - 1 ? sibs[idx + 1] : null;
  }
  if (row.type === 'movie') {
    item.more = row.genres ? movieList(p, `i.id != ? AND (', ' || i.genres || ', ') LIKE ?`, 'RANDOM()', 12, [row.id, `%, ${row.genres.split(', ')[0]}, %`]) : [];
    if (row.collection_id) {
      const c = collectionsFor(p, 1, row.collection_id)[0];
      if (c && c.count > 1) item.collection = c;
    }
    // Other copies of the same film
    item.versions = db.prepare(`SELECT d.id, d.width, d.height, d.video_codec, d.size, d.path, d.edition FROM items i JOIN items d ON (${C.SAME_FILM} OR d.id = i.id)
      WHERE i.id = ? ORDER BY d.height DESC, d.size DESC`).all(row.id)
      .map(v => ({ id: v.id, edition: v.edition || null, label: `${v.edition ? v.edition + ' · ' : ''}${v.height >= 2000 ? '4K' : v.height >= 1000 ? '1080p' : v.height >= 700 ? '720p' : 'SD'} · ${(v.video_codec || '').toUpperCase()} · ${v.size > 1e9 ? (v.size / 1e9).toFixed(1) + ' GB' : Math.round(v.size / 1e6) + ' MB'}`, file: path.basename(v.path) }));
    if (item.versions && item.versions.length < 2) delete item.versions;
  }
  if (['movie', 'show'].includes(row.type)) {
    item.cast = db.prepare(`SELECT pe.id, pe.name, pe.photo, c.role, c.character FROM credits c JOIN people pe ON pe.id = c.person_id
      WHERE c.item_id = ? ORDER BY CASE c.role WHEN 'cast' THEN 1 ELSE 0 END, c.ord LIMIT 24`).all(row.id)
      .map(x => ({ id: x.id, name: x.name, photo: x.photo ? `/img/${x.photo}` : null, role: x.role, character: x.character }));
  }
  if (['movie', 'episode', 'home'].includes(row.type)) {
    item.downloads = db.prepare('SELECT id, quality, status, progress, size FROM versions WHERE item_id = ?').all(row.id);
  }
  res.json(item);
});

r.post('/items/:id/watched', (req, res) => {
  const p = req.profile;
  const row = getVisibleItem(p, req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const watched = req.body?.watched ? 1 : 0;
  let ids = [row.id];
  if (row.type === 'show') {
    const season = req.body?.season;
    ids = db.prepare(`SELECT id FROM items WHERE parent_id = ? ${season != null ? 'AND season = ?' : ''}`).all(...[row.id, season].filter(x => x != null)).map(x => x.id);
  }
  const stmt = db.prepare(`INSERT INTO progress(profile_id, item_id, position, duration, watched, updated_at) VALUES (?, ?, 0, NULL, ?, ?)
    ON CONFLICT(profile_id, item_id) DO UPDATE SET watched = excluded.watched, position = 0, updated_at = excluded.updated_at`);
  for (const id of ids) stmt.run(p.id, id, watched, now());
  if (watched) trakt.markWatched(p.id, ids);
  res.json({ ok: true });
});

// Progress heartbeat from the player (every ~10s). Also drives screen time, history, and "stop" requests.
r.post('/progress', (req, res) => {
  const { itemId, position, duration, deviceId, state } = req.body || {};
  const item = db.prepare('SELECT id, duration, type FROM items WHERE id = ?').get(itemId);
  if (!item) return res.status(404).json({ error: 'Not found' });
  const dur = duration || item.duration || null;
  const watched = dur && position >= dur * 0.92 ? 1 : 0;
  const was = db.prepare('SELECT watched FROM progress WHERE profile_id = ? AND item_id = ?').get(req.profile.id, item.id)?.watched;
  if (watched && !was && ['movie', 'episode'].includes(item.type)) {
    trakt.markWatched(req.profile.id, [item.id]);
    const title = db.prepare('SELECT title FROM items WHERE id = ?').get(item.id)?.title || 'something';
    notify.message({ admins: true, title: `${req.profile.name} finished ${title}`, body: 'Just now', url: `/#/item/${item.id}` }).catch(() => {});
  }
  db.prepare(`INSERT INTO progress(profile_id, item_id, position, duration, watched, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(profile_id, item_id) DO UPDATE SET position = excluded.position, duration = excluded.duration,
      watched = MAX(excluded.watched, CASE WHEN excluded.position < 60 THEN 0 ELSE progress.watched END), updated_at = excluded.updated_at`)
    .run(req.profile.id, item.id, watched ? 0 : position, dur, watched, now());
  const extra = deviceId ? activity.heartbeat({ profile: req.profile, deviceId: String(deviceId), itemId: item.id, position, state: state || 'playing' }) : {};
  if (extra.stop) for (const [id, s] of stream.sessions) if (s.deviceId === deviceId) stream.stopSession(id);
  if (item.type === 'episode' && position > 60) { try { versions.autoQueueNext(req.profile.id, item.id); } catch {} }
  res.json({ ok: true, watched: !!watched, ...extra });
});

// ---------- playback ----------
r.post('/play/:id', (req, res) => {
  const p = req.profile;
  const row = getVisibleItem(p, req.params.id);
  if (!row || !row.path || !['movie', 'episode', 'home'].includes(row.type)) return res.status(404).json({ error: 'Not found' });
  const allowed = activity.check(p, row.id);
  if (!allowed.ok) return res.status(403).json({ error: allowed.message, code: allowed.reason });
  if (!fs.existsSync(row.path)) return res.status(410).json({ error: 'File is missing from disk — try a library scan' });
  const { caps = {}, audioIndex = 0, start = 0, deviceId = 'unknown', subKey = null, forceStream = false, night = false, forceTranscode = false } = req.body || {};
  const quality = C.capQuality(p, req.body?.quality || 'original');
  if (p.auto_subs && !row.subs_checked && subtitles.configured()) {
    const lang = p.sub_lang || 'en';
    const has = stream.listSubtitles(row).some(s => (s.lang || '').toLowerCase().startsWith(lang.slice(0, 2)));
    if (!has) subtitles.autoFetch(row, lang);
  }
  const subs = stream.listSubtitles(row);
  const burn = subs.find(s => s.key === subKey && s.burn);
  const q = stream.QUALITIES[quality] || stream.QUALITIES.original;
  const ready = versions.bestReady(row.id, q.height);
  const decision = stream.decide(row, quality, caps, audioIndex | 0, burn ? +burn.key.slice(4) : null, night ? null : ready, !!forceStream || !!night || !!forceTranscode);
  // The device said it couldn't play the file as it is (e.g. 10-bit or very high-bitrate video), so fully convert it
  if (forceTranscode && decision.mode === 'hls') { decision.copyVideo = false; decision.copyAudio = false; decision.reason = 'device'; }
  const base = {
    itemId: row.id, duration: row.duration, title: row.title, showTitle: row.show_title, season: row.season, episode: row.episode,
    subtitles: subs.map(({ key, label, lang, burn: b }) => ({ key, label, lang, burn: !!b, url: b ? null : `/api/subs/${row.id}/${key}` })),
    audioTracks: stream.audioTracks(row), qualities: Object.entries(stream.QUALITIES).map(([k, v]) => ({ key: k, label: v.label })),
    quality, audioIndex: audioIndex | 0, resume: row.watched ? 0 : (row.position || 0), remaining: allowed.remaining ?? null, episodesLeft: allowed.episodesLeft ?? null, maxQuality: p.max_quality || null, night: !!night,
    chapters: chaptersOf(row),
    hdr: hdrOf(row),
    intro: row.intro_end ? { start: row.intro_start || 0, end: row.intro_end } : null,
    creditsStart: row.credits_start || null,
  };
  const dev = String(deviceId).slice(0, 64);
  let out;
  if (decision.mode === 'direct') out = { ...base, mode: 'direct', url: `/api/stream/${row.id}`, start: 0 };
  else if (decision.mode === 'version') out = { ...base, mode: 'direct', url: `/api/versions/${decision.version.id}/file`, start: 0, prepared: decision.version.quality };
  else {
    for (const [id, s] of stream.sessions) if (s.deviceId === dev) stream.stopSession(id);
    const s = stream.startSession(row, { quality, audioIndex: audioIndex | 0, start: Math.max(0, +start || 0), deviceId: dev, profileId: p.id,
      copyVideo: decision.copyVideo, copyAudio: decision.copyAudio, burnSub: burn ? +burn.key.slice(4) : null, night: !!night });
    out = { ...base, mode: 'hls', url: `/api/hls/${s.id}/index.m3u8`, sessionId: s.id, start: s.start, reason: decision.reason, transcoding: !decision.copyVideo, hw: !!s.hw };
  }
  out.playId = activity.startPlay({ profile: p, item: row, deviceId: dev, ua: req.headers['user-agent'], ip: req.ip, info: out });
  res.json(out);
});
// Can this profile start item #id right now? (used before "Up next" so kids get a friendly goodbye instead)
r.get('/screen-time', (req, res) => res.json(activity.check(req.profile, +req.query.itemId || null)));
r.post('/play-stop', (req, res) => { activity.endPlay(String(req.body?.deviceId || '')); res.json({ ok: true }); });

// Admin: mark where the intro ends or the credits start, from the current playback position.
r.post('/items/:id/markers', (req, res) => {
  if (!req.profile.is_admin) return res.status(403).json({ error: 'Only an admin can set this' });
  const row = db.prepare("SELECT id, type, parent_id, season FROM items WHERE id = ?").get(req.params.id);
  if (!row || !['episode', 'movie'].includes(row.type)) return res.status(404).json({ error: 'Not found' });
  const introEnd = req.body?.introEnd == null ? null : Math.max(0, +req.body.introEnd || 0);
  const creditsStart = req.body?.creditsStart == null ? null : Math.max(0, +req.body.creditsStart || 0);
  if (introEnd == null && creditsStart == null) return res.status(400).json({ error: 'Nothing to save' });
  if (row.type === 'episode' && req.body?.applySeason && introEnd != null) {
    db.prepare("UPDATE items SET intro_start = 0, intro_end = ?, intro_done = 1 WHERE parent_id = ? AND season = ? AND type = 'episode'").run(introEnd, row.parent_id, row.season);
  } else if (introEnd != null) {
    db.prepare('UPDATE items SET intro_start = 0, intro_end = ?, intro_done = 1 WHERE id = ?').run(introEnd, row.id);
  }
  if (creditsStart != null) db.prepare('UPDATE items SET credits_start = ?, credits_done = 1 WHERE id = ?').run(creditsStart, row.id);
  res.json({ ok: true });
});

function chaptersOf(row) {
  try {
    const probe = JSON.parse(row.probe || '{}');
    return (probe.chapters || []).filter(c => c && Number.isFinite(+c.start)).slice(0, 80).map(c => ({ start: +c.start, title: String(c.title || '').slice(0, 80) }));
  } catch { return []; }
}
function hdrOf(row) {
  try {
    const probe = JSON.parse(row.probe || '{}');
    return !!(probe.hdr || /smpte2084|arib-std-b67/i.test(probe.color_transfer || ''));
  } catch { return false; }
}

r.get('/stream/:id', (req, res) => {
  const row = getVisibleItem(req.profile, req.params.id);
  if (!row || !row.path) return res.status(404).end();
  res.sendFile(row.path, { dotfiles: 'allow', acceptRanges: true, headers: { 'Cache-Control': 'no-store' } });
});
r.get('/hls/:sid/index.m3u8', wrap(stream.servePlaylist));
r.get('/hls/:sid/:seg', wrap(stream.serveSegment));
r.delete('/hls/:sid', (req, res) => { stream.stopSession(req.params.sid); res.json({ ok: true }); });
r.get('/subs/:id/:key', (req, res) => {
  const row = getVisibleItem(req.profile, req.params.id);
  if (!row || !row.path) return res.status(404).end();
  stream.serveSubtitle(row, req.params.key, res);
});

// Connection speed check for automatic quality
const NOISE = crypto.randomBytes(256 * 1024);
r.get('/speedtest', (req, res) => {
  const kb = Math.min(8192, Math.max(64, parseInt(req.query.kb, 10) || 1024));
  res.set({ 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'Content-Length': kb * 1024 });
  let left = kb * 1024;
  const pump = () => {
    while (left > 0) {
      const chunk = NOISE.subarray(0, Math.min(NOISE.length, left));
      left -= chunk.length;
      if (!res.write(chunk)) return res.once('drain', pump);
    }
    res.end();
  };
  pump();
});

// ---------- prepared copies & downloads ----------
r.post('/versions', (req, res) => {
  const row = getVisibleItem(req.profile, req.body?.itemId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const reason = req.body.reason === 'download' ? 'download' : req.profile.is_admin ? 'manual' : 'download';
  try { res.json(versions.request(row.id, String(req.body.quality || '720'), reason)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
r.get('/versions/:id', (req, res) => {
  const v = db.prepare('SELECT id, item_id, quality, status, progress, size, error FROM versions WHERE id = ?').get(req.params.id);
  if (!v || !getVisibleItem(req.profile, v.item_id)) return res.status(404).json({ error: 'Not found' });
  res.json(v);
});
r.get('/versions/:id/file', (req, res) => {
  const v = db.prepare("SELECT v.*, i.title FROM versions v JOIN items i ON i.id = v.item_id WHERE v.id = ? AND v.status = 'ready'").get(req.params.id);
  if (!v || !getVisibleItem(req.profile, v.item_id) || !fs.existsSync(v.path)) return res.status(404).end();
  db.prepare('UPDATE versions SET used_at = ? WHERE id = ?').run(now(), v.id);
  const headers = { 'Cache-Control': 'no-store' };
  if (req.query.download === '1') headers['Content-Disposition'] = `attachment; filename="${v.title.replace(/[^\w .()-]/g, '')} (${v.quality}p).mp4"`;
  res.sendFile(v.path, { acceptRanges: true, headers });
});

// ---------- Chromecast ----------
function castBase(req) {
  const set = getSetting('lan_url');
  if (set) return set.replace(/\/$/, '');
  const host = req.headers.host || '';
  if (/^(192\.168|10\.|172\.(1[6-9]|2\d|3[01]))\./.test(host)) return `http://${host}`;
  return null;
}
r.post('/cast/:id', (req, res) => {
  const row = getVisibleItem(req.profile, req.params.id);
  if (!row || !row.path) return res.status(404).json({ error: 'Not found' });
  const allowed = activity.check(req.profile, row.id);
  if (!allowed.ok) return res.status(403).json({ error: allowed.message, code: allowed.reason });
  const base = castBase(req);
  if (!base) return res.status(400).json({ error: "Casting needs your server's home network address. Ask the admin to set it in Settings → Server." });
  const { quality = '1080', start = 0, audioIndex = 0, subKey = null } = req.body || {};
  res.json({ ...cast.prepare(row, { quality, start: +start || 0, audioIndex: audioIndex | 0, subKey, base }), title: row.title, showTitle: row.show_title });
});

// ---------- notifications ----------
r.get('/notifications', (req, res) => {
  const p = req.profile;
  res.json(notify.list(60).filter(n => (n.profile_id == null || n.profile_id === p.id) && (n.kind !== 'alert' || p.is_admin))
    .filter(n => !n.item_ids.length || n.item_ids.some(id => C.visibleTo(p, id))).slice(0, 40)
    .map(n => ({ id: n.id, at: n.created_at, kind: n.kind, title: n.title, body: n.body, image: C.img(n.image), items: C.itemsByIds(p, n.item_ids.slice(0, 8)) })));
});
r.post('/push/subscribe', (req, res) => { try { notify.subscribe(req.profile.id, req.body); res.json({ ok: true }); } catch (e) { res.status(400).json({ error: e.message }); } });
r.post('/push/unsubscribe', (req, res) => { notify.unsubscribe(req.body?.endpoint); res.json({ ok: true }); });
r.post('/push/test', wrap(async (req, res) => res.json({ sent: await notify.test(req.profile.id) })));

// ---------- watch together ----------
r.post('/rooms', (req, res) => {
  const row = getVisibleItem(req.profile, req.body?.itemId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json({ code: rooms.create(row.id, req.profile) });
});
r.get('/rooms/:code', (req, res) => {
  const room = rooms.get(req.params.code);
  if (!room) return res.status(404).json({ error: 'That watch party has ended or the code is wrong' });
  if (!getVisibleItem(req.profile, room.itemId)) return res.status(403).json({ error: "This profile can't watch that title" });
  res.json({ code: room.code, itemId: room.itemId });
});
r.get('/rooms/:code/events', (req, res) => {
  const room = rooms.get(req.params.code);
  if (!room) return res.status(404).end();
  if (!getVisibleItem(req.profile, room.itemId)) return res.status(403).end();
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  rooms.join(room, { clientId: String(req.query.clientId || crypto.randomUUID()).slice(0, 64), profile: req.profile, res });
});
r.post('/rooms/:code/action', (req, res) => {
  const room = rooms.get(req.params.code);
  if (!room) return res.status(404).json({ error: 'Room closed' });
  rooms.action(room, { ...req.body, profile: req.profile });
  res.json({ ok: true });
});

module.exports = { router: r, auth, nextEpisodeFor, collectionsFor };
