// Admin-only: libraries, profiles, settings, activity, downloads, backups.
const express = require('express');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { db, getSetting, setSetting } = require('../db');
const C = require('../common');
const scanner = require('../scanner');
const tmdb = require('../tmdb');
const stream = require('../stream');
const activity = require('../features/activity');
const versions = require('../features/versions');
const backup = require('../features/backup');
const intro = require('../features/intro');
const watcher = require('../features/watcher');
const alerts = require('../features/alerts');
const trickplay = require('../features/trickplay');
const requestsF = require('../features/requests');
const crypto = require('crypto');

const { now, wrap } = C;
const r = express.Router();

r.use((req, res, next) => (req.profile.is_admin ? next() : res.status(403).json({ error: 'Admin only' })));

const LIB_TYPES = { movie: 'Movies', tv: 'TV Shows', home: 'Home Videos', music: 'Music', photo: 'Photos' };
const restartWatcher = () => watcher.start(() => scanner.scanAll());

r.get('/overview', (req, res) => {
  const libs = db.prepare(`SELECT l.*, (SELECT COUNT(*) FROM items i WHERE i.library_id = l.id AND i.type IN ('movie','show','home','track','photo')) AS count FROM libraries l ORDER BY l.id`).all()
    .map(l => ({ ...l, kids_safe: !!l.kids_safe, exists: fs.existsSync(l.path) }));
  const key = tmdb.apiKey();
  const vstats = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes, SUM(status IN ('queued','working')) AS pending FROM versions").get();
  res.json({
    serverName: getSetting('server_name', 'Marquee'),
    libraries: libs,
    libraryTypes: LIB_TYPES,
    profiles: db.prepare('SELECT * FROM profiles ORDER BY hidden, is_admin DESC, id').all().map(p => ({ ...C.publicProfile(p), usedToday: activity.usedToday(p.id), limitToday: activity.limitFor(p),
      episodesToday: p.episode_limit != null ? activity.episodesToday(p.id) : null, week: activity.lastDays(p.id, 7),
      libraries: db.prepare('SELECT library_id FROM profile_libraries WHERE profile_id = ?').all(p.id).map(x => x.library_id),
      invites: db.prepare('SELECT token, expires_at, uses FROM invites WHERE profile_id = ?').all(p.id) })),
    disks: alerts.status.disks.length ? alerts.status.disks : alerts.check().disks,
    trickplay: { ...trickplay.status, enabled: trickplay.enabled(), done: db.prepare('SELECT COUNT(*) AS n FROM items WHERE trickplay = 1').get().n },
    tmdbKeySet: !!key, tmdbKeyHint: key ? '••••' + key.slice(-4) : null,
    scan: scanner.status,
    intros: { ...intro.status, available: intro.HAS_CHROMAPRINT, found: db.prepare("SELECT COUNT(*) AS n FROM items WHERE intro_end IS NOT NULL").get().n },
    watcher: watcher.status,
    transcoding: { hwaccel: config.HWACCEL, hwAvailable: stream.hwStatus.ok, activeStreams: stream.sessions.size, tonemap: stream.HAS_ZSCALE },
    levels: tmdb.LEVEL_NAMES,
    settings: {
      webhookUrl: getSetting('webhook_url', ''), lanUrl: getSetting('lan_url', ''), autoOptimize: getSetting('auto_optimize', '0') === '1',
      autoOptimizeQuality: getSetting('auto_optimize_quality', '720'), optimizeMaxGb: +getSetting('optimize_max_gb', '50'),
      osApiKeySet: !!getSetting('os_api_key'), osUsername: getSetting('os_username', ''), osLanguages: getSetting('os_languages', 'en'),
      radarrUrl: getSetting('radarr_url', ''), radarrKeySet: !!getSetting('radarr_key'), radarrRoot: getSetting('radarr_root', ''), radarrProfile: getSetting('radarr_profile', ''),
      sonarrUrl: getSetting('sonarr_url', ''), sonarrKeySet: !!getSetting('sonarr_key'), sonarrRoot: getSetting('sonarr_root', ''), sonarrProfile: getSetting('sonarr_profile', ''),
      requestsAuto: getSetting('requests_auto', '0') === '1', traktClientId: getSetting('trakt_client_id', ''), traktSecretSet: !!getSetting('trakt_client_secret'),
    },
    pendingRequests: db.prepare("SELECT COUNT(*) AS n FROM requests WHERE status = 'pending'").get().n,
    versions: vstats,
    backups: backup.listBackups().slice(0, 7),
    stats: db.prepare(`SELECT
        SUM(type = 'movie') AS movies, SUM(type = 'show') AS shows, SUM(type = 'episode') AS episodes,
        SUM(type = 'track') AS tracks, SUM(type = 'photo') AS photos, SUM(type = 'home') AS homeVideos,
        SUM(CASE WHEN type IN ('movie','show') AND tmdb_id IS NULL THEN 1 ELSE 0 END) AS unmatched,
        SUM(COALESCE(size, 0)) AS bytes FROM items`).get(),
  });
});

