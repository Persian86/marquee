// SQLite storage (built into Node 22 — no native modules to compile)
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const { CONFIG_DIR } = require('./config');

fs.mkdirSync(CONFIG_DIR, { recursive: true });
const db = new DatabaseSync(path.join(CONFIG_DIR, 'marquee.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');

const ITEMS_SQL = `CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  type TEXT NOT NULL,              -- movie | show | episode | home | track | photo
  parent_id INTEGER REFERENCES items(id) ON DELETE CASCADE,
  folder_key TEXT,
  title TEXT NOT NULL,
  sort_title TEXT,
  year INTEGER,
  overview TEXT,
  tagline TEXT,
  poster TEXT,
  backdrop TEXT,
  still TEXT,
  vote REAL,
  certification TEXT,
  level INTEGER,
  genres TEXT,
  runtime INTEGER,
  tmdb_id INTEGER,
  season INTEGER,
  episode INTEGER,
  air_date TEXT,
  path TEXT UNIQUE,
  size INTEGER,
  mtime INTEGER,
  duration REAL,
  container TEXT,
  video_codec TEXT,
  audio_codec TEXT,
  width INTEGER,
  height INTEGER,
  bitrate INTEGER,
  probe TEXT,
  metadata_done INTEGER NOT NULL DEFAULT 0,
  added_at INTEGER NOT NULL,
  collection_id INTEGER,
  trailer TEXT,
  intro_start REAL,
  intro_end REAL,
  credits_start REAL,
  intro_done INTEGER NOT NULL DEFAULT 0,
  artist TEXT,
  album TEXT,
  album_artist TEXT,
  track_no INTEGER,
  disc_no INTEGER,
  taken_at INTEGER,
  folder TEXT,
  meta_version INTEGER NOT NULL DEFAULT 0
)`;

db.exec(`
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#e5a823',
  pin_hash TEXT,
  is_admin INTEGER NOT NULL DEFAULT 0,
  is_kids INTEGER NOT NULL DEFAULT 0,
  max_level INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS libraries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL,              -- movie | tv | home | music | photo
  path TEXT NOT NULL UNIQUE,
  kids_safe INTEGER NOT NULL DEFAULT 0
);
`);

// ---- one-time migration: v1 tables had CHECK constraints on type; rebuild without them ----
function rebuild(table, createSql) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  if (!row || !/CHECK\s*\(type IN/i.test(row.sql)) return;
  const oldCols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  db.exec('PRAGMA foreign_keys = OFF; BEGIN;');
  db.exec(createSql.replace(`IF NOT EXISTS ${table} (`, `${table}_new (`));
  const newCols = db.prepare(`PRAGMA table_info(${table}_new)`).all().map(c => c.name);
  const cols = oldCols.filter(c => newCols.includes(c)).join(', ');
  db.exec(`INSERT INTO ${table}_new (${cols}) SELECT ${cols} FROM ${table}; DROP TABLE ${table}; ALTER TABLE ${table}_new RENAME TO ${table}; COMMIT;`);
  console.log(`Migrated table ${table}`);
}
rebuild('libraries', `CREATE TABLE IF NOT EXISTS libraries (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, type TEXT NOT NULL, path TEXT NOT NULL UNIQUE, kids_safe INTEGER NOT NULL DEFAULT 0)`);
rebuild('items', ITEMS_SQL);
db.exec(ITEMS_SQL);

// Add any columns missing from older databases
function ensureColumns(table, cols) {
  const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name));
  for (const [name, def] of Object.entries(cols)) if (!have.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`);
}
ensureColumns('items', {
  collection_id: 'INTEGER', trailer: 'TEXT', intro_start: 'REAL', intro_end: 'REAL', credits_start: 'REAL',
  intro_done: 'INTEGER NOT NULL DEFAULT 0', artist: 'TEXT', album: 'TEXT', album_artist: 'TEXT', track_no: 'INTEGER',
  disc_no: 'INTEGER', taken_at: 'INTEGER', folder: 'TEXT', meta_version: 'INTEGER NOT NULL DEFAULT 0',
});
ensureColumns('items', { edition: 'TEXT', locked: 'TEXT', recap_start: 'REAL', recap_end: 'REAL', credits_done: 'INTEGER NOT NULL DEFAULT 0',
  lat: 'REAL', lon: 'REAL', trickplay: 'INTEGER NOT NULL DEFAULT 0', subs_checked: 'INTEGER NOT NULL DEFAULT 0', tvdb_id: 'INTEGER', imdb_id: 'TEXT' });
ensureColumns('sessions', { guest: 'INTEGER NOT NULL DEFAULT 0' });
ensureColumns('profiles', { max_quality: 'TEXT', hidden: 'INTEGER NOT NULL DEFAULT 0', trakt: 'TEXT', auto_subs: 'INTEGER NOT NULL DEFAULT 0', sub_lang: 'TEXT' });
ensureColumns('profiles', {
  limit_weekday: 'INTEGER', limit_weekend: 'INTEGER', bedtime_start: 'TEXT', bedtime_end: 'TEXT',
  bonus_day: 'TEXT', bonus_minutes: 'INTEGER NOT NULL DEFAULT 0', auto_skip_intro: 'INTEGER NOT NULL DEFAULT 0',
});

db.exec(`
PRAGMA foreign_keys = ON;
CREATE INDEX IF NOT EXISTS idx_items_type ON items(type);
CREATE INDEX IF NOT EXISTS idx_items_parent ON items(parent_id);
CREATE INDEX IF NOT EXISTS idx_items_folder ON items(library_id, folder_key);
CREATE INDEX IF NOT EXISTS idx_items_tmdb ON items(tmdb_id);
CREATE INDEX IF NOT EXISTS idx_items_album ON items(album_artist, album);
CREATE INDEX IF NOT EXISTS idx_items_collection ON items(collection_id);

CREATE TABLE IF NOT EXISTS progress (
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  position REAL NOT NULL DEFAULT 0,
  duration REAL,
  watched INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (profile_id, item_id)
);

CREATE TABLE IF NOT EXISTS watchlist (
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (profile_id, item_id)
);

CREATE TABLE IF NOT EXISTS collections (
  id INTEGER PRIMARY KEY,           -- TMDB collection id
  name TEXT NOT NULL,
  overview TEXT,
  poster TEXT,
  backdrop TEXT
);

CREATE TABLE IF NOT EXISTS lists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  shared INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS list_items (
  list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (list_id, item_id)
);

CREATE TABLE IF NOT EXISTS people (
  id INTEGER PRIMARY KEY,           -- TMDB person id
  name TEXT NOT NULL,
  photo TEXT
);
CREATE TABLE IF NOT EXISTS credits (
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  role TEXT NOT NULL,               -- cast | director | creator
  character TEXT,
  ord INTEGER,
  PRIMARY KEY (item_id, person_id, role)
);
CREATE INDEX IF NOT EXISTS idx_credits_person ON credits(person_id);

CREATE TABLE IF NOT EXISTS history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  item_id INTEGER REFERENCES items(id) ON DELETE SET NULL,
  title TEXT,
  device TEXT,
  started_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  seconds INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_history_profile ON history(profile_id, started_at);

CREATE TABLE IF NOT EXISTS usage (
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  seconds INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (profile_id, day)
);

CREATE TABLE IF NOT EXISTS versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  quality TEXT NOT NULL,
  path TEXT,
  status TEXT NOT NULL DEFAULT 'queued',   -- queued | working | ready | failed
  progress REAL NOT NULL DEFAULT 0,
  size INTEGER,
  reason TEXT NOT NULL DEFAULT 'manual',   -- manual | auto | download
  error TEXT,
  created_at INTEGER NOT NULL,
  used_at INTEGER,
  UNIQUE (item_id, quality)
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  item_ids TEXT,
  image TEXT
);

