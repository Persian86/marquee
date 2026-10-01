// Space saver: overnight, quietly re-encodes big older-format videos (H.264, MPEG-2, VC-1…) to HEVC,
// which is usually 40–50% smaller with no visible difference. Safe by design:
//  • only runs in the night-time window you choose, and pauses whenever someone is watching
//  • the new file is checked (same length, same tracks, actually smaller) before anything is replaced
//  • the original is kept in a hidden ".marquee-originals" folder for a few days, so it can be put back
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { db, getSetting } = require('../db');
const { HWACCEL, VAAPI_DEVICE } = require('../config');
const notify = require('./notify');

const OLD_CODECS = ['h264', 'mpeg2video', 'mpeg4', 'msmpeg4v3', 'msmpeg4v2', 'vc1', 'wmv3', 'mpeg1video', 'theora'];
const KEEP_DIR = '.marquee-originals';
const status = { running: false, paused: null, current: null, error: null };

const setting = (k, d) => getSetting(k, d);
const enabled = () => setting('space_saver', '0') === '1';
const windowHours = () => [+setting('space_saver_start', '1'), +setting('space_saver_end', '6')];
function inWindow(d = new Date()) {
  const [s, e] = windowHours(), h = d.getHours();
  return s === e ? true : s < e ? h >= s && h < e : h >= s || h < e;
}
let streamMod = null;
const someoneWatching = () => { streamMod = streamMod || require('../stream'); return streamMod.sessions.size > 0 || require('./activity').active().some(a => a.state === 'playing'); };

const minGb = () => Math.max(0, +setting('space_saver_min_gb', '1'));
function writable(dir) { try { fs.accessSync(dir, fs.constants.W_OK); return true; } catch { return false; } }

// Videos worth shrinking, biggest savings first
function candidates(limit = 500) {
  return db.prepare(`SELECT i.id, i.title, i.type, i.path, i.size, i.video_codec, i.height, i.duration, i.probe, s.title AS show
    FROM items i LEFT JOIN items s ON s.id = i.parent_id LEFT JOIN space_saver ss ON ss.item_id = i.id
    WHERE i.type IN ('movie','episode','home') AND i.optimised = 0 AND i.size >= ? AND i.video_codec IN (${OLD_CODECS.map(() => '?').join(',')})
      AND (ss.status IS NULL OR ss.status IN ('queued'))
    ORDER BY i.size DESC LIMIT ${limit | 0}`).all(Math.round(minGb() * 1e9), ...OLD_CODECS)
    .filter(r => { try { return !JSON.parse(r.probe || '{}').hdr; } catch { return true; } });
}
const estimate = bytes => Math.round(bytes * 0.45); // typical saving from H.264 → HEVC at similar quality

function summary() {
  const list = candidates(5000);
  const lib = db.prepare('SELECT path FROM libraries WHERE type IN (\'movie\',\'tv\',\'home\')').all();
  const readOnly = lib.filter(l => fs.existsSync(l.path) && !writable(l.path)).map(l => l.path);
  const done = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(old_size - new_size), 0) AS saved FROM space_saver WHERE status = 'done'").get();
  return {
    enabled: enabled(), window: windowHours(), inWindow: inWindow(), minGb: minGb(), keepDays: +setting('space_saver_keep_days', '7'),
    hw: HWACCEL === 'vaapi' && fs.existsSync(VAAPI_DEVICE), readOnly,
    candidates: list.length, potentialBytes: list.reduce((a, r) => a + estimate(r.size), 0),
    done: done.n, savedBytes: done.saved, ...status,
    top: list.slice(0, 10).map(r => ({ id: r.id, title: r.show ? `${r.show} — ${r.title}` : r.title, size: r.size, codec: r.video_codec, saving: estimate(r.size) })),
    recent: db.prepare(`SELECT ss.*, i.title FROM space_saver ss JOIN items i ON i.id = ss.item_id ORDER BY ss.updated_at DESC LIMIT 15`).all(),
  };
}

function probe(file) {
  return new Promise(resolve => execFile('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', file], { timeout: 60000 }, (err, out) => {
    if (err) return resolve(null);
    try { const j = JSON.parse(out); resolve({ duration: +j.format.duration, streams: j.streams.map(s => s.codec_type) }); } catch { resolve(null); }
  }));
}

