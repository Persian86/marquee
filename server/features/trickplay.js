// Scrub previews: little thumbnails every few seconds, packed into sprite sheets (like Jellyfin's "trickplay").
const fs = require('fs');
const path = require('path');
const bg = require('./background');
const { db, getSetting } = require('../db');
const { CONFIG_DIR } = require('../config');

const DIR = path.join(CONFIG_DIR, 'trickplay');
fs.mkdirSync(DIR, { recursive: true });
const status = { running: false, done: 0, total: 0, current: null };
const COLS = 10, ROWS = 10, WIDTH = 240;

function enabled() { return getSetting('trickplay', '1') === '1'; }

function generate(item) {
  return new Promise(resolve => {
    let p = {};
    try { p = JSON.parse(item.probe || '{}'); } catch {}
    const interval = (item.duration || 0) < 1200 ? 5 : 10;
    const height = Math.round(WIDTH * (p.height || 9) / (p.width || 16) / 2) * 2;
    const out = path.join(DIR, String(item.id));
    fs.rmSync(out, { recursive: true, force: true });
    fs.mkdirSync(out, { recursive: true });
    // Decoding keyframes only makes this quick even for long films
    const proc = bg.spawnLow('ffmpeg', ['-v', 'error', '-nostdin', '-skip_frame', 'nokey', '-i', item.path, '-an', '-sn', '-dn',
      '-vf', `fps=1/${interval},scale=${WIDTH}:${height},tile=${COLS}x${ROWS}`, '-q:v', '6', '-fps_mode', 'vfr', path.join(out, '%03d.jpg')], { stdio: 'ignore' });
    const timer = setTimeout(() => proc.kill('SIGKILL'), 30 * 60000);
    proc.on('close', code => {
      clearTimeout(timer);
      const sheets = fs.existsSync(out) ? fs.readdirSync(out).filter(f => f.endsWith('.jpg')).length : 0;
      if (code === 0 && sheets) {
        fs.writeFileSync(path.join(out, 'info.json'), JSON.stringify({ interval, width: WIDTH, height, cols: COLS, rows: ROWS, count: Math.ceil((item.duration || 0) / interval), sheets }));
        db.prepare('UPDATE items SET trickplay = 1 WHERE id = ?').run(item.id);
      } else {
        fs.rmSync(out, { recursive: true, force: true });
        db.prepare('UPDATE items SET trickplay = -1 WHERE id = ?').run(item.id);
      }
      resolve();
    });
  });
}

async function run() {
  if (status.running || !enabled()) return;
  status.running = true;
  try {
    // Things people are watching first, then newest
    const items = db.prepare(`SELECT i.id, i.path, i.duration, i.probe FROM items i WHERE i.type IN ('movie','episode','home') AND i.trickplay = 0 AND i.duration > 60
      ORDER BY (SELECT MAX(updated_at) FROM progress p WHERE p.item_id = i.id OR p.item_id IN (SELECT id FROM items x WHERE x.parent_id = i.parent_id)) DESC NULLS LAST, i.added_at DESC`).all();
    status.total = items.length; status.done = 0;
    for (const it of items) {
      if (!enabled()) break;
      await bg.idle(); // never while someone is watching or browsing
      if (!enabled()) break;
      status.current = it.id;
      if (fs.existsSync(it.path)) await bg.turn(() => generate(it));
      status.done++;
    }
  } finally {
    status.running = false;
    status.current = null;
  }
}

function info(id) {
  const f = path.join(DIR, String(+id), 'info.json');
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
}
function sheetPath(id, n) {
  const f = path.join(DIR, String(+id), `${String(+n).padStart(3, '0')}.jpg`);
  return fs.existsSync(f) ? f : null;
}
function cleanup() {
  const ids = new Set(db.prepare("SELECT id FROM items WHERE trickplay = 1").all().map(r => String(r.id)));
  for (const d of fs.readdirSync(DIR)) if (!ids.has(d)) fs.rmSync(path.join(DIR, d), { recursive: true, force: true });
}

module.exports = { run, info, sheetPath, status, cleanup, enabled };
