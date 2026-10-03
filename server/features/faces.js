// Faces in photos: finds faces, groups the same person together, and lets you name them
// ("show me every photo of Zoey"). Runs quietly in the background on the ZimaOS box.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { Worker } = require('worker_threads');
const { db, getSetting, setSetting } = require('../db');
const { TRANSCODE_DIR } = require('../config');
const C = require('../common');

const SAME = 0.5;        // descriptor distance: below this it's very likely the same person
const START_GROUP = 0.45; // two loose faces this close start a new (unnamed) person
const CROP_DIR = path.join(TRANSCODE_DIR, 'optimized', 'faces');
fs.mkdirSync(CROP_DIR, { recursive: true });

let available = true;
try { require.resolve('@vladmandic/face-api'); require.resolve('@tensorflow/tfjs-backend-wasm'); } catch { available = false; }

const status = { running: false, done: 0, total: 0, error: null, current: null };
const enabled = () => available && getSetting('faces_enabled', '1') === '1';

// ---------- descriptors ----------
const toBlob = arr => Buffer.from(new Float32Array(arr).buffer);
const fromBlob = b => new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
function dist(a, b) { let s = 0; for (let i = 0; i < 128; i++) { const d = a[i] - b[i]; s += d * d; } return Math.sqrt(s); }

// Average face of each person (confirmed faces count double)
let centroids = null;
function loadCentroids() {
  const sums = new Map();
  for (const f of db.prepare('SELECT person_id, descriptor, confirmed FROM faces WHERE person_id IS NOT NULL').iterate()) {
    const d = fromBlob(f.descriptor);
    let s = sums.get(f.person_id);
    if (!s) { s = { v: new Float32Array(128), n: 0 }; sums.set(f.person_id, s); }
    const wgt = f.confirmed ? 2 : 1;
    for (let i = 0; i < 128; i++) s.v[i] += d[i] * wgt;
    s.n += wgt;
  }
  centroids = new Map([...sums].map(([id, s]) => [id, s.v.map(x => x / s.n)]));
}

function assign(faceId, desc) {
  if (!centroids) loadCentroids();
  let best = null, bestD = SAME;
  for (const [pid, c] of centroids) { const d = dist(desc, c); if (d < bestD) { bestD = d; best = pid; } }
  if (best) { db.prepare('UPDATE faces SET person_id = ? WHERE id = ?').run(best, faceId); centroids = null; return; }
  // No known person: see if it matches another loose face, and if so start a new person with both
  let twin = null, twinD = START_GROUP;
  for (const f of db.prepare('SELECT id, descriptor FROM faces WHERE person_id IS NULL AND id != ? ORDER BY id DESC LIMIT 4000').iterate(faceId)) {
    const d = dist(desc, fromBlob(f.descriptor));
    if (d < twinD) { twinD = d; twin = f.id; }
  }
  if (twin) {
    const pid = Number(db.prepare('INSERT INTO face_people (name, cover_face_id, created_at) VALUES (NULL, ?, ?)').run(faceId, Date.now()).lastInsertRowid);
    db.prepare('UPDATE faces SET person_id = ? WHERE id IN (?, ?)').run(pid, faceId, twin);
    // Pull in any other loose faces that look like this new person
    for (const f of db.prepare('SELECT id, descriptor FROM faces WHERE person_id IS NULL').all()) {
      if (dist(desc, fromBlob(f.descriptor)) < SAME) db.prepare('UPDATE faces SET person_id = ? WHERE id = ?').run(pid, f.id);
    }
    centroids = null;
  }
}

// ---------- background worker ----------
let worker = null, seq = 0;
const pending = new Map();
function getWorker() {
  if (worker) return worker;
  worker = new Worker(path.join(__dirname, 'faces-worker.js'), { resourceLimits: { maxOldGenerationSizeMb: 1024 } });
  worker.on('message', m => { const p = pending.get(m.id); pending.delete(m.id); if (p) (m.error ? p.reject(Object.assign(new Error(m.error), { fatal: m.fatal })) : p.resolve(m.faces)); });
  worker.on('error', e => { for (const p of pending.values()) p.reject(e); pending.clear(); worker = null; });
  worker.on('exit', () => { worker = null; });
  return worker;
}
function detect(item) {
  let probe = {};
  try { probe = JSON.parse(item.probe || '{}') || {}; } catch {}
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, path: item.path, width: item.width || probe.width, height: item.height || probe.height, orientation: probe.orientation || 1 });
  });
}

let stream = null;
const busyStreaming = () => { stream = stream || require('../stream'); return stream.sessions.size > 0; };

