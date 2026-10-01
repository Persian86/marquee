// /ext/v1 — for other apps: FamilyNest (movie night), home-screen widgets, and voice assistants (JARVIS, Siri, Google).
// They sign in with an app key made in Marquee → Settings → Connected apps (or by the Marquee app itself for widgets).
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { db, getSetting } = require('../db');
const C = require('../common');
const tmdb = require('../tmdb');
const movienight = require('../features/movienight');
const assistant = require('../features/assistant');

const r = express.Router();
const fail = (res, e, code = 400) => res.status(code).json({ error: e.message || String(e) });

// ---------- app keys ----------
const KINDS = ['widget', 'assistant', 'familynest', 'device'];
function createToken(profileId, kind, name) {
  const token = 'mq_' + crypto.randomBytes(24).toString('base64url');
  db.prepare('INSERT INTO app_tokens (token, profile_id, kind, name, created_at) VALUES (?, ?, ?, ?, ?)').run(token, profileId, kind, String(name || kind).slice(0, 60), Date.now());
  return token;
}
function tokenAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : String(req.query.k || '');
  const row = token && db.prepare('SELECT t.token, t.kind, t.name AS app_name, p.* FROM app_tokens t JOIN profiles p ON p.id = t.profile_id WHERE t.token = ?').get(token);
  if (!row) return res.status(401).json({ error: 'Unknown or removed app key — make a new one in Marquee → Settings → Connected apps' });
  req.appToken = { token: row.token, kind: row.kind, name: row.app_name };
  req.profile = row;
  if (!row.last_used || Date.now() - row.last_used > 60000) db.prepare('UPDATE app_tokens SET last_used = ? WHERE token = ?').run(Date.now(), token);
  next();
}

// Session routes (mounted under /api) to manage keys
const manage = express.Router();
manage.get('/app-tokens', (req, res) => {
  const rows = req.profile.is_admin
    ? db.prepare('SELECT t.token, t.kind, t.name, t.created_at, t.last_used, p.name AS profile FROM app_tokens t JOIN profiles p ON p.id = t.profile_id ORDER BY t.created_at DESC').all()
    : db.prepare('SELECT t.token, t.kind, t.name, t.created_at, t.last_used, p.name AS profile FROM app_tokens t JOIN profiles p ON p.id = t.profile_id WHERE t.profile_id = ? ORDER BY t.created_at DESC').all(req.profile.id);
  res.json(rows.map(t => ({ ...t, id: t.token.slice(-8), token: undefined, hint: '…' + t.token.slice(-6) })));
});
manage.post('/app-tokens', (req, res) => {
  const kind = KINDS.includes(req.body?.kind) ? req.body.kind : null;
  if (!kind) return fail(res, new Error('Unknown kind'));
  if (!['widget', 'device'].includes(kind) && req.profile.is_guest) return fail(res, new Error('Guests can’t connect apps'), 403);
  let profileId = req.profile.id;
  if (req.body.profileId && req.profile.is_admin) profileId = +req.body.profileId;
  if (kind === 'familynest' && !req.profile.is_admin) return fail(res, new Error('Ask the admin to connect FamilyNest'), 403);
  // A phone or tablet only ever needs one device key — replace the old one (e.g. after switching profile)
  if (kind === 'device' && req.body.name) db.prepare("DELETE FROM app_tokens WHERE kind = 'device' AND name = ?").run(String(req.body.name).slice(0, 60));
  res.json({ token: createToken(profileId, kind, req.body.name), server: getSetting('public_url') || null });
});
manage.delete('/app-tokens/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM app_tokens WHERE substr(token, -8) = ?').get(req.params.id);
  if (row && (req.profile.is_admin || row.profile_id === req.profile.id)) db.prepare('DELETE FROM app_tokens WHERE token = ?').run(row.token);
  res.json({ ok: true });
});

// ---------- everything below needs an app key ----------
r.use(tokenAuth);

r.get('/me', (req, res) => res.json({ profile: { id: req.profile.id, name: req.profile.name, color: req.profile.color, isKids: !!req.profile.is_kids },
  app: req.appToken.kind, serverName: getSetting('server_name', 'Marquee') }));

// Artwork, signed in with the app key (so widgets and FamilyNest can show posters)
r.get(/^\/img\/(.+)$/, C.wrap(async (req, res) => {
  const name = decodeURIComponent(req.params[0]);
  if (name.includes('..')) return res.status(400).end();
  let file = name;
  if (name.startsWith('tmdb/')) file = await tmdb.cacheTmdbPath(name);
  const full = file && path.join(tmdb.IMG_DIR, file);
  if (!full || !full.startsWith(tmdb.IMG_DIR) || !fs.existsSync(full)) return res.status(404).end();
  res.set('Cache-Control', 'private, max-age=604800').sendFile(full);
}));
const extImg = req => u => (u && u.startsWith('/img/') ? `/ext/v1/img/${u.slice(5)}?k=${encodeURIComponent(req.appToken.token)}` : u);

