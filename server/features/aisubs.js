// AI subtitles: listens to the audio with Whisper (whisper.cpp, running on your ZimaOS box — nothing is uploaded)
// and writes subtitles for anything that has none, like home videos. Can also translate foreign films into English.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { db, getSetting } = require('../db');
const { CONFIG_DIR, TRANSCODE_DIR } = require('../config');
const subtitles = require('./subtitles');

const BIN = process.env.WHISPER_BIN || 'whisper-cli';
const MODEL_DIR = path.join(CONFIG_DIR, 'models');
fs.mkdirSync(MODEL_DIR, { recursive: true });
const MODELS = {
  tiny: { size: '75 MB', note: 'Fastest, rough' },
  base: { size: '142 MB', note: 'Good balance (recommended)' },
  small: { size: '466 MB', note: 'Most accurate, slow on small boxes' },
};

let available = false;
try { execFileSync(BIN, ['--help'], { stdio: 'ignore', timeout: 5000 }); available = true; } catch (e) { available = e.code !== 'ENOENT' && typeof e.status === 'number' && e.status !== 127; }
let hasNice = false;
try { execFileSync('nice', ['true'], { stdio: 'ignore' }); hasNice = true; } catch {}

const status = { running: false, current: null, download: null, error: null };
const modelName = () => (MODELS[getSetting('ai_subs_model')] ? getSetting('ai_subs_model') : 'base');
const modelPath = name => path.join(MODEL_DIR, `ggml-${name}.bin`);

async function ensureModel(name) {
  const dest = modelPath(name);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 1e6) return dest;
  const url = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${name}.bin`;
  status.download = { model: name, pct: 0 };
  const r = await fetch(url, { signal: AbortSignal.timeout(30 * 60000) });
  if (!r.ok) throw new Error(`Couldn't download the ${name} speech model (${r.status})`);
  const total = +r.headers.get('content-length') || 0;
  const tmp = dest + '.part';
  const out = fs.createWriteStream(tmp);
  let got = 0;
  for await (const chunk of r.body) {
    got += chunk.length;
    if (total) status.download.pct = Math.round(got / total * 100);
    if (!out.write(chunk)) await new Promise(res => out.once('drain', res));
  }
  await new Promise(res => out.end(res));
  fs.renameSync(tmp, dest);
  status.download = null;
  return dest;
}

function queue(itemId, task = 'transcribe') {
  if (!['transcribe', 'translate'].includes(task)) throw new Error('Unknown task');
  const it = db.prepare("SELECT id, type FROM items WHERE id = ? AND type IN ('movie','episode','home')").get(itemId);
  if (!it) throw new Error('Only videos can get subtitles');
  db.prepare(`INSERT INTO ai_subs (item_id, task, status, progress, created_at) VALUES (?, ?, 'queued', 0, ?)
    ON CONFLICT(item_id, task) DO UPDATE SET status = 'queued', progress = 0, error = NULL, created_at = excluded.created_at`).run(itemId, task, Date.now());
  setImmediate(run);
  return job(itemId, task);
}
const job = (itemId, task) => db.prepare('SELECT * FROM ai_subs WHERE item_id = ? AND task = ?').get(itemId, task);
function jobsFor(itemId) { return db.prepare('SELECT task, status, progress, language, error FROM ai_subs WHERE item_id = ?').all(itemId); }
function cancel(itemId, task) {
  db.prepare("DELETE FROM ai_subs WHERE item_id = ? AND task = ? AND status != 'working'").run(itemId, task);
  if (current && current.itemId === itemId && current.task === task) current.proc?.kill('SIGKILL');
}

let current = null;
async function run() {
  if (status.running || !available) return;
  status.running = true; status.error = null;
  try {
    let j;
    while ((j = db.prepare("SELECT * FROM ai_subs WHERE status = 'queued' ORDER BY created_at LIMIT 1").get())) {
      const item = db.prepare('SELECT * FROM items WHERE id = ?').get(j.item_id);
      if (!item || !fs.existsSync(item.path || '')) { db.prepare("UPDATE ai_subs SET status = 'failed', error = 'File missing' WHERE item_id = ? AND task = ?").run(j.item_id, j.task); continue; }
      db.prepare("UPDATE ai_subs SET status = 'working', progress = 0 WHERE item_id = ? AND task = ?").run(j.item_id, j.task);
      status.current = { itemId: item.id, title: item.title, task: j.task };
      try {
        const lang = await transcribe(item, j.task);
        db.prepare("UPDATE ai_subs SET status = 'ready', progress = 1, language = ? WHERE item_id = ? AND task = ?").run(lang, j.item_id, j.task);
      } catch (e) {
        db.prepare("UPDATE ai_subs SET status = 'failed', error = ? WHERE item_id = ? AND task = ?").run(String(e.message).slice(0, 300), j.item_id, j.task);
        status.error = e.message;
      }
    }
  } finally { status.running = false; status.current = null; current = null; }
}

