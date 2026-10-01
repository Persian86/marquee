// Trakt.tv sync: anything finished in Marquee is marked watched on Trakt (and ratings), and Trakt history can be imported.
const { db, getSetting } = require('../db');

const API = 'https://api.trakt.tv';
const clientId = () => getSetting('trakt_client_id') || '';
const clientSecret = () => getSetting('trakt_client_secret') || '';
const configured = () => !!(clientId() && clientSecret());
const pending = new Map(); // profileId -> device code

async function call(endpoint, { method = 'GET', body, token } = {}) {
  const res = await fetch(API + endpoint, {
    method, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000),
    headers: { 'Content-Type': 'application/json', 'trakt-api-version': '2', 'trakt-api-key': clientId(), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) { const e = new Error(data?.error_description || `Trakt error ${res.status}`); e.status = res.status; throw e; }
  return data;
}

async function startLink(profileId) {
  if (!configured()) throw new Error('Ask the admin to add Trakt app details in Settings');
  const d = await call('/oauth/device/code', { method: 'POST', body: { client_id: clientId() } });
  pending.set(profileId, { ...d, started: Date.now() });
  return { code: d.user_code, url: d.verification_url, expiresIn: d.expires_in };
}
async function pollLink(profileId) {
  const p = pending.get(profileId);
  if (!p) return { state: 'none' };
  if (Date.now() - p.started > p.expires_in * 1000) { pending.delete(profileId); return { state: 'expired' }; }
  try {
    const t = await call('/oauth/device/token', { method: 'POST', body: { code: p.device_code, client_id: clientId(), client_secret: clientSecret() } });
    if (!t) return { state: 'waiting' };
    const user = await call('/users/settings', { token: t.access_token }).catch(() => null);
    save(profileId, { access: t.access_token, refresh: t.refresh_token, expires: Date.now() + t.expires_in * 1000, username: user?.user?.username || null });
    pending.delete(profileId);
    return { state: 'linked', username: user?.user?.username };
  } catch (e) {
    if (e.status === 400) return { state: 'waiting' };
    if (e.status === 418 || e.status === 410) { pending.delete(profileId); return { state: 'denied' }; }
    throw e;
  }
}
function save(profileId, t) { db.prepare('UPDATE profiles SET trakt = ? WHERE id = ?').run(t ? JSON.stringify(t) : null, profileId); }
async function token(profileId) {
  const row = db.prepare('SELECT trakt FROM profiles WHERE id = ?').get(profileId);
  if (!row?.trakt || !configured()) return null;
  let t = JSON.parse(row.trakt);
  if (t.expires - Date.now() < 86400000) {
    try {
      const r = await call('/oauth/token', { method: 'POST', body: { refresh_token: t.refresh, client_id: clientId(), client_secret: clientSecret(), redirect_uri: 'urn:ietf:wg:oauth:2.0:oob', grant_type: 'refresh_token' } });
      t = { ...t, access: r.access_token, refresh: r.refresh_token, expires: Date.now() + r.expires_in * 1000 };
      save(profileId, t);
    } catch { return null; }
  }
  return t.access;
}
function unlink(profileId) { save(profileId, null); }

// Shape one of our items for Trakt's /sync endpoints
function payload(itemIds, extra = () => ({})) {
  const movies = [], shows = new Map();
  for (const id of itemIds) {
    const it = db.prepare('SELECT i.*, s.tmdb_id AS show_tmdb FROM items i LEFT JOIN items s ON s.id = i.parent_id WHERE i.id = ?').get(id);
    if (!it) continue;
    if (it.type === 'movie' && it.tmdb_id) movies.push({ ids: { tmdb: it.tmdb_id }, ...extra(it) });
    if (it.type === 'show' && it.tmdb_id) shows.set(it.tmdb_id, { ids: { tmdb: it.tmdb_id }, ...extra(it) });
    if (it.type === 'episode' && it.show_tmdb && it.episode != null) {
      const s = shows.get(it.show_tmdb) || { ids: { tmdb: it.show_tmdb }, seasons: [] };
      if (!s.seasons) s.seasons = [];
      let season = s.seasons.find(x => x.number === it.season);
      if (!season) s.seasons.push(season = { number: it.season, episodes: [] });
      season.episodes.push({ number: it.episode, ...extra(it) });
      shows.set(it.show_tmdb, s);
    }
  }
  return { movies, shows: [...shows.values()] };
}

async function markWatched(profileId, itemIds) {
  const t = await token(profileId);
  if (!t) return;
  const at = new Date().toISOString();
  try { await call('/sync/history', { method: 'POST', token: t, body: payload(itemIds, () => ({ watched_at: at })) }); } catch (e) { console.warn('Trakt sync:', e.message); }
}
async function rate(profileId, itemId, rating) {
  const t = await token(profileId);
  if (!t) return;
  try { await call(rating ? '/sync/ratings' : '/sync/ratings/remove', { method: 'POST', token: t, body: payload([itemId], () => (rating ? { rating } : {})) }); } catch (e) { console.warn('Trakt rating:', e.message); }
}

// Pull Trakt history into Marquee
async function importHistory(profileId) {
  const t = await token(profileId);
  if (!t) throw new Error('Link Trakt first');
  const [movies, shows] = await Promise.all([call('/sync/watched/movies', { token: t }), call('/sync/watched/shows', { token: t })]);
  const mark = db.prepare(`INSERT INTO progress (profile_id, item_id, position, duration, watched, updated_at) VALUES (?, ?, 0, NULL, 1, ?)
    ON CONFLICT(profile_id, item_id) DO UPDATE SET watched = 1, position = 0`);
  let n = 0;
  for (const m of movies || []) {
    for (const it of db.prepare("SELECT id FROM items WHERE type = 'movie' AND tmdb_id = ?").all(m.movie.ids.tmdb)) { mark.run(profileId, it.id, Date.parse(m.last_watched_at) || Date.now()); n++; }
  }
  for (const s of shows || []) {
    const show = db.prepare("SELECT id FROM items WHERE type = 'show' AND tmdb_id = ?").get(s.show.ids.tmdb);
    if (!show) continue;
    for (const season of s.seasons || []) for (const ep of season.episodes || []) {
      const it = db.prepare("SELECT id FROM items WHERE parent_id = ? AND season = ? AND episode = ?").get(show.id, season.number, ep.number);
      if (it) { mark.run(profileId, it.id, Date.parse(ep.last_watched_at) || Date.now()); n++; }
    }
  }
  return n;
}

function status(profileId) {
  const row = db.prepare('SELECT trakt FROM profiles WHERE id = ?').get(profileId);
  return { configured: configured(), linked: !!row?.trakt, username: row?.trakt ? JSON.parse(row.trakt).username : null };
}

module.exports = { startLink, pollLink, unlink, markWatched, rate, importHistory, status, configured };
