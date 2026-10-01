// Library health report: broken files, missing episodes, doubtful matches, missing artwork and duplicates — in one list.
const fs = require('fs');
const path = require('path');
const { db } = require('../db');
const tmdb = require('../tmdb');
const C = require('../common');

const norm = s => String(s || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').trim();
function similarity(a, b) {
  a = norm(a); b = norm(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const A = new Set(a.split(' ')), B = new Set(b.split(' '));
  const shared = [...A].filter(w => B.has(w)).length;
  return shared / Math.max(A.size, B.size);
}

let cache = null, building = null;

async function build() {
  const out = { at: Date.now(), broken: [], missing: [], gaps: [], matches: [], artwork: [], duplicates: [], notes: [] };

  // 1. Files that can't be read, or have disappeared
  for (const r of db.prepare("SELECT i.id, i.type, i.title, i.path, i.size, i.duration, i.probe, i.parent_id, s.title AS show FROM items i LEFT JOIN items s ON s.id = i.parent_id WHERE i.type IN ('movie','episode','home','track') AND i.path IS NOT NULL").iterate()) {
    const name = r.show ? `${r.show} — ${r.title}` : r.title;
    if (!fs.existsSync(r.path)) out.missing.push({ id: r.id, type: r.type, title: name, path: r.path, problem: 'File is missing from disk' });
    else if (!r.size) out.broken.push({ id: r.id, type: r.type, title: name, path: r.path, problem: 'Empty file (0 bytes)' });
    else if (!r.probe || !r.duration) out.broken.push({ id: r.id, type: r.type, title: name, path: r.path, problem: "Couldn't be read — may be damaged or still copying" });
    else {
      try {
        const p = JSON.parse(r.probe);
        if (r.type !== 'track' && !p.video_codec) out.broken.push({ id: r.id, type: r.type, title: name, path: r.path, problem: 'No picture (audio only)' });
        else if (r.type !== 'track' && !(p.audio || []).length) out.broken.push({ id: r.id, type: r.type, title: name, path: r.path, problem: 'No sound track', minor: true });
      } catch {}
    }
  }
  for (const r of db.prepare("SELECT id, title FROM items WHERE type = 'photo' AND faces_done = 2 LIMIT 200").all()) out.broken.push({ id: r.id, type: 'photo', title: r.title, problem: "Photo couldn't be opened" });

  // 2. Matches worth checking (no match at all, or the file name and match disagree)
  for (const r of db.prepare("SELECT i.id, i.type, i.title, i.year, i.tmdb_id, i.path, i.folder_key, i.poster, i.locked FROM items i WHERE i.type IN ('movie','show')").iterate()) {
    const locked = (() => { try { return JSON.parse(r.locked || '[]'); } catch { return []; } })();
    if (!r.tmdb_id) { out.matches.push({ id: r.id, type: r.type, title: r.title, problem: 'Not matched — no poster, cast or description' }); continue; }
    const source = r.type === 'show' ? (r.folder_key || '') : path.basename(path.dirname(r.path)) + ' ' + path.basename(r.path);
    const fromName = require('../parse').parseTitleYear(r.type === 'show' ? r.folder_key || '' : (r.folder_key || '').split('/')[0] || path.basename(r.path));
    if (!locked.includes('title') && fromName.title) {
      const sim = similarity(fromName.title, r.title);
      const yearOff = fromName.year && r.year && Math.abs(fromName.year - r.year) > 1;
      if (sim < 0.34 || yearOff) out.matches.push({ id: r.id, type: r.type, title: r.title, year: r.year, problem: `Matched as “${r.title}${r.year ? ` (${r.year})` : ''}” but the file is “${fromName.title}${fromName.year ? ` (${fromName.year})` : ''}”`, file: source });
    }
    if (!r.poster) out.artwork.push({ id: r.id, type: r.type, title: r.title, problem: 'No poster' });
  }

  // 3. Duplicates (same film more than once)
  for (const d of db.prepare(`SELECT i.tmdb_id, MIN(i.title) AS title, COUNT(*) AS n, SUM(i.size) AS bytes, GROUP_CONCAT(i.id) AS ids FROM items i
    WHERE i.type = 'movie' AND i.tmdb_id IS NOT NULL GROUP BY i.tmdb_id, COALESCE(i.edition, '') HAVING n > 1`).all()) {
    out.duplicates.push({ id: +d.ids.split(',')[0], title: d.title, problem: `${d.n} copies of the same edition (${(d.bytes / 1e9).toFixed(1)} GB in total)`, ids: d.ids.split(',').map(Number) });
  }

  // 4. Missing episodes: gaps in what you have, and (with TMDB) aired episodes you don't have
  const today = new Date().toISOString().slice(0, 10);
  let tmdbOk = !!tmdb.apiKey();
  if (!tmdbOk) out.notes.push('Add a TMDB key in Settings to also check for whole missing seasons and newly aired episodes.');
  for (const show of db.prepare("SELECT id, title, tmdb_id FROM items WHERE type = 'show'").all()) {
    const have = new Map();
    for (const e of db.prepare("SELECT season, episode FROM items WHERE parent_id = ? AND type = 'episode' AND season > 0 AND episode IS NOT NULL").all(show.id)) {
      if (!have.has(e.season)) have.set(e.season, new Set());
      have.get(e.season).add(e.episode);
    }
    const missing = [];
    if (tmdbOk && show.tmdb_id) {
      try {
        for (const s of await tmdb.seasonList(show.tmdb_id)) {
          if (!s.season || !s.airDate || s.airDate > today) continue;
          const eps = (await tmdb.seasonEpisodes(show.tmdb_id, s.season)).filter(e => e.airDate && e.airDate <= today);
          const got = have.get(s.season) || new Set();
          const lack = eps.filter(e => !got.has(e.episode));
          if (lack.length === eps.length && eps.length) missing.push({ season: s.season, all: true, count: eps.length });
          else for (const e of lack) missing.push({ season: s.season, episode: e.episode, title: e.title });
        }
      } catch (e) { if (/401/.test(e.message)) tmdbOk = false; }
    } else {
      for (const [season, set] of have) {
        const max = Math.max(...set);
        for (let n = 1; n < max; n++) if (!set.has(n)) missing.push({ season, episode: n });
      }
    }
    if (missing.length) {
      const wholeSeasons = missing.filter(m => m.all);
      const singles = missing.filter(m => !m.all);
      const parts = [];
      if (wholeSeasons.length) parts.push(`${wholeSeasons.length === 1 ? 'Season' : 'Seasons'} ${wholeSeasons.map(m => m.season).join(', ')}`);
      if (singles.length) parts.push(singles.slice(0, 8).map(m => `S${String(m.season).padStart(2, '0')}E${String(m.episode).padStart(2, '0')}`).join(', ') + (singles.length > 8 ? ` and ${singles.length - 8} more` : ''));
      out.gaps.push({ id: show.id, type: 'show', title: show.title, problem: `Missing ${parts.join(' · ')}`, missing });
    }
  }
  out.summary = {
    broken: out.broken.filter(x => !x.minor).length, missing: out.missing.length, gaps: out.gaps.length, matches: out.matches.length,
    artwork: out.artwork.length, duplicates: out.duplicates.length,
  };
  out.summary.total = out.summary.broken + out.summary.missing + out.summary.gaps + out.summary.matches + out.summary.duplicates;
  return out;
}

async function report({ fresh = false } = {}) {
  if (cache && !fresh && Date.now() - cache.at < 6 * 3600000) return cache;
  if (!building) building = build().then(r => { cache = r; return r; }).finally(() => { building = null; });
  return building;
}
function invalidate() { cache = null; }

module.exports = { report, invalidate, similarity };
