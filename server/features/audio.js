// Music extras (play counts, playlists, smart playlists, radio, lyrics) and podcasts.
const fs = require('fs');
const path = require('path');
const { XMLParser } = require('fast-xml-parser');
const { db } = require('../db');
const C = require('../common');

const { visible, formatItem } = C;
const now = () => Date.now();

// ---------- play counts ----------
function recordPlay(profileId, itemId) {
  db.prepare(`INSERT INTO plays (profile_id, item_id, count, last_at) VALUES (?, ?, 1, ?)
    ON CONFLICT(profile_id, item_id) DO UPDATE SET count = count + 1, last_at = excluded.last_at`).run(profileId, itemId, now());
}

// ---------- playlists ----------
function playlists(profile) {
  const lists = db.prepare(`SELECT pl.*, pr.name AS owner, (SELECT COUNT(*) FROM playlist_items x WHERE x.playlist_id = pl.id) AS n,
      (SELECT SUM(i.duration) FROM playlist_items x JOIN items i ON i.id = x.item_id WHERE x.playlist_id = pl.id) AS dur
    FROM playlists pl JOIN profiles pr ON pr.id = pl.profile_id WHERE pl.shared = 1 OR pl.profile_id = ? ORDER BY pl.name`).all(profile.id)
    .map(p => ({ id: p.id, name: p.name, owner: p.owner, mine: p.profile_id === profile.id, shared: !!p.shared, count: p.n, duration: p.dur,
      covers: db.prepare('SELECT DISTINCT i.poster FROM playlist_items x JOIN items i ON i.id = x.item_id WHERE x.playlist_id = ? AND i.poster IS NOT NULL ORDER BY x.pos LIMIT 4').all(p.id).map(r => C.img(r.poster)) }));
  return { playlists: lists, smart: SMART.map(s => ({ key: s.key, name: s.name, desc: s.desc })) };
}
function playlistTracks(profile, id) {
  const pl = db.prepare('SELECT * FROM playlists WHERE id = ? AND (shared = 1 OR profile_id = ?)').get(id, profile.id);
  if (!pl) return null;
  const tracks = db.prepare(`SELECT i.* FROM playlist_items x JOIN items i ON i.id = x.item_id JOIN libraries l ON l.id = i.library_id
    WHERE x.playlist_id = ? AND ${visible(profile)} ORDER BY x.pos`).all(id).map(formatItem);
  return { id: pl.id, name: pl.name, mine: pl.profile_id === profile.id || !!profile.is_admin, shared: !!pl.shared, tracks };
}
function createPlaylist(profile, name, itemIds = []) {
  const r = db.prepare('INSERT INTO playlists (name, profile_id, shared, created_at) VALUES (?, ?, 1, ?)').run(String(name).slice(0, 80), profile.id, now());
  const id = Number(r.lastInsertRowid);
  addToPlaylist(id, itemIds);
  return id;
}
function addToPlaylist(id, itemIds) {
  let pos = db.prepare('SELECT COALESCE(MAX(pos), 0) AS p FROM playlist_items WHERE playlist_id = ?').get(id).p;
  const ins = db.prepare('INSERT OR IGNORE INTO playlist_items (playlist_id, item_id, pos) VALUES (?, ?, ?)');
  for (const t of itemIds) ins.run(id, t, ++pos);
}

