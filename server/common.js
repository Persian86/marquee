// Shared helpers used by all route files.
const crypto = require('crypto');
const { db, refreshDups } = require('./db');

const now = () => Date.now();
const COLORS = ['#f0b429', '#e0533d', '#3d9be0', '#45b36b', '#a65fd9', '#e05d9b', '#22b5b0', '#f07c2a'];

function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(String(pin), salt, 32).toString('hex');
}
function checkPin(pin, stored) {
  if (!stored) return true;
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(String(pin || ''), salt, 32);
  return crypto.timingSafeEqual(test, Buffer.from(hash, 'hex'));
}
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function createSession(res, profileId, req = null, { guest = false, deviceId = null } = {}) {
  const token = crypto.randomBytes(32).toString('hex');
  const ip = req ? String(req.ip || '').replace(/^::ffff:/, '') : null;
  db.prepare('INSERT INTO sessions(token, profile_id, created_at, last_seen, guest, ip, ua, device_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(token, profileId, now(), now(), guest ? 1 : 0, ip, req ? String(req.headers['user-agent'] || '').slice(0, 300) : null, deviceId);
  // Over https the cookie is marked Secure so it's never sent over plain http.
  // Guest invite sessions expire in 30 days; family sessions last a year and are dropped after a year of silence.
  const secure = req && (req.secure || req.headers['x-forwarded-proto'] === 'https') ? '; Secure' : '';
  const maxAge = guest ? 60 * 60 * 24 * 30 : 60 * 60 * 24 * 365;
  const cookie = `mq_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
  const prev = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', prev ? [].concat(prev, cookie) : cookie);
  return token;
}

const img = name => (name ? `/img/${name}` : null);

function publicProfile(p) {
  return {
    maxQuality: p.max_quality || null, hidden: !!p.hidden, autoSubs: !!p.auto_subs, subLang: p.sub_lang || 'en', traktConnected: !!p.trakt,
    id: p.id, name: p.name, color: p.color, hasPin: !!p.pin_hash, isAdmin: !!p.is_admin, isKids: !!p.is_kids, maxLevel: p.max_level,
    limitWeekday: p.limit_weekday ?? null, limitWeekend: p.limit_weekend ?? null, bedtimeStart: p.bedtime_start || null, bedtimeEnd: p.bedtime_end || null,
    autoSkipIntro: !!p.auto_skip_intro, episodeLimit: p.episode_limit ?? null, letFinish: !!p.let_finish,
    cinemaMode: !!p.cinema_mode, themeMusic: p.theme_music !== 0,
  };
}

// SQL condition: what a profile may see. Unrated things are only visible to kids if their library is marked kids-safe.
// Libraries a profile may use (null = all of them)
function profileLibs(profile) {
  if (profile.libs === undefined) {
    const ids = db.prepare('SELECT library_id FROM profile_libraries WHERE profile_id = ?').all(profile.id).map(x => x.library_id);
    profile.libs = ids.length ? ids : null;
  }
  return profile.libs;
}
function visible(profile, levelExpr = 'i.level', l = 'l') {
  const lvl = profile.max_level | 0;
  const libs = profileLibs(profile);
  const libCond = libs ? `${l}.id IN (${libs.map(n => n | 0).join(',')})` : '1=1';
  if (lvl >= 4) return libCond;
  return `(${libCond} AND (${l}.kids_safe = 1 OR (${levelExpr} IS NOT NULL AND ${levelExpr} <= ${lvl})))`;
}

// Hide lower-quality duplicates of the same film (same TMDB match in two places)
const SAME_FILM = `(d.type = 'movie' AND d.id != i.id AND ((i.tmdb_id IS NOT NULL AND d.tmdb_id = i.tmdb_id)
  OR (i.tmdb_id IS NULL AND d.tmdb_id IS NULL AND LOWER(d.title) = LOWER(i.title) AND d.year IS i.year)))`;
// Precomputed in db.js (refreshDups) — a plain column check instead of comparing every film with every other one
const NOT_DUP = 'i.hidden_dup = 0';

function formatItem(r) {
  if (!r) return null;
  const out = {
    id: r.id, type: r.type, title: r.title, year: r.year, overview: r.overview, tagline: r.tagline,
    poster: img(r.poster), backdrop: img(r.backdrop), still: img(r.still), vote: r.vote,
    certification: r.certification, genres: r.genres ? r.genres.split(', ') : [], runtime: r.runtime,
    duration: r.duration, season: r.season, episode: r.episode, airDate: r.air_date, addedAt: r.added_at,
    parentId: r.parent_id, tmdbId: r.tmdb_id,
  };
  if (r.type === 'track') Object.assign(out, { artist: r.artist, album: r.album, albumArtist: r.album_artist, track: r.track_no, disc: r.disc_no });
  if (r.type === 'home' || r.type === 'photo') Object.assign(out, { takenAt: r.taken_at, folder: r.folder });
  if (r.width) out.video = { width: r.width, height: r.height, codec: r.video_codec, audio: r.audio_codec, container: r.container, size: r.size };
  if (r.position != null || r.watched != null) out.progress = { position: r.position || 0, watched: !!r.watched, duration: r.pduration || r.duration };
  if (r.show_title) out.show = { id: r.parent_id, title: r.show_title, poster: img(r.show_poster), backdrop: img(r.show_backdrop) };
  if (r.episode_count != null) out.episodeCount = r.episode_count;
  if (r.unwatched != null) out.unwatched = r.unwatched;
  if (r.in_list != null) out.inList = !!r.in_list;
  return out;
}

// Just what a poster in a grid needs — big libraries were sending every movie's full description to the phone
function formatCard(r) {
  if (!r) return null;
  const out = { id: r.id, type: r.type, title: r.title, year: r.year, poster: img(r.poster), addedAt: r.added_at };
  if (r.position != null || r.watched != null) out.progress = { position: r.position || 0, watched: !!r.watched, duration: r.pduration || r.duration };
  if (r.episode_count != null) out.episodeCount = r.episode_count;
  if (r.unwatched != null) out.unwatched = r.unwatched;
  return out;
}

const PROGRESS_JOIN = 'LEFT JOIN progress pr ON pr.item_id = i.id AND pr.profile_id = ?';
const PROGRESS_COLS = 'pr.position, pr.watched, pr.duration AS pduration';
const EP_ORDER = '(i.season = 0), i.season, i.episode, i.sort_title';

function getVisibleItem(profile, id) {
  const r = db.prepare(`SELECT i.*, ${PROGRESS_COLS}, s.title AS show_title, s.poster AS show_poster, s.backdrop AS show_backdrop,
      COALESCE(s.level, i.level) AS eff_level, l.kids_safe, l.type AS lib_type
    FROM items i JOIN libraries l ON l.id = i.library_id LEFT JOIN items s ON s.id = i.parent_id ${PROGRESS_JOIN}
    WHERE i.id = ?`).get(profile.id, id);
  if (!r) return null;
  if (!canSee(profile, r)) return null;
  return r;
}
function canSee(profile, r) {
  const libs = profileLibs(profile);
  if (libs && r.library_id != null && !libs.includes(r.library_id)) return false;
  if ((profile.max_level | 0) >= 4) return true;
  if (r.kids_safe) return true;
  const lvl = r.eff_level !== undefined ? r.eff_level : r.level;
  return lvl != null && lvl <= profile.max_level;
}
// Used by notifications: can this profile see item #id?
function visibleTo(profile, id) {
  const r = db.prepare(`SELECT COALESCE(s.level, i.level) AS eff_level, l.kids_safe, i.library_id FROM items i JOIN libraries l ON l.id = i.library_id
    LEFT JOIN items s ON s.id = i.parent_id WHERE i.id = ?`).get(id);
  return !!r && canSee(profile, r);
}

function showList(profile, where = '1=1', order = 'i.sort_title', limit = 5000, params = [], fmt = formatItem) {
  return db.prepare(`SELECT i.*,
      (SELECT COUNT(*) FROM items e WHERE e.parent_id = i.id) AS episode_count,
      (SELECT COUNT(*) FROM items e WHERE e.parent_id = i.id AND NOT EXISTS
        (SELECT 1 FROM progress p WHERE p.item_id = e.id AND p.profile_id = ? AND p.watched = 1)) AS unwatched
    FROM items i JOIN libraries l ON l.id = i.library_id
    WHERE i.type = 'show' AND ${visible(profile)} AND ${where} ORDER BY ${order} LIMIT ${limit | 0}`).all(profile.id, ...params).map(fmt);
}
function movieList(profile, where = '1=1', order = 'i.sort_title', limit = 5000, params = [], fmt = formatItem) {
  return db.prepare(`SELECT i.*, ${PROGRESS_COLS} FROM items i JOIN libraries l ON l.id = i.library_id ${PROGRESS_JOIN}
    WHERE i.type = 'movie' AND ${visible(profile)} AND ${NOT_DUP} AND ${where} ORDER BY ${order} LIMIT ${limit | 0}`).all(profile.id, ...params).map(fmt);
}
// Mixed movies + shows by id list, keeping order
function itemsByIds(profile, ids) {
  const out = [];
  for (const id of ids) {
    const r = getVisibleItem(profile, id);
    if (!r) continue;
    if (r.type === 'show') {
      const s = showList(profile, 'i.id = ?', 'i.id', 1, [r.id])[0];
      if (s) out.push(s);
    } else out.push(formatItem(r));
  }
  return out;
}

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const QUALITY_ORDER = ['original', '1080', '720', '480', '360'];
// Never stream above a profile's cap (e.g. friends outside the house)
function capQuality(profile, q) {
  const cap = profile.max_quality;
  if (!cap) return q;
  return QUALITY_ORDER.indexOf(q) < QUALITY_ORDER.indexOf(cap) ? cap : q;
}

module.exports = {
  profileLibs, capQuality, QUALITY_ORDER, now, COLORS, hashPin, checkPin, parseCookies, createSession, img, publicProfile, visible, NOT_DUP, SAME_FILM, formatItem, formatCard,
  PROGRESS_JOIN, PROGRESS_COLS, EP_ORDER, getVisibleItem, canSee, visibleTo, showList, movieList, itemsByIds, wrap,
};
