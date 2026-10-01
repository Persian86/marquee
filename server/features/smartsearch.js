// Plain-English search: "funny movies under 90 minutes", "80s action with Arnold", "something like Moana".
// Works on its own with built-in rules. Optionally uses an AI model to understand trickier requests —
// either a local one on your network (Ollama, nothing leaves the house) or Claude with your own API key.
const { db, getSetting } = require('../db');
const C = require('../common');

// Words people use → TMDB genre names (movies and TV use slightly different names)
const GENRE_WORDS = [
  [/\b(funny|comed(y|ies)|laugh|hilarious|silly|lighthearted)\b/, ['Comedy']],
  [/\b(scary|horror|spooky|frightening|creepy|terrifying)\b/, ['Horror']],
  [/\b(action|explosions?|fight(ing)?|shoot ?em ?up)\b/, ['Action', 'Action & Adventure']],
  [/\b(animated|animation|cartoons?|pixar|anime)\b/, ['Animation']],
  [/\b(romantic|romance|love stor(y|ies)|rom ?com)\b/, ['Romance']],
  [/\b(sci ?fi|science fiction|space|aliens?|futuristic|robots?)\b/, ['Science Fiction', 'Sci-Fi & Fantasy']],
  [/\b(family|for the kids|kids|children s|for children)\b/, ['Family', 'Kids']],
  [/\b(thriller|suspense|edge of (my|your) seat|tense)\b/, ['Thriller']],
  [/\b(myster(y|ies)|whodunn?it|detective)\b/, ['Mystery']],
  [/\b(documentar(y|ies)|true stor(y|ies)|real life)\b/, ['Documentary']],
  [/\b(fantasy|magic(al)?|dragons?|wizards?)\b/, ['Fantasy', 'Sci-Fi & Fantasy']],
  [/\b(adventure|quest|treasure)\b/, ['Adventure', 'Action & Adventure']],
  [/\b(drama|sad|tear ?jerker|emotional|moving)\b/, ['Drama']],
  [/\b(crime|heist|gangsters?|mob|mafia)\b/, ['Crime']],
  [/\b(war|soldiers?|battle)\b/, ['War', 'War & Politics']],
  [/\b(western|cowboys?)\b/, ['Western']],
  [/\b(musical|music|singing)\b/, ['Music']],
  [/\b(histor(y|ical)|period piece|based on history)\b/, ['History']],
];
const STOP = new Set('a an the and or of for to in on with without me us i we my our some something anything find show give want watch movie movies film films show shows tv series that is are be it its from about like good great please can you get have has had some any one ones what which really very bit kind sort tonight now today'.split(' '));

