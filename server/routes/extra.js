// Routes for: ratings, Trakt/Letterboxd, recommendations, stats, scrub previews, subtitles, requests,
// music extras, podcasts, photo map, devices/remote control.
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { db, getSetting } = require('../db');
const C = require('../common');
const tmdb = require('../tmdb');
const discover = require('../features/discover');
const trickplay = require('../features/trickplay');
const subtitles = require('../features/subtitles');
const requests = require('../features/requests');
const audio = require('../features/audio');
const trakt = require('../features/trakt');
const devices = require('../features/devices');

const { formatItem, visible, getVisibleItem, wrap } = C;
const r = express.Router();
const fail = (res, e, code = 400) => res.status(code).json({ error: e.message || String(e) });

// ---------- ratings ----------
r.post('/ratings/:id', (req, res) => {
  const it = getVisibleItem(req.profile, req.params.id);
  if (!it) return res.status(404).json({ error: 'Not found' });
  const rating = Math.max(0, Math.min(10, parseInt(req.body?.rating, 10) || 0));
  if (rating) db.prepare('INSERT OR REPLACE INTO ratings (profile_id, item_id, rating, rated_at) VALUES (?, ?, ?, ?)').run(req.profile.id, it.id, rating, Date.now());
  else db.prepare('DELETE FROM ratings WHERE profile_id = ? AND item_id = ?').run(req.profile.id, it.id);
  trakt.rate(req.profile.id, it.id, rating || null);
  res.json({ ok: true });
});

// ---------- Trakt & Letterboxd ----------
r.get('/trakt', (req, res) => res.json(trakt.status(req.profile.id)));
r.post('/trakt/link', wrap(async (req, res) => { try { res.json(await trakt.startLink(req.profile.id)); } catch (e) { fail(res, e); } }));
r.post('/trakt/poll', wrap(async (req, res) => { try { res.json(await trakt.pollLink(req.profile.id)); } catch (e) { fail(res, e); } }));
r.post('/trakt/import', wrap(async (req, res) => { try { res.json({ marked: await trakt.importHistory(req.profile.id) }); } catch (e) { fail(res, e); } }));
r.delete('/trakt', (req, res) => { trakt.unlink(req.profile.id); res.json({ ok: true }); });
r.get('/letterboxd.csv', (req, res) => {
  const rows = db.prepare(`SELECT i.title, i.year, i.tmdb_id, pr.updated_at, r.rating FROM progress pr JOIN items i ON i.id = pr.item_id
    LEFT JOIN ratings r ON r.profile_id = pr.profile_id AND r.item_id = i.id WHERE pr.profile_id = ? AND pr.watched = 1 AND i.type = 'movie'`).all(req.profile.id);
  const q = v => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const csv = ['Title,Year,tmdbID,WatchedDate,Rating10', ...rows.map(x => [x.title, x.year, x.tmdb_id, new Date(x.updated_at).toISOString().slice(0, 10), x.rating].map(q).join(','))].join('\n');
  res.set({ 'Content-Type': 'text/csv', 'Content-Disposition': `attachment; filename="marquee-${req.profile.name}-letterboxd.csv"` }).send(csv);
});

// ---------- discovery & stats ----------
r.get('/discover', (req, res) => {
  const p = req.profile;
  res.json({ because: discover.becauseYouWatched(p), smart: discover.smartRows(p), onThisDay: discover.onThisDay(p) });
});
r.get('/stats', (req, res) => {
  const year = parseInt(req.query.year, 10) || new Date().getFullYear();
  const pid = req.query.profileId === 'all' && req.profile.is_admin ? null : req.query.profileId && req.profile.is_admin ? +req.query.profileId : req.profile.id;
  res.json(discover.stats({ profileId: pid, year }));
});

// ---------- scrub previews ----------
r.get('/trickplay/:id', (req, res) => {
  if (!getVisibleItem(req.profile, req.params.id)) return res.status(404).end();
  const info = trickplay.info(req.params.id);
  info ? res.json(info) : res.status(404).json({ error: 'Not ready' });
});
r.get('/trickplay/:id/:n.jpg', (req, res) => {
  if (!getVisibleItem(req.profile, req.params.id)) return res.status(404).end();
  const f = trickplay.sheetPath(req.params.id, req.params.n);
  f ? res.set('Cache-Control', 'private, max-age=604800').sendFile(f) : res.status(404).end();
});

