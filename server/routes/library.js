// My List, collections & family lists, people, music, photos, home videos.
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { db } = require('../db');
const C = require('../common');
const { TRANSCODE_DIR } = require('../config');
const tmdb = require('../tmdb');
const { collectionsFor } = require('./core');

const { now, formatItem, visible, movieList, getVisibleItem, wrap } = C;
const r = express.Router();

// ---------- My List ----------
r.get('/watchlist', (req, res) => {
  const ids = db.prepare('SELECT item_id FROM watchlist WHERE profile_id = ? ORDER BY added_at DESC').all(req.profile.id).map(x => x.item_id);
  res.json(C.itemsByIds(req.profile, ids));
});
r.post('/watchlist/:id', (req, res) => {
  if (!getVisibleItem(req.profile, req.params.id)) return res.status(404).json({ error: 'Not found' });
  db.prepare('INSERT OR IGNORE INTO watchlist (profile_id, item_id, added_at) VALUES (?, ?, ?)').run(req.profile.id, req.params.id, now());
  res.json({ ok: true });
});
r.delete('/watchlist/:id', (req, res) => {
  db.prepare('DELETE FROM watchlist WHERE profile_id = ? AND item_id = ?').run(req.profile.id, req.params.id);
  res.json({ ok: true });
});

// ---------- collections & lists ----------
function listsFor(p) {
  return db.prepare(`SELECT li.*, pr.name AS owner, pr.color AS owner_color, (SELECT COUNT(*) FROM list_items x WHERE x.list_id = li.id) AS n
    FROM lists li JOIN profiles pr ON pr.id = li.profile_id WHERE li.shared = 1 OR li.profile_id = ? ORDER BY li.name`).all(p.id)
    .map(l => {
      const cover = db.prepare(`SELECT i.poster, i.backdrop FROM list_items x JOIN items i ON i.id = x.item_id WHERE x.list_id = ? AND i.poster IS NOT NULL ORDER BY x.added_at LIMIT 4`).all(l.id);
      return { id: l.id, name: l.name, shared: !!l.shared, owner: l.owner, ownerColor: l.owner_color, mine: l.profile_id === p.id, count: l.n, covers: cover.map(c => C.img(c.poster)) };
    });
}
r.get('/collections', (req, res) => res.json({ collections: collectionsFor(req.profile, 500), lists: listsFor(req.profile) }));
r.get('/collections/:id', (req, res) => {
  const c = collectionsFor(req.profile, 1, +req.params.id)[0];
  if (!c) return res.status(404).json({ error: 'Not found' });
  res.json({ ...c, items: movieList(req.profile, 'i.collection_id = ?', 'i.year, i.sort_title', 100, [c.id]) });
});
r.get('/lists', (req, res) => res.json(listsFor(req.profile)));
r.post('/lists', (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: 'Give the list a name' });
  const x = db.prepare('INSERT INTO lists (name, profile_id, shared, created_at) VALUES (?, ?, ?, ?)').run(name, req.profile.id, req.body.shared === false ? 0 : 1, now());
  const id = Number(x.lastInsertRowid);
  if (req.body.itemId && getVisibleItem(req.profile, req.body.itemId)) db.prepare('INSERT OR IGNORE INTO list_items (list_id, item_id, added_at) VALUES (?, ?, ?)').run(id, req.body.itemId, now());
  res.json({ id });
});
function ownList(req, res) {
  const l = db.prepare('SELECT * FROM lists WHERE id = ?').get(req.params.id);
  if (!l || (!l.shared && l.profile_id !== req.profile.id)) { res.status(404).json({ error: 'Not found' }); return null; }
  return l;
}
r.get('/lists/:id', (req, res) => {
  const l = ownList(req, res); if (!l) return;
  const ids = db.prepare('SELECT item_id FROM list_items WHERE list_id = ? ORDER BY added_at').all(l.id).map(x => x.item_id);
  const owner = db.prepare('SELECT name FROM profiles WHERE id = ?').get(l.profile_id);
  res.json({ id: l.id, name: l.name, shared: !!l.shared, owner: owner?.name, mine: l.profile_id === req.profile.id || !!req.profile.is_admin, items: C.itemsByIds(req.profile, ids) });
});
r.patch('/lists/:id', (req, res) => {
  const l = ownList(req, res); if (!l) return;
  if (l.profile_id !== req.profile.id && !req.profile.is_admin) return res.status(403).json({ error: 'Only the person who made it can change it' });
  if (req.body.name) db.prepare('UPDATE lists SET name = ? WHERE id = ?').run(String(req.body.name).slice(0, 60), l.id);
  if (req.body.shared != null) db.prepare('UPDATE lists SET shared = ? WHERE id = ?').run(req.body.shared ? 1 : 0, l.id);
  res.json({ ok: true });
});
r.delete('/lists/:id', (req, res) => {
  const l = ownList(req, res); if (!l) return;
  if (l.profile_id !== req.profile.id && !req.profile.is_admin) return res.status(403).json({ error: 'Only the person who made it can delete it' });
  db.prepare('DELETE FROM lists WHERE id = ?').run(l.id);
  res.json({ ok: true });
});
r.post('/lists/:id/items', (req, res) => {
  const l = ownList(req, res); if (!l) return;
  if (!getVisibleItem(req.profile, req.body?.itemId)) return res.status(404).json({ error: 'Not found' });
  db.prepare('INSERT OR IGNORE INTO list_items (list_id, item_id, added_at) VALUES (?, ?, ?)').run(l.id, req.body.itemId, now());
  res.json({ ok: true });
});
r.delete('/lists/:id/items/:itemId', (req, res) => {
  const l = ownList(req, res); if (!l) return;
  db.prepare('DELETE FROM list_items WHERE list_id = ? AND item_id = ?').run(l.id, req.params.itemId);
  res.json({ ok: true });
});