function parseRules(text) {
  const t = ` ${String(text).toLowerCase().replace(/[’']/g, ' ').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ')} `;
  const f = { genres: [], keywords: [], people: [], chips: [] };
  let rest = t;
  const eat = re => { rest = rest.replace(re, ' '); };

  // "like Moana" / "similar to Shrek"
  let m = /\b(?:like|similar to|same as|in the style of)\s+(.+)$/.exec(t);
  if (m) { f.similarTo = m[1].trim(); eat(/\b(?:like|similar to|same as|in the style of)\s+.+$/); }
  // People
  m = /\b(?:with|starring|featuring|directed by|by)\s+([a-z][a-z.-]+(?:\s+[a-z][a-z.-]+){0,2})\b/.exec(rest);
  if (m && !/^(the|a|my|kids|family|subtitles)\b/.test(m[1])) { f.people.push(m[1].trim()); eat(m[0]); f.chips.push(`With ${title(m[1])}`); }
  // Type
  if (/\b(tv shows?|series|shows?|tv)\b/.test(rest) && !/\bmovies?|films?\b/.test(rest)) { f.type = 'show'; f.chips.push('TV shows'); }
  else if (/\b(movies?|films?)\b/.test(rest)) f.type = 'movie';
  // Genres
  for (const [re, gs] of GENRE_WORDS) if (re.test(rest)) { f.genres.push(gs); f.chips.push(gs[0]); rest = rest.replace(re, ' '); }
  // Length
  if ((m = /\b(?:under|less than|shorter than|no more than|max(?:imum)?|within)\s+(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m)\b/.exec(rest))) {
    f.maxRuntime = Math.round(+m[1] * (/^h/.test(m[2]) ? 60 : 1)); eat(m[0]); f.chips.push(`Under ${fmtMins(f.maxRuntime)}`);
  } else if ((m = /\b(?:over|more than|longer than|at least)\s+(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m)\b/.exec(rest))) {
    f.minRuntime = Math.round(+m[1] * (/^h/.test(m[2]) ? 60 : 1)); eat(m[0]); f.chips.push(`Over ${fmtMins(f.minRuntime)}`);
  } else if (/\b(short|quick)\b/.test(rest)) { f.maxRuntime = 95; eat(/\b(short|quick)\b/g); f.chips.push('Short'); }
  else if (/\b(long|epic)\b/.test(rest)) { f.minRuntime = 140; eat(/\b(long|epic)\b/g); f.chips.push('Long'); }
  // Era
  if ((m = /\b(?:19|20)?(\d)0 ?s\b|\b(eighties|nineties|seventies|sixties|fifties)\b/.exec(rest))) {
    const words = { fifties: 5, sixties: 6, seventies: 7, eighties: 8, nineties: 9 };
    const d = m[2] ? words[m[2]] : +m[1];
    const full = /\b20\d0 ?s\b/.test(m[0]) || d <= 2 ? 2000 + d * 10 : 1900 + d * 10;
    f.yearFrom = full; f.yearTo = full + 9; eat(m[0]); f.chips.push(`${full}s`);
  } else if ((m = /\b(?:from|in|made in|released in)\s+((?:19|20)\d\d)\b/.exec(rest))) { f.yearFrom = f.yearTo = +m[1]; eat(m[0]); f.chips.push(m[1]); }
  else if ((m = /\b(?:before|older than|pre)\s+((?:19|20)\d\d)\b/.exec(rest))) { f.yearTo = +m[1] - 1; eat(m[0]); f.chips.push(`Before ${m[1]}`); }
  else if ((m = /\b(?:after|since|newer than|post)\s+((?:19|20)\d\d)\b/.exec(rest))) { f.yearFrom = +m[1] + 1; eat(m[0]); f.chips.push(`After ${m[1]}`); }
  else if (/\b(new|recent|latest|newest)\b/.test(rest)) { f.yearFrom = new Date().getFullYear() - 3; eat(/\b(new|recent|latest|newest)\b/); f.chips.push('Recent'); }
  else if (/\b(old|classic|oldies|retro)\b/.test(rest)) { f.yearTo = 1990; eat(/\b(old|classic|oldies|retro)\b/); f.chips.push('Classic'); }
  // Quality & suitability
  if (/\b(highly rated|top rated|best|acclaimed|award winning|great|good)\b/.test(rest)) { f.minVote = 7.3; eat(/\b(highly rated|top rated|best|acclaimed|award winning|great|good)\b/); f.chips.push('Highly rated'); }
  if (/\b(kid friendly|kids friendly|family friendly|for (the )?kids|for children|g rated|pg)\b/.test(rest) || f.genres.some(g => g.includes('Kids'))) { f.kids = true; eat(/\b(kid friendly|kids friendly|family friendly|for (the )?kids|for children|g rated|pg)\b/); f.chips.push('Kid friendly'); }
  if (/\b(haven t (seen|watched)|not (seen|watched)|unwatched|new to (me|us)|never seen)\b/.test(rest)) { f.unwatched = true; eat(/\b(haven t (seen|watched)|not (seen|watched)|unwatched|new to (me|us)|never seen)\b/); f.chips.push('Not watched yet'); }
  if (/\b(rewatch|again|watched before|favourites?|favorites?)\b/.test(rest)) { f.watched = true; eat(/\b(rewatch|again|watched before|favourites?|favorites?)\b/); f.chips.push('Watched before'); }
  // Whatever is left: search titles and descriptions for it ("dinosaurs", "christmas")
  f.keywords = rest.split(' ').map(w => w.trim()).filter(w => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w));
  for (const k of f.keywords) f.chips.push(`“${k}”`);
  if (f.similarTo) f.chips.push(`Like ${title(f.similarTo)}`);
  return f;
}
const title = s => s.replace(/\b\w/g, c => c.toUpperCase());
const fmtMins = m => (m % 60 === 0 && m >= 60 ? `${m / 60} hour${m === 60 ? '' : 's'}` : `${m} min`);

