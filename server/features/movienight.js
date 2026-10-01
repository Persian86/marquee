// Movie night: everyone swipes yes/no on a shortlist from their own phone (in Marquee or FamilyNest)
// and Marquee finds the film you all said yes to.
const crypto = require('crypto');
const { db, getSetting } = require('../db');
const C = require('../common');
const notify = require('./notify');

const rooms = new Map(); // code -> room
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_LIFE = 12 * 3600000;

function newCode() {
  let c;
  do { c = Array.from(crypto.randomBytes(4), b => LETTERS[b % LETTERS.length]).join(''); } while (rooms.has(c));
  return c;
}

// Profiles are looked up by id, or by name for people joining from FamilyNest ("Zoey" → Zoey's Marquee profile)
function profileByName(name) {
  return db.prepare('SELECT * FROM profiles WHERE LOWER(name) = LOWER(?) AND hidden = 0').get(String(name || '').trim()) || null;
}

function pickCandidates(profile, opts, exclude = new Set(), count = 12) {
  const where = ['i.duration IS NOT NULL'], params = [];
  if (opts.genre) { where.push(`(', ' || i.genres || ', ') LIKE ?`); params.push(`%, ${opts.genre}, %`); }
  if (opts.maxRuntime) where.push(`i.duration <= ${(opts.maxRuntime | 0) * 60 + 300}`);
  if (opts.familyFriendly) where.push('(i.level IS NOT NULL AND i.level <= 1)'); // G and PG
  if (opts.pool !== 'all') where.push('(pr.watched IS NULL OR pr.watched = 0)');
  if (opts.pool === 'mylist') where.push(`i.id IN (SELECT item_id FROM watchlist WHERE profile_id = ${profile.id | 0} UNION SELECT li.item_id FROM list_items li JOIN lists l2 ON l2.id = li.list_id WHERE l2.shared = 1)`);
  if (exclude.size) where.push(`i.id NOT IN (${[...exclude].map(n => n | 0).join(',')})`);
  // Favour well-rated films, with a bit of randomness so it's different each time
  return C.movieList(profile, where.join(' AND '), '(COALESCE(i.vote, 6) + ABS(RANDOM() % 300) / 100.0) DESC', count, params);
}

function create(profile, opts = {}) {
  const o = {
    genre: opts.genre ? String(opts.genre).slice(0, 40) : null,
    maxRuntime: opts.maxRuntime ? Math.max(60, Math.min(300, opts.maxRuntime | 0)) : null,
    familyFriendly: !!opts.familyFriendly,
    pool: ['unwatched', 'all', 'mylist'].includes(opts.pool) ? opts.pool : 'unwatched',
  };
  const candidates = pickCandidates(profile, o);
  if (candidates.length < 2) throw new Error(o.genre || o.maxRuntime || o.pool === 'mylist' ? 'Not enough movies match those choices — try fewer filters' : 'Add some movies to Marquee first');
  const code = newCode();
  const room = {
    code, hostName: profile.name, hostProfileId: profile.id, createdAt: Date.now(), options: o,
    candidates: candidates.map(c => c.id), info: new Map(candidates.map(c => [c.id, c])),
    members: new Map(), listeners: new Set(), match: null, scheduled: null, closedAt: null,
  };
  rooms.set(code, room);
  join(room, { profile });
  return room;
}

function get(code) {
  const room = rooms.get(String(code || '').toUpperCase().trim());
  if (room && Date.now() - room.createdAt > ROOM_LIFE) { rooms.delete(room.code); return null; }
  return room || null;
}