// ---------- people ----------
r.get('/people/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM people WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  const ids = db.prepare(`SELECT c.item_id, c.character, c.role FROM credits c JOIN items i ON i.id = c.item_id WHERE c.person_id = ? ORDER BY i.year DESC`).all(p.id);
  const items = C.itemsByIds(req.profile, [...new Set(ids.map(x => x.item_id))]).map(it => {
    const c = ids.find(x => x.item_id === it.id);
    return { ...it, character: c?.character, role: c?.role };
  });
  res.json({ id: p.id, name: p.name, photo: p.photo ? `/img/${p.photo}` : null, items });
});

// ---------- music ----------
r.get('/music/albums', (req, res) => {
  const p = req.profile;
  const sort = req.query.sort === 'added' ? 'MAX(i.added_at) DESC' : req.query.sort === 'year' ? 'MAX(i.year) DESC' : 'LOWER(i.album_artist), LOWER(i.album)';
  res.json(db.prepare(`SELECT i.album, i.album_artist, MAX(i.poster) AS poster, MAX(i.year) AS year, COUNT(*) AS n, MAX(i.added_at) AS added
    FROM items i JOIN libraries l ON l.id = i.library_id WHERE i.type = 'track' AND ${visible(p)}
    GROUP BY i.album_artist, i.album ORDER BY ${sort}`).all()
    .map(a => ({ album: a.album, artist: a.album_artist, poster: C.img(a.poster), year: a.year, count: a.n })));
});
r.get('/music/artists', (req, res) => {
  res.json(db.prepare(`SELECT i.album_artist AS name, COUNT(DISTINCT i.album) AS albums, COUNT(*) AS tracks, MAX(i.poster) AS poster
    FROM items i JOIN libraries l ON l.id = i.library_id WHERE i.type = 'track' AND ${visible(req.profile)}
    GROUP BY i.album_artist ORDER BY LOWER(i.album_artist)`).all().map(a => ({ ...a, poster: C.img(a.poster) })));
});
r.get('/music/album', (req, res) => {
  const tracks = db.prepare(`SELECT i.* FROM items i JOIN libraries l ON l.id = i.library_id WHERE i.type = 'track' AND i.album_artist = ? AND i.album = ? AND ${visible(req.profile)}
    ORDER BY i.disc_no, i.track_no, i.sort_title`).all(String(req.query.artist || ''), String(req.query.album || '')).map(formatItem);
  if (!tracks.length) return res.status(404).json({ error: 'Not found' });
  res.json({ album: req.query.album, artist: req.query.artist, poster: tracks.find(t => t.poster)?.poster || null, year: tracks.find(t => t.year)?.year || null,
    duration: tracks.reduce((s, t) => s + (t.duration || 0), 0), tracks });
});
r.get('/music/artist', (req, res) => {
  const name = String(req.query.name || '');
  const albums = db.prepare(`SELECT i.album, i.album_artist, MAX(i.poster) AS poster, MAX(i.year) AS year, COUNT(*) AS n FROM items i JOIN libraries l ON l.id = i.library_id
    WHERE i.type = 'track' AND i.album_artist = ? AND ${visible(req.profile)} GROUP BY i.album ORDER BY year DESC`).all(name)
    .map(a => ({ album: a.album, artist: a.album_artist, poster: C.img(a.poster), year: a.year, count: a.n }));
  const tracks = db.prepare(`SELECT i.* FROM items i JOIN libraries l ON l.id = i.library_id WHERE i.type = 'track' AND i.album_artist = ? AND ${visible(req.profile)}
    ORDER BY RANDOM() LIMIT 200`).all(name).map(formatItem);
  res.json({ name, albums, tracks });
});
r.get('/music/shuffle', (req, res) => {
  res.json(db.prepare(`SELECT i.* FROM items i JOIN libraries l ON l.id = i.library_id WHERE i.type = 'track' AND ${visible(req.profile)} ORDER BY RANDOM() LIMIT 100`).all().map(formatItem));
});
// Plays natively if the browser can, otherwise converts to MP3 on the fly
r.get('/audio/:id', (req, res) => {
  const row = getVisibleItem(req.profile, req.params.id);
  if (!row || row.type !== 'track') return res.status(404).end();
  const native = ['mp3', 'aac', 'flac', 'opus', 'vorbis', 'alac'].includes(row.audio_codec) && !/\.(wma|ape|wv|aiff?)$/i.test(row.path) && req.query.transcode !== '1';
  if (native) return res.sendFile(row.path, { dotfiles: 'allow', acceptRanges: true });
  res.set({ 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' });
  const proc = spawn('ffmpeg', ['-v', 'error', '-i', row.path, '-vn', '-map', '0:a:0', '-c:a', 'libmp3lame', '-b:a', '256k', '-f', 'mp3', 'pipe:1'], { stdio: ['ignore', 'pipe', 'ignore'] });
  proc.stdout.pipe(res);
  req.on('close', () => proc.kill('SIGKILL'));
});

// ---------- photos ----------
r.get('/photos/albums', (req, res) => {
  const rows = db.prepare(`SELECT i.library_id, l.name AS lib, COALESCE(i.folder, '') AS folder, COUNT(*) AS n, MAX(i.taken_at) AS latest, MIN(i.taken_at) AS earliest,
      (SELECT x.id FROM items x WHERE x.library_id = i.library_id AND COALESCE(x.folder, '') = COALESCE(i.folder, '') AND x.type = 'photo' ORDER BY x.taken_at DESC LIMIT 1) AS cover
    FROM items i JOIN libraries l ON l.id = i.library_id WHERE i.type = 'photo' AND ${visible(req.profile)}
    GROUP BY i.library_id, COALESCE(i.folder, '') ORDER BY latest DESC`).all();
  res.json(rows.map(a => ({ library: a.library_id, folder: a.folder, name: a.folder ? a.folder.split('/').pop() : a.lib, path: a.folder, count: a.n, latest: a.latest, earliest: a.earliest, cover: `/api/photo/${a.cover}/thumb` })));
});
r.get('/photos', (req, res) => {
  const p = req.profile;
  const where = ['i.type = \'photo\'', visible(p)], params = [];
  if (req.query.library) { where.push('i.library_id = ?'); params.push(+req.query.library); }
  if (req.query.folder != null) { where.push("COALESCE(i.folder, '') = ?"); params.push(String(req.query.folder)); }
  if (req.query.since) { where.push('i.taken_at >= ?'); params.push(+req.query.since); }
  res.json(db.prepare(`SELECT i.id, i.title, i.taken_at, i.folder FROM items i JOIN libraries l ON l.id = i.library_id WHERE ${where.join(' AND ')}
    ORDER BY i.taken_at DESC LIMIT ${Math.min(5000, +req.query.limit || 3000)}`).all(...params)
    .map(x => ({ id: x.id, title: x.title, takenAt: x.taken_at, folder: x.folder, thumb: `/api/photo/${x.id}/thumb`, display: `/api/photo/${x.id}/display`, original: `/api/photo/${x.id}/original` })));
});
const PHOTO_CACHE = path.join(TRANSCODE_DIR, 'optimized', 'photos');
fs.mkdirSync(PHOTO_CACHE, { recursive: true });
const ORIENT = { 2: 'hflip', 3: 'transpose=1,transpose=1', 4: 'vflip', 5: 'transpose=0', 6: 'transpose=1', 7: 'transpose=3', 8: 'transpose=2' };
const photoJobs = new Map();
r.get('/photo/:id/:size', wrap(async (req, res) => {
  const row = getVisibleItem(req.profile, req.params.id);
  if (!row || row.type !== 'photo') return res.status(404).end();
  if (req.params.size === 'original') return res.sendFile(row.path, { dotfiles: 'allow', headers: { 'Cache-Control': 'private, max-age=86400' } });
  const width = req.params.size === 'thumb' ? 400 : 2048;
  const dest = path.join(PHOTO_CACHE, crypto.createHash('sha1').update(row.path + row.mtime + width).digest('hex').slice(0, 24) + '.jpg');
  if (!fs.existsSync(dest)) {
    if (!photoJobs.has(dest)) {
      let orient = 1;
      try { orient = JSON.parse(row.probe || '{}').orientation || 1; } catch {}
      const vf = [ORIENT[orient], `scale='min(${width},iw)':-2`].filter(Boolean).join(',');
      photoJobs.set(dest, new Promise(done => execFile('ffmpeg', ['-v', 'error', '-y', '-noautorotate', '-i', row.path, '-frames:v', '1', '-vf', vf, '-q:v', width > 1000 ? '3' : '5', dest],
        { timeout: 60000 }, () => { photoJobs.delete(dest); done(); })));
    }
    await photoJobs.get(dest);
    if (!fs.existsSync(dest)) return res.sendFile(row.path, { dotfiles: 'allow' }); // couldn't convert — send original
  }
  res.sendFile(dest, { headers: { 'Cache-Control': 'private, max-age=2592000' } });
}));

// ---------- home videos ----------
r.get('/home-videos', (req, res) => {
  const p = req.profile;
  res.json(db.prepare(`SELECT i.*, ${C.PROGRESS_COLS} FROM items i JOIN libraries l ON l.id = i.library_id ${C.PROGRESS_JOIN}
    WHERE i.type = 'home' AND ${visible(p)} ORDER BY i.taken_at DESC`).all(p.id).map(formatItem));
});

module.exports = { router: r };
