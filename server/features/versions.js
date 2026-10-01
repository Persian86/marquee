// Pre-converted copies ("optimized versions"): phone-friendly MP4s made in the background.
// Used for instant playback, offline downloads, and casting.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { db, getSetting } = require('../db');
const { TRANSCODE_DIR, HWACCEL, VAAPI_DEVICE } = require('../config');

const DIR = path.join(TRANSCODE_DIR, 'optimized');
fs.mkdirSync(DIR, { recursive: true });

const PRESETS = {
  '1080': { height: 1080, bitrate: 6_000_000, label: '1080p' },
  '720': { height: 720, bitrate: 3_000_000, label: '720p' },
  '480': { height: 480, bitrate: 1_200_000, label: '480p' },
};
let current = null; // { id, proc }

function itemProbe(item) { try { return JSON.parse(item.probe || '{}') || {}; } catch { return {}; } }

function request(itemId, quality, reason = 'manual') {
  if (!PRESETS[quality]) throw new Error('Unknown quality');
  const item = db.prepare("SELECT id, type FROM items WHERE id = ? AND type IN ('movie','episode','home')").get(itemId);
  if (!item) throw new Error('Not a video');
  const existing = db.prepare('SELECT * FROM versions WHERE item_id = ? AND quality = ?').get(itemId, quality);
  if (existing) {
    // Upgrade the reason so manual/download copies aren't cleaned up as "auto"
    const rank = { auto: 0, manual: 1, download: 2 };
    if (rank[reason] > rank[existing.reason]) db.prepare('UPDATE versions SET reason = ? WHERE id = ?').run(reason, existing.id);
    if (existing.status === 'failed') db.prepare("UPDATE versions SET status = 'queued', error = NULL, progress = 0 WHERE id = ?").run(existing.id);
    db.prepare('UPDATE versions SET used_at = ? WHERE id = ?').run(Date.now(), existing.id);
    kick();
    return db.prepare('SELECT * FROM versions WHERE id = ?').get(existing.id);
  }
  const r = db.prepare('INSERT INTO versions (item_id, quality, reason, created_at, used_at) VALUES (?, ?, ?, ?, ?)').run(itemId, quality, reason, Date.now(), Date.now());
  kick();
  return db.prepare('SELECT * FROM versions WHERE id = ?').get(Number(r.lastInsertRowid));
}

function remove(id) {
  const v = db.prepare('SELECT * FROM versions WHERE id = ?').get(id);
  if (!v) return;
  if (current && current.id === v.id) { current.proc.kill('SIGKILL'); current = null; }
  if (v.path) fs.rm(v.path, { force: true }, () => {});
  fs.rm(path.join(DIR, `${v.item_id}-${v.quality}.mp4.part`), { force: true }, () => {});
  db.prepare('DELETE FROM versions WHERE id = ?').run(id);
  setImmediate(kick);
}

function kick() {
  if (current) return;
  const next = db.prepare(`SELECT v.*, i.path AS src, i.probe, i.duration FROM versions v JOIN items i ON i.id = v.item_id
    WHERE v.status IN ('queued','working') ORDER BY CASE v.reason WHEN 'download' THEN 0 WHEN 'manual' THEN 1 ELSE 2 END, v.id LIMIT 1`).get();
  if (!next) return;
  if (!fs.existsSync(next.src)) {
    db.prepare("UPDATE versions SET status = 'failed', error = 'Source file missing' WHERE id = ?").run(next.id);
    return setImmediate(kick);
  }
  run(next, HWACCEL === 'vaapi' && fs.existsSync(VAAPI_DEVICE));
}