async function transcribe(item, task) {
  const model = await ensureModel(modelName());
  const work = path.join(TRANSCODE_DIR, `whisper-${item.id}-${task}`);
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  try {
    // 1. Pull out the soundtrack as 16 kHz mono — what Whisper expects
    const wav = path.join(work, 'audio.wav');
    await exec('ffmpeg', ['-v', 'error', '-nostdin', '-y', '-i', item.path, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav]);
    // 2. Listen and write an .srt file
    const threads = String(Math.max(1, Math.min(8, os.cpus().length - 1)));
    const args = ['-m', model, '-f', wav, '-osrt', '-of', path.join(work, 'out'), '-t', threads, '-pp', '-l', task === 'translate' ? 'auto' : (getSetting('ai_subs_language') || 'auto')];
    if (task === 'translate') args.push('--translate');
    let detected = null;
    await new Promise((resolve, reject) => {
      const cmd = hasNice ? 'nice' : BIN;
      const proc = spawn(cmd, hasNice ? ['-n', '15', BIN, ...args] : args, { stdio: ['ignore', 'ignore', 'pipe'] });
      current = { itemId: item.id, task, proc };
      let tail = '';
      proc.stderr.on('data', d => {
        const s = d.toString();
        tail = (tail + s).slice(-2000);
        const m = /progress\s*=\s*(\d+)%/g;
        let x, last = null;
        while ((x = m.exec(s))) last = +x[1];
        if (last != null) db.prepare('UPDATE ai_subs SET progress = ? WHERE item_id = ? AND task = ?').run(last / 100, item.id, task);
        const l = /auto-detected language:\s*([a-z]{2,3})/.exec(s);
        if (l) detected = l[1];
      });
      proc.on('error', reject);
      proc.on('close', code => (code === 0 ? resolve() : reject(new Error(code === null ? 'Stopped' : `Whisper failed: ${tail.split('\n').filter(Boolean).pop() || code}`))));
    });
    const srt = path.join(work, 'out.srt');
    if (!fs.existsSync(srt) || !fs.readFileSync(srt, 'utf8').trim()) throw new Error('No speech found');
    const lang = task === 'translate' ? 'en' : (detected || getSetting('ai_subs_language') || 'en');
    const dir = path.join(subtitles.DIR, String(item.id));
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(srt, path.join(dir, `${lang}.ai${task === 'translate' ? '-translated' : ''}.srt`));
    return lang;
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
}

function exec(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', d => { err = (err + d).slice(-1000); });
    p.on('error', reject);
    p.on('close', code => (code === 0 ? resolve() : reject(new Error(/does not contain any stream|matches no streams/.test(err) ? 'This video has no sound' : err.trim().split('\n').pop() || 'ffmpeg failed'))));
  });
}

// After each scan: optionally make subtitles for new home videos, or for anything with none at all
function autoQueue(added) {
  const mode = getSetting('ai_subs_auto', 'off');
  if (mode === 'off' || !available) return;
  const stream = require('../stream');
  for (const a of added) {
    if (!['movie', 'episode', 'home'].includes(a.type)) continue;
    if (mode === 'home' && a.type !== 'home') continue;
    const item = db.prepare('SELECT * FROM items WHERE id = ?').get(a.id);
    if (!item || job(item.id, 'transcribe')) continue;
    if (stream.listSubtitles(item).length) continue;
    try { queue(item.id, 'transcribe'); } catch {}
  }
}

function summary() {
  return {
    available, model: modelName(), models: MODELS, ...status,
    modelReady: fs.existsSync(modelPath(modelName())),
    queued: db.prepare("SELECT COUNT(*) AS n FROM ai_subs WHERE status = 'queued'").get().n,
    done: db.prepare("SELECT COUNT(*) AS n FROM ai_subs WHERE status = 'ready'").get().n,
    recent: db.prepare(`SELECT a.item_id, a.task, a.status, a.progress, a.error, i.title FROM ai_subs a JOIN items i ON i.id = a.item_id ORDER BY a.created_at DESC LIMIT 20`).all(),
  };
}

// Pick up anything left queued from before a restart
setTimeout(() => { db.prepare("UPDATE ai_subs SET status = 'queued' WHERE status = 'working'").run(); run(); }, 20000).unref();

module.exports = { queue, cancel, jobsFor, autoQueue, summary, run, get available() { return available; }, MODELS };