let proc = null;
async function shrink(item) {
  const dir = path.dirname(item.path), ext = path.extname(item.path).toLowerCase(), base = path.basename(item.path);
  if (!writable(dir)) throw Object.assign(new Error('Folder is read-only — see Settings → Space saver'), { skip: true });
  const mp4 = ['.mp4', '.m4v', '.mov'].includes(ext);
  const outExt = mp4 ? ext : '.mkv';
  const tmp = path.join(dir, `.${base}.marquee-tmp${outExt}`);
  const useHw = HWACCEL === 'vaapi' && fs.existsSync(VAAPI_DEVICE) && setting('space_saver_hw', '1') === '1';
  const args = ['-hide_banner', '-v', 'error', '-nostdin', '-y'];
  if (useHw) args.push('-hwaccel', 'vaapi', '-hwaccel_device', VAAPI_DEVICE, '-hwaccel_output_format', 'vaapi');
  args.push('-i', item.path, '-map', '0:v:0', '-map', '0:a?');
  if (!mp4) args.push('-map', '0:s?', '-map', '0:t?'); // MKV keeps every subtitle and font
  args.push('-map_metadata', '0', '-map_chapters', '0', '-c', 'copy');
  if (useHw) args.push('-c:v', 'hevc_vaapi', '-qp', setting('space_saver_qp', '25'), '-vf', 'format=nv12|vaapi,hwupload');
  else args.push('-c:v', 'libx265', '-crf', setting('space_saver_crf', '23'), '-preset', setting('space_saver_preset', 'medium'), '-x265-params', 'log-level=error', '-pix_fmt', 'yuv420p');
  args.push('-tag:v', 'hvc1');
  if (mp4) args.push('-movflags', '+faststart');
  args.push('-progress', 'pipe:1', tmp);

  const dur = item.duration || 1;
  try {
    await new Promise((resolve, reject) => {
      proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let err = '';
      proc.stderr.on('data', d => { err = (err + d).slice(-1500); });
      proc.stdout.on('data', d => {
        const m = /out_time_(?:ms|us)=(\d+)/.exec(String(d));
        if (m) db.prepare('UPDATE space_saver SET progress = ?, updated_at = ? WHERE item_id = ?').run(Math.min(0.99, +m[1] / 1e6 / dur), Date.now(), item.id);
      });
      proc.on('error', reject);
      proc.on('close', code => (code === 0 ? resolve() : reject(new Error(code === null ? 'Stopped' : (err.trim().split('\n').pop() || `ffmpeg exited ${code}`)))));
    });
    proc = null;
    // Check the new file before touching the original
    const [a, b] = [await probe(item.path), await probe(tmp)];
    if (!a || !b) throw new Error("Couldn't verify the new file");
    if (Math.abs(a.duration - b.duration) > Math.max(2, a.duration * 0.005)) throw new Error(`New file is a different length (${Math.round(b.duration)}s vs ${Math.round(a.duration)}s)`);
    const countOf = (list, t) => list.filter(x => x === t).length;
    if (countOf(b.streams, 'audio') < countOf(a.streams, 'audio')) throw new Error('Audio tracks went missing');
    const newSize = fs.statSync(tmp).size;
    if (newSize > item.size * 0.9) throw Object.assign(new Error('Already efficient — HEVC would barely help'), { skip: true });
    // Swap: original goes to the hidden keep folder (same disk, so it's instant)
    const keep = path.join(dir, KEEP_DIR);
    fs.mkdirSync(keep, { recursive: true });
    const kept = path.join(keep, `${Date.now()}-${base}`);
    fs.renameSync(item.path, kept);
    const finalPath = mp4 ? item.path : path.join(dir, path.basename(item.path, path.extname(item.path)) + outExt);
    fs.renameSync(tmp, finalPath);
    fs.writeFileSync(kept + '.json', JSON.stringify({ restoreTo: item.path, replacedBy: finalPath, itemId: item.id, at: Date.now() }));
    if (finalPath !== item.path) db.prepare('UPDATE items SET path = ? WHERE id = ?').run(finalPath, item.id);
    db.prepare('UPDATE items SET optimised = 1 WHERE id = ?').run(item.id);
    return newSize;
  } finally {
    proc = null;
    fs.rmSync(tmp, { force: true });
  }
}

