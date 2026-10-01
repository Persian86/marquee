// Metadata from The Movie Database (free API key from themoviedb.org)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { CONFIG_DIR, TMDB_API_KEY } = require('./config');
const { getSetting } = require('./db');

const IMG_DIR = path.join(CONFIG_DIR, 'images');
fs.mkdirSync(IMG_DIR, { recursive: true });

// Classification -> numeric level. 0 = everyone, 1 = PG, 2 = teen/M, 3 = MA15+/R, 4 = adults only
const LEVELS = {
  // Australia
  'E': 0, 'G': 0, 'P': 0, 'C': 0, 'PG': 1, 'M': 2, 'MA15+': 3, 'MA 15+': 3, 'R18+': 4, 'R 18+': 4, 'X18+': 4, 'AV15+': 3,
  // US film
  'PG-13': 2, 'R': 3, 'NC-17': 4,
  // US TV
  'TV-Y': 0, 'TV-Y7': 0, 'TV-Y7-FV': 0, 'TV-G': 0, 'TV-PG': 1, 'TV-14': 2, 'TV-MA': 3,
  // UK
  'U': 0, '12': 2, '12A': 2, '15': 3, '18': 4, 'R18': 4,
};
const LEVEL_NAMES = ['All ages (G)', 'Up to PG', 'Up to M / PG-13', 'Up to MA15+ / R', 'Everything'];
const PREFERRED_REGIONS = ['AU', 'US', 'GB'];

function levelFor(cert) {
  if (!cert) return null;
  const c = cert.trim().toUpperCase();
  return Object.prototype.hasOwnProperty.call(LEVELS, c) ? LEVELS[c] : null;
}

function apiKey() {
  return (getSetting('tmdb_api_key') || TMDB_API_KEY || '').trim();
}

async function tmdb(endpoint, params = {}) {
  const key = apiKey();
  if (!key) throw new Error('No TMDB API key');
  const url = new URL('https://api.themoviedb.org/3' + endpoint);
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') url.searchParams.set(k, v);
  const headers = { accept: 'application/json' };
  if (key.startsWith('eyJ')) headers.authorization = 'Bearer ' + key; // v4 read token
  else url.searchParams.set('api_key', key);
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
    if (res.status === 429) { await new Promise(r => setTimeout(r, 1500 * (attempt + 1))); continue; }
    if (!res.ok) throw new Error(`TMDB ${res.status} on ${endpoint}`);
    return res.json();
  }
  throw new Error('TMDB rate limited');
}

async function testKey() {
  await tmdb('/configuration');
  return true;
}

// Download a TMDB image into the local cache, return the cached file name
async function cacheImage(tmdbPath, size) {
  if (!tmdbPath) return null;
  const name = crypto.createHash('sha1').update(size + tmdbPath).digest('hex').slice(0, 20) + '.jpg';
  const dest = path.join(IMG_DIR, name);
  if (fs.existsSync(dest)) return name;
  try {
    const res = await fetch(`https://image.tmdb.org/t/p/${size}${tmdbPath}`, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) return null;
    fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
    return name;
  } catch { return null; }
}

// Copy artwork that sits next to the media (poster.jpg, fanart.jpg …) into the cache
function cacheLocalImage(file) {
  try {
    const st = fs.statSync(file);
    const name = crypto.createHash('sha1').update(file + st.mtimeMs).digest('hex').slice(0, 20) + path.extname(file).toLowerCase();
    const dest = path.join(IMG_DIR, name);
    if (!fs.existsSync(dest)) fs.copyFileSync(file, dest);
    return name;
  } catch { return null; }
}

function pickCert(list, getCert) {
  for (const region of PREFERRED_REGIONS) {
    const entry = list.find(r => r.iso_3166_1 === region);
    const cert = entry && getCert(entry);
    if (cert) return cert;
  }
  return null;
}

async function lookupMovie(title, year) {
  let res = await tmdb('/search/movie', { query: title, year, include_adult: 'false' });
  if (!res.results.length && year) res = await tmdb('/search/movie', { query: title, include_adult: 'false' });
  if (!res.results.length) return null;
  return movieDetails(res.results[0].id, year);
}