function run(v, useHw) {
  const q = PRESETS[v.quality];
  const p = itemProbe(v);
  const srcH = p.height || 1080, srcW = p.width || 1920;
  const h = Math.min(srcH, q.height);
  const w = Math.round((srcW * h / srcH) / 2) * 2;
  const out = path.join(DIR, `${v.item_id}-${v.quality}.mp4`);
  const part = out + '.part';
  const args = ['-hide_banner', '-v', 'error', '-nostdin', '-y'];
  if (useHw) args.push('-hwaccel', 'vaapi', '-hwaccel_device', VAAPI_DEVICE, '-hwaccel_output_format', 'vaapi');
  args.push('-i', v.src, '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn', '-map_chapters', '-1');
  if (useHw) args.push('-vf', `${p.hdr ? 'tonemap_vaapi=format=nv12:t=bt709:m=bt709:p=bt709,' : ''}scale_vaapi=w=${w}:h=${Math.round(h / 2) * 2}:format=nv12`, '-c:v', 'h264_vaapi', '-b:v', String(q.bitrate), '-maxrate', String(q.bitrate * 1.5), '-bufsize', String(q.bitrate * 3));
  else args.push('-vf', `scale=${w}:${Math.round(h / 2) * 2},format=yuv420p`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-maxrate', String(q.bitrate * 1.5), '-bufsize', String(q.bitrate * 3), '-profile:v', 'high', '-level:v', '4.1');
  args.push('-c:a', 'aac', '-ac', '2', '-b:a', '160k', '-movflags', '+faststart', '-f', 'mp4', '-progress', 'pipe:1', part);

  db.prepare("UPDATE versions SET status = 'working', progress = 0, error = NULL WHERE id = ?").run(v.id);
  // Low priority so live streams always win
  const proc = spawn('nice', ['-n', '15', 'ffmpeg', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  current = { id: v.id, proc };
  let err = '', lastWrite = 0;
  proc.stderr.on('data', d => { err = (err + d).slice(-2000); });
  proc.stdout.on('data', d => {
    const m = String(d).match(/out_time_us=(\d+)/g);
    if (!m || !v.duration) return;
    const t = parseInt(m[m.length - 1].split('=')[1], 10) / 1e6;
    if (Date.now() - lastWrite > 2000) {
      lastWrite = Date.now();
      db.prepare('UPDATE versions SET progress = ? WHERE id = ?').run(Math.min(0.99, t / v.duration), v.id);
    }
  });
  proc.on('close', code => {
    if (!current || current.id !== v.id) return; // removed meanwhile
    current = null;
    if (code === 0 && fs.existsSync(part)) {
      fs.renameSync(part, out);
      db.prepare("UPDATE versions SET status = 'ready', progress = 1, path = ?, size = ? WHERE id = ?").run(out, fs.statSync(out).size, v.id);
    } else if (useHw) {
      return run(v, false);
    } else {
      fs.rm(part, { force: true }, () => {});
      db.prepare("UPDATE versions SET status = 'failed', error = ? WHERE id = ?").run(err.trim().split('\n').pop() || `ffmpeg exited ${code}`, v.id);
    }
    setImmediate(kick);
  });
}

// Best ready copy for a quality limit (used to play instantly instead of live-converting)
function bestReady(itemId, maxHeight) {
  const rows = db.prepare("SELECT * FROM versions WHERE item_id = ? AND status = 'ready'").all(itemId);
  const ok = rows.filter(r => PRESETS[r.quality].height <= maxHeight && fs.existsSync(r.path))
    .sort((a, b) => PRESETS[b.quality].height - PRESETS[a.quality].height);
  if (ok[0]) db.prepare('UPDATE versions SET used_at = ? WHERE id = ?').run(Date.now(), ok[0].id);
  return ok[0] || null;
}

// "Prepare the next episodes" for shows people are watching
function autoQueueNext(profileId, episodeId) {
  if (getSetting('auto_optimize', '0') !== '1') return;
  const ep = db.prepare("SELECT id, parent_id FROM items WHERE id = ? AND type = 'episode'").get(episodeId);
  if (!ep) return;
  const quality = getSetting('auto_optimize_quality', '720');
  const eps = db.prepare(`SELECT i.id FROM items i LEFT JOIN progress p ON p.item_id = i.id AND p.profile_id = ?
    WHERE i.parent_id = ? AND COALESCE(p.watched, 0) = 0 ORDER BY (i.season = 0), i.season, i.episode`).all(profileId, ep.parent_id).map(r => r.id);
  const idx = eps.indexOf(episodeId);
  for (const id of eps.slice(idx + 1, idx + 3)) request(id, quality, 'auto');
}

// Housekeeping: drop auto copies of watched/old things and keep under the size cap
function cleanup() {
  const capBytes = parseFloat(getSetting('optimize_max_gb', '50')) * 1e9;
  const weekAgo = Date.now() - 7 * 86400000;
  for (const v of db.prepare("SELECT * FROM versions WHERE reason = 'auto' AND COALESCE(used_at, created_at) < ?").all(weekAgo)) remove(v.id);
  for (const v of db.prepare("SELECT * FROM versions WHERE reason = 'download' AND created_at < ?").all(Date.now() - 14 * 86400000)) remove(v.id);
  let total = db.prepare("SELECT COALESCE(SUM(size), 0) AS s FROM versions WHERE status = 'ready'").get().s;
  if (total > capBytes) {
    for (const v of db.prepare("SELECT * FROM versions WHERE status = 'ready' ORDER BY CASE reason WHEN 'auto' THEN 0 WHEN 'download' THEN 1 ELSE 2 END, COALESCE(used_at, created_at)").all()) {
      if (total <= capBytes) break;
      total -= v.size || 0;
      remove(v.id);
    }
  }
  // Files left over from deleted rows
  const known = new Set(db.prepare('SELECT path FROM versions WHERE path IS NOT NULL').all().map(r => r.path));
  for (const f of fs.readdirSync(DIR)) {
    const full = path.join(DIR, f);
    if (!known.has(full) && !(current && f.startsWith(String(db.prepare('SELECT item_id FROM versions WHERE id = ?').get(current.id)?.item_id) + '-'))) fs.rm(full, { force: true }, () => {});
  }
}

function list() {
  return db.prepare(`SELECT v.*, i.title, i.type, s.title AS show_title, i.season, i.episode FROM versions v JOIN items i ON i.id = v.item_id
    LEFT JOIN items s ON s.id = i.parent_id ORDER BY v.created_at DESC`).all();
}

// On startup: anything mid-conversion restarts
db.prepare("UPDATE versions SET status = 'queued' WHERE status = 'working'").run();
setTimeout(kick, 5000).unref();
setInterval(cleanup, 6 * 3600000).unref();

module.exports = { request, remove, bestReady, autoQueueNext, cleanup, list, PRESETS, DIR };
