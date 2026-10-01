// "Because you watched…", smart rows, On this day, and viewing stats / Family Wrapped.
const { db } = require('../db');
const C = require('../common');

const { visible, formatItem } = C;

// Pick a few things this profile finished recently to base suggestions on
function seeds(profile, n = 3) {
  return db.prepare(`SELECT COALESCE(s.id, i.id) AS id, MAX(pr.updated_at) AS t FROM progress pr JOIN items i ON i.id = pr.item_id
    LEFT JOIN items s ON s.id = i.parent_id AND i.type = 'episode'
    WHERE pr.profile_id = ? AND (pr.watched = 1 OR pr.position > 600) AND i.type IN ('movie','episode')
    GROUP BY COALESCE(s.id, i.id) ORDER BY t DESC LIMIT ?`).all(profile.id, n).map(r => r.id);
}

function features(id) {
  const it = db.prepare('SELECT id, type, genres, collection_id, vote FROM items WHERE id = ?').get(id);
  if (!it) return null;
  const people = db.prepare("SELECT person_id, role FROM credits WHERE item_id = ? AND (role != 'cast' OR ord < 10)").all(id);
  return { ...it, genres: new Set((it.genres || '').split(', ').filter(Boolean)), cast: new Set(people.filter(p => p.role === 'cast').map(p => p.person_id)),
    crew: new Set(people.filter(p => p.role !== 'cast').map(p => p.person_id)) };
}

// Unwatched movies + shows this profile can see, with what we need to score them
function candidates(profile) {
  const rows = db.prepare(`SELECT i.id, i.type, i.genres, i.collection_id, i.vote FROM items i JOIN libraries l ON l.id = i.library_id
    LEFT JOIN progress pr ON pr.item_id = i.id AND pr.profile_id = ?
    WHERE i.type IN ('movie','show') AND ${visible(profile)} AND ${C.NOT_DUP.replace(/d\.type = 'movie'/g, "d.type = i.type")}
      AND COALESCE(pr.watched, 0) = 0`).all(profile.id);
  const credits = db.prepare("SELECT item_id, person_id, role FROM credits WHERE role != 'cast' OR ord < 10").all();
  const byItem = new Map();
  for (const c of credits) { if (!byItem.has(c.item_id)) byItem.set(c.item_id, []); byItem.get(c.item_id).push(c); }
  const fullyWatchedShows = new Set(db.prepare(`SELECT s.id FROM items s WHERE s.type = 'show' AND NOT EXISTS (SELECT 1 FROM items e
    LEFT JOIN progress p ON p.item_id = e.id AND p.profile_id = ? WHERE e.parent_id = s.id AND COALESCE(p.watched, 0) = 0)`).all(profile.id).map(r => r.id));
  return rows.filter(r => !fullyWatchedShows.has(r.id)).map(r => {
    const ppl = byItem.get(r.id) || [];
    return { ...r, genres: new Set((r.genres || '').split(', ').filter(Boolean)), cast: new Set(ppl.filter(p => p.role === 'cast').map(p => p.person_id)), crew: new Set(ppl.filter(p => p.role !== 'cast').map(p => p.person_id)) };
  });
}

function score(seed, c) {
  let s = 0;
  if (seed.collection_id && seed.collection_id === c.collection_id) s += 6;
  for (const g of c.genres) if (seed.genres.has(g)) s += 2;
  for (const p of c.cast) if (seed.cast.has(p)) s += 1.5;
  for (const p of c.crew) if (seed.crew.has(p)) s += 3;
  if (seed.type === c.type) s += 1;
  if (c.vote) s += (c.vote - 6) * 0.4;
  return s;
}

function becauseYouWatched(profile) {
  const cands = candidates(profile);
  const used = new Set();
  const rows = [];
  for (const id of seeds(profile)) {
    const seed = features(id);
    if (!seed) continue;
    const picks = cands.filter(c => c.id !== id && !used.has(c.id)).map(c => [score(seed, c), c]).filter(([s]) => s >= 3)
      .sort((a, b) => b[0] - a[0]).slice(0, 15).map(([, c]) => c.id);
    if (picks.length < 3) continue;
    picks.forEach(p => used.add(p));
    const title = db.prepare('SELECT title FROM items WHERE id = ?').get(id).title;
    rows.push({ title: `Because you watched ${title}`, items: C.itemsByIds(profile, picks) });
  }
  return rows;
}