// ---------- optional AI understanding ----------
function aiConfig() {
  const provider = getSetting('ai_provider', 'none');
  if (provider === 'ollama' && getSetting('ollama_url')) return { provider, url: getSetting('ollama_url').replace(/\/$/, ''), model: getSetting('ollama_model', 'llama3.2') };
  if (provider === 'anthropic' && getSetting('anthropic_key')) return { provider, key: getSetting('anthropic_key'), model: getSetting('anthropic_model', 'claude-haiku-4-5-20251001') };
  return null;
}
const SCHEMA_HELP = `Reply with ONLY a JSON object, no prose. Keys (all optional): "type" ("movie"|"show"), "genres" (array, choose only from the list given),
"maxRuntime" (minutes), "minRuntime", "yearFrom", "yearTo", "minVote" (0-10), "kids" (true for child-friendly), "unwatched" (true),
"people" (actor or director names), "similarTo" (a title), "keywords" (1-3 topic words like "dinosaurs" or "christmas").`;
async function parseAI(text, genres) {
  const cfg = aiConfig();
  if (!cfg) return null;
  const prompt = `Turn this request for something to watch into search filters.\nAvailable genres: ${genres.join(', ')}.\n${SCHEMA_HELP}\nRequest: "${String(text).slice(0, 300)}"`;
  let out;
  if (cfg.provider === 'ollama') {
    const r = await fetch(`${cfg.url}/api/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(20000),
      body: JSON.stringify({ model: cfg.model, prompt, stream: false, format: 'json', options: { temperature: 0 } }) });
    if (!r.ok) throw new Error(`Ollama ${r.status}`);
    out = (await r.json()).response;
  } else {
    const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', signal: AbortSignal.timeout(20000),
      headers: { 'content-type': 'application/json', 'x-api-key': cfg.key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: cfg.model, max_tokens: 300, messages: [{ role: 'user', content: prompt }] }) });
    if (!r.ok) throw new Error(`Claude ${r.status}`);
    out = (await r.json()).content?.[0]?.text;
  }
  const json = JSON.parse(String(out).slice(String(out).indexOf('{'), String(out).lastIndexOf('}') + 1));
  const f = { genres: [], keywords: [], people: [], chips: [] };
  if (json.type === 'movie' || json.type === 'show') { f.type = json.type; if (json.type === 'show') f.chips.push('TV shows'); }
  for (const g of [].concat(json.genres || [])) if (genres.includes(g)) { f.genres.push([g]); f.chips.push(g); }
  for (const k of ['maxRuntime', 'minRuntime', 'yearFrom', 'yearTo', 'minVote']) if (isFinite(+json[k]) && json[k] != null && json[k] !== '') f[k] = +json[k];
  if (f.maxRuntime) f.chips.push(`Under ${fmtMins(f.maxRuntime)}`);
  if (f.minRuntime) f.chips.push(`Over ${fmtMins(f.minRuntime)}`);
  if (f.yearFrom || f.yearTo) f.chips.push(f.yearFrom && f.yearTo ? (f.yearFrom === f.yearTo ? `${f.yearFrom}` : `${f.yearFrom}–${f.yearTo}`) : f.yearFrom ? `After ${f.yearFrom - 1}` : `Before ${f.yearTo + 1}`);
  if (f.minVote) f.chips.push('Highly rated');
  if (json.kids) { f.kids = true; f.chips.push('Kid friendly'); }
  if (json.unwatched) { f.unwatched = true; f.chips.push('Not watched yet'); }
  for (const p of [].concat(json.people || []).slice(0, 2)) { f.people.push(String(p)); f.chips.push(`With ${p}`); }
  if (json.similarTo) { f.similarTo = String(json.similarTo); f.chips.push(`Like ${json.similarTo}`); }
  for (const k of [].concat(json.keywords || []).slice(0, 3)) { f.keywords.push(String(k).toLowerCase()); f.chips.push(`“${k}”`); }
  return f;
}

function libraryGenres(profile) {
  const set = new Set();
  for (const r of db.prepare(`SELECT i.genres FROM items i JOIN libraries l ON l.id = i.library_id WHERE i.type IN ('movie','show') AND i.genres IS NOT NULL AND ${C.visible(profile)}`).all()) {
    for (const g of r.genres.split(', ')) set.add(g);
  }
  return [...set].sort();
}

// ---------- run the filters ----------
function run(profile, f, limit) {
  const where = [], params = [];
  if (f.genres.length) {
    for (const alts of f.genres) {
      where.push(`(${alts.map(() => `(', ' || COALESCE(i.genres, '') || ', ') LIKE ?`).join(' OR ')})`);
      params.push(...alts.map(g => `%, ${g}, %`));
    }
  }
  const mins = "COALESCE(i.runtime, i.duration / 60.0)";
  if (f.maxRuntime) where.push(`${mins} <= ${+f.maxRuntime}`);
  if (f.minRuntime) where.push(`${mins} >= ${+f.minRuntime}`);
  if (f.yearFrom) where.push(`i.year >= ${f.yearFrom | 0}`);
  if (f.yearTo) where.push(`i.year <= ${f.yearTo | 0}`);
  if (f.minVote) where.push(`i.vote >= ${+f.minVote}`);
  if (f.kids) where.push('(i.level IS NOT NULL AND i.level <= 1)');
  for (const name of f.people) {
    where.push(`i.id IN (SELECT c.item_id FROM credits c JOIN people pe ON pe.id = c.person_id WHERE pe.name LIKE ?)`);
    params.push(`%${name.replace(/[%_]/g, '')}%`);
  }
  for (const k of f.keywords) {
    where.push('(i.title LIKE ? OR i.overview LIKE ? OR i.tagline LIKE ?)');
    params.push(`%${k}%`, `%${k}%`, `%${k}%`);
  }
  let similar = null;
  if (f.similarTo) {
    const assistant = require('./assistant');
    similar = assistant.findTitle(profile, f.similarTo);
  }
  const w = where.join(' AND ') || '1=1';
  let movies = f.type === 'show' ? [] : C.movieList(profile, w, 'COALESCE(i.vote, 0) DESC', 400, params);
  let shows = f.type === 'movie' ? [] : C.showList(profile, w, 'COALESCE(i.vote, 0) DESC', 400, params);
  if (f.unwatched) { movies = movies.filter(m => !m.progress?.watched); shows = shows.filter(s => s.unwatched > 0); }
  if (f.watched) { movies = movies.filter(m => m.progress?.watched); shows = shows.filter(s => s.unwatched < s.episodeCount); }
  let items = [...movies, ...shows];
  if (similar) items = rankSimilar(profile, similar, items.filter(i => i.id !== similar.id));
  else items.sort((a, b) => (b.vote || 0) - (a.vote || 0));
  return { items: items.slice(0, limit), similarTo: similar ? { id: similar.id, title: similar.title } : null };
}

// "Like Moana": shared genres, cast and directors, same collection, similar era, and rating
function rankSimilar(profile, base, items) {
  const b = db.prepare('SELECT * FROM items WHERE id = ?').get(base.id);
  const bGenres = new Set((b.genres || '').split(', ').filter(Boolean));
  const bPeople = new Set(db.prepare('SELECT person_id FROM credits WHERE item_id = ?').all(b.id).map(x => x.person_id));
  const scored = items.map(it => {
    const row = db.prepare('SELECT genres, collection_id, year, level FROM items WHERE id = ?').get(it.id);
    const g = (row.genres || '').split(', ').filter(Boolean);
    let score = g.filter(x => bGenres.has(x)).length * 3 - Math.max(0, g.length - bGenres.size) * 0.3;
    if (bPeople.size) score += db.prepare(`SELECT COUNT(*) AS n FROM credits WHERE item_id = ? AND person_id IN (${[...bPeople].map(n => n | 0).join(',')})`).get(it.id).n * 2;
    if (b.collection_id && row.collection_id === b.collection_id) score += 6;
    if (b.year && row.year) score -= Math.min(3, Math.abs(b.year - row.year) / 10);
    if (b.level != null && row.level != null) score -= Math.abs(b.level - row.level) * 1.5;
    score += (it.vote || 6) / 5;
    if (it.type !== (b.type === 'show' ? 'show' : 'movie')) score -= 1;
    return { it, score };
  });
  return scored.filter(s => s.score > 1).sort((a, b2) => b2.score - a.score).map(s => s.it);
}

async function search(profile, text, { limit = 60 } = {}) {
  const q = String(text || '').trim();
  if (!q) return { query: q, chips: [], items: [], used: 'rules' };
  let f = null, used = 'rules', aiError = null;
  if (aiConfig()) {
    try { f = await parseAI(q, libraryGenres(profile)); used = 'ai'; } catch (e) { aiError = e.message; }
  }
  if (!f) f = parseRules(q);
  let out = run(profile, f, limit);
  // Nothing matched every filter: relax the loosest ones and say so
  let relaxed = false;
  if (!out.items.length && (f.keywords.length || f.minVote)) { out = run(profile, { ...f, keywords: [], minVote: null }, limit); relaxed = out.items.length > 0; }
  if (!out.items.length && f.genres.length > 1) { out = run(profile, { ...f, genres: f.genres.slice(0, 1), keywords: [], minVote: null }, limit); relaxed = out.items.length > 0; }
  return { query: q, chips: f.chips, items: out.items, similarTo: out.similarTo, used, relaxed, aiError };
}

// Does this look like a description rather than a title? ("funny movies" vs "Frozen")
function looksNatural(text) {
  const t = String(text).toLowerCase();
  return t.split(/\s+/).length >= 2 && (GENRE_WORDS.some(([re]) => re.test(t)) || /\b(under|over|like|similar|with|starring|from|before|after|\d0s|short|long|kids|family|something|haven'?t|best|rated)\b/.test(t));
}

module.exports = { search, parseRules, looksNatural, aiConfig };