// ---------- smart playlists ----------
const SMART = [
  { key: 'most-played', name: 'Most played', desc: 'Your top songs', sql: p => `SELECT i.* FROM plays pl JOIN items i ON i.id = pl.item_id JOIN libraries l ON l.id = i.library_id WHERE pl.profile_id = ${p.id} AND ${visible(p)} ORDER BY pl.count DESC LIMIT 100` },
  { key: 'recent', name: 'Recently added', desc: 'New to the library', sql: p => `SELECT i.* FROM items i JOIN libraries l ON l.id = i.library_id WHERE i.type = 'track' AND ${visible(p)} ORDER BY i.added_at DESC LIMIT 100` },
  { key: 'forgotten', name: 'Forgotten favourites', desc: 'Loved once, not played lately', sql: p => `SELECT i.* FROM plays pl JOIN items i ON i.id = pl.item_id JOIN libraries l ON l.id = i.library_id WHERE pl.profile_id = ${p.id} AND pl.count >= 3 AND pl.last_at < ${now() - 60 * 86400000} AND ${visible(p)} ORDER BY RANDOM() LIMIT 100` },
  { key: 'never', name: 'Never played', desc: 'Give these a go', sql: p => `SELECT i.* FROM items i JOIN libraries l ON l.id = i.library_id WHERE i.type = 'track' AND ${visible(p)} AND NOT EXISTS (SELECT 1 FROM plays pl WHERE pl.item_id = i.id AND pl.profile_id = ${p.id}) ORDER BY RANDOM() LIMIT 100` },
];
function smartTracks(profile, key) {
  const s = SMART.find(x => x.key === key);
  if (s) return { name: s.name, tracks: db.prepare(s.sql(profile)).all().map(formatItem) };
  if (key.startsWith('genre:')) {
    const g = key.slice(6);
    return { name: g, tracks: db.prepare(`SELECT i.* FROM items i JOIN libraries l ON l.id = i.library_id WHERE i.type = 'track' AND i.genres LIKE ? AND ${visible(profile)} ORDER BY RANDOM() LIMIT 100`).all(`%${g}%`).map(formatItem) };
  }
  return null;
}
function genres(profile) {
  const rows = db.prepare(`SELECT i.genres, COUNT(*) AS n FROM items i JOIN libraries l ON l.id = i.library_id WHERE i.type = 'track' AND i.genres IS NOT NULL AND ${visible(profile)} GROUP BY i.genres`).all();
  const out = {};
  for (const r of rows) for (const g of r.genres.split(/[;,/]/).map(x => x.trim()).filter(Boolean)) out[g] = (out[g] || 0) + r.n;
  return Object.entries(out).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));
}

// ---------- radio: the artist (or song) plus similar-sounding things by genre, favourites weighted up ----------
function radio(profile, { artist, trackId }) {
  let seedArtist = artist, seedGenres = [];
  if (trackId) {
    const t = db.prepare("SELECT album_artist, genres FROM items WHERE id = ? AND type = 'track'").get(trackId);
    if (t) { seedArtist = t.album_artist; seedGenres = (t.genres || '').split(/[;,/]/).map(x => x.trim()).filter(Boolean); }
  }
  if (seedArtist && !seedGenres.length) {
    seedGenres = [...new Set(db.prepare("SELECT genres FROM items WHERE type = 'track' AND album_artist = ? AND genres IS NOT NULL").all(seedArtist)
      .flatMap(r => r.genres.split(/[;,/]/).map(x => x.trim())).filter(Boolean))];
  }
  const pool = db.prepare(`SELECT i.*, COALESCE(pl.count, 0) AS plays FROM items i JOIN libraries l ON l.id = i.library_id
    LEFT JOIN plays pl ON pl.item_id = i.id AND pl.profile_id = ? WHERE i.type = 'track' AND ${visible(profile)}`).all(profile.id);
  const scored = pool.map(t => {
    let s = Math.random() * 2;
    if (t.album_artist === seedArtist) s += 3;
    if (seedGenres.some(g => (t.genres || '').includes(g))) s += 2.5;
    s += Math.min(2, t.plays / 5);
    return [s, t];
  }).filter(([s]) => s > 2.2).sort((a, b) => b[0] - a[0]).slice(0, 80).map(([, t]) => t);
  // Don't play the same artist three times in a row
  const out = [];
  while (scored.length) {
    const i = scored.findIndex(t => out.length < 2 || !(out[out.length - 1].album_artist === t.album_artist && out[out.length - 2].album_artist === t.album_artist));
    out.push(scored.splice(i < 0 ? 0 : i, 1)[0]);
  }
  return out.slice(0, 60).map(formatItem);
}