// Genre taste from what they've watched and how they rated it
function favouriteGenres(profile) {
  const rows = db.prepare(`SELECT COALESCE(s.genres, i.genres) AS genres, COALESCE(r.rating, 6) AS rating FROM progress pr JOIN items i ON i.id = pr.item_id
    LEFT JOIN items s ON s.id = i.parent_id LEFT JOIN ratings r ON r.profile_id = pr.profile_id AND r.item_id = COALESCE(s.id, i.id)
    WHERE pr.profile_id = ? AND (pr.watched = 1 OR pr.position > 600)`).all(profile.id);
  const w = {};
  for (const r of rows) for (const g of (r.genres || '').split(', ').filter(Boolean)) w[g] = (w[g] || 0) + (r.rating - 4) / 2;
  return Object.entries(w).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).map(([g]) => g);
}

function smartRows(profile) {
  const rows = [];
  const unwatched = '(pr.watched IS NULL OR pr.watched = 0)';
  const short = C.movieList(profile, `${unwatched} AND COALESCE(i.runtime, i.duration / 60) BETWEEN 60 AND 100`, 'RANDOM()', 15);
  if (short.length >= 3) rows.push({ title: 'Short enough for tonight', items: short });
  const fav = favouriteGenres(profile)[0];
  if (fav) {
    const g = C.movieList(profile, `${unwatched} AND (', ' || i.genres || ', ') LIKE ?`, 'i.vote DESC NULLS LAST', 15, [`%, ${fav}, %`]);
    if (g.length >= 3) rows.push({ title: `Unwatched ${fav.toLowerCase()} films`, items: g, link: `#/movies?genre=${encodeURIComponent(fav)}&unwatched=1` });
  }
  const top = C.movieList(profile, `${unwatched} AND i.vote >= 7.5`, 'i.vote DESC', 15);
  if (top.length >= 3) rows.push({ title: "Highly rated — you haven't seen these", items: top });
  const decades = db.prepare(`SELECT (i.year / 10) * 10 AS d, COUNT(*) AS n FROM items i JOIN libraries l ON l.id = i.library_id
    WHERE i.type = 'movie' AND i.year IS NOT NULL AND ${visible(profile)} GROUP BY d HAVING n >= 5 ORDER BY RANDOM() LIMIT 1`).get();
  if (decades) {
    const list = C.movieList(profile, 'i.year BETWEEN ? AND ?', 'RANDOM()', 15, [decades.d, decades.d + 9]);
    rows.push({ title: `Films from the ${String(decades.d).slice(2)}s`, items: list });
  }
  const loved = db.prepare(`SELECT r.item_id FROM ratings r WHERE r.profile_id = ? AND r.rating >= 8 ORDER BY RANDOM() LIMIT 15`).all(profile.id).map(x => x.item_id);
  if (loved.length >= 3) rows.push({ title: 'Your favourites', items: C.itemsByIds(profile, loved) });
  return rows;
}

function onThisDay(profile) {
  const d = new Date();
  const md = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const rows = db.prepare(`SELECT i.* FROM items i JOIN libraries l ON l.id = i.library_id WHERE i.type IN ('photo','home') AND i.taken_at IS NOT NULL
    AND strftime('%m-%d', i.taken_at / 1000, 'unixepoch', 'localtime') = ? AND strftime('%Y', i.taken_at / 1000, 'unixepoch', 'localtime') < ?
    AND ${visible(profile)} ORDER BY i.taken_at DESC LIMIT 40`).all(md, String(d.getFullYear()));
  return rows.map(r => ({ ...formatItem(r), thumb: r.type === 'photo' ? `/api/photo/${r.id}/thumb` : null, yearsAgo: d.getFullYear() - new Date(r.taken_at).getFullYear() }));
}

