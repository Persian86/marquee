// Routes for: AI subtitles, cinema mode (trailers before a movie), theme songs.
const express = require('express');
const fs = require('fs');
const path = require('path');
const { db, getSetting } = require('../db');
const { CONFIG_DIR } = require('../config');
const C = require('../common');
const parse = require('../parse');
const aisubs = require('../features/aisubs');

const { getVisibleItem } = C;
const r = express.Router();
const fail = (res, e, code = 400) => res.status(code).json({ error: e.message || String(e) });

const PREROLL_DIR = path.join(CONFIG_DIR, 'prerolls');
const THEME_DIR = path.join(CONFIG_DIR, 'themes');
fs.mkdirSync(PREROLL_DIR, { recursive: true });
fs.mkdirSync(THEME_DIR, { recursive: true });

// ---------- AI subtitles ----------
r.get('/ai-subs/:id', (req, res) => {
  if (!getVisibleItem(req.profile, req.params.id)) return res.status(404).end();
  res.json({ available: aisubs.available, jobs: aisubs.jobsFor(+req.params.id) });
});
r.post('/ai-subs/:id', (req, res) => {
  if (req.profile.is_kids || req.profile.is_guest) return fail(res, new Error('Ask a grown-up to make subtitles'), 403);
  if (!aisubs.available) return fail(res, new Error('AI subtitles need the updated Marquee image — see the setup guide'));
  const it = getVisibleItem(req.profile, req.params.id);
  if (!it) return res.status(404).end();
  try { res.json(aisubs.queue(it.id, req.body?.task || 'transcribe')); } catch (e) { fail(res, e); }
});
r.delete('/ai-subs/:id/:task', (req, res) => { aisubs.cancel(+req.params.id, req.params.task); res.json({ ok: true }); });

// ---------- cinema mode: a couple of trailers (and your own intro clip) before the movie ----------
const isVideoFile = f => parse.isVideo(f);
r.get('/cinema/:id', (req, res) => {
  const p = req.profile;
  const it = getVisibleItem(p, req.params.id);
  if (!it || it.type !== 'movie' || !p.cinema_mode) return res.json({ items: [] });
  const want = Math.max(0, Math.min(4, +getSetting('cinema_trailers', '2')));
  const pool = db.prepare(`SELECT i.id, i.title, i.year, i.trailer, i.local_trailer, i.backdrop FROM items i JOIN libraries l ON l.id = i.library_id
    LEFT JOIN progress pr ON pr.item_id = i.id AND pr.profile_id = ?
    WHERE i.type = 'movie' AND i.id != ? AND (i.trailer IS NOT NULL OR i.local_trailer IS NOT NULL) AND (pr.watched IS NULL OR pr.watched = 0)
      AND ${C.visible(p)} AND ${C.NOT_DUP} ORDER BY i.added_at DESC LIMIT 25`).all(p.id, it.id);
  const picks = [];
  while (picks.length < want && pool.length) picks.push(pool.splice(Math.floor(Math.random() * Math.min(pool.length, 10)), 1)[0]);
  const items = picks.map(m => (m.local_trailer && fs.existsSync(m.local_trailer)
    ? { kind: 'trailer', itemId: m.id, title: m.title, year: m.year, url: `/api/trailer/${m.id}` }
    : { kind: 'youtube', itemId: m.id, title: m.title, year: m.year, key: m.trailer }));
  let prerolls = [];
  try { prerolls = fs.readdirSync(PREROLL_DIR).filter(isVideoFile); } catch {}
  if (prerolls.length) items.push({ kind: 'preroll', title: 'Feature presentation', url: `/api/preroll/${encodeURIComponent(prerolls[Math.floor(Math.random() * prerolls.length)])}` });
  res.json({ items });
});
r.get('/trailer/:id', (req, res) => {
  const it = getVisibleItem(req.profile, req.params.id);
  if (!it?.local_trailer || !fs.existsSync(it.local_trailer)) return res.status(404).end();
  res.sendFile(it.local_trailer, { dotfiles: 'allow', acceptRanges: true });
});
r.get('/preroll/:name', (req, res) => {
  const f = path.join(PREROLL_DIR, path.basename(req.params.name));
  if (!fs.existsSync(f)) return res.status(404).end();
  res.sendFile(f, { acceptRanges: true });
});

// ---------- theme songs ----------
r.get('/items/:id/theme', (req, res) => {
  const it = getVisibleItem(req.profile, req.params.id);
  if (!it?.theme || !fs.existsSync(it.theme)) return res.status(404).end();
  res.sendFile(it.theme, { dotfiles: 'allow', acceptRanges: true, headers: { 'Cache-Control': 'private, max-age=86400' } });
});
// Admin: upload a theme song (base64 in JSON, like artwork)
const AUDIO_OK = { 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'm4a', 'audio/ogg': 'ogg', 'audio/flac': 'flac', 'audio/x-flac': 'flac', 'audio/opus': 'opus' };
r.post('/admin-theme/:id', (req, res) => {
  if (!req.profile.is_admin) return fail(res, new Error('Admins only'), 403);
  const it = db.prepare("SELECT id, theme FROM items WHERE id = ? AND type IN ('show','movie')").get(req.params.id);
  if (!it) return res.status(404).end();
  const ext = AUDIO_OK[req.body?.type];
  if (!ext || !req.body?.data) return fail(res, new Error('Choose an MP3, M4A, OGG or FLAC file'));
  const buf = Buffer.from(String(req.body.data).replace(/^data:[^,]+,/, ''), 'base64');
  if (buf.length > 30e6) return fail(res, new Error('That file is too big (30 MB max)'));
  for (const f of fs.readdirSync(THEME_DIR)) if (f.startsWith(`${it.id}.`)) fs.rmSync(path.join(THEME_DIR, f));
  const dest = path.join(THEME_DIR, `${it.id}.${ext}`);
  fs.writeFileSync(dest, buf);
  db.prepare('UPDATE items SET theme = ? WHERE id = ?').run(dest, it.id);
  res.json({ ok: true });
});
r.delete('/admin-theme/:id', (req, res) => {
  if (!req.profile.is_admin) return fail(res, new Error('Admins only'), 403);
  const it = db.prepare('SELECT id, theme FROM items WHERE id = ?').get(req.params.id);
  if (it?.theme?.startsWith(THEME_DIR)) fs.rmSync(it.theme, { force: true });
  db.prepare('UPDATE items SET theme = NULL WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = { router: r };