async function movieDetails(id, year) {
  const d = await tmdb(`/movie/${id}`, { append_to_response: 'release_dates,credits,videos' });
  const cert = pickCert(d.release_dates?.results || [], r => {
    const withCert = (r.release_dates || []).filter(x => x.certification);
    const theatrical = withCert.find(x => x.type === 3) || withCert[0];
    return theatrical && theatrical.certification;
  });
  return {
    tmdb_id: d.id,
    imdb_id: d.imdb_id || null,
    title: d.title,
    year: d.release_date ? parseInt(d.release_date.slice(0, 4), 10) : year,
    overview: d.overview,
    tagline: d.tagline,
    vote: d.vote_average,
    runtime: d.runtime,
    genres: (d.genres || []).map(g => g.name).join(', '),
    certification: cert,
    level: levelFor(cert),
    poster: await cacheImage(d.poster_path, 'w500'),
    backdrop: await cacheImage(d.backdrop_path, 'w1280'),
    collection: d.belongs_to_collection ? {
      id: d.belongs_to_collection.id, name: d.belongs_to_collection.name,
      poster: d.belongs_to_collection.poster_path ? 'tmdb/w500' + d.belongs_to_collection.poster_path : null,
      backdrop: d.belongs_to_collection.backdrop_path ? 'tmdb/w1280' + d.belongs_to_collection.backdrop_path : null,
    } : null,
    people: extractPeople(d.credits, (d.credits?.crew || []).filter(c => c.job === 'Director'), 'director'),
    trailer: pickTrailer(d.videos),
  };
}

function extractPeople(credits, crew, crewRole) {
  const out = [];
  for (const c of (credits?.cast || []).slice(0, 18)) out.push({ id: c.id, name: c.name, photo: c.profile_path, role: 'cast', character: c.character, ord: c.order });
  for (const c of crew || []) out.push({ id: c.id, name: c.name, photo: c.profile_path, role: crewRole, character: null, ord: 0 });
  return out;
}

function pickTrailer(videos) {
  const list = (videos?.results || []).filter(v => v.site === 'YouTube' && /Trailer|Teaser/.test(v.type));
  const best = list.find(v => v.type === 'Trailer' && v.official) || list.find(v => v.type === 'Trailer') || list[0];
  return best ? best.key : null;
}

// Fetch a TMDB image the first time it's asked for ("tmdb/w185/abc.jpg"), then serve from cache
async function cacheTmdbPath(rel) {
  const m = rel.match(/^tmdb\/(w\d+|original)(\/[A-Za-z0-9_.-]+)$/);
  if (!m) return null;
  return cacheImage(m[2], m[1]);
}

async function lookupShow(title, year) {
  let res = await tmdb('/search/tv', { query: title, first_air_date_year: year });
  if (!res.results.length && year) res = await tmdb('/search/tv', { query: title });
  if (!res.results.length) return null;
  return showDetails(res.results[0].id, year);
}

async function search(kind, query) {
  const res = await tmdb(kind === 'show' ? '/search/tv' : '/search/movie', { query, include_adult: 'false' });
  return res.results.slice(0, 12).map(r => ({
    tmdb_id: r.id,
    title: r.title || r.name,
    year: (r.release_date || r.first_air_date || '').slice(0, 4),
    overview: r.overview,
    poster: r.poster_path ? `https://image.tmdb.org/t/p/w185${r.poster_path}` : null,
  }));
}

async function showDetails(id, year) {
  const d = await tmdb(`/tv/${id}`, { append_to_response: 'content_ratings,aggregate_credits,videos' });
  const cert = pickCert(d.content_ratings?.results || [], r => r.rating);
  return {
    tmdb_id: d.id,
    title: d.name,
    year: d.first_air_date ? parseInt(d.first_air_date.slice(0, 4), 10) : year,
    overview: d.overview,
    tagline: d.tagline,
    vote: d.vote_average,
    genres: (d.genres || []).map(g => g.name).join(', '),
    certification: cert,
    level: levelFor(cert),
    poster: await cacheImage(d.poster_path, 'w500'),
    backdrop: await cacheImage(d.backdrop_path, 'w1280'),
    people: extractPeople({ cast: (d.aggregate_credits?.cast || []).map(c => ({ ...c, character: c.roles?.[0]?.character })) }, d.created_by || [], 'creator'),
    trailer: pickTrailer(d.videos),
  };
}

