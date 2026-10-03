// Walks library folders, probes files, matches metadata.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { db } = require('./db');
const { CONFIG_DIR } = require('./config');
const parse = require('./parse');
const tmdb = require('./tmdb');
const { readExif, dateFromName } = require('./exif');
const nfo = require('./nfo');

const META_VERSION = 2; // bump to re-fetch matched titles (v2 added cast, collections, trailers)
const AUDIO_EXT = new Set(['.mp3', '.m4a', '.m4b', '.aac', '.flac', '.ogg', '.oga', '.opus', '.wav', '.wma', '.alac', '.aiff', '.aif', '.ape', '.wv']);
const PHOTO_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tif', '.tiff']);

const status = { running: false, phase: 'idle', library: null, done: 0, total: 0, lastRun: null, lastError: null, added: 0 };
let queued = false;
let newItems = [];
const completeHooks = [];
const onScanComplete = fn => completeHooks.push(fn);

function probe(file) {
  return new Promise(resolve => {
    execFile('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-show_chapters', file],
      { maxBuffer: 20 * 1024 * 1024, timeout: 60000 }, (err, stdout) => {
        if (err) return resolve(null);
        try {
          const j = JSON.parse(stdout);
          const streams = j.streams || [];
          const v = streams.find(s => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
          const audio = streams.filter(s => s.codec_type === 'audio').map((s, i) => ({
            index: i, codec: s.codec_name, channels: s.channels, language: s.tags?.language || null,
            title: s.tags?.title || null, default: !!s.disposition?.default,
          }));
          const subs = streams.filter(s => s.codec_type === 'subtitle').map((s, i) => ({
            index: i, codec: s.codec_name, language: s.tags?.language || null, title: s.tags?.title || null,
            forced: !!s.disposition?.forced, text: ['subrip', 'ass', 'ssa', 'mov_text', 'webvtt', 'text'].includes(s.codec_name),
            image: ['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'xsub'].includes(s.codec_name),
          }));
          const tags = {};
          for (const [k, val] of Object.entries(j.format?.tags || {})) tags[k.toLowerCase()] = val;
          resolve({
            duration: parseFloat(j.format?.duration) || parseFloat(v?.duration) || null,
            container: (j.format?.format_name || '').split(',')[0],
            format_name: j.format?.format_name || '',
            bitrate: parseInt(j.format?.bit_rate, 10) || null,
            video_codec: v?.codec_name || null,
            width: v?.width || null,
            height: v?.height || null,
            pix_fmt: v?.pix_fmt || null,
            profile: v?.profile || null,
            hdr: /smpte2084|arib-std-b67/.test(v?.color_transfer || ''),
            coverArt: streams.some(s => s.disposition?.attached_pic),
            chapters: (j.chapters || []).map(c => ({ start: +c.start_time, end: +c.end_time, title: c.tags?.title || '' })),
            tags, audio, subs,
          });
        } catch { resolve(null); }
      });
  });
}

function walk(dir, accept, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name.startsWith('@') || e.name === '#recycle' || e.name === 'lost+found') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, accept, out);
    else if ((e.isFile() || e.isSymbolicLink()) && accept(e.name, full)) out.push(full);
  }
  return out;
}
const ACCEPT = {
  movie: (n, f) => parse.isVideo(n) && !parse.isSample(f),
  tv: (n, f) => parse.isVideo(n) && !parse.isSample(f),
  home: n => parse.isVideo(n),
  music: n => AUDIO_EXT.has(path.extname(n).toLowerCase()),
  photo: n => PHOTO_EXT.has(path.extname(n).toLowerCase()),
};