// ---------- online subtitles ----------
r.get('/subtitles/search/:id', wrap(async (req, res) => {
  const it = getVisibleItem(req.profile, req.params.id);
  if (!it) return res.status(404).json({ error: 'Not found' });
  try { res.json(await subtitles.search(it, req.query.lang || req.profile.sub_lang || 'en')); } catch (e) { fail(res, e); }
}));
r.post('/subtitles/download/:id', wrap(async (req, res) => {
  const it = getVisibleItem(req.profile, req.params.id);
  if (!it) return res.status(404).json({ error: 'Not found' });
  try { await subtitles.download(it, req.body.fileId, req.body.language || 'en'); res.json({ ok: true }); } catch (e) { fail(res, e); }
}));

// ---------- requests ----------
r.get('/requests', (req, res) => res.json({ requests: requests.list(req.profile), radarr: requests.configured('radarr'), sonarr: requests.configured('sonarr') }));
r.get('/requests/search', wrap(async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const results = q ? await tmdb.searchMulti(q) : await tmdb.trending();
    res.json(requests.annotate(results, req.profile.id));
  } catch (e) { fail(res, /No TMDB/.test(e.message) ? new Error('Searching needs posters & info turned on — the admin can add a free TMDB key in Settings.') : e); }
}));
r.post('/requests', wrap(async (req, res) => { try { res.json(await requests.create(req.profile, req.body || {})); } catch (e) { fail(res, e); } }));
r.post('/requests/:id/approve', wrap(async (req, res) => {
  if (!req.profile.is_admin) return res.status(403).json({ error: 'Admin only' });
  try { await requests.approve(+req.params.id); res.json({ ok: true }); } catch (e) { fail(res, e); }
}));
r.post('/requests/:id/decline', (req, res) => {
  if (!req.profile.is_admin) return res.status(403).json({ error: 'Admin only' });
  requests.decline(+req.params.id, req.body?.note); res.json({ ok: true });
});
r.delete('/requests/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM requests WHERE id = ?').get(req.params.id);
  if (!row || (!req.profile.is_admin && row.profile_id !== req.profile.id)) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM requests WHERE id = ?').run(row.id); res.json({ ok: true });
});

// ---------- music extras ----------
r.post('/music/played/:id', (req, res) => { if (getVisibleItem(req.profile, req.params.id)) audio.recordPlay(req.profile.id, +req.params.id); res.json({ ok: true }); });
r.get('/music/playlists', (req, res) => res.json({ ...audio.playlists(req.profile), genres: audio.genres(req.profile).slice(0, 12) }));
r.get('/music/playlists/:id', (req, res) => { const p = audio.playlistTracks(req.profile, +req.params.id); p ? res.json(p) : res.status(404).json({ error: 'Not found' }); });
r.get('/music/smart/:key', (req, res) => { const p = audio.smartTracks(req.profile, req.params.key); p ? res.json(p) : res.status(404).json({ error: 'Not found' }); });
r.post('/music/playlists', (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name it first' });
  res.json({ id: audio.createPlaylist(req.profile, name, (req.body.itemIds || []).filter(id => getVisibleItem(req.profile, id))) });
});
function ownPlaylist(req, res) {
  const p = db.prepare('SELECT * FROM playlists WHERE id = ?').get(req.params.id);
  if (!p || (p.profile_id !== req.profile.id && !req.profile.is_admin && !p.shared)) { res.status(404).json({ error: 'Not found' }); return null; }
  return p;
}
r.post('/music/playlists/:id/items', (req, res) => { const p = ownPlaylist(req, res); if (!p) return; audio.addToPlaylist(p.id, [].concat(req.body?.itemIds || req.body?.itemId || [])); res.json({ ok: true }); });
r.delete('/music/playlists/:id/items/:itemId', (req, res) => { const p = ownPlaylist(req, res); if (!p) return; db.prepare('DELETE FROM playlist_items WHERE playlist_id = ? AND item_id = ?').run(p.id, req.params.itemId); res.json({ ok: true }); });
r.patch('/music/playlists/:id', (req, res) => { const p = ownPlaylist(req, res); if (!p) return; if (req.body?.name) db.prepare('UPDATE playlists SET name = ? WHERE id = ?').run(String(req.body.name).slice(0, 80), p.id); res.json({ ok: true }); });
r.delete('/music/playlists/:id', (req, res) => {
  const p = ownPlaylist(req, res); if (!p) return;
  if (p.profile_id !== req.profile.id && !req.profile.is_admin) return res.status(403).json({ error: 'Only the person who made it can delete it' });
  db.prepare('DELETE FROM playlists WHERE id = ?').run(p.id); res.json({ ok: true });
});
r.get('/music/radio', (req, res) => res.json(audio.radio(req.profile, { artist: req.query.artist, trackId: req.query.track ? +req.query.track : null })));
r.get('/music/lyrics/:id', wrap(async (req, res) => {
  const it = getVisibleItem(req.profile, req.params.id);
  if (!it || it.type !== 'track') return res.status(404).json({ error: 'Not found' });
  res.json((await audio.lyrics(it)) || { none: true });
}));

