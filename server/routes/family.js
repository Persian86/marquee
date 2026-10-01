// Routes for: movie night voting, memories, faces in photos.
const express = require('express');
const { db, getSetting } = require('../db');
const C = require('../common');
const movienight = require('../features/movienight');
const memories = require('../features/memories');
const smartsearch = require('../features/smartsearch');
const assistant = require('../features/assistant');
const faces = require('../features/faces');
const share = require('../features/share');

const { wrap } = C;
const r = express.Router();
const fail = (res, e, code = 400) => res.status(code).json({ error: e.message || String(e) });

// ---------- movie night ----------
r.get('/movienight', (req, res) => res.json(movienight.active()));
r.post('/movienight', (req, res) => {
  try { const room = movienight.create(req.profile, req.body || {}); res.json({ code: room.code }); } catch (e) { fail(res, e); }
});
function roomAndMe(req, res) {
  const room = movienight.get(req.params.code);
  if (!room) { res.status(404).json({ error: 'That movie night has finished, or the code is wrong' }); return []; }
  return [room, movienight.join(room, { profile: req.profile })];
}
r.get('/movienight/:code', (req, res) => {
  const [room, me] = roomAndMe(req, res);
  if (room) res.json(movienight.view(room, me));
});
r.get('/movienight/:code/events', (req, res) => {
  const [room, me] = roomAndMe(req, res);
  if (!room) return;
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  movienight.listen(room, me, res);
});
r.post('/movienight/:code/vote', (req, res) => {
  const [room, me] = roomAndMe(req, res);
  if (!room) return;
  try { movienight.vote(room, me, +req.body?.itemId, !!req.body?.yes); res.json(movienight.view(room, me)); } catch (e) { fail(res, e); }
});
r.post('/movienight/:code/more', (req, res) => {
  const [room, me] = roomAndMe(req, res);
  if (room) res.json({ added: movienight.addMore(room, req.profile), ...movienight.view(room, me) });
});
r.post('/movienight/:code/schedule', (req, res) => {
  const [room, me] = roomAndMe(req, res);
  if (!room) return;
  try { movienight.schedule(room, me, req.body?.at); res.json(movienight.view(room, me)); } catch (e) { fail(res, e); }
});
r.get('/movienight/:code/event.ics', (req, res) => {
  const room = movienight.get(req.params.code);
  const text = room && movienight.ics(room);
  if (!text) return res.status(404).end();
  res.set({ 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': 'attachment; filename="movie-night.ics"' }).send(text);
});
r.delete('/movienight/:code', (req, res) => {
  const room = movienight.get(req.params.code);
  if (room && (room.hostProfileId === req.profile.id || req.profile.is_admin)) movienight.close(room);
  res.json({ ok: true });
});

// ---------- plain-English search & voice commands from inside the app ----------
r.get('/smart-search', wrap(async (req, res) => res.json(await smartsearch.search(req.profile, req.query.q, { limit: 60 }))));
r.post('/assistant', wrap(async (req, res) => {
  try { res.json(await assistant.handle(req.profile, String(req.body?.text || ''), { device: req.body?.device || null })); }
  catch (e) { res.json({ ok: false, speech: e.message }); }
}));

// ---------- guest share links ----------
r.get('/shares', (req, res) => res.json({ shares: share.list(req.profile), publicBase: share.publicBase() || null }));
r.post('/shares', (req, res) => { try { res.json(share.create(req.profile, req.body || {})); } catch (e) { fail(res, e); } });
r.delete('/shares/:id', (req, res) => res.json({ ok: share.revoke(req.profile, req.params.id) }));

// ---------- memories ----------
r.get('/memories', (req, res) => res.json(memories.forProfile(req.profile)));

// ---------- faces in photos ----------
r.get('/photo-people', (req, res) => res.json({ people: faces.people(req.profile), status: req.profile.is_admin ? faces.summary() : { enabled: faces.enabled() } }));
r.get('/photo-people/:id', (req, res) => {
  const person = db.prepare('SELECT id, name, hidden FROM face_people WHERE id = ?').get(req.params.id);
  if (!person) return fail(res, new Error('Not found'), 404);
  const photos = faces.photosOf(req.profile, person.id);
  if (!photos.length) return fail(res, new Error('Not found'), 404);
  res.json({ ...person, photos });
});
const canEdit = (req, res) => { if (req.profile.is_kids || req.profile.is_guest) { fail(res, new Error('Ask a grown-up to change names'), 403); return false; } return true; };
r.patch('/photo-people/:id', (req, res) => {
  if (!canEdit(req, res)) return;
  let id = +req.params.id;
  if (req.body?.name !== undefined) id = faces.rename(id, req.body.name);
  if (req.body?.hidden !== undefined) faces.hide(id, !!req.body.hidden);
  if (req.body?.coverFaceId) faces.setCover(id, +req.body.coverFaceId);
  res.json({ ok: true, id });
});
r.post('/photo-people/:id/merge', (req, res) => { if (canEdit(req, res)) { faces.merge(+req.params.id, +req.body?.into); res.json({ ok: true }); } });
r.get('/photo-faces/:id', (req, res) => {
  if (!C.getVisibleItem(req.profile, req.params.id)) return res.status(404).end();
  res.json(faces.facesIn(+req.params.id));
});
r.patch('/faces/:id', (req, res) => {
  if (!canEdit(req, res)) return;
  try { res.json({ ok: true, personId: faces.setFace(+req.params.id, { personId: req.body?.personId, name: req.body?.name }) }); } catch (e) { fail(res, e); }
});
r.get('/faces/:id/thumb', wrap(async (req, res) => {
  const f = db.prepare('SELECT item_id FROM faces WHERE id = ?').get(req.params.id);
  if (!f || !C.getVisibleItem(req.profile, f.item_id)) return res.status(404).end();
  await faces.thumb(+req.params.id, res);
}));

module.exports = { router: r };