// ---------- widgets: Continue watching + New arrivals ----------
r.get('/widget', (req, res) => {
  const p = req.profile;
  const img = extImg(req);
  const cont = db.prepare(`SELECT i.*, ${C.PROGRESS_COLS}, s.title AS show_title, s.poster AS show_poster, s.backdrop AS show_backdrop
    FROM progress pr JOIN items i ON i.id = pr.item_id LEFT JOIN items s ON s.id = i.parent_id JOIN libraries l ON l.id = i.library_id
    WHERE pr.profile_id = ? AND pr.watched = 0 AND pr.position > 30 AND (pr.duration IS NULL OR pr.position < pr.duration * 0.92)
      AND i.type IN ('movie','episode','home') AND ${C.visible(p, 'COALESCE(s.level, i.level)')}
    ORDER BY pr.updated_at DESC LIMIT 6`).all(p.id).map(C.formatItem);
  const card = (it, wide) => ({
    id: it.id, type: it.type,
    title: it.show ? it.show.title : it.title,
    subtitle: it.show ? `S${it.season} · E${it.episode} · ${it.title}` : [it.year, it.runtime ? `${it.runtime} min` : null].filter(Boolean).join(' · '),
    progress: it.progress && it.progress.duration ? Math.min(1, it.progress.position / it.progress.duration) : null,
    image: img(wide ? (it.still || it.backdrop || it.show?.backdrop || it.poster || it.show?.poster) : (it.poster || it.show?.poster || it.backdrop)),
    open: `marquee://item/${it.show ? it.show.id : it.id}`, play: `marquee://play/${it.id}`,
  });
  const recent = C.movieList(p, '1=1', 'i.added_at DESC', 8).concat(C.showList(p, '1=1', 'i.added_at DESC', 8))
    .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0)).slice(0, 8);
  res.json({
    serverName: getSetting('server_name', 'Marquee'), profile: p.name, updatedAt: Date.now(),
    continueWatching: cont.map(x => card(x, true)),
    newArrivals: recent.map(x => card(x, false)),
  });
});

// ---------- movie night (FamilyNest) ----------
// Who's voting: ?member=Hayley (matched to the Marquee profile with that name, if there is one)
function member(req, room) {
  const name = String(req.query.member || req.body?.member || req.profile.name).trim();
  return movienight.join(room, { name, source: req.appToken.kind === 'familynest' ? 'familynest' : 'app' });
}
function room(req, res) {
  const rm = movienight.get(req.params.code);
  if (!rm) res.status(404).json({ error: 'That movie night has finished, or the code is wrong' });
  return rm;
}
r.get('/movienight', (req, res) => res.json(movienight.active()));
r.get('/movienight/options', (req, res) => {
  const rows = db.prepare(`SELECT i.genres FROM items i JOIN libraries l ON l.id = i.library_id WHERE i.type = 'movie' AND i.genres IS NOT NULL AND ${C.visible(req.profile)}`).all();
  const counts = {};
  for (const x of rows) for (const g of x.genres.split(', ')) counts[g] = (counts[g] || 0) + 1;
  res.json({ genres: Object.entries(counts).filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).map(([g]) => g), pools: ['unwatched', 'all', 'mylist'] });
});
r.post('/movienight', (req, res) => {
  try {
    const starter = movienight.profileByName(req.body?.member) || req.profile;
    const rm = movienight.create(starter, req.body || {});
    // The person starting it from FamilyNest is the first member (not the app key's profile)
    if (req.body?.member && !movienight.profileByName(req.body.member)) member(req, rm);
    res.json(movienight.view(rm, member(req, rm), extImg(req)));
  } catch (e) { fail(res, e); }
});
r.get('/movienight/:code', (req, res) => { const rm = room(req, res); if (rm) res.json(movienight.view(rm, member(req, rm), extImg(req))); });
r.get('/movienight/:code/events', (req, res) => {
  const rm = room(req, res);
  if (!rm) return;
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  movienight.listen(rm, member(req, rm), res, extImg(req));
});
// The Hub screen: watch everyone's progress without voting
r.get('/movienight/:code/board', (req, res) => { const rm = room(req, res); if (rm) res.json(movienight.view(rm, null, extImg(req))); });
r.post('/movienight/:code/vote', (req, res) => {
  const rm = room(req, res);
  if (!rm) return;
  try { const m = member(req, rm); movienight.vote(rm, m, +req.body?.itemId, !!req.body?.yes); res.json(movienight.view(rm, m, extImg(req))); } catch (e) { fail(res, e); }
});
r.post('/movienight/:code/more', (req, res) => { const rm = room(req, res); if (rm) { movienight.addMore(rm, req.profile); res.json(movienight.view(rm, member(req, rm), extImg(req))); } });
r.post('/movienight/:code/schedule', (req, res) => {
  const rm = room(req, res);
  if (!rm) return;
  try { const m = member(req, rm); movienight.schedule(rm, m, req.body?.at); res.json(movienight.view(rm, m, extImg(req))); } catch (e) { fail(res, e); }
});
r.get('/movienight/:code/event.ics', (req, res) => {
  const rm = room(req, res);
  const text = rm && movienight.ics(rm);
  if (!rm) return;
  if (!text) return res.status(404).end();
  res.set({ 'Content-Type': 'text/calendar; charset=utf-8' }).send(text);
});

// ---------- voice assistants ----------
r.post('/assistant', C.wrap(async (req, res) => {
  try { res.json(await assistant.handle(req.profile, String(req.body?.text || ''), { device: req.body?.device || null })); }
  catch (e) { res.json({ ok: false, speech: e.message }); }
}));

module.exports = { router: r, manage, createToken, tokenAuth };