async function run() {
  if (status.running || !enabled()) return;
  status.running = true; status.error = null;
  try {
    const todo = db.prepare("SELECT i.* FROM items i WHERE i.type = 'photo' AND i.faces_done = 0 ORDER BY i.taken_at DESC").all();
    status.total = todo.length; status.done = 0;
    for (const item of todo) {
      if (!enabled()) break;
      // Leave the processor to video when someone's watching
      await require('./background').idle();
      status.current = item.title;
      try {
        if (fs.existsSync(item.path)) {
          const faces = await detect(item);
          db.prepare('DELETE FROM faces WHERE item_id = ?').run(item.id);
          for (const f of faces) {
            const fid = Number(db.prepare('INSERT INTO faces (item_id, x, y, w, h, score, descriptor) VALUES (?, ?, ?, ?, ?, ?, ?)')
              .run(item.id, f.x, f.y, f.w, f.h, f.score, toBlob(f.descriptor)).lastInsertRowid);
            assign(fid, Float32Array.from(f.descriptor));
          }
        }
        db.prepare('UPDATE items SET faces_done = 1 WHERE id = ?').run(item.id);
      } catch (e) {
        if (e.fatal) { available = false; status.error = 'Face recognition could not start on this server: ' + e.message; break; }
        db.prepare('UPDATE items SET faces_done = 2 WHERE id = ?').run(item.id); // couldn't read — skip it
      }
      status.done++;
    }
  } finally {
    status.running = false; status.current = null;
    if (worker) { worker.terminate(); worker = null; }
  }
}

// ---------- reading ----------
// People with photos this profile can see
function people(profile, { includeUnnamed = true } = {}) {
  const rows = db.prepare(`SELECT fp.id, fp.name, fp.cover_face_id, fp.hidden, COUNT(DISTINCT f.item_id) AS n, MAX(i.taken_at) AS latest
    FROM face_people fp JOIN faces f ON f.person_id = fp.id JOIN items i ON i.id = f.item_id JOIN libraries l ON l.id = i.library_id
    WHERE fp.hidden = 0 AND ${C.visible(profile)} GROUP BY fp.id HAVING (n >= 2 OR fp.name IS NOT NULL) ORDER BY (fp.name IS NULL), n DESC`).all();
  return rows.filter(p => p.name || includeUnnamed).map(p => ({
    id: p.id, name: p.name, count: p.n, latest: p.latest,
    cover: `/api/faces/${p.cover_face_id || db.prepare('SELECT id FROM faces WHERE person_id = ? ORDER BY confirmed DESC, score DESC LIMIT 1').get(p.id)?.id}/thumb`,
  }));
}
function photosOf(profile, personId) {
  return db.prepare(`SELECT DISTINCT i.id, i.title, i.taken_at, i.folder FROM faces f JOIN items i ON i.id = f.item_id JOIN libraries l ON l.id = i.library_id
    WHERE f.person_id = ? AND ${C.visible(profile)} ORDER BY i.taken_at DESC`).all(personId)
    .map(x => ({ id: x.id, title: x.title, takenAt: x.taken_at, folder: x.folder, thumb: `/api/photo/${x.id}/thumb`, display: `/api/photo/${x.id}/display`, original: `/api/photo/${x.id}/original` }));
}
function facesIn(itemId) {
  return db.prepare('SELECT f.id, f.x, f.y, f.w, f.h, f.person_id, fp.name FROM faces f LEFT JOIN face_people fp ON fp.id = f.person_id WHERE f.item_id = ?').all(itemId)
    .map(f => ({ id: f.id, box: { x: f.x, y: f.y, w: f.w, h: f.h }, personId: f.person_id, name: f.name || null, thumb: `/api/faces/${f.id}/thumb` }));
}

