// Turns messy file / folder names into titles, years, seasons and episodes.
const path = require('path');

const VIDEO_EXT = new Set(['.mp4', '.m4v', '.mkv', '.avi', '.mov', '.wmv', '.ts', '.m2ts', '.webm', '.mpg', '.mpeg', '.flv', '.3gp', '.ogv', '.divx', '.vob']);

const JUNK = /\b(2160p|1080p|1080i|720p|576p|480p|4k|uhd|hdr10\+?|hdr|dv|dolby ?vision|bluray|blu-ray|brrip|bdrip|webrip|web-dl|webdl|web|hdtv|dvdrip|dvd|remux|x264|x265|h\.?264|h\.?265|hevc|avc|aac\d?(\.\d)?|ac3|eac3|dts(-hd)?|truehd|atmos|ddp?\d?(\.\d)?|10bit|8bit|proper|repack|extended|unrated|directors\.?cut|imax|yts|yify|rarbg|internal|limited|multi|subs?)\b.*$/i;

function isVideo(file) {
  return VIDEO_EXT.has(path.extname(file).toLowerCase());
}

function isSample(file) {
  return /(^|[\W_])sample([\W_]|$)/i.test(path.basename(file)) || /[-_. ](trailer|teaser)\d*\.\w+$/i.test(path.basename(file)) || /[\\/](samples?|extras|featurettes|behind the scenes|trailers?)[\\/]/i.test(file);
}

function clean(s) {
  return s
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/[._]+/g, ' ')
    .replace(/\s+-\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// "The Matrix (1999)", "The.Matrix.1999.1080p.BluRay" -> { title, year }
function parseTitleYear(raw) {
  let s = raw.replace(/\.[a-z0-9]{2,4}$/i, '');
  let year = null;
  const paren = s.match(/^(.*?)[\s._]*[(\[]((?:19|20)\d{2})[)\]]/);
  if (paren) {
    year = parseInt(paren[2], 10);
    s = paren[1];
  } else {
    // A bare year followed by junk/end — use the LAST plausible year so "2001 A Space Odyssey 1968" works
    const re = /[\s._-]((?:19|20)\d{2})(?=[\s._-]|$)/g;
    let m, last = null;
    while ((m = re.exec(s))) if (m.index > 0) last = m;
    if (last) {
      year = parseInt(last[1], 10);
      s = s.slice(0, last.index);
    }
  }
  s = s.replace(JUNK, '');
  s = s.replace(/\{[^}]*\}/g, '');
  const title = clean(s) || clean(raw);
  return { title, year };
}

// Find SxxEyy / 1x02 / "Season 1 Episode 2" in a path
function parseEpisode(relPath) {
  const name = path.basename(relPath);
  let m = name.match(/[Ss](\d{1,2})[\s._-]*[Ee](\d{1,3})(?:[\s._-]*[Ee-](\d{1,3}))?/);
  if (m) return { season: +m[1], episode: +m[2], episodeEnd: m[3] ? +m[3] : null };
  m = name.match(/(?:^|[\s._-])(\d{1,2})x(\d{2,3})(?:[\s._-]|$)/i);
  if (m) return { season: +m[1], episode: +m[2] };
  m = relPath.match(/season[\s._-]*(\d{1,2}).*?(?:episode|ep|e)[\s._-]*(\d{1,3})/i);
  if (m) return { season: +m[1], episode: +m[2] };
  // "Season 2/03 - Title.mkv"
  const seasonDir = relPath.match(/season[\s._-]*(\d{1,2})/i) || (/specials/i.test(relPath) ? [null, '0'] : null);
  const ep = name.match(/^(?:e|ep|episode)?[\s._-]*(\d{1,3})(?:[\s._-]|$)/i);
  if (seasonDir && ep) return { season: +seasonDir[1], episode: +ep[1] };
  return null;
}

function episodeTitleFromName(name) {
  const base = name.replace(/\.[a-z0-9]{2,4}$/i, '');
  const m = base.match(/(?:[Ss]\d{1,2}[Ee]\d{1,3}(?:-?[Ee]\d{1,3})?|\d{1,2}x\d{2,3})[\s._-]*(.*)$/);
  if (!m || !m[1]) return null;
  const t = clean(m[1].replace(JUNK, ''));
  return t || null;
}

// "{edition-Director's Cut}" (Plex style) or common edition words in the name
const EDITIONS = [[/director'?s[ ._-]?cut/i, "Director's Cut"], [/extended[ ._-]?(edition|cut)?/i, 'Extended Edition'], [/theatrical[ ._-]?(cut|edition)?/i, 'Theatrical Cut'],
  [/\bunrated\b/i, 'Unrated'], [/\bremastered\b/i, 'Remastered'], [/special[ ._-]edition/i, 'Special Edition'], [/final[ ._-]cut/i, 'Final Cut'],
  [/ultimate[ ._-]?(edition|cut)/i, 'Ultimate Edition'], [/\bimax\b/i, 'IMAX'], [/criterion/i, 'Criterion'], [/anniversary[ ._-]edition/i, 'Anniversary Edition']];
function parseEdition(name) {
  const m = name.match(/\{edition-([^}]+)\}/i);
  if (m) return m[1].trim();
  for (const [re, label] of EDITIONS) if (re.test(name)) return label;
  return null;
}

function sortTitle(title) {
  return title.toLowerCase().replace(/^(the|a|an)\s+/, '').trim();
}

module.exports = { parseEdition, isVideo, isSample, parseTitleYear, parseEpisode, episodeTitleFromName, sortTitle, VIDEO_EXT };
