// Guest share links: send one movie or episode to someone outside the family, no Tailscale or sign-in needed.
// Links expire, can be limited to a number of views, and can be cancelled any time.
// They're served on a separate port (8421) that ONLY knows about share links — the rest of Marquee is never exposed.
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { db, getSetting } = require('../db');
const C = require('../common');
const stream = require('../stream');
const versions = require('./versions');
const tmdb = require('../tmdb');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

function publicBase() { return (getSetting('share_url') || '').replace(/\/$/, ''); }

function create(profile, { itemId, days = 7, maxViews = null, note = '' }) {
  const it = C.getVisibleItem(profile, itemId);
  if (!it || !['movie', 'episode', 'home'].includes(it.type)) throw new Error('Only movies, episodes and home videos can be shared');
  if (profile.is_kids || profile.is_guest) throw new Error('Ask a grown-up to share this');
  const token = crypto.randomBytes(18).toString('base64url');
  const d = Math.max(1, Math.min(30, days | 0 || 7));
  db.prepare('INSERT INTO shares (token, item_id, profile_id, note, created_at, expires_at, max_views) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(token, it.id, profile.id, String(note || '').slice(0, 200), Date.now(), Date.now() + d * 86400000, maxViews ? Math.max(1, maxViews | 0) : null);
  // Make a web-friendly copy in the background so the guest can skip around instantly in any browser
  try { if (!webFriendly(it)) versions.request(it.id, getSetting('share_quality', '1080'), 'manual'); } catch {}
  return { token, url: link(token) };
}
const link = token => (publicBase() ? `${publicBase()}/s/${token}` : `/s/${token}`);

function webFriendly(item) {
  try {
    const p = JSON.parse(item.probe || '{}');
    return /mp4|mov/.test(p.format_name || '') && p.video_codec === 'h264' && (p.pix_fmt || 'yuv420p') === 'yuv420p' && ['aac', 'mp3'].includes(p.audio?.[0]?.codec || 'aac') && (p.height || 0) <= 1080;
  } catch { return false; }
}

function list(profile) {
  const rows = db.prepare(`SELECT sh.*, i.title, i.type, s.title AS show, i.season, i.episode, p.name AS by FROM shares sh JOIN items i ON i.id = sh.item_id
    LEFT JOIN items s ON s.id = i.parent_id JOIN profiles p ON p.id = sh.profile_id
    WHERE ${profile.is_admin ? '1=1' : 'sh.profile_id = ?'} ORDER BY sh.created_at DESC LIMIT 100`).all(...(profile.is_admin ? [] : [profile.id]));
  return rows.map(r => ({ id: r.token.slice(0, 8), url: link(r.token), title: r.show ? `${r.show} — S${r.season}E${r.episode} ${r.title}` : r.title, itemId: r.item_id,
    by: r.by, note: r.note, createdAt: r.created_at, expiresAt: r.expires_at, maxViews: r.max_views, views: r.views,
    active: !r.revoked && r.expires_at > Date.now() && (!r.max_views || r.views < r.max_views) }));
}
function revoke(profile, id) {
  const r = db.prepare('SELECT * FROM shares WHERE substr(token, 1, 8) = ?').get(id);
  if (!r || (!profile.is_admin && r.profile_id !== profile.id)) return false;
  db.prepare('UPDATE shares SET revoked = 1 WHERE token = ?').run(r.token);
  for (const [sid, s] of stream.sessions) if (s.deviceId === `share:${r.token}`) stream.stopSession(sid);
  return true;
}

// ---------- the public share server ----------
function valid(token) {
  const r = db.prepare('SELECT sh.*, p.name AS by FROM shares sh JOIN profiles p ON p.id = sh.profile_id WHERE sh.token = ?').get(String(token || ''));
  if (!r) return { error: 'This link doesn’t work — check you copied all of it.' };
  if (r.revoked) return { error: 'This link has been switched off by the person who sent it.' };
  if (r.expires_at < Date.now()) return { error: 'This link has expired. Ask for a new one.' };
  return { share: r };
}
const seen = new Map(); // token:ip -> last counted (a view = a visit, not every seek)

function router() {
  const r = express.Router();
  r.use((req, res, next) => { res.set({ 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' }); next(); });
  r.get('/s/vendor/hls.min.js', (req, res) => res.sendFile(require.resolve('hls.js/dist/hls.min.js')));
  r.get('/s/share.css', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'share.css')));
  r.get('/s/share.js', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'share.js')));
  r.get('/s/:token', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'share.html')));
  const load = (req, res) => {
    const v = valid(req.params.token);
    if (v.error) { res.status(410).json({ error: v.error }); return null; }
    const item = db.prepare('SELECT i.*, s.title AS show_title, s.poster AS show_poster, s.backdrop AS show_backdrop FROM items i LEFT JOIN items s ON s.id = i.parent_id WHERE i.id = ?').get(v.share.item_id);
    if (!item || !item.path || !fs.existsSync(item.path)) { res.status(410).json({ error: 'This video is no longer available.' }); return null; }
    return { share: v.share, item };
  };
  r.get('/s/:token/info', (req, res) => {
    const x = load(req, res);
    if (!x) return;
    const { share: sh, item: it } = x;
    const viewsLeft = sh.max_views ? Math.max(0, sh.max_views - sh.views) : null;
    res.json({
      title: it.show_title ? `${it.show_title}` : it.title, subtitle: it.show_title ? `Season ${it.season} · Episode ${it.episode} · ${it.title}` : [it.year, it.runtime ? `${it.runtime} min` : null].filter(Boolean).join(' · '),
      overview: it.overview, from: sh.by, note: sh.note, expiresAt: sh.expires_at, viewsLeft, duration: it.duration,
      poster: (it.poster || it.show_poster) ? `/s/${req.params.token}/art/poster` : null, backdrop: (it.backdrop || it.still || it.show_backdrop) ? `/s/${req.params.token}/art/backdrop` : null,
      serverName: getSetting('server_name', 'Marquee'),
    });
  });
  r.get('/s/:token/art/:kind', C.wrap(async (req, res) => {
    const x = load(req, res);
    if (!x) return;
    const it = x.item;
    let name = req.params.kind === 'poster' ? it.poster || it.show_poster : it.backdrop || it.still || it.show_backdrop;
    if (!name) return res.status(404).end();
    if (name.startsWith('tmdb/')) name = await tmdb.cacheTmdbPath(name);
    const f = name && path.join(tmdb.IMG_DIR, name);
    if (!f || !fs.existsSync(f)) return res.status(404).end();
    res.set('Cache-Control', 'public, max-age=86400').sendFile(f);
  }));
  r.post('/s/:token/play', express.json({ limit: '10kb' }), (req, res) => {
    const x = load(req, res);
    if (!x) return;
    const { share: sh, item } = x;
    const key = `${sh.token}:${req.ip}`;
    if (!seen.has(key) || Date.now() - seen.get(key) > 6 * 3600000) {
      if (sh.max_views && sh.views >= sh.max_views) return res.status(410).json({ error: 'This link has been used up. Ask for a new one.' });
      db.prepare('UPDATE shares SET views = views + 1 WHERE token = ?').run(sh.token);
      seen.set(key, Date.now());
      if (sh.views === 0) require('./notify').message({ kind: 'info', profileId: sh.profile_id, title: '🔗 Your share was opened', body: `Someone just started watching ${item.show_title ? `${item.show_title} — ${item.title}` : item.title}.` }).catch(() => {});
    }
    const caps = req.body?.caps || {};
    const quality = getSetting('share_quality', '1080');
    const ready = versions.bestReady(item.id, +quality || 1080);
    const decision = stream.decide(item, quality, caps, 0, null, ready, false);
    const base = `/s/${sh.token}`;
    const subs = stream.listSubtitles(item).filter(s => !s.burn).map(s => ({ key: s.key, label: s.label, lang: s.lang, url: `${base}/subs/${s.key}` }));
    if (decision.mode === 'direct') return res.json({ mode: 'direct', url: `${base}/file`, subs });
    if (decision.mode === 'version') return res.json({ mode: 'direct', url: `${base}/file?v=${decision.version.id}`, subs });
    const s = stream.startSession(item, { quality, audioIndex: 0, start: Math.max(0, +req.body?.start || 0), deviceId: `share:${sh.token}`, profileId: sh.profile_id,
      copyVideo: decision.copyVideo, copyAudio: decision.copyAudio, burnSub: null, night: false });
    res.json({ mode: 'hls', url: `${base}/hls/${s.id}/index.m3u8`, start: s.start, duration: item.duration, subs });
  });
  r.get('/s/:token/file', (req, res) => {
    const x = load(req, res);
    if (!x) return;
    if (req.query.v) {
      const v = db.prepare("SELECT path FROM versions WHERE id = ? AND item_id = ? AND status = 'ready'").get(+req.query.v, x.item.id);
      if (v && fs.existsSync(v.path)) return res.sendFile(v.path, { acceptRanges: true, headers: { 'Cache-Control': 'no-store' } });
      return res.status(404).end();
    }
    res.sendFile(x.item.path, { dotfiles: 'allow', acceptRanges: true, headers: { 'Cache-Control': 'no-store' } });
  });
  const ownSession = (req, res, next) => {
    const s = stream.sessions.get(req.params.sid);
    if (!s || s.deviceId !== `share:${req.params.token}` || valid(req.params.token).error) return res.status(404).end();
    next();
  };
  r.get('/s/:token/hls/:sid/index.m3u8', ownSession, C.wrap(stream.servePlaylist));
  r.get('/s/:token/hls/:sid/:seg', ownSession, C.wrap(stream.serveSegment));
  r.get('/s/:token/subs/:key', (req, res) => { const x = load(req, res); if (x) stream.serveSubtitle(x.item, req.params.key, res); });
  return r;
}

// The share-only server for Tailscale Funnel (or any reverse proxy you choose)
function startPublicServer(port) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.use(router());
  app.get('/', (req, res) => res.status(404).send('Nothing here.'));
  app.use((req, res) => res.status(404).send('Not found'));
  app.use((err, req, res, next) => { console.error('Share server:', err.message); if (!res.headersSent) res.status(500).end(); });
  app.listen(port, '0.0.0.0', () => console.log(`Share links served on port ${port}`)).on('error', e => console.warn(`Share server couldn't start on port ${port}: ${e.message}`));
}

module.exports = { create, list, revoke, router, startPublicServer, publicBase };