let tickBusy = false;
async function tick({ force = false } = {}) {
  if (tickBusy) return;
  tickBusy = true;
  try {
    cleanupOriginals();
    if (!force && (!enabled() || !inWindow())) { status.paused = enabled() ? 'Waiting for the night-time window' : null; return; }
    status.running = true; status.error = null;
    let next;
    while ((next = db.prepare("SELECT item_id FROM space_saver WHERE status = 'queued' ORDER BY updated_at LIMIT 1").get() || (enabled() && candidates(1)[0] && { item_id: candidates(1)[0].id }))) {
      if (!force && (!enabled() || !inWindow())) break;
      while (someoneWatching()) { status.paused = 'Paused while someone is watching'; await new Promise(r => setTimeout(r, 30000)); }
      status.paused = null;
      const item = db.prepare('SELECT * FROM items WHERE id = ?').get(next.item_id);
      if (!item || !fs.existsSync(item.path)) { db.prepare("INSERT OR REPLACE INTO space_saver (item_id, status, error, updated_at) VALUES (?, 'failed', 'File missing', ?)").run(next.item_id, Date.now()); continue; }
      db.prepare("INSERT OR REPLACE INTO space_saver (item_id, status, progress, old_size, updated_at) VALUES (?, 'working', 0, ?, ?)").run(item.id, item.size, Date.now());
      status.current = { id: item.id, title: item.title, size: item.size };
      try {
        const newSize = await shrink(item);
        db.prepare("UPDATE space_saver SET status = 'done', progress = 1, new_size = ?, updated_at = ? WHERE item_id = ?").run(newSize, Date.now(), item.id);
        rescanSoon();
      } catch (e) {
        db.prepare('UPDATE space_saver SET status = ?, error = ?, updated_at = ? WHERE item_id = ?').run(e.skip ? 'skipped' : 'failed', String(e.message).slice(0, 300), Date.now(), item.id);
        if (e.message === 'Stopped') break;
      }
      status.current = null;
    }
  } catch (e) { status.error = e.message; }
  finally { status.running = false; status.current = null; tickBusy = false; }
}

// Pause ffmpeg (not kill it) when someone starts watching or the window closes; carry on later
setInterval(() => {
  if (!proc) return;
  const shouldPause = someoneWatching() || (!inWindow() && !manualRun);
  try { proc.kill(shouldPause ? 'SIGSTOP' : 'SIGCONT'); } catch {}
  status.paused = shouldPause ? (someoneWatching() ? 'Paused while someone is watching' : 'Paused until tonight') : null;
}, 10000).unref();
let manualRun = false;

function queue(itemId) {
  db.prepare("INSERT OR REPLACE INTO space_saver (item_id, status, progress, updated_at) VALUES (?, 'queued', 0, ?)").run(itemId, Date.now());
}
async function runNow() { manualRun = true; try { await tick({ force: true }); } finally { manualRun = false; } }
function stop() { if (proc) { try { proc.kill('SIGCONT'); proc.kill('SIGKILL'); } catch {} } }

// Originals older than the keep period are deleted; any can be put back before that
function keptOriginals() {
  const out = [];
  for (const l of db.prepare("SELECT path FROM libraries WHERE type IN ('movie','tv','home')").all()) {
    const walk = dir => {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory() && e.name === KEEP_DIR) {
          for (const f of fs.readdirSync(full)) if (f.endsWith('.json')) {
            try { out.push({ ...JSON.parse(fs.readFileSync(path.join(full, f), 'utf8')), file: path.join(full, f.slice(0, -5)), meta: path.join(full, f) }); } catch {}
          }
        } else if (e.isDirectory() && !e.name.startsWith('.')) walk(full);
      }
    };
    walk(l.path);
  }
  return out;
}
function cleanupOriginals() {
  const days = +setting('space_saver_keep_days', '7');
  for (const k of keptOriginals()) {
    if (Date.now() - k.at > days * 86400000) {
      fs.rmSync(k.file, { force: true }); fs.rmSync(k.meta, { force: true });
      try { const dir = path.dirname(k.file); if (!fs.readdirSync(dir).length) fs.rmdirSync(dir); } catch {}
    }
  }
}
function restore(itemId) {
  const k = keptOriginals().find(x => x.itemId === itemId && fs.existsSync(x.file));
  if (!k) throw new Error('The original is no longer kept');
  if (fs.existsSync(k.replacedBy)) fs.rmSync(k.replacedBy);
  fs.renameSync(k.file, k.restoreTo);
  fs.rmSync(k.meta, { force: true });
  db.prepare('UPDATE items SET path = ?, optimised = 0 WHERE id = ?').run(k.restoreTo, itemId);
  db.prepare("UPDATE space_saver SET status = 'skipped', error = 'Original put back', updated_at = ? WHERE item_id = ?").run(Date.now(), itemId);
  try { const dir = path.dirname(k.file); if (!fs.readdirSync(dir).length) fs.rmdirSync(dir); } catch {}
  rescanSoon();
}
// Re-read the changed file's details (codec, size) shortly after
let rescanTimer = null;
function rescanSoon() { clearTimeout(rescanTimer); rescanTimer = setTimeout(() => require('../scanner').scanAll(), 5000); }

setInterval(() => tick().catch(() => {}), 5 * 60000).unref();
// Leftovers from a restart mid-job start again
setTimeout(() => { db.prepare("UPDATE space_saver SET status = 'queued' WHERE status = 'working'").run(); tick().catch(() => {}); }, 30000).unref();

module.exports = { summary, queue, runNow, stop, restore, keptOriginals, candidates, inWindow, KEEP_DIR };