// A member is a Marquee profile, or a FamilyNest person (by name, linked to the profile with the same name if there is one)
function memberKey({ profile, name }) { return profile ? `p${profile.id}` : `n:${String(name).trim().toLowerCase()}`; }
function join(room, { profile = null, name = null, source = 'marquee' }) {
  if (!profile && name) profile = profileByName(name);
  const displayName = profile ? profile.name : String(name || 'Guest').trim().slice(0, 30) || 'Guest';
  const key = memberKey({ profile, name: displayName });
  let m = room.members.get(key);
  if (!m) {
    m = { key, name: displayName, color: profile?.color || '#8a8a8a', profileId: profile?.id || null, source, votes: new Map(), joinedAt: Date.now() };
    room.members.set(key, m);
    broadcast(room);
  }
  return m;
}

// Films this member is allowed to see (kids only get films their profile allows)
function allowedFor(m, itemId) {
  if (!m.profileId) return true;
  const p = db.prepare('SELECT * FROM profiles WHERE id = ?').get(m.profileId);
  return !p || C.visibleTo(p, itemId);
}

function vote(room, member, itemId, yes) {
  if (!room.candidates.includes(itemId)) throw new Error('That film is not in this movie night');
  member.votes.set(itemId, !!yes);
  computeMatch(room);
  broadcast(room);
}

function computeMatch(room) {
  if (room.match) return;
  const members = [...room.members.values()];
  if (members.length < 2) return;
  for (const id of room.candidates) {
    const usable = members.filter(m => allowedFor(m, id));
    if (usable.length < members.length) continue;          // someone (a kid) can't watch it
    if (members.every(m => m.votes.get(id) === true)) { room.match = { itemId: id, unanimous: true, at: Date.now() }; announceMatch(room); return; }
  }
  // Everyone's finished and nothing was unanimous: go with the most-loved film
  const finished = members.every(m => room.candidates.every(id => m.votes.has(id) || !allowedFor(m, id)));
  if (finished) {
    let best = null, bestScore = 0;
    for (const id of room.candidates) {
      if (!members.every(m => allowedFor(m, id))) continue;
      const score = members.filter(m => m.votes.get(id) === true).length;
      if (score > bestScore) { best = id; bestScore = score; }
    }
    if (best) { room.match = { itemId: best, unanimous: false, yes: bestScore, of: members.length, at: Date.now() }; announceMatch(room); }
  }
}

function announceMatch(room) {
  const film = room.info.get(room.match.itemId);
  notify.webhook('movie_night', 'Movie night pick', `${film?.title || 'A film'} — chosen by ${[...room.members.values()].map(m => m.name).join(', ')}`,
    { code: room.code, itemId: room.match.itemId, film: film ? { title: film.title, year: film.year } : null }).catch(() => {});
}

function addMore(room, profile) {
  const host = db.prepare('SELECT * FROM profiles WHERE id = ?').get(room.hostProfileId) || profile;
  const more = pickCandidates(host, room.options, new Set(room.candidates), 8);
  for (const c of more) { room.candidates.push(c.id); room.info.set(c.id, c); }
  broadcast(room);
  return more.length;
}

function schedule(room, member, at) {
  const t = new Date(at).getTime();
  if (!room.match) throw new Error('Pick a film first');
  if (!isFinite(t)) throw new Error('Pick a time');
  room.scheduled = { at: t, by: member.name };
  const film = room.info.get(room.match.itemId);
  const when = new Date(t).toLocaleString('en-AU', { weekday: 'long', hour: 'numeric', minute: '2-digit' });
  for (const m of room.members.values()) {
    if (m.profileId) notify.message({ kind: 'info', profileId: m.profileId, title: '🍿 Movie night', body: `${film.title} — ${when}`, url: `/#/item/${film.id}`, itemIds: [film.id] }).catch(() => {});
  }
  notify.webhook('movie_night_scheduled', 'Movie night', `${film.title} — ${when}`, {
    code: room.code, itemId: film.id, start: new Date(t).toISOString(), durationMinutes: Math.round((film.duration || 7200) / 60) + 15,
    film: { title: film.title, year: film.year }, people: [...room.members.values()].map(m => m.name),
  }).catch(() => {});
  broadcast(room);
}