CREATE TABLE IF NOT EXISTS push_subs (
  endpoint TEXT PRIMARY KEY,
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  sub TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`);

db.exec(`
CREATE TABLE IF NOT EXISTS profile_libraries (
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  PRIMARY KEY (profile_id, library_id)
);
CREATE TABLE IF NOT EXISTS invites (
  token TEXT PRIMARY KEY,
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  uses INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS ratings (
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  rating INTEGER NOT NULL,              -- 1..10 (half stars)
  rated_at INTEGER NOT NULL,
  PRIMARY KEY (profile_id, item_id)
);
CREATE TABLE IF NOT EXISTS plays (
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  count INTEGER NOT NULL DEFAULT 0,
  last_at INTEGER NOT NULL,
  PRIMARY KEY (profile_id, item_id)
);
CREATE TABLE IF NOT EXISTS playlists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  shared INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS playlist_items (
  playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  pos INTEGER NOT NULL,
  PRIMARY KEY (playlist_id, item_id)
);
CREATE TABLE IF NOT EXISTS lyrics (
  item_id INTEGER PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  synced INTEGER NOT NULL DEFAULT 0,
  text TEXT,
  source TEXT,
  fetched_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS podcasts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  feed_url TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  author TEXT,
  image TEXT,
  description TEXT,
  last_checked INTEGER,
  added_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS podcast_episodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  podcast_id INTEGER NOT NULL REFERENCES podcasts(id) ON DELETE CASCADE,
  guid TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  pub_date INTEGER,
  duration REAL,
  audio_url TEXT NOT NULL,
  image TEXT,
  UNIQUE (podcast_id, guid)
);
CREATE TABLE IF NOT EXISTS podcast_progress (
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  episode_id INTEGER NOT NULL REFERENCES podcast_episodes(id) ON DELETE CASCADE,
  position REAL NOT NULL DEFAULT 0,
  played INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (profile_id, episode_id)
);
CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  tmdb_id INTEGER NOT NULL,
  media_type TEXT NOT NULL,             -- movie | tv
  title TEXT NOT NULL,
  year INTEGER,
  poster TEXT,
  overview TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | declined | available | failed
  note TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_edition ON items(tmdb_id, edition);
`);
ensureColumns('notifications', { kind: "TEXT NOT NULL DEFAULT 'new'", profile_id: 'INTEGER' });

// ---- v4: kids episode limits, faces, AI subtitles, space saver, share links, security, widgets, voice ----
ensureColumns('profiles', { episode_limit: 'INTEGER', let_finish: 'INTEGER NOT NULL DEFAULT 0', cinema_mode: 'INTEGER NOT NULL DEFAULT 0', theme_music: 'INTEGER NOT NULL DEFAULT 1' });
ensureColumns('items', { faces_done: 'INTEGER NOT NULL DEFAULT 0', theme: 'TEXT', local_trailer: 'TEXT', optimised: 'INTEGER NOT NULL DEFAULT 0', health: 'TEXT' });
ensureColumns('sessions', { ip: 'TEXT', ua: 'TEXT', device_id: 'TEXT' });
db.exec(`
CREATE TABLE IF NOT EXISTS face_people (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  cover_face_id INTEGER,
  hidden INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS faces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  person_id INTEGER REFERENCES face_people(id) ON DELETE SET NULL,
  x REAL, y REAL, w REAL, h REAL,          -- 0..1 of the photo
  score REAL,
  descriptor BLOB NOT NULL,
  confirmed INTEGER NOT NULL DEFAULT 0     -- 1 = a person said "yes, that's them"
);
CREATE INDEX IF NOT EXISTS idx_faces_person ON faces(person_id);
CREATE INDEX IF NOT EXISTS idx_faces_item ON faces(item_id);

CREATE TABLE IF NOT EXISTS ai_subs (
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  task TEXT NOT NULL DEFAULT 'transcribe',  -- transcribe | translate
  status TEXT NOT NULL DEFAULT 'queued',    -- queued | working | ready | failed
  progress REAL NOT NULL DEFAULT 0,
  language TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (item_id, task)
);

CREATE TABLE IF NOT EXISTS space_saver (
  item_id INTEGER PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued',    -- queued | working | done | failed | skipped
  progress REAL NOT NULL DEFAULT 0,
  old_size INTEGER, new_size INTEGER,
  error TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS shares (
  token TEXT PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  note TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  max_views INTEGER,
  views INTEGER NOT NULL DEFAULT 0,
  revoked INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS signins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  profile_id INTEGER,
  ip TEXT,
  ua TEXT,
  ok INTEGER NOT NULL,
  reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_signins_at ON signins(at);
CREATE TABLE IF NOT EXISTS known_devices (
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  PRIMARY KEY (profile_id, device_id)
);

CREATE TABLE IF NOT EXISTS app_tokens (
  token TEXT PRIMARY KEY,
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                       -- widget | assistant
  name TEXT,
  created_at INTEGER NOT NULL,
  last_used INTEGER
);
`);

// ---- speed: which copy of a film is the one to show ----
// Checking "is there a better copy of this film?" for every movie on every screen got slow with big libraries,
// so the answer is stored on each row (hidden_dup) and refreshed only when the library actually changes.
ensureColumns('items', { hidden_dup: 'INTEGER NOT NULL DEFAULT 0', scan_key: 'TEXT' });
db.exec(`
PRAGMA synchronous = NORMAL;
PRAGMA cache_size = -64000;
PRAGMA temp_store = MEMORY;
CREATE TABLE IF NOT EXISTS flags (key TEXT PRIMARY KEY, value INTEGER NOT NULL DEFAULT 0);
INSERT OR IGNORE INTO flags (key, value) VALUES ('dups_dirty', 1);
CREATE TRIGGER IF NOT EXISTS trg_dups_ins AFTER INSERT ON items WHEN NEW.type IN ('movie','show')
  BEGIN UPDATE flags SET value = 1 WHERE key = 'dups_dirty' AND value = 0; END;
CREATE TRIGGER IF NOT EXISTS trg_dups_del AFTER DELETE ON items WHEN OLD.type IN ('movie','show')
  BEGIN UPDATE flags SET value = 1 WHERE key = 'dups_dirty' AND value = 0; END;
CREATE TRIGGER IF NOT EXISTS trg_dups_upd AFTER UPDATE OF tmdb_id, title, year, height, size, type ON items WHEN NEW.type IN ('movie','show')
  BEGIN UPDATE flags SET value = 1 WHERE key = 'dups_dirty' AND value = 0; END;
CREATE INDEX IF NOT EXISTS idx_items_type_added ON items(type, added_at);
CREATE INDEX IF NOT EXISTS idx_items_scan_key ON items(library_id, scan_key);
CREATE INDEX IF NOT EXISTS idx_items_type_sort ON items(type, sort_title);
CREATE INDEX IF NOT EXISTS idx_progress_profile ON progress(profile_id, updated_at);
`);
const dupsDirty = db.prepare("SELECT value FROM flags WHERE key = 'dups_dirty'");
// Best copy = highest resolution, then biggest file, then first added. Everything else of the same film is hidden from grids.
let dupsAt = 0;
function refreshDups(force = false) {
  if (!dupsDirty.get()?.value) return;
  // During a big scan the library changes constantly; refreshing every few seconds is plenty
  if (!force && Date.now() - dupsAt < 5000) return;
  dupsAt = Date.now();
  db.exec(`
    BEGIN;
    UPDATE flags SET value = 0 WHERE key = 'dups_dirty';
    UPDATE items SET hidden_dup = 0 WHERE hidden_dup != 0;
    UPDATE items SET hidden_dup = 1 WHERE id IN (
      SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (PARTITION BY type, CASE WHEN tmdb_id IS NOT NULL THEN 't' || tmdb_id ELSE 'n' || LOWER(title) || '|' || COALESCE(year, '') END
          ORDER BY COALESCE(height, 0) DESC, COALESCE(size, 0) DESC, id) AS rn
        FROM items WHERE type IN ('movie','show'))
      WHERE rn > 1);
    COMMIT;`);
}

function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value == null ? null : String(value));
}

// Server secret used for signed cast links
if (!getSetting('secret')) setSetting('secret', require('crypto').randomBytes(32).toString('hex'));

module.exports = { db, getSetting, setSetting, refreshDups };