function findArt(dir, names) {
  for (const n of names) for (const ext of ['.jpg', '.jpeg', '.png', '.webp']) {
    const f = path.join(dir, n + ext);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

const now = () => Date.now();
const hash = s => crypto.createHash('sha1').update(s).digest('hex').slice(0, 20);

// One show per name, however its folders are laid out: "Bluey/Season 1", "Bluey Season 2", "Bluey.S03.1080p" and
// loose "Bluey S04E01.mkv" files all land in the same show. show = { name, key, folder } from parse.showFromPath.
function upsertShow(lib, show) {
  let found = db.prepare("SELECT id, folder_key FROM items WHERE library_id = ? AND type = 'show' AND scan_key = ? ORDER BY id LIMIT 1").get(lib.id, show.key);
  if (!found) {
    // "Bluey (2018)" and plain "Bluey Season 2" are the same show — unless there are two different years to choose from
    const bare = show.key.replace(/ \(\d{4}\)$/, '');
    const near = db.prepare("SELECT id, folder_key, scan_key FROM items WHERE library_id = ? AND type = 'show' AND (scan_key = ? OR scan_key GLOB ?) ORDER BY id")
      .all(lib.id, bare, bare + ' ([0-9][0-9][0-9][0-9])');
    if (near.length === 1 && (bare === show.key || near[0].scan_key === bare)) found = near[0];
  }
  if (found) {
    // Learn the show's own folder (for poster.jpg, theme.mp3, tvshow.nfo) if we only knew season folders before
    if (show.folder && found.folder_key.startsWith('~')) db.prepare('UPDATE items SET folder_key = ? WHERE id = ?').run(show.folder, found.id);
    return found.id;
  }
  const { title, year } = parse.parseTitleYear(show.name);
  const r = db.prepare(`INSERT INTO items (library_id, type, folder_key, scan_key, title, sort_title, year, added_at)
    VALUES (?, 'show', ?, ?, ?, ?, ?, ?)`).run(lib.id, show.folder || '~' + show.key, show.key, title, parse.sortTitle(title), year, now());
  return Number(r.lastInsertRowid);
}

// Things that point at a show (My List, lists, ratings) follow it when two shows are merged
function moveShowLinks(fromId, toId) {
  for (const t of ['watchlist', 'list_items', 'ratings']) {
    db.prepare(`UPDATE OR IGNORE ${t} SET item_id = ? WHERE item_id = ?`).run(toId, fromId);
    db.prepare(`DELETE FROM ${t} WHERE item_id = ?`).run(fromId);
  }
}

// Libraries scanned before Marquee understood season folders: put every episode under the right show.
function regroupShows(lib) {
  const eps = db.prepare("SELECT id, path, parent_id, season, episode, title, tmdb_id FROM items WHERE library_id = ? AND type = 'episode'").all(lib.id);
  if (!eps.length) return;
  const cache = new Map();
  let moved = 0;
  db.exec('BEGIN');
  try {
    for (const e of eps) {
      const rel = path.relative(lib.path, e.path);
      if (rel.startsWith('..')) continue;
      const show = parse.showFromPath(rel.split(path.sep));
      let target = cache.get(show.key + '\u0000' + (show.folder || ''));
      if (!target) { target = upsertShow(lib, show); cache.set(show.key + '\u0000' + (show.folder || ''), target); }
      // Season/episode numbers that only the folder name could tell us
      if (e.episode == null || !e.season) {
        const ep = parse.parseEpisode(rel);
        if (ep && (ep.season !== e.season || ep.episode !== e.episode)) db.prepare('UPDATE items SET season = ?, episode = ? WHERE id = ?').run(ep.season, ep.episode, e.id);
      }
      // "Episode 1" → the real name, when the file name has one ("01 - Pups Make a Splash.mkv")
      if (/^Episode \d+$/.test(e.title) && !e.tmdb_id) {
        const t = parse.episodeTitleFromName(path.basename(e.path));
        if (t) db.prepare('UPDATE items SET title = ?, sort_title = ? WHERE id = ?').run(t, t.toLowerCase(), e.id);
      }
      if (target !== e.parent_id) {
        db.prepare('UPDATE items SET parent_id = ? WHERE id = ?').run(target, e.id);
        moveShowLinks(e.parent_id, target);
        moved++;
      }
    }
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
  if (moved) {
    db.prepare(`DELETE FROM items WHERE library_id = ? AND type = 'show' AND NOT EXISTS (SELECT 1 FROM items e WHERE e.parent_id = items.id)`).run(lib.id);
    console.log(`Regrouped ${moved} episode(s) in ${lib.name} into their shows`);
  }
}

function mergeShowInto(fromId, toId) {
  db.prepare('UPDATE items SET parent_id = ? WHERE parent_id = ?').run(toId, fromId);
  moveShowLinks(fromId, toId);
  db.prepare('DELETE FROM items WHERE id = ?').run(fromId);
}

// "Bluey" (from season folders) and "Bluey (2018)" are one show, as long as there's only one year to choose from
function mergeNearShows(lib) {
  const bare = db.prepare("SELECT id, scan_key FROM items WHERE library_id = ? AND type = 'show' AND scan_key IS NOT NULL AND scan_key NOT GLOB '* ([0-9][0-9][0-9][0-9])'").all(lib.id);
  for (const b of bare) {
    const dated = db.prepare("SELECT id FROM items WHERE library_id = ? AND type = 'show' AND scan_key GLOB ?").all(lib.id, b.scan_key + ' ([0-9][0-9][0-9][0-9])');
    if (dated.length === 1) mergeShowInto(b.id, dated[0].id);
  }
}

// After matching, two folders can turn out to be the same show ("Dr Who" and "Doctor Who (2005)") — merge them.
function mergeMatchedShows() {
  const groups = db.prepare(`SELECT library_id, tmdb_id, MIN(id) AS keep, COUNT(*) AS n FROM items
    WHERE type = 'show' AND tmdb_id IS NOT NULL GROUP BY library_id, tmdb_id HAVING n > 1`).all();
  for (const g of groups) {
    const others = db.prepare("SELECT id FROM items WHERE type = 'show' AND library_id = ? AND tmdb_id = ? AND id != ?").all(g.library_id, g.tmdb_id, g.keep);
    for (const o of others) mergeShowInto(o.id, g.keep);
  }
  if (groups.length) console.log(`Merged ${groups.length} show(s) that were split across folders`);
}

function insertItem(cols) {
  const keys = Object.keys(cols);
  const r = db.prepare(`INSERT INTO items (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...Object.values(cols));
  const id = Number(r.lastInsertRowid);
  newItems.push({ id, type: cols.type, parent_id: cols.parent_id || null, library_id: cols.library_id });
  status.added++;
  return id;
}

function cleanTitle(file) {
  return path.basename(file, path.extname(file)).replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// Album art for music: folder image, else the picture embedded in the file
function albumArt(file, info, key) {
  const dir = path.dirname(file);
  const local = findArt(dir, ['cover', 'folder', 'front', 'album', 'Cover', 'Folder', 'AlbumArt']);
  if (local) return Promise.resolve(tmdb.cacheLocalImage(local));
  if (!info?.coverArt) return Promise.resolve(null);
  const name = 'album-' + hash(key) + '.jpg';
  const dest = path.join(tmdb.IMG_DIR, name);
  if (fs.existsSync(dest)) return Promise.resolve(name);
  return new Promise(resolve => execFile('ffmpeg', ['-y', '-v', 'error', '-i', file, '-an', '-map', '0:v:0', '-frames:v', '1', '-vf', 'scale=600:-2', dest],
    { timeout: 30000 }, err => resolve(err || !fs.existsSync(dest) ? null : name)));
}
const albumArtCache = new Map();

async function scanLibrary(lib) {
  status.library = lib.name;
  status.phase = 'Finding files';
  if (!fs.existsSync(lib.path)) throw new Error(`Folder not found: ${lib.path}`);
  const files = walk(lib.path, ACCEPT[lib.type] || ACCEPT.movie);
  const perDir = {};
  for (const f of files) perDir[path.dirname(f)] = (perDir[path.dirname(f)] || 0) + 1;

  if (lib.type === 'tv') {
    // Shows made by an older version have no key yet: give them one, then fix any grouping
    for (const s of db.prepare("SELECT id, folder_key, title, year, locked FROM items WHERE library_id = ? AND type = 'show' AND scan_key IS NULL").all(lib.id)) {
      const raw = s.folder_key && !s.folder_key.startsWith('~') ? path.basename(s.folder_key) : s.folder_key ? s.folder_key.slice(1) : s.title;
      const name = parse.stripSeason(raw);
      db.prepare('UPDATE items SET scan_key = ? WHERE id = ?').run(parse.showKey(name), s.id);
      if (name !== raw) {
        // It was named after one season's folder ("Bluey Season 1"): it now holds the whole show, so name and look it up properly
        const { title, year } = parse.parseTitleYear(name);
        const keepTitle = /title/.test(s.locked || '');
        db.prepare(`UPDATE items SET folder_key = ?, tmdb_id = NULL, metadata_done = 0 ${keepTitle ? '' : ', title = ?, sort_title = ?, year = ?'} WHERE id = ?`)
          .run(...['~' + parse.showKey(name), ...(keepTitle ? [] : [title, parse.sortTitle(title), year]), s.id]);
      }
    }
    try { regroupShows(lib); mergeNearShows(lib); } catch (e) { console.warn('Regrouping shows failed:', e.message); }
  }

  const seen = new Set();
  status.phase = 'Reading files';
  status.total = files.length;
  status.done = 0;

  for (const file of files) {
    status.done++;
    seen.add(file);
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    const existing = db.prepare('SELECT id, size, mtime FROM items WHERE path = ?').get(file);
    if (existing && existing.size === st.size && existing.mtime === Math.floor(st.mtimeMs)) continue;

    const rel = path.relative(lib.path, file);
    const parts = rel.split(path.sep);
    const relDir = parts.length > 1 ? parts.slice(0, -1).join('/') : '';

    // ---- photos: no probing needed ----
    if (lib.type === 'photo') {
      const ex = /\.jpe?g$/i.test(file) ? readExif(file) : {};
      const cols = { size: st.size, mtime: Math.floor(st.mtimeMs), taken_at: ex.takenAt || dateFromName(path.basename(file)) || Math.floor(st.mtimeMs), probe: JSON.stringify({ orientation: ex.orientation || 1 }), lat: ex.lat ?? null, lon: ex.lon ?? null };
      if (existing) { db.prepare('UPDATE items SET size = ?, mtime = ?, taken_at = ?, probe = ?, lat = ?, lon = ? WHERE id = ?').run(...Object.values(cols), existing.id); continue; }
      insertItem({ library_id: lib.id, type: 'photo', title: path.basename(file, path.extname(file)), sort_title: path.basename(file).toLowerCase(), folder: relDir, path: file, ...cols, metadata_done: 2, added_at: now() });
      continue;
    }

    const info = await probe(file);
    const probeCols = {
      size: st.size, mtime: Math.floor(st.mtimeMs),
      duration: info?.duration ?? null, container: info?.container ?? null,
      video_codec: info?.video_codec ?? null, audio_codec: info?.audio?.[0]?.codec ?? null,
      width: info?.width ?? null, height: info?.height ?? null, bitrate: info?.bitrate ?? null,
      probe: info ? JSON.stringify(info) : null,
    };

    if (existing) {
      const sets = Object.keys(probeCols).map(k => `${k} = ?`).join(', ');
      db.prepare(`UPDATE items SET ${sets}, intro_done = 0 WHERE id = ?`).run(...Object.values(probeCols), existing.id);
      continue;
    }

    if (lib.type === 'movie') {
      const dir = path.dirname(file);
      const ownFolder = dir !== lib.path && perDir[dir] <= 2;
      const source = ownFolder ? path.basename(dir) : path.basename(file);
      let { title, year } = parse.parseTitleYear(source);
      if (ownFolder && !year) {
        // Folder has no year: trust a file name that does ("Extra Copies/Big.Buck.Bunny.2008.mp4")
        const fromFile = parse.parseTitleYear(path.basename(file));
        if (fromFile.year) ({ title, year } = fromFile);
      }
      // Every copy is kept: different editions (Director's Cut…) and qualities (4K/1080p) become choices on the movie page
      const edition = parse.parseEdition(path.basename(file)) || (ownFolder ? parse.parseEdition(path.basename(dir)) : null);
      insertItem({ library_id: lib.id, type: 'movie', folder_key: rel, title, sort_title: parse.sortTitle(title), year, edition, path: file, ...probeCols, added_at: now() });
    } else if (lib.type === 'tv') {
      const ep = parse.parseEpisode(rel);
      const showId = upsertShow(lib, parse.showFromPath(parts));
      const epTitle = parse.episodeTitleFromName(path.basename(file)) ||
        (ep ? `Episode ${ep.episode}` : parse.parseTitleYear(path.basename(file)).title);
      insertItem({ library_id: lib.id, type: 'episode', parent_id: showId, title: epTitle, sort_title: epTitle.toLowerCase(),
        season: ep ? ep.season : 0, episode: ep ? ep.episode : null, path: file, ...probeCols, added_at: now() });
      db.prepare('UPDATE items SET added_at = ? WHERE id = ?').run(now(), showId);
    } else if (lib.type === 'home') {
      const taken = dateFromName(path.basename(file)) || (info?.tags?.creation_time ? Date.parse(info.tags.creation_time) : null) || Math.floor(st.mtimeMs);
      const title = cleanTitle(file);
      insertItem({ library_id: lib.id, type: 'home', title, sort_title: title.toLowerCase(), folder: relDir, taken_at: taken,
        year: new Date(taken).getFullYear(), path: file, ...probeCols, added_at: now() });
    } else if (lib.type === 'music') {
      const t = info?.tags || {};
      const artist = (t.artist || t.album_artist || (parts.length >= 3 ? parts[parts.length - 3] : 'Unknown artist')).trim();
      const albumArtist = (t.album_artist || t.albumartist || artist).trim();
      const album = (t.album || (parts.length >= 2 ? parts[parts.length - 2] : 'Unknown album')).trim();
      const trackNo = parseInt(String(t.track || '').split('/')[0], 10) || parseInt((path.basename(file).match(/^(\d{1,3})/) || [])[1], 10) || null;
      const discNo = parseInt(String(t.disc || t.discnumber || '').split('/')[0], 10) || 1;
      const title = (t.title || cleanTitle(file).replace(/^\d{1,3}[\s.-]+/, '')).trim();
      const key = albumArtist + '\u0000' + album;
      if (!albumArtCache.has(key)) albumArtCache.set(key, await albumArt(file, info, key));
      insertItem({ library_id: lib.id, type: 'track', title, sort_title: title.toLowerCase(), artist, album_artist: albumArtist, album,
        track_no: trackNo, disc_no: discNo, year: parseInt(t.date || t.year, 10) || null, genres: t.genre || null,
        poster: albumArtCache.get(key), folder: relDir, path: file, ...probeCols, metadata_done: 2, added_at: now() });
    }
  }

  if (lib.type === 'movie' || lib.type === 'tv') findExtras(lib);

  // Remove things that disappeared from disk
  status.phase = 'Cleaning up';
  const rows = db.prepare('SELECT id, path FROM items WHERE library_id = ? AND path IS NOT NULL').all(lib.id);
  for (const r of rows) if (!seen.has(r.path)) db.prepare('DELETE FROM items WHERE id = ?').run(r.id);
  db.prepare(`DELETE FROM items WHERE library_id = ? AND type = 'show'
    AND NOT EXISTS (SELECT 1 FROM items e WHERE e.parent_id = items.id)`).run(lib.id);
}

// Local trailers ("Movie (2008)-trailer.mp4" or a Trailers folder) and theme songs (theme.mp3 in the show or movie folder)
const THEME_NAMES = ['theme.mp3', 'theme.m4a', 'theme.ogg', 'theme.flac', 'theme.opus'];
function findExtras(lib) {
  const uploaded = p => p && p.startsWith(path.join(CONFIG_DIR, 'themes'));
  const setTheme = (id, dir, current) => {
    if (uploaded(current)) return; // someone uploaded one in Marquee — keep it
    const t = THEME_NAMES.map(n => path.join(dir, n)).find(f => fs.existsSync(f)) || null;
    if (t !== current) db.prepare('UPDATE items SET theme = ? WHERE id = ?').run(t, id);
  };
  if (lib.type === 'tv') {
    for (const show of db.prepare("SELECT id, folder_key, theme FROM items WHERE library_id = ? AND type = 'show'").all(lib.id)) {
      if (show.folder_key && !show.folder_key.startsWith('~')) setTheme(show.id, path.join(lib.path, show.folder_key), show.theme);
    }
    return;
  }
  const byDir = {};
  for (const m of db.prepare("SELECT id, path, theme, local_trailer FROM items WHERE library_id = ? AND type = 'movie'").all(lib.id)) (byDir[path.dirname(m.path)] = byDir[path.dirname(m.path)] || []).push(m);
  for (const [dir, movies] of Object.entries(byDir)) {
    const own = dir !== lib.path && movies.length <= 2;
    let files = [];
    try { files = fs.readdirSync(dir); } catch {}
    for (const m of movies) {
      const base = path.basename(m.path, path.extname(m.path)).toLowerCase();
      let trailer = files.find(f => parse.isVideo(f) && /[-_. ](trailer|teaser)\d*\.\w+$/i.test(f) && (own || f.toLowerCase().startsWith(base)));
      trailer = trailer ? path.join(dir, trailer) : null;
      if (!trailer && own) {
        const sub = ['Trailers', 'trailers', 'Trailer', 'trailer'].map(n => path.join(dir, n)).find(d => fs.existsSync(d));
        const f = sub && fs.readdirSync(sub).find(x => parse.isVideo(x));
        if (f) trailer = path.join(sub, f);
      }
      if (trailer !== m.local_trailer) db.prepare('UPDATE items SET local_trailer = ? WHERE id = ?').run(trailer, m.id);
      if (own) setTheme(m.id, dir, m.theme);
    }
  }
}

function applyMeta(id, meta, keepLocal = {}) {
  const cols = ['tmdb_id', 'imdb_id', 'tvdb_id', 'title', 'year', 'overview', 'tagline', 'vote', 'runtime', 'genres', 'certification', 'level', 'poster', 'backdrop', 'still', 'air_date', 'trailer', 'edition'];
  let locked = [];
  try { locked = JSON.parse(db.prepare('SELECT locked FROM items WHERE id = ?').get(id)?.locked || '[]'); } catch {}
  if (locked.includes('certification')) keepLocal = { ...keepLocal, level: true };
  const sets = [], vals = [];
  for (const c of cols) {
    if (meta[c] === undefined || meta[c] === null || meta[c] === '') continue;
    if (keepLocal[c] || locked.includes(c)) continue;
    sets.push(`${c} = ?`); vals.push(meta[c]);
  }
  if (meta.title && !locked.includes('title') && !locked.includes('sort_title')) { sets.push('sort_title = ?'); vals.push(parse.sortTitle(meta.title)); }
  if (meta.certification && !meta.level && !locked.includes('certification')) { const lv = tmdb.levelFor(meta.certification); if (lv != null) { sets.push('level = ?'); vals.push(lv); } }
  if (meta.collection) {
    const c = meta.collection;
    db.prepare(`INSERT INTO collections (id, name, poster, backdrop) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, poster = excluded.poster, backdrop = excluded.backdrop`).run(c.id, c.name, c.poster, c.backdrop);
    sets.push('collection_id = ?'); vals.push(c.id);
  }
  if (meta.people) {
    db.prepare('DELETE FROM credits WHERE item_id = ?').run(id);
    const addPerson = db.prepare('INSERT INTO people (id, name, photo) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, photo = COALESCE(excluded.photo, people.photo)');
    const addCredit = db.prepare('INSERT OR IGNORE INTO credits (item_id, person_id, role, character, ord) VALUES (?, ?, ?, ?, ?)');
    for (const p of meta.people) {
      addPerson.run(p.id, p.name, p.photo ? 'tmdb/w185' + p.photo : null);
      addCredit.run(id, p.id, p.role, p.character || null, p.ord ?? 0);
    }
  }
  if (meta.tmdb_id) { sets.push('meta_version = ?'); vals.push(META_VERSION); }
  if (sets.length) db.prepare(`UPDATE items SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
}

function grabFrame(file, at, width = 480) {
  const name = 'frame-' + hash(file + width) + '.jpg';
  const dest = path.join(tmdb.IMG_DIR, name);
  if (fs.existsSync(dest)) return Promise.resolve(name);
  return new Promise(resolve => {
    execFile('ffmpeg', ['-y', '-v', 'error', '-ss', String(Math.max(0.5, at)), '-i', file, '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '4', dest],
      { timeout: 30000 }, err => resolve(err || !fs.existsSync(dest) ? null : name));
  });
}

async function fetchMetadata() {
  const hasKey = !!tmdb.apiKey();
  // metadata_done: 0 = never tried, 1 = local only (no key at the time), 2 = done
  const pending = db.prepare(`SELECT i.*, l.path AS lib_path FROM items i JOIN libraries l ON l.id = i.library_id
    WHERE i.type IN ('movie','show','episode','home') AND (i.metadata_done < ?
      OR (? AND i.type IN ('movie','show') AND i.tmdb_id IS NOT NULL AND i.meta_version < ${META_VERSION}))
    ORDER BY CASE i.type WHEN 'show' THEN 0 WHEN 'movie' THEN 1 ELSE 2 END, i.id`).all(hasKey ? 2 : 1, hasKey ? 1 : 0);
  status.phase = 'Fetching posters & info';
  status.total = pending.length;
  status.done = 0;

  for (const item of pending) {
    status.done++;
    if (item.type === 'home') {
      if (!item.still) {
        const frame = await grabFrame(item.path, Math.min(5, (item.duration || 10) * 0.2));
        if (frame) db.prepare('UPDATE items SET still = ? WHERE id = ?').run(frame, item.id);
      }
      db.prepare('UPDATE items SET metadata_done = 2 WHERE id = ?').run(item.id);
      continue;
    }
    const local = {};
    // Local artwork wins over downloaded artwork
    if (item.type === 'movie') {
      const dir = path.dirname(item.path);
      if (dir !== item.lib_path) {
        const base = path.basename(item.path, path.extname(item.path));
        const p = findArt(dir, ['poster', 'folder', 'cover', base + '-poster', base]);
        const b = findArt(dir, ['fanart', 'backdrop', 'background', base + '-fanart']);
        if (p) local.poster = tmdb.cacheLocalImage(p);
        if (b) local.backdrop = tmdb.cacheLocalImage(b);
      }
    } else if (item.type === 'show' && !item.folder_key.startsWith('~')) {
      const dir = path.join(item.lib_path, item.folder_key);
      const p = findArt(dir, ['poster', 'folder', 'cover']);
      const b = findArt(dir, ['fanart', 'backdrop', 'background']);
      if (p) local.poster = tmdb.cacheLocalImage(p);
      if (b) local.backdrop = tmdb.cacheLocalImage(b);
    } else if (item.type === 'episode') {
      const base = path.join(path.dirname(item.path), path.basename(item.path, path.extname(item.path)));
      const t = findArt(path.dirname(base), [path.basename(base) + '-thumb', path.basename(base)]);
      if (t) local.still = tmdb.cacheLocalImage(t);
    }
    if (Object.keys(local).length) applyMeta(item.id, local);

    // .nfo files (Kodi/Jellyfin style) can pin the exact match and supply your own details
    const n = item.type === 'movie' ? nfo.forMovie(item.path) : item.type === 'show' && !item.folder_key.startsWith('~') ? nfo.forShow(path.join(item.lib_path, item.folder_key))
      : item.type === 'episode' ? nfo.forEpisode(item.path) : null;
    let tmdbId = item.tmdb_id || n?.tmdb_id || null;

    let done = 1;
    if (hasKey) {
      try {
        let meta = null;
        if (!tmdbId && n?.imdb_id && ['movie', 'show'].includes(item.type)) tmdbId = await tmdb.findByImdb(n.imdb_id, item.type);
        // Already matched (possibly fixed by hand) — refresh by id, don't search again
        if (item.type === 'movie') meta = tmdbId ? await tmdb.movieDetails(tmdbId, item.year) : await tmdb.lookupMovie(item.title, item.year);
        else if (item.type === 'show') meta = tmdbId ? await tmdb.showDetails(tmdbId, item.year) : await tmdb.lookupShow(item.title, item.year);
        else if (item.type === 'episode' && item.episode != null) {
          const show = db.prepare('SELECT tmdb_id FROM items WHERE id = ?').get(item.parent_id);
          if (show?.tmdb_id) meta = await tmdb.lookupEpisode(show.tmdb_id, item.season, item.episode);
        }
        if (meta) applyMeta(item.id, meta, { poster: !!local.poster, backdrop: !!local.backdrop, still: !!local.still });
        if (n) applyMeta(item.id, n);
        else if (['movie', 'show'].includes(item.type)) db.prepare('UPDATE items SET meta_version = ? WHERE id = ?').run(META_VERSION, item.id);
        done = 2;
      } catch (e) {
        status.lastError = e.message;
        done = /No TMDB|401/.test(e.message) ? 1 : 0;
      }
    } else if (n) applyMeta(item.id, n);
    if (item.type === 'episode' && !local.still) {
      const cur = db.prepare('SELECT still FROM items WHERE id = ?').get(item.id);
      if (!cur.still) {
        const frame = await grabFrame(item.path, (item.duration || 600) * 0.15);
        if (frame) db.prepare('UPDATE items SET still = ? WHERE id = ?').run(frame, item.id);
      }
    }
    db.prepare('UPDATE items SET metadata_done = ? WHERE id = ?').run(done, item.id);
  }
}

async function scanAll() {
  if (status.running) { queued = true; return; }
  status.running = true;
  status.added = 0;
  status.lastError = null;
  newItems = [];
  albumArtCache.clear();
  try {
    const libs = db.prepare('SELECT * FROM libraries').all();
    for (const lib of libs) {
      try { await scanLibrary(lib); } catch (e) { status.lastError = e.message; }
    }
    await fetchMetadata();
    try { mergeMatchedShows(); } catch (e) { console.warn('Merging shows failed:', e.message); }
  } catch (e) {
    status.lastError = e.message;
    console.error('Scan failed:', e);
  } finally {
    status.running = false;
    status.phase = 'idle';
    status.library = null;
    status.lastRun = Date.now();
    if (status.added) console.log(`Scan finished: ${status.added} new file(s)`);
    const added = newItems;
    newItems = [];
    for (const fn of completeHooks) { try { await fn(added); } catch (e) { console.error('After-scan task failed:', e.message); } }
    if (queued) { queued = false; setTimeout(scanAll, 1000); }
  }
}

function refreshMetadata(itemId) {
  if (itemId) db.prepare('UPDATE items SET metadata_done = 0 WHERE id = ? OR parent_id = ?').run(itemId, itemId);
  else db.prepare("UPDATE items SET metadata_done = 0 WHERE type IN ('movie','show','episode')").run();
  tmdb.clearSeasonCache();
  scanAll();
}

module.exports = { scanAll, status, probe, refreshMetadata, applyMeta, grabFrame, onScanComplete, META_VERSION };