r.get('/browse', (req, res) => {
  const p = path.resolve(String(req.query.path || '/'));
  try {
    const hide = ['proc', 'sys', 'dev', 'run', 'etc', 'usr', 'bin', 'sbin', 'lib', 'lib64', 'boot', 'var', 'tmp', 'opt', 'root', 'srv', 'app', 'config', 'transcode'];
    const dirs = fs.readdirSync(p, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.') && !(p === '/' && hide.includes(d.name)))
      .map(d => d.name).sort((a, b) => a.localeCompare(b));
    res.json({ path: p, parent: p === '/' ? null : path.dirname(p), dirs });
  } catch { res.status(400).json({ error: `Can't open ${p}` }); }
});

r.post('/libraries', (req, res) => {
  const { name, type, path: p, kidsSafe } = req.body || {};
  if (!LIB_TYPES[type]) return res.status(400).json({ error: 'Unknown library type' });
  if (!p || !fs.existsSync(p)) return res.status(400).json({ error: `Folder not found inside the app: ${p}` });
  try {
    db.prepare('INSERT INTO libraries(name, type, path, kids_safe) VALUES (?, ?, ?, ?)').run(name || LIB_TYPES[type], type, path.resolve(p), kidsSafe ? 1 : 0);
  } catch { return res.status(400).json({ error: 'That folder is already a library' }); }
  restartWatcher();
  scanner.scanAll();
  res.json({ ok: true });
});
r.patch('/libraries/:id', (req, res) => {
  const { name, kidsSafe } = req.body || {};
  if (name != null) db.prepare('UPDATE libraries SET name = ? WHERE id = ?').run(String(name), req.params.id);
  if (kidsSafe != null) db.prepare('UPDATE libraries SET kids_safe = ? WHERE id = ?').run(kidsSafe ? 1 : 0, req.params.id);
  res.json({ ok: true });
});
r.delete('/libraries/:id', (req, res) => {
  db.prepare("DELETE FROM items WHERE library_id = ? AND parent_id IS NOT NULL").run(req.params.id);
  db.prepare('DELETE FROM items WHERE library_id = ?').run(req.params.id);
  db.prepare('DELETE FROM libraries WHERE id = ?').run(req.params.id);
  restartWatcher();
  res.json({ ok: true });
});

r.post('/scan', (req, res) => { scanner.scanAll(); res.json({ ok: true }); });
r.post('/group-shows', (req, res) => {
  try { res.json(scanner.groupAllShows()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
r.post('/refresh', (req, res) => { scanner.refreshMetadata(req.body?.itemId || null); res.json({ ok: true }); });
r.post('/intros', (req, res) => {
  if (req.body?.redo) db.prepare("UPDATE items SET intro_done = 0, intro_start = NULL, intro_end = NULL WHERE type = 'episode'").run();
  intro.detectAll();
  res.json({ ok: true });
});

r.put('/settings', wrap(async (req, res) => {
  const b = req.body || {};
  if (b.serverName != null) setSetting('server_name', String(b.serverName).trim().slice(0, 40) || 'Marquee');
  if (b.webhookUrl != null) {
    const u = String(b.webhookUrl).trim();
    if (u && !/^https?:\/\//.test(u)) return res.status(400).json({ error: 'Webhook must start with http:// or https://' });
    setSetting('webhook_url', u);
  }
  if (b.lanUrl != null) {
    const u = String(b.lanUrl).trim().replace(/\/$/, '');
    if (u && !/^https?:\/\/[^/]+$/.test(u)) return res.status(400).json({ error: 'Use the form http://192.168.1.50:8420' });
    setSetting('lan_url', u);
  }
  if (b.autoOptimize != null) setSetting('auto_optimize', b.autoOptimize ? '1' : '0');
  if (b.trickplay != null) { setSetting('trickplay', b.trickplay ? '1' : '0'); if (b.trickplay) trickplay.run(); }
  if (b.requestsAuto != null) setSetting('requests_auto', b.requestsAuto ? '1' : '0');
  // Plain text settings (keys left blank are kept)
  const text = { osApiKey: 'os_api_key', osUsername: 'os_username', osPassword: 'os_password', osLanguages: 'os_languages',
    radarrUrl: 'radarr_url', radarrKey: 'radarr_key', radarrRoot: 'radarr_root', radarrProfile: 'radarr_profile',
    sonarrUrl: 'sonarr_url', sonarrKey: 'sonarr_key', sonarrRoot: 'sonarr_root', sonarrProfile: 'sonarr_profile',
    traktClientId: 'trakt_client_id', traktClientSecret: 'trakt_client_secret' };
  const secrets = ['osApiKey', 'osPassword', 'radarrKey', 'sonarrKey', 'traktClientSecret'];
  for (const [k, key] of Object.entries(text)) {
    if (b[k] === undefined) continue;
    const v = String(b[k] ?? '').trim();
    if (secrets.includes(k) && !v) continue;
    if (/Url$/.test(k) && v && !/^https?:\/\//.test(v)) return res.status(400).json({ error: 'Addresses must start with http:// or https://' });
    setSetting(key, v);
  }
  if (b.autoOptimizeQuality && versions.PRESETS[b.autoOptimizeQuality]) setSetting('auto_optimize_quality', b.autoOptimizeQuality);
  if (b.optimizeMaxGb != null) setSetting('optimize_max_gb', String(Math.max(1, Math.min(10000, +b.optimizeMaxGb || 50))));
  if (b.tmdbApiKey != null) {
    const old = getSetting('tmdb_api_key');
    setSetting('tmdb_api_key', String(b.tmdbApiKey).trim());
    if (b.tmdbApiKey) {
      try { await tmdb.testKey(); } catch (e) {
        setSetting('tmdb_api_key', old);
        return res.status(400).json({ error: /401/.test(e.message) ? 'TMDB rejected that key' : `Couldn't reach TMDB: ${e.message}` });
      }
      scanner.scanAll();
    }
  }
  res.json({ ok: true });
}));

// ---------- profiles ----------
const HM = /^([01]?\d|2[0-3]):[0-5]\d$/;
function profileFields(body, isNew) {
  const f = {};
  if (body.name != null) f.name = String(body.name).trim().slice(0, 30);
  if (isNew && !f.name) throw new Error('Name required');
  if (body.color && /^#[0-9a-f]{6}$/i.test(body.color)) f.color = body.color;
  if (body.isKids != null) f.is_kids = body.isKids ? 1 : 0;
  if (body.maxLevel != null) f.max_level = Math.max(0, Math.min(4, body.maxLevel | 0));
  if (body.pin !== undefined) {
    if (body.pin === null || body.pin === '') f.pin_hash = null;
    else if (/^\d{4,8}$/.test(String(body.pin))) f.pin_hash = C.hashPin(body.pin);
    else throw new Error('PIN must be 4–8 digits');
  }
  for (const [k, col] of [['limitWeekday', 'limit_weekday'], ['limitWeekend', 'limit_weekend']]) {
    if (body[k] === undefined) continue;
    f[col] = body[k] === null || body[k] === '' ? null : Math.max(0, Math.min(1440, parseInt(body[k], 10) || 0));
  }
  if (body.episodeLimit !== undefined) f.episode_limit = body.episodeLimit === null || body.episodeLimit === '' ? null : Math.max(0, Math.min(50, parseInt(body.episodeLimit, 10) || 0));
  if (body.letFinish !== undefined) f.let_finish = body.letFinish ? 1 : 0;
  if (body.maxQuality !== undefined) f.max_quality = ['1080', '720', '480', '360'].includes(body.maxQuality) ? body.maxQuality : null;
  if (body.hidden !== undefined) f.hidden = body.hidden ? 1 : 0;
  for (const [k, col] of [['bedtimeStart', 'bedtime_start'], ['bedtimeEnd', 'bedtime_end']]) {
    if (body[k] === undefined) continue;
    if (body[k] && !HM.test(body[k])) throw new Error('Bedtime must look like 19:30');
    f[col] = body[k] || null;
  }
  return f;
}
r.post('/profiles', (req, res) => {
  try {
    const f = profileFields(req.body || {}, true);
    const count = db.prepare('SELECT COUNT(*) AS n FROM profiles').get().n;
    const x = db.prepare('INSERT INTO profiles(name, color, pin_hash, is_admin, is_kids, max_level, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(f.name, f.color || C.COLORS[count % C.COLORS.length], f.pin_hash || null, req.body.isAdmin ? 1 : 0, f.is_kids || 0, f.max_level ?? (f.is_kids ? 1 : 4), now());
    const rest = Object.fromEntries(Object.entries(f).filter(([k]) => ['limit_weekday', 'limit_weekend', 'bedtime_start', 'bedtime_end', 'max_quality', 'hidden', 'episode_limit', 'let_finish'].includes(k)));
    const id = Number(x.lastInsertRowid);
    if (Object.keys(rest).length) db.prepare(`UPDATE profiles SET ${Object.keys(rest).map(k => `${k} = ?`).join(', ')} WHERE id = ?`).run(...Object.values(rest), id);
    setLibraries(id, req.body.libraries);
    res.json({ ok: true, id });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
r.patch('/profiles/:id', (req, res) => {
  try {
    const f = profileFields(req.body || {}, false);
    const target = db.prepare('SELECT * FROM profiles WHERE id = ?').get(req.params.id);
    if (!target) return res.status(404).json({ error: 'Not found' });
    if (target.is_admin && f.pin_hash === null) return res.status(400).json({ error: 'Admin profiles must keep a PIN' });
    if (req.body.isAdmin != null && target.id !== req.profile.id) f.is_admin = req.body.isAdmin ? 1 : 0;
    if (f.is_admin && !target.pin_hash && !f.pin_hash) return res.status(400).json({ error: 'Set a PIN before making this profile an admin' });
    const keys = Object.keys(f);
    if (keys.length) db.prepare(`UPDATE profiles SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`).run(...Object.values(f), target.id);
    setLibraries(target.id, req.body.libraries);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
// Which libraries a profile can use; empty/absent = all
function setLibraries(profileId, libs) {
  if (!Array.isArray(libs)) return;
  db.prepare('DELETE FROM profile_libraries WHERE profile_id = ?').run(profileId);
  for (const l of libs) db.prepare('INSERT OR IGNORE INTO profile_libraries (profile_id, library_id) VALUES (?, ?)').run(profileId, l | 0);
}

// Invite links: open on a friend's device to sign straight into a (usually hidden) profile
r.post('/invites', (req, res) => {
  const p = db.prepare('SELECT * FROM profiles WHERE id = ?').get(req.body?.profileId);
  if (!p) return res.status(404).json({ error: 'Profile not found' });
  if (p.is_admin) return res.status(400).json({ error: "Invites can't be made for admin profiles" });
  const token = crypto.randomBytes(12).toString('base64url');
  const days = Math.max(0, Math.min(365, parseInt(req.body.days, 10) || 14));
  db.prepare('INSERT INTO invites (token, profile_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(token, p.id, Date.now(), days ? Date.now() + days * 86400000 : null);
  res.json({ token });
});
r.delete('/invites/:token', (req, res) => {
  const inv = db.prepare('SELECT * FROM invites WHERE token = ?').get(req.params.token);
  db.prepare('DELETE FROM invites WHERE token = ?').run(req.params.token);
  if (inv && req.query.signOut === '1') db.prepare('DELETE FROM sessions WHERE profile_id = ? AND guest = 1').run(inv.profile_id);
  res.json({ ok: true });
});

// ---------- edit details & artwork ----------
const EDITABLE = { title: 'title', sortTitle: 'sort_title', year: 'year', overview: 'overview', tagline: 'tagline', genres: 'genres', certification: 'certification', edition: 'edition' };
r.patch('/items/:id', (req, res) => {
  const it = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
  if (!it) return res.status(404).json({ error: 'Not found' });
  let locked = JSON.parse(it.locked || '[]');
  if (req.body.unlock) locked = [];
  const sets = [], vals = [];
  for (const [k, col] of Object.entries(EDITABLE)) {
    if (req.body[k] === undefined) continue;
    let v = req.body[k];
    if (col === 'year') v = parseInt(v, 10) || null;
    else v = v == null ? null : String(v).trim() || null;
    sets.push(`${col} = ?`); vals.push(v);
    if (!locked.includes(col)) locked.push(col);
    if (col === 'title' && req.body.sortTitle === undefined) { sets.push('sort_title = ?'); vals.push(require('../parse').sortTitle(v || it.title)); }
    if (col === 'certification') { sets.push('level = ?'); vals.push(tmdb.levelFor(v)); }
  }
  sets.push('locked = ?'); vals.push(JSON.stringify(locked));
  db.prepare(`UPDATE items SET ${sets.join(', ')} WHERE id = ?`).run(...vals, it.id);
  if (req.body.unlock) scanner.refreshMetadata(it.id);
  res.json({ ok: true, locked });
});
r.get('/items/:id/images', wrap(async (req, res) => {
  const it = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
  if (!it || !['movie', 'show'].includes(it.type)) return res.status(404).json({ error: 'Not found' });
  if (!it.tmdb_id) return res.status(400).json({ error: 'Match this title first (Fix match), then pick artwork' });
  try { res.json(await tmdb.images(it.type, it.tmdb_id)); } catch (e) { res.status(400).json({ error: e.message }); }
}));
r.post('/items/:id/image', wrap(async (req, res) => {
  const it = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
  if (!it) return res.status(404).json({ error: 'Not found' });
  const kind = req.body.kind === 'backdrop' ? 'backdrop' : 'poster';
  let name = null;
  if (req.body.path) name = await tmdb.cacheImage(req.body.path, kind === 'poster' ? 'w500' : 'w1280');
  else if (req.body.dataUrl) { // your own picture
    const m = /^data:image\/(jpeg|png|webp);base64,(.+)$/.exec(req.body.dataUrl);
    if (!m) return res.status(400).json({ error: 'Use a JPG, PNG or WebP picture' });
    name = `custom-${it.id}-${kind}-${Date.now()}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`;
    fs.writeFileSync(path.join(tmdb.IMG_DIR, name), Buffer.from(m[2], 'base64'));
  }
  if (!name) return res.status(400).json({ error: "Couldn't save that picture" });
  const locked = new Set(JSON.parse(it.locked || '[]')); locked.add(kind);
  db.prepare(`UPDATE items SET ${kind} = ?, locked = ? WHERE id = ?`).run(name, JSON.stringify([...locked]), it.id);
  res.json({ ok: true });
}));

// ---------- Radarr / Sonarr ----------
r.get('/arr/:kind', wrap(async (req, res) => {
  if (!['radarr', 'sonarr'].includes(req.params.kind)) return res.status(404).end();
  try { res.json(await requestsF.options(req.params.kind)); } catch (e) { res.status(400).json({ error: e.message }); }
}));
r.post('/trickplay/run', (req, res) => { trickplay.run(); res.json({ ok: true }); });
r.get('/disks', (req, res) => res.json(alerts.check()));

r.delete('/profiles/:id', (req, res) => {
  if (+req.params.id === req.profile.id) return res.status(400).json({ error: "You can't delete the profile you're using" });
  db.prepare('DELETE FROM profiles WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});
r.post('/profiles/:id/bonus', (req, res) => {
  activity.grantBonus(+req.params.id, parseInt(req.body?.minutes, 10) || 30);
  res.json({ ok: true });
});

// ---------- fix match ----------
r.get('/match/:id', wrap(async (req, res) => {
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
  if (!item || !['movie', 'show'].includes(item.type)) return res.status(404).json({ error: 'Not found' });
  if (!tmdb.apiKey()) return res.status(400).json({ error: 'Add a TMDB API key in Settings first' });
  res.json(await tmdb.search(item.type, String(req.query.q || item.title)));
}));
r.post('/match/:id', wrap(async (req, res) => {
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
  if (!item || !['movie', 'show'].includes(item.type)) return res.status(404).json({ error: 'Not found' });
  const meta = item.type === 'movie' ? await tmdb.movieDetails(req.body.tmdbId, item.year) : await tmdb.showDetails(req.body.tmdbId, item.year);
  db.prepare('UPDATE items SET poster = NULL, backdrop = NULL, certification = NULL, level = NULL, collection_id = NULL, trailer = NULL WHERE id = ?').run(item.id);
  scanner.applyMeta(item.id, meta);
  if (item.type === 'show') {
    db.prepare('UPDATE items SET metadata_done = 0, still = NULL WHERE parent_id = ?').run(item.id);
    tmdb.clearSeasonCache();
    scanner.scanAll();
  }
  db.prepare('UPDATE items SET metadata_done = 2 WHERE id = ?').run(item.id);
  res.json({ ok: true });
}));

// ---------- activity ----------
r.get('/activity', (req, res) => {
  res.json({ nowPlaying: activity.active(), system: activity.system(), transcodes: stream.sessions.size, hw: stream.hwStatus });
});
r.post('/activity/stop', (req, res) => {
  const np = activity.requestStop(String(req.body?.deviceId || ''), req.body?.message);
  if (np?.sessionId) stream.stopSession(np.sessionId);
  res.json({ ok: true });
});
r.get('/history', (req, res) => {
  const pid = req.query.profileId ? +req.query.profileId : null;
  res.json({ history: activity.history({ profileId: pid, limit: 200 }), usage: pid ? activity.usageSummary(pid) : [] });
});

// ---------- duplicates ----------
r.get('/duplicates', (req, res) => {
  const groups = db.prepare(`SELECT tmdb_id FROM items WHERE type = 'movie' AND tmdb_id IS NOT NULL GROUP BY tmdb_id HAVING COUNT(*) > 1`).all();
  const byName = db.prepare(`SELECT LOWER(title) AS t, year FROM items WHERE type = 'movie' AND tmdb_id IS NULL GROUP BY LOWER(title), year HAVING COUNT(*) > 1`).all();
  const fmt = rows => rows.map(x => ({ id: x.id, title: x.title, year: x.year, path: x.path, size: x.size, width: x.width, height: x.height, codec: x.video_codec, bitrate: x.bitrate }))
    .sort((a, b) => (b.height || 0) - (a.height || 0) || (b.size || 0) - (a.size || 0));
  const out = [];
  for (const g of groups) out.push(fmt(db.prepare("SELECT * FROM items WHERE type = 'movie' AND tmdb_id = ?").all(g.tmdb_id)));
  for (const g of byName) out.push(fmt(db.prepare("SELECT * FROM items WHERE type = 'movie' AND tmdb_id IS NULL AND LOWER(title) = ? AND year IS ?").all(g.t, g.year)));
  res.json(out.map(files => ({ title: files[0].title, year: files[0].year, keep: files[0].id, files })));
});

// ---------- prepared copies ----------
r.get('/versions', (req, res) => res.json(versions.list()));
r.post('/versions', (req, res) => {
  try {
    const ids = [].concat(req.body?.itemIds || req.body?.itemId || []);
    let n = 0;
    for (const id of ids) {
      const item = db.prepare('SELECT id, type FROM items WHERE id = ?').get(id);
      if (!item) continue;
      const targets = item.type === 'show' ? db.prepare("SELECT id FROM items WHERE parent_id = ?").all(id).map(x => x.id) : [id];
      for (const t of targets) { versions.request(t, String(req.body.quality || '720'), 'manual'); n++; }
    }
    res.json({ queued: n });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
r.delete('/versions/:id', (req, res) => { versions.remove(+req.params.id); res.json({ ok: true }); });

// ---------- backups ----------
r.get('/backup', (req, res) => {
  res.set('Content-Disposition', `attachment; filename="marquee-backup-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json(backup.create());
});
r.get('/backups/:name', (req, res) => {
  const f = path.join(backup.BACKUP_DIR, path.basename(req.params.name));
  if (!fs.existsSync(f)) return res.status(404).end();
  res.download(f);
});
r.post('/restore', express.json({ limit: '100mb' }), (req, res) => {
  try {
    const result = backup.restore(req.body);
    restartWatcher();
    scanner.scanAll();
    res.json({ ok: true, ...result });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = { router: r, restartWatcher };