// ---------- podcasts ----------
r.get('/podcasts', (req, res) => res.json({ podcasts: audio.podcastList(req.profile), latest: audio.latestEpisodes(req.profile, 30) }));
r.get('/podcasts/search', wrap(async (req, res) => { try { res.json(await audio.searchPodcasts(String(req.query.q || ''))); } catch (e) { fail(res, e); } }));
r.post('/podcasts', wrap(async (req, res) => {
  if (req.profile.is_kids) return res.status(403).json({ error: 'Ask a grown-up to add podcasts' });
  try { res.json({ id: await audio.subscribe(String(req.body?.feedUrl || '')) }); } catch (e) { fail(res, e); }
}));
r.get('/podcasts/:id', (req, res) => { const p = audio.podcastEpisodes(req.profile, +req.params.id); p ? res.json(p) : res.status(404).json({ error: 'Not found' }); });
r.delete('/podcasts/:id', (req, res) => {
  if (!req.profile.is_admin) return res.status(403).json({ error: 'Admin only' });
  db.prepare('DELETE FROM podcasts WHERE id = ?').run(req.params.id); res.json({ ok: true });
});
r.post('/podcasts/refresh', wrap(async (req, res) => { await audio.refreshAll(); res.json({ ok: true }); }));
r.post('/podcast-episodes/:id/progress', (req, res) => { audio.podcastProgress(req.profile.id, +req.params.id, +req.body.position || 0, +req.body.duration || 0); res.json({ ok: true }); });
r.post('/podcast-episodes/:id/played', (req, res) => { audio.markPlayed(req.profile.id, +req.params.id, !!req.body?.played); res.json({ ok: true }); });

// ---------- photo map ----------
r.get('/photos/map', (req, res) => {
  res.json(db.prepare(`SELECT i.id, i.lat, i.lon, i.taken_at, i.folder FROM items i JOIN libraries l ON l.id = i.library_id
    WHERE i.type = 'photo' AND i.lat IS NOT NULL AND ${visible(req.profile)} ORDER BY i.taken_at DESC LIMIT 20000`).all()
    .map(p => ({ id: p.id, lat: p.lat, lon: p.lon, takenAt: p.taken_at, folder: p.folder, thumb: `/api/photo/${p.id}/thumb`, display: `/api/photo/${p.id}/display`, original: `/api/photo/${p.id}/original` })));
});

// ---------- devices / remote control ----------
r.get('/devices/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  devices.connect({ clientId: String(req.query.clientId || crypto.randomUUID()).slice(0, 64), profile: req.profile, name: req.query.name, res });
});
r.post('/devices/state', (req, res) => { devices.update(String(req.body?.clientId || ''), req.body?.state || null); res.json({ ok: true }); });
r.get('/devices', (req, res) => res.json(devices.list(req.profile, req.query.except)));
r.post('/devices/:clientId/command', (req, res) => {
  try {
    if (req.body?.type === 'open' && !getVisibleItem(req.profile, req.body.itemId)) return res.status(404).json({ error: 'Not found' });
    devices.command(req.profile, req.params.clientId, req.body || {}); res.json({ ok: true });
  } catch (e) { fail(res, e, 404); }
});

module.exports = { router: r };