// ---------- stats / Wrapped ----------
function stats({ profileId = null, year = new Date().getFullYear() }) {
  const from = new Date(year, 0, 1).getTime(), to = new Date(year + 1, 0, 1).getTime();
  const where = `h.started_at >= ${from} AND h.started_at < ${to}` + (profileId ? ` AND h.profile_id = ${profileId | 0}` : '');
  const total = db.prepare(`SELECT COALESCE(SUM(h.seconds), 0) AS s, COUNT(*) AS n FROM history h WHERE ${where}`).get();
  const byMonth = db.prepare(`SELECT CAST(strftime('%m', h.started_at / 1000, 'unixepoch', 'localtime') AS INTEGER) AS m, SUM(h.seconds) AS s FROM history h WHERE ${where} GROUP BY m`).all();
  const byDay = db.prepare(`SELECT CAST(strftime('%w', h.started_at / 1000, 'unixepoch', 'localtime') AS INTEGER) AS d, SUM(h.seconds) AS s FROM history h WHERE ${where} GROUP BY d ORDER BY s DESC`).all();
  const titles = db.prepare(`SELECT COALESCE(s.id, i.id) AS id, COALESCE(s.title, i.title) AS title, COALESCE(s.poster, i.poster) AS poster, COALESCE(s.type, i.type) AS type,
      SUM(h.seconds) AS s, COUNT(DISTINCT i.id) AS parts FROM history h JOIN items i ON i.id = h.item_id LEFT JOIN items s ON s.id = i.parent_id
    WHERE ${where} AND i.type IN ('movie','episode','home') GROUP BY COALESCE(s.id, i.id) ORDER BY s DESC LIMIT 10`).all();
  const genreRows = db.prepare(`SELECT COALESCE(s.genres, i.genres) AS g, h.seconds AS s FROM history h JOIN items i ON i.id = h.item_id LEFT JOIN items s ON s.id = i.parent_id WHERE ${where}`).all();
  const genres = {};
  for (const r of genreRows) for (const g of (r.g || '').split(', ').filter(Boolean)) genres[g] = (genres[g] || 0) + r.s;
  // Longest single-day binge of one show
  const binge = db.prepare(`SELECT s.title, date(h.started_at / 1000, 'unixepoch', 'localtime') AS day, SUM(h.seconds) AS s, COUNT(DISTINCT i.id) AS eps
    FROM history h JOIN items i ON i.id = h.item_id JOIN items s ON s.id = i.parent_id WHERE ${where} AND i.type = 'episode' GROUP BY s.id, day ORDER BY eps DESC, s DESC LIMIT 1`).get();
  const pw = profileId ? `AND p.profile_id = ${profileId | 0}` : '';
  const music = db.prepare(`SELECT i.album_artist AS artist, SUM(p.count) AS plays, MAX(i.poster) AS poster FROM plays p JOIN items i ON i.id = p.item_id
    WHERE i.type = 'track' AND p.last_at >= ${from} ${pw} GROUP BY i.album_artist ORDER BY plays DESC LIMIT 5`).all();
  const people = profileId ? [] : db.prepare(`SELECT pr.id, pr.name, pr.color, COALESCE(SUM(h.seconds), 0) AS s FROM profiles pr LEFT JOIN history h ON h.profile_id = pr.id
    AND h.started_at >= ${from} AND h.started_at < ${to} WHERE pr.hidden = 0 GROUP BY pr.id ORDER BY s DESC`).all();
  const firstWatch = db.prepare(`SELECT h.title, h.started_at FROM history h WHERE ${where} ORDER BY h.started_at LIMIT 1`).get();
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return {
    year, hours: Math.round(total.s / 360) / 10, sessions: total.n,
    months: Array.from({ length: 12 }, (_, i) => Math.round((byMonth.find(m => m.m === i + 1)?.s || 0) / 360) / 10),
    favouriteDay: byDay[0] ? DAYS[byDay[0].d] : null,
    top: titles.map(t => ({ id: t.id, title: t.title, poster: C.img(t.poster), type: t.type, hours: Math.round(t.s / 360) / 10, parts: t.parts })),
    genres: Object.entries(genres).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, s]) => ({ name, hours: Math.round(s / 360) / 10 })),
    binge: binge ? { show: binge.title, day: binge.day, episodes: binge.eps, hours: Math.round(binge.s / 360) / 10 } : null,
    music: music.map(m => ({ artist: m.artist, plays: m.plays, poster: C.img(m.poster) })),
    people: people.map(p => ({ id: p.id, name: p.name, color: p.color, hours: Math.round(p.s / 360) / 10 })),
    first: firstWatch || null,
  };
}

module.exports = { becauseYouWatched, smartRows, onThisDay, stats, favouriteGenres };
