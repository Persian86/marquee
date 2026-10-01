// Reads Kodi/Jellyfin-style .nfo files sitting next to your media.
const fs = require('fs');
const path = require('path');

const decode = s => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&').trim();
function tag(xml, name) { const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i')); return m ? decode(m[1]) : null; }
function tags(xml, name) { return [...xml.matchAll(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'gi'))].map(m => decode(m[1])).filter(Boolean); }

function parse(file) {
  let xml;
  try { xml = fs.readFileSync(file, 'utf8'); } catch { return null; }
  if (!/<(movie|tvshow|episodedetails)[\s>]/i.test(xml)) {
    // Some .nfo files are just a TMDB/IMDb link
    const tm = xml.match(/themoviedb\.org\/(?:movie|tv)\/(\d+)/), im = xml.match(/(tt\d{6,9})/);
    return tm || im ? { tmdb_id: tm ? +tm[1] : null, imdb_id: im ? im[1] : null } : null;
  }
  const uid = type => { const m = xml.match(new RegExp(`<uniqueid[^>]*type=["']${type}["'][^>]*>([^<]+)</uniqueid>`, 'i')); return m ? m[1].trim() : null; };
  const out = {
    title: tag(xml, 'title'), year: parseInt(tag(xml, 'year') || (tag(xml, 'premiered') || '').slice(0, 4), 10) || null,
    overview: tag(xml, 'plot') || tag(xml, 'outline'), tagline: tag(xml, 'tagline'),
    certification: (tag(xml, 'mpaa') || '').replace(/^(Rated|AU:|US:)\s*/i, '') || null,
    genres: tags(xml, 'genre').join(', ') || null, runtime: parseInt(tag(xml, 'runtime'), 10) || null,
    vote: parseFloat(tag(xml, 'rating')) || null, air_date: tag(xml, 'aired') || tag(xml, 'premiered'),
    tmdb_id: parseInt(uid('tmdb') || tag(xml, 'tmdbid'), 10) || null,
    imdb_id: uid('imdb') || (tag(xml, 'id') || '').match(/tt\d+/)?.[0] || null,
    edition: tag(xml, 'edition'),
  };
  for (const k of Object.keys(out)) if (out[k] == null || out[k] === '') delete out[k];
  return out;
}

function forMovie(file) {
  const dir = path.dirname(file), base = path.basename(file, path.extname(file));
  for (const f of [path.join(dir, base + '.nfo'), path.join(dir, 'movie.nfo')]) if (fs.existsSync(f)) return parse(f);
  return null;
}
function forShow(dir) { const f = path.join(dir, 'tvshow.nfo'); return fs.existsSync(f) ? parse(f) : null; }
function forEpisode(file) { const f = path.join(path.dirname(file), path.basename(file, path.extname(file)) + '.nfo'); return fs.existsSync(f) ? parse(f) : null; }

module.exports = { parse, forMovie, forShow, forEpisode };