// ---------- changing ----------
function rename(personId, name) {
  name = String(name || '').trim().slice(0, 40) || null;
  // Naming a second group with an existing name merges them ("Zoey" as a baby and "Zoey" now)
  const same = name && db.prepare('SELECT id FROM face_people WHERE LOWER(name) = LOWER(?) AND id != ?').get(name, personId);
  if (same) { merge(personId, same.id); return same.id; }
  db.prepare('UPDATE face_people SET name = ? WHERE id = ?').run(name, personId);
  db.prepare('UPDATE faces SET confirmed = 1 WHERE person_id = ?').run(personId);
  return personId;
}
function merge(fromId, intoId) {
  db.prepare('UPDATE faces SET person_id = ? WHERE person_id = ?').run(intoId, fromId);
  db.prepare('DELETE FROM face_people WHERE id = ?').run(fromId);
  centroids = null;
}
function hide(personId, hidden = true) { db.prepare('UPDATE face_people SET hidden = ? WHERE id = ?').run(hidden ? 1 : 0, personId); }
// "That's not Zoey" / "This is Hayley"
function setFace(faceId, { personId = undefined, name = undefined }) {
  const f = db.prepare('SELECT * FROM faces WHERE id = ?').get(faceId);
  if (!f) throw new Error('Face not found');
  let pid = personId === undefined ? f.person_id : personId;
  if (name) {
    pid = db.prepare('SELECT id FROM face_people WHERE LOWER(name) = LOWER(?)').get(String(name).trim())?.id
      || Number(db.prepare('INSERT INTO face_people (name, cover_face_id, created_at) VALUES (?, ?, ?)').run(String(name).trim().slice(0, 40), faceId, Date.now()).lastInsertRowid);
  }
  db.prepare('UPDATE faces SET person_id = ?, confirmed = ? WHERE id = ?').run(pid ?? null, pid ? 1 : 0, faceId);
  centroids = null;
  // Remove now-empty people
  db.prepare('DELETE FROM face_people WHERE id NOT IN (SELECT DISTINCT person_id FROM faces WHERE person_id IS NOT NULL) AND name IS NULL').run();
  return pid;
}
function setCover(personId, faceId) { db.prepare('UPDATE face_people SET cover_face_id = ? WHERE id = ?').run(faceId, personId); }

function resetAll() {
  db.exec('DELETE FROM faces; DELETE FROM face_people; UPDATE items SET faces_done = 0 WHERE type = \'photo\';');
  centroids = null;
  setTimeout(run, 1000);
}

// A square crop of one face, for the People row
const cropJobs = new Map();
async function thumb(faceId, res) {
  const f = db.prepare('SELECT f.*, i.path, i.probe, i.mtime FROM faces f JOIN items i ON i.id = f.item_id WHERE f.id = ?').get(faceId);
  if (!f) return res.status(404).end();
  const dest = path.join(CROP_DIR, crypto.createHash('sha1').update(`${f.path}${f.mtime}${f.id}${f.x}`).digest('hex').slice(0, 24) + '.jpg');
  if (!fs.existsSync(dest)) {
    if (!cropJobs.has(dest)) {
      let orient = 1;
      try { orient = JSON.parse(f.probe || '{}').orientation || 1; } catch {}
      const ORIENT = { 2: 'hflip', 3: 'transpose=1,transpose=1', 4: 'vflip', 5: 'transpose=0', 6: 'transpose=1', 7: 'transpose=3', 8: 'transpose=2' };
      // Pad the face a little so it isn't cropped tight on the eyebrows
      const pad = 0.35, side = `max(${f.w}*iw,${f.h}*ih)*${1 + pad * 2}`;
      const cx = `(${f.x}+${f.w}/2)*iw`, cy = `(${f.y}+${f.h}/2)*ih`;
      const crop = `crop='min(${side},min(iw,ih))':'min(${side},min(iw,ih))':'max(0,min(iw-ow,${cx}-ow/2))':'max(0,min(ih-oh,${cy}-oh/2))'`;
      const vf = [ORIENT[orient], crop, 'scale=240:240'].filter(Boolean).join(',');
      cropJobs.set(dest, new Promise(done => execFile('ffmpeg', ['-v', 'error', '-y', '-noautorotate', '-i', f.path, '-frames:v', '1', '-vf', vf, '-q:v', '4', dest], { timeout: 30000 }, () => { cropJobs.delete(dest); done(); })));
    }
    await cropJobs.get(dest);
    if (!fs.existsSync(dest)) return res.status(404).end();
  }
  res.sendFile(dest, { headers: { 'Cache-Control': 'private, max-age=604800' } });
}

function summary() {
  return {
    available, enabled: enabled(), ...status,
    photos: db.prepare("SELECT COUNT(*) AS n FROM items WHERE type = 'photo'").get().n,
    checked: db.prepare("SELECT COUNT(*) AS n FROM items WHERE type = 'photo' AND faces_done > 0").get().n,
    faces: db.prepare('SELECT COUNT(*) AS n FROM faces').get().n,
    people: db.prepare('SELECT COUNT(*) AS n FROM face_people').get().n,
  };
}

module.exports = { run, people, photosOf, facesIn, rename, merge, hide, setFace, setCover, resetAll, thumb, summary, enabled, status };
