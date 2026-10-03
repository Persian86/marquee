// Finds TV intros by matching the audio fingerprint of neighbouring episodes in a season.
// Chapters named "Intro"/"Opening"/"Credits" are used first when the file has them.
const { spawn, execFileSync } = require('child_process');
const bg = require('./background');
const { db } = require('../db');

const POINT = 0.1238;          // seconds per chromaprint point
const MIN_INTRO = 12;          // seconds
const MAX_INTRO = 150;
const MAX_GAP = 28;            // points (~3.5s) of mismatch tolerated inside a match
let HAS_CHROMAPRINT = false;
try { HAS_CHROMAPRINT = /chromaprint/.test(execFileSync('ffmpeg', ['-hide_banner', '-muxers'], { encoding: 'utf8' })); } catch {}

const status = { running: false, done: 0, total: 0 };

function fingerprint(file, seconds, offset = 0) {
  return new Promise(resolve => {
    const p = bg.spawnLow('ffmpeg', ['-v', 'error', ...(offset > 0 ? ['-ss', String(offset)] : []), '-t', String(seconds), '-i', file, '-vn', '-sn', '-ac', '1', '-f', 'chromaprint', '-fp_format', 'raw', '-'], { stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks = [];
    p.stdout.on('data', d => chunks.push(d));
    const timer = setTimeout(() => p.kill('SIGKILL'), 180000);
    p.on('close', code => {
      clearTimeout(timer);
      const buf = Buffer.concat(chunks);
      if (code !== 0 || buf.length < 8) return resolve(null);
      const out = new Uint32Array(buf.length >> 2);
      for (let i = 0; i < out.length; i++) out[i] = buf.readUInt32LE(i * 4);
      resolve(out);
    });
  });
}

function popcount(x) {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

// Longest stretch where a[i] ≈ b[i + shift]
function bestMatch(a, b, minSecs = MIN_INTRO, maxSecs = MAX_INTRO) {
  // Candidate shifts from exact matches (fast), then check each properly
  const index = new Map();
  for (let j = 0; j < b.length; j++) {
    const k = b[j] >>> 12;
    let list = index.get(k);
    if (!list) index.set(k, list = []);
    if (list.length < 40) list.push(j);
  }
  const votes = new Map();
  for (let i = 0; i < a.length; i++) {
    const list = index.get(a[i] >>> 12);
    if (list) for (const j of list) votes.set(j - i, (votes.get(j - i) || 0) + 1);
  }
  const shifts = [...votes.entries()].sort((x, y) => y[1] - x[1]).slice(0, 12).map(x => x[0]);
  let best = null;
  for (const shift of shifts) {
    let runStart = -1, lastGood = -1;
    const lo = Math.max(0, -shift), hi = Math.min(a.length, b.length - shift);
    for (let i = lo; i <= hi; i++) {
      const good = i < hi && popcount(a[i] ^ b[i + shift]) <= 6;
      if (good) {
        if (runStart < 0) runStart = i;
        lastGood = i;
      } else if (runStart >= 0 && (i - lastGood > MAX_GAP || i === hi)) {
        const len = lastGood - runStart + 1;
        if (!best || len > best.len) best = { len, aStart: runStart, bStart: runStart + shift };
        runStart = -1;
      }
    }
  }
  if (!best) return null;
  const secs = best.len * POINT;
  if (secs < minSecs || secs > maxSecs) return null;
  return { a: [best.aStart * POINT, (best.aStart + best.len) * POINT], b: [best.bStart * POINT, (best.bStart + best.len) * POINT] };
}

// How much of a (a recap) appears anywhere in b (earlier episodes): returns covered [start, end] seconds of a, or null
function coverage(a, b, minRunSecs = 2.5) {
  const index = new Map();
  for (let j = 0; j < b.length; j++) { const k = b[j] >>> 12; let l = index.get(k); if (!l) index.set(k, l = []); if (l.length < 60) l.push(j); }
  const votes = new Map();
  for (let i = 0; i < a.length; i++) { const l = index.get(a[i] >>> 12); if (l) for (const j of l) votes.set(j - i, (votes.get(j - i) || 0) + 1); }
  const shifts = [...votes.entries()].filter(v => v[1] >= 6).sort((x, y) => y[1] - x[1]).slice(0, 40).map(x => x[0]);
  const covered = new Uint8Array(a.length);
  const minRun = Math.round(minRunSecs / POINT);
  for (const shift of shifts) {
    let run = 0;
    for (let i = Math.max(0, -shift); i < Math.min(a.length, b.length - shift); i++) {
      if (popcount(a[i] ^ b[i + shift]) <= 6) run++;
      else { if (run >= minRun) covered.fill(1, i - run, i); run = 0; }
    }
    if (run >= minRun) covered.fill(1, Math.min(a.length, b.length - shift) - run, Math.min(a.length, b.length - shift));
  }
  const total = covered.reduce((x, y) => x + y, 0);
  if (total * POINT < 8 || total / a.length < 0.3) return null;
  const first = covered.indexOf(1), last = covered.lastIndexOf(1);
  return [first * POINT, (last + 1) * POINT];
}

function fromChapters(probeJson) {
  let p;
  try { p = JSON.parse(probeJson || '{}'); } catch { return {}; }
  const out = {};
  for (const c of p.chapters || []) {
    if (/^(intro|opening|op|opening credits|theme)\b/i.test(c.title) && c.end - c.start < 300) { out.intro = [c.start, c.end]; }
    if (/^(credits|ending|ed|end credits|outro)\b/i.test(c.title)) out.credits = c.start;
    if (/^(recap|previously)\b/i.test(c.title)) out.recap = [c.start, c.end];
  }
  return out;
}

function save(id, f) {
  const intro = f.intro, recap = f.recap;
  db.prepare('UPDATE items SET intro_start = ?, intro_end = ?, credits_start = COALESCE(?, credits_start), recap_start = ?, recap_end = ?, intro_done = 1 WHERE id = ?')
    .run(intro ? Math.max(0, intro[0] < 1.5 ? 0 : intro[0]) : null, intro ? intro[1] : null, f.credits ?? null,
      recap ? Math.max(0, recap[0] < 1.5 ? 0 : recap[0]) : null, recap ? recap[1] : null, id);
}

async function detectAll() {
  if (status.running) return;
  status.running = true;
  try {
    const seasons = db.prepare(`SELECT DISTINCT parent_id, season FROM items WHERE type = 'episode' AND intro_done = 0`).all();
    status.total = seasons.length; status.done = 0;
    for (const s of seasons) {
      await bg.idle(); // never while someone is watching or browsing
      status.done++;
      const eps = db.prepare(`SELECT id, path, duration, probe, intro_done FROM items WHERE type = 'episode' AND parent_id = ? AND season IS ?
        ORDER BY episode, sort_title`).all(s.parent_id, s.season);
      const found = new Map();
      // 1. chapters
      for (const e of eps) {
        const ch = fromChapters(e.probe);
        if (ch.intro || ch.credits || ch.recap) found.set(e.id, { intro: ch.intro || null, credits: ch.credits ?? null, recap: ch.recap || null, chapter: true });
      }
      // 2. audio fingerprints against the neighbouring episode
      if (HAS_CHROMAPRINT && eps.length >= 2) {
        const prints = new Map();
        const getPrint = async e => {
          if (!prints.has(e.id)) prints.set(e.id, await fingerprint(e.path, Math.min(600, Math.max(60, (e.duration || 1200) * 0.3))));
          return prints.get(e.id);
        };
        for (let i = 0; i < eps.length; i++) {
          const e = eps[i];
          if (found.get(e.id)?.intro) continue;
          const neighbours = [eps[i + 1], eps[i - 1], eps[i + 2], eps[i - 2]].filter(Boolean);
          const pa = await getPrint(e);
          if (!pa) continue;
          for (const n of neighbours) {
            const pb = await getPrint(n);
            if (!pb) continue;
            const m = bestMatch(pa, pb);
            if (m) {
              found.set(e.id, { ...(found.get(e.id) || {}), intro: m.a });
              if (!found.get(n.id)?.intro) found.set(n.id, { ...(found.get(n.id) || {}), intro: m.b });
              break;
            }
          }
          // Free memory for episodes we're done comparing
          if (i >= 2) prints.delete(eps[i - 2].id);
        }
      }
      // 3. end credits: the same music at the end of neighbouring episodes
      if (HAS_CHROMAPRINT && eps.length >= 2) {
        const tails = new Map();
        const tailLen = e => Math.min(420, Math.max(60, (e.duration || 1200) * 0.25));
        const getTail = async e => {
          if (!tails.has(e.id)) tails.set(e.id, e.duration ? await fingerprint(e.path, tailLen(e), e.duration - tailLen(e)) : null);
          return tails.get(e.id);
        };
        for (let i = 0; i < eps.length; i++) {
          const e = eps[i];
          if (found.get(e.id)?.credits != null || !e.duration) continue;
          const ta = await getTail(e);
          if (!ta) continue;
          for (const n of [eps[i + 1], eps[i - 1]].filter(Boolean)) {
            const tb = await getTail(n);
            if (!tb || !n.duration) continue;
            const m = bestMatch(ta, tb, 15, 600);
            if (m) {
              found.set(e.id, { ...(found.get(e.id) || {}), credits: e.duration - tailLen(e) + m.a[0] });
              if (found.get(n.id)?.credits == null) found.set(n.id, { ...(found.get(n.id) || {}), credits: n.duration - tailLen(n) + m.b[0] });
              break;
            }
          }
          if (i >= 2) tails.delete(eps[i - 2].id);
        }
      }
      // 4. "Previously on…": the part before the intro that reuses audio from the previous episode
      if (HAS_CHROMAPRINT) {
        for (let i = 1; i < eps.length; i++) {
          const e = eps[i], f = found.get(e.id);
          if (!f?.intro || f.recap || f.intro[0] < 20) continue;
          const pre = await fingerprint(e.path, f.intro[0]);
          const prev = await fingerprint(eps[i - 1].path, Math.min(3600, eps[i - 1].duration || 3600));
          if (!pre || !prev) continue;
          const c = coverage(pre, prev);
          if (c && c[0] < 15) found.set(e.id, { ...f, recap: [c[0], Math.min(f.intro[0], c[1] + 1)] });
        }
      }
      for (const e of eps) {
        if (e.intro_done) continue;
        save(e.id, found.get(e.id) || {});
      }
    }
  } catch (e) {
    console.error('Intro detection failed:', e);
  } finally {
    status.running = false;
  }
}

module.exports = { detectAll, status, bestMatch, coverage, fingerprint, HAS_CHROMAPRINT };
