// Backup & restore of everything that isn't your media: settings, profiles, libraries, watch history, lists.
// Items are matched by file path, so a restore works even on a fresh install after the first scan.
const fs = require('fs');
const path = require('path');
const { db } = require('../db');
const { CONFIG_DIR } = require('../config');

const BACKUP_DIR = path.join(CONFIG_DIR, 'backups');
const PENDING = path.join(CONFIG_DIR, 'pending-restore.json');
fs.mkdirSync(BACKUP_DIR, { recursive: true });

function create() {
  const pathOf = id => db.prepare('SELECT path, type, folder_key, library_id FROM items WHERE id = ?').get(id);
  // Shows have no file — identify them by library path + folder
  const ref = id => {
    const i = pathOf(id);
    if (!i) return null;
    if (i.path) return { path: i.path };
    const lib = db.prepare('SELECT path FROM libraries WHERE id = ?').get(i.library_id);
    return { show: i.folder_key, lib: lib?.path };
  };
  return {
    app: 'marquee', version: 2, created_at: new Date().toISOString(),
    settings: db.prepare("SELECT * FROM settings WHERE key NOT IN ('secret')").all(),
    profiles: db.prepare('SELECT * FROM profiles').all(),
    libraries: db.prepare('SELECT * FROM libraries').all(),
    progress: db.prepare('SELECT * FROM progress').all().map(r => ({ ...r, ref: ref(r.item_id) })).filter(r => r.ref),
    watchlist: db.prepare('SELECT * FROM watchlist').all().map(r => ({ ...r, ref: ref(r.item_id) })).filter(r => r.ref),
    lists: db.prepare('SELECT * FROM lists').all(),
    list_items: db.prepare('SELECT * FROM list_items').all().map(r => ({ ...r, ref: ref(r.item_id) })).filter(r => r.ref),
    history: db.prepare('SELECT * FROM history ORDER BY id DESC LIMIT 5000').all().map(r => ({ ...r, ref: r.item_id ? ref(r.item_id) : null })),
    usage: db.prepare('SELECT * FROM usage').all(),
  };
}

function resolve(ref) {
  if (!ref) return null;
  if (ref.path) return db.prepare('SELECT id FROM items WHERE path = ?').get(ref.path)?.id || null;
  return db.prepare("SELECT i.id FROM items i JOIN libraries l ON l.id = i.library_id WHERE i.type = 'show' AND i.folder_key = ? AND l.path = ?").get(ref.show, ref.lib)?.id || null;
}

function restore(data) {
  if (!data || data.app !== 'marquee') throw new Error("That file isn't a Marquee backup");
  db.exec('PRAGMA foreign_keys = OFF; BEGIN;');
  try {
    for (const t of ['sessions', 'progress', 'watchlist', 'list_items', 'lists', 'history', 'usage', 'push_subs', 'profiles']) db.exec(`DELETE FROM ${t}`);
    const ins = (table, row) => {
      const keys = Object.keys(row).filter(k => k !== 'ref');
      db.prepare(`INSERT OR REPLACE INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map(k => row[k]));
    };
    for (const s of data.settings || []) ins('settings', s);
    for (const p of data.profiles || []) ins('profiles', p);
    for (const l of data.libraries || []) {
      if (!db.prepare('SELECT 1 FROM libraries WHERE path = ?').get(l.path)) db.prepare('INSERT INTO libraries (name, type, path, kids_safe) VALUES (?, ?, ?, ?)').run(l.name, l.type, l.path, l.kids_safe);
    }
    for (const l of data.lists || []) ins('lists', l);
    for (const u of data.usage || []) ins('usage', u);
    db.exec('COMMIT; PRAGMA foreign_keys = ON;');
  } catch (e) {
    db.exec('ROLLBACK; PRAGMA foreign_keys = ON;');
    throw e;
  }
  // Watch data is applied now for files already scanned, and again after the next scan for the rest
  fs.writeFileSync(PENDING, JSON.stringify({ progress: data.progress || [], watchlist: data.watchlist || [], list_items: data.list_items || [], history: data.history || [], tries: 0 }));
  return applyPending();
}

function applyPending() {
  if (!fs.existsSync(PENDING)) return null;
  const p = JSON.parse(fs.readFileSync(PENDING, 'utf8'));
  const left = { progress: [], watchlist: [], list_items: [], history: [], tries: (p.tries || 0) + 1 };
  let applied = 0;
  for (const r of p.progress) {
    const id = resolve(r.ref);
    if (!id) { left.progress.push(r); continue; }
    db.prepare(`INSERT OR REPLACE INTO progress (profile_id, item_id, position, duration, watched, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(r.profile_id, id, r.position, r.duration, r.watched, r.updated_at); applied++;
  }
  for (const r of p.watchlist) {
    const id = resolve(r.ref);
    if (!id) { left.watchlist.push(r); continue; }
    db.prepare('INSERT OR IGNORE INTO watchlist (profile_id, item_id, added_at) VALUES (?, ?, ?)').run(r.profile_id, id, r.added_at); applied++;
  }
  for (const r of p.list_items) {
    const id = resolve(r.ref);
    if (!id) { left.list_items.push(r); continue; }
    db.prepare('INSERT OR IGNORE INTO list_items (list_id, item_id, added_at) VALUES (?, ?, ?)').run(r.list_id, id, r.added_at); applied++;
  }
  for (const r of p.history) {
    const id = r.ref ? resolve(r.ref) : null;
    if (r.ref && !id && left.tries < 3) { left.history.push(r); continue; }
    db.prepare('INSERT INTO history (profile_id, item_id, title, device, started_at, last_at, seconds) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(r.profile_id, id, r.title, r.device, r.started_at, r.last_at, r.seconds); applied++;
  }
  const remaining = left.progress.length + left.watchlist.length + left.list_items.length + left.history.length;
  if (!remaining || left.tries >= 3) fs.rmSync(PENDING, { force: true });
  else fs.writeFileSync(PENDING, JSON.stringify(left));
  return { applied, waiting: remaining };
}

function nightly() {
  const d = new Date();
  const name = `marquee-${d.toISOString().slice(0, 10)}.json`;
  fs.writeFileSync(path.join(BACKUP_DIR, name), JSON.stringify(create()));
  for (const dir of ['subtitles', 'faces']) {
    const src = path.join(CONFIG_DIR, dir);
    const dest = path.join(BACKUP_DIR, `${dir}-${d.toISOString().slice(0, 10)}`);
    if (fs.existsSync(src)) { try { fs.cpSync(src, dest, { recursive: true }); } catch (e) { console.warn('Backup sidecars:', e.message); } }
  }
  const files = fs.readdirSync(BACKUP_DIR).filter(f => /^marquee-.*\.json$/.test(f)).sort();
  for (const f of files.slice(0, -7)) fs.rmSync(path.join(BACKUP_DIR, f), { force: true });
}

function schedule() {
  const tick = () => {
    const d = new Date();
    const name = `marquee-${d.toISOString().slice(0, 10)}.json`;
    if (d.getHours() >= 3 && !fs.existsSync(path.join(BACKUP_DIR, name))) { try { nightly(); } catch (e) { console.error('Backup failed:', e.message); } }
  };
  setInterval(tick, 30 * 60000).unref();
  setTimeout(tick, 60000).unref();
}

function listBackups() {
  return fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.json')).sort().reverse()
    .map(f => ({ name: f, size: fs.statSync(path.join(BACKUP_DIR, f)).size }));
}

module.exports = { create, restore, applyPending, schedule, listBackups, BACKUP_DIR };