const seasonCache = new Map();
async function lookupEpisode(showTmdbId, season, episode) {
  const key = showTmdbId + ':' + season;
  if (!seasonCache.has(key)) {
    seasonCache.set(key, tmdb(`/tv/${showTmdbId}/season/${season}`).catch(() => null));
  }
  const s = await seasonCache.get(key);
  const ep = s && (s.episodes || []).find(e => e.episode_number === episode);
  if (!ep) return null;
  return {
    title: ep.name,
    overview: ep.overview,
    air_date: ep.air_date,
    runtime: ep.runtime,
    vote: ep.vote_average,
    still: await cacheImage(ep.still_path, 'w300'),
  };
}

function clearSeasonCache() { seasonCache.clear(); }
// For the library health report: which episodes exist (and have aired) according to TMDB
async function seasonList(showTmdbId) { return ((await tmdb(`/tv/${showTmdbId}`)).seasons || []).map(s => ({ season: s.season_number, count: s.episode_count, airDate: s.air_date })); }
async function seasonEpisodes(showTmdbId, season) {
  const key = showTmdbId + ':' + season;
  if (!seasonCache.has(key)) seasonCache.set(key, tmdb(`/tv/${showTmdbId}/season/${season}`).catch(() => null));
  const s = await seasonCache.get(key);
  return (s?.episodes || []).map(e => ({ episode: e.episode_number, title: e.name, airDate: e.air_date }));
}

async function findByImdb(imdbId, type) {
  const r = await tmdb(`/find/${imdbId}`, { external_source: 'imdb_id' });
  const hit = type === 'show' ? r.tv_results?.[0] : r.movie_results?.[0];
  return hit ? hit.id : null;
}
// All poster/backdrop choices for the picker
async function images(type, id) {
  const r = await tmdb(`/${type === 'show' ? 'tv' : 'movie'}/${id}/images`, { include_image_language: 'en,null' });
  const map = (list, size) => (list || []).slice(0, 40).map(x => ({ path: x.file_path, preview: `https://image.tmdb.org/t/p/${size}${x.file_path}`, votes: x.vote_count, lang: x.iso_639_1 }));
  return { posters: map(r.posters, 'w185'), backdrops: map(r.backdrops, 'w300') };
}
async function externalIds(type, id) { return tmdb(`/${type === 'show' || type === 'tv' ? 'tv' : 'movie'}/${id}/external_ids`); }
async function searchMulti(query) {
  const r = await tmdb('/search/multi', { query, include_adult: 'false' });
  return r.results.filter(x => x.media_type === 'movie' || x.media_type === 'tv').slice(0, 20).map(x => ({
    tmdbId: x.id, type: x.media_type, title: x.title || x.name, year: parseInt((x.release_date || x.first_air_date || '').slice(0, 4), 10) || null,
    overview: x.overview, poster: x.poster_path ? `https://image.tmdb.org/t/p/w342${x.poster_path}` : null, vote: x.vote_average,
  }));
}
async function trending() {
  const r = await tmdb('/trending/all/week');
  return r.results.filter(x => x.media_type === 'movie' || x.media_type === 'tv').slice(0, 20).map(x => ({
    tmdbId: x.id, type: x.media_type, title: x.title || x.name, year: parseInt((x.release_date || x.first_air_date || '').slice(0, 4), 10) || null,
    overview: x.overview, poster: x.poster_path ? `https://image.tmdb.org/t/p/w342${x.poster_path}` : null, vote: x.vote_average,
  }));
}

module.exports = { seasonList, seasonEpisodes, findByImdb, images, externalIds, searchMulti, trending, cacheImage, cacheTmdbPath, lookupMovie, lookupShow, lookupEpisode, movieDetails, showDetails, search, cacheLocalImage, testKey, apiKey, levelFor, LEVEL_NAMES, IMG_DIR, clearSeasonCache };