// ---------- lyrics: .lrc next to the file → lyrics inside the file → LRCLIB (free online lyrics) ----------
async function lyrics(item) {
  const cached = db.prepare('SELECT * FROM lyrics WHERE item_id = ?').get(item.id);
  if (cached && (cached.text || now() - cached.fetched_at < 30 * 86400000)) return cached.text ? { synced: !!cached.synced, text: cached.text, source: cached.source } : null;
  let found = null;
  const base = item.path.replace(/\.[^.]+$/, '');
  for (const ext of ['.lrc', '.txt']) if (fs.existsSync(base + ext)) { const t = fs.readFileSync(base + ext, 'utf8'); found = { synced: /\[\d+:\d+/.test(t), text: t, source: 'file' }; break; }
  if (!found) {
    try {
      const tags = JSON.parse(item.probe || '{}').tags || {};
      const t = tags.lyrics || tags['lyrics-eng'] || tags.unsyncedlyrics || Object.entries(tags).find(([k]) => k.startsWith('lyrics'))?.[1];
      if (t) found = { synced: /\[\d+:\d+/.test(t), text: t, source: 'tags' };
    } catch {}
  }
  if (!found) {
    try {
      const q = new URLSearchParams({ artist_name: item.artist || item.album_artist || '', track_name: item.title, album_name: item.album || '', duration: Math.round(item.duration || 0) });
      const r = await fetch(`https://lrclib.net/api/get?${q}`, { headers: { 'User-Agent': 'Marquee v2 (self-hosted media server)' }, signal: AbortSignal.timeout(10000) });
      if (r.ok) { const d = await r.json(); if (d.syncedLyrics || d.plainLyrics) found = { synced: !!d.syncedLyrics, text: d.syncedLyrics || d.plainLyrics, source: 'lrclib' }; }
    } catch {}
  }
  db.prepare('INSERT OR REPLACE INTO lyrics (item_id, synced, text, source, fetched_at) VALUES (?, ?, ?, ?, ?)').run(item.id, found?.synced ? 1 : 0, found?.text || null, found?.source || null, now());
  return found;
}

// ---------- podcasts ----------
const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', textNodeName: '#text', cdataPropName: false, isArray: n => n === 'item' });
const text = v => (v == null ? null : typeof v === 'object' ? (v['#text'] ?? null) : String(v));
function parseDuration(v) {
  const s = text(v);
  if (!s) return null;
  if (/^\d+$/.test(s)) return +s;
  const p = s.split(':').map(Number);
  return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p.length === 2 ? p[0] * 60 + p[1] : null;
}
const strip = s => (s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim().slice(0, 4000);

async function fetchFeed(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'Marquee v2 podcast player' }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`Couldn't load that feed (${r.status})`);
  const doc = xml.parse(await r.text());
  const ch = doc?.rss?.channel;
  if (!ch) throw new Error("That doesn't look like a podcast feed");
  return {
    title: text(ch.title) || 'Podcast', author: text(ch['itunes:author']) || text(ch.author), description: strip(text(ch.description) || text(ch['itunes:summary'])),
    image: ch['itunes:image']?.['@href'] || text(ch.image?.url),
    episodes: (ch.item || []).filter(i => i.enclosure?.['@url']).map(i => ({
      guid: text(i.guid) || i.enclosure['@url'], title: text(i.title) || 'Episode', description: strip(text(i.description) || text(i['content:encoded']) || text(i['itunes:summary'])),
      pubDate: Date.parse(text(i.pubDate)) || null, duration: parseDuration(i['itunes:duration']), audioUrl: i.enclosure['@url'], image: i['itunes:image']?.['@href'] || null,
    })),
  };
}
async function subscribe(url) {
  const f = await fetchFeed(url);
  db.prepare(`INSERT INTO podcasts (feed_url, title, author, image, description, last_checked, added_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(feed_url) DO UPDATE SET title = excluded.title, author = excluded.author, image = excluded.image, description = excluded.description, last_checked = excluded.last_checked`)
    .run(url, f.title, f.author, f.image, f.description, now(), now());
  const id = db.prepare('SELECT id FROM podcasts WHERE feed_url = ?').get(url).id;
  storeEpisodes(id, f.episodes);
  return id;
}
function storeEpisodes(podcastId, eps) {
  const ins = db.prepare(`INSERT INTO podcast_episodes (podcast_id, guid, title, description, pub_date, duration, audio_url, image) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(podcast_id, guid) DO UPDATE SET title = excluded.title, description = excluded.description, audio_url = excluded.audio_url, duration = COALESCE(excluded.duration, duration)`);
  for (const e of eps.slice(0, 500)) ins.run(podcastId, e.guid, e.title, e.description, e.pubDate, e.duration, e.audioUrl, e.image);
}
async function refreshAll() {
  for (const p of db.prepare('SELECT * FROM podcasts').all()) {
    try { const f = await fetchFeed(p.feed_url); storeEpisodes(p.id, f.episodes); db.prepare('UPDATE podcasts SET last_checked = ? WHERE id = ?').run(now(), p.id); }
    catch (e) { console.warn('Podcast refresh failed:', p.title, e.message); }
  }
}
async function searchPodcasts(term) {
  const r = await fetch(`https://itunes.apple.com/search?media=podcast&limit=20&term=${encodeURIComponent(term)}`, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('Podcast search is unavailable right now');
  const d = await r.json();
  return (d.results || []).filter(x => x.feedUrl).map(x => ({ title: x.collectionName, author: x.artistName, image: x.artworkUrl600 || x.artworkUrl100, feedUrl: x.feedUrl, episodes: x.trackCount,
    subscribed: !!db.prepare('SELECT 1 FROM podcasts WHERE feed_url = ?').get(x.feedUrl) }));
}
function podcastList(profile) {
  return db.prepare(`SELECT p.*, (SELECT COUNT(*) FROM podcast_episodes e WHERE e.podcast_id = p.id AND NOT EXISTS
      (SELECT 1 FROM podcast_progress pp WHERE pp.episode_id = e.id AND pp.profile_id = ? AND pp.played = 1)) AS unplayed,
      (SELECT MAX(pub_date) FROM podcast_episodes e WHERE e.podcast_id = p.id) AS latest
    FROM podcasts p ORDER BY latest DESC`).all(profile.id);
}
function podcastEpisodes(profile, id) {
  const p = db.prepare('SELECT * FROM podcasts WHERE id = ?').get(id);
  if (!p) return null;
  const eps = db.prepare(`SELECT e.*, pp.position, pp.played FROM podcast_episodes e LEFT JOIN podcast_progress pp ON pp.episode_id = e.id AND pp.profile_id = ?
    WHERE e.podcast_id = ? ORDER BY e.pub_date DESC LIMIT 300`).all(profile.id, id);
  return { ...p, episodes: eps };
}
function latestEpisodes(profile, limit = 20) {
  return db.prepare(`SELECT e.*, p.title AS podcast, p.image AS podcast_image, pp.position, pp.played FROM podcast_episodes e JOIN podcasts p ON p.id = e.podcast_id
    LEFT JOIN podcast_progress pp ON pp.episode_id = e.id AND pp.profile_id = ? WHERE COALESCE(pp.played, 0) = 0 ORDER BY e.pub_date DESC LIMIT ?`).all(profile.id, limit);
}
function podcastProgress(profileId, episodeId, position, duration) {
  const played = duration && position >= duration * 0.95 ? 1 : 0;
  db.prepare(`INSERT INTO podcast_progress (profile_id, episode_id, position, played, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(profile_id, episode_id) DO UPDATE SET position = excluded.position, played = MAX(played, excluded.played), updated_at = excluded.updated_at`)
    .run(profileId, episodeId, position, played, now());
  if (duration) db.prepare('UPDATE podcast_episodes SET duration = COALESCE(duration, ?) WHERE id = ?').run(duration, episodeId);
}
function markPlayed(profileId, episodeId, played) {
  db.prepare(`INSERT INTO podcast_progress (profile_id, episode_id, position, played, updated_at) VALUES (?, ?, 0, ?, ?)
    ON CONFLICT(profile_id, episode_id) DO UPDATE SET played = excluded.played, position = 0, updated_at = excluded.updated_at`).run(profileId, episodeId, played ? 1 : 0, now());
}

setInterval(refreshAll, 6 * 3600000).unref();

module.exports = { recordPlay, playlists, playlistTracks, createPlaylist, addToPlaylist, smartTracks, genres, radio, lyrics,
  subscribe, refreshAll, searchPodcasts, podcastList, podcastEpisodes, latestEpisodes, podcastProgress, markPlayed };