// .ics file so it can go straight into any calendar (FamilyNest, Google, Apple)
function ics(room) {
  if (!room.match) return null;
  const film = room.info.get(room.match.itemId);
  const start = room.scheduled?.at || nextEvening();
  const end = start + ((film.duration || 7200) + 900) * 1000;
  const f = t => new Date(t).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const esc = s => String(s || '').replace(/[\\;,]/g, m => '\\' + m).replace(/\n/g, '\\n');
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Marquee//Movie night//EN', 'BEGIN:VEVENT',
    `UID:movienight-${room.code}-${film.id}@marquee`, `DTSTAMP:${f(Date.now())}`, `DTSTART:${f(start)}`, `DTEND:${f(end)}`,
    `SUMMARY:${esc(`🍿 Movie night: ${film.title}`)}`, `DESCRIPTION:${esc(`${film.overview || ''}\n\nChosen by ${[...room.members.values()].map(m => m.name).join(', ')} on Marquee.`)}`,
    'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
}
function nextEvening() { const d = new Date(); if (d.getHours() >= 19) d.setDate(d.getDate() + 1); d.setHours(19, 0, 0, 0); return d.getTime(); }

// What one member sees. imgUrl lets FamilyNest rewrite poster links so they work with its token.
function view(room, member, imgUrl = u => u) {
  const film = id => {
    const c = room.info.get(id);
    return c && { id: c.id, title: c.title, year: c.year, overview: c.overview, poster: imgUrl(c.poster), backdrop: imgUrl(c.backdrop), genres: c.genres, vote: c.vote,
      runtime: c.duration ? Math.round(c.duration / 60) : c.runtime, certification: c.certification };
  };
  const members = [...room.members.values()];
  const mine = member ? room.candidates.filter(id => allowedFor(member, id)) : room.candidates;
  return {
    code: room.code, host: room.hostName, createdAt: room.createdAt, options: room.options,
    you: member ? { name: member.name, key: member.key } : null,
    members: members.map(m => ({ name: m.name, color: m.color, source: m.source, voted: m.votes.size, total: room.candidates.filter(id => allowedFor(m, id)).length })),
    toVote: member ? mine.filter(id => !member.votes.has(id)).map(film) : [],
    yourYes: member ? mine.filter(id => member.votes.get(id) === true).map(film) : [],
    // Films everyone so far said yes to (shown as "Looking good" before the final pick)
    agreed: members.length > 1 ? room.candidates.filter(id => members.every(m => m.votes.get(id) === true)).map(film) : [],
    total: room.candidates.length,
    match: room.match ? { ...room.match, film: film(room.match.itemId) } : null,
    scheduled: room.scheduled,
  };
}

function broadcast(room) {
  for (const l of room.listeners) {
    try { l.res.write(`event: state\ndata: ${JSON.stringify(view(room, room.members.get(l.key), l.imgUrl))}\n\n`); } catch {}
  }
}
function listen(room, member, res, imgUrl) {
  const l = { key: member.key, res, imgUrl };
  room.listeners.add(l);
  res.write(`event: state\ndata: ${JSON.stringify(view(room, member, imgUrl))}\n\n`);
  const ping = setInterval(() => { try { res.write('event: ping\ndata: {}\n\n'); } catch {} }, 25000);
  res.on('close', () => { clearInterval(ping); room.listeners.delete(l); });
}

function active() {
  const out = [];
  for (const r of rooms.values()) {
    if (Date.now() - r.createdAt > ROOM_LIFE) { rooms.delete(r.code); continue; }
    out.push({ code: r.code, host: r.hostName, createdAt: r.createdAt, members: [...r.members.values()].map(m => m.name), match: r.match ? r.info.get(r.match.itemId)?.title : null });
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

function close(room) { rooms.delete(room.code); for (const l of room.listeners) try { l.res.end(); } catch {} }

module.exports = { create, get, join, vote, addMore, schedule, ics, view, listen, active, close, profileByName };
