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
  // "Season 2/03 - Title.mkv", "Bluey S02/Episode 5.mkv", "Series 2/Bluey - 05 - Title.mkv"
  const dirs = path.dirname(relPath);
  const seasonDir = dirs.match(/(?:season|series|staffel|saison|temporada)[\s._-]*(\d{1,2})/i) || dirs.match(/(?:^|[\\/\s._-])s(\d{1,2})(?=$|[\\/\s._-])/i)
    || (/specials/i.test(dirs) ? [null, '0'] : null);
  const ep = name.match(/^(?:e|ep|episode)?[\s._-]*(\d{1,3})(?:[\s._-]|$)/i)
    || name.match(/(?:^|[\s._-])(?:e|ep|episode)[\s._-]*(\d{1,3})(?:[\s._-]|$)/i)
    || name.match(/[\s._]-[\s._]*(\d{1,3})[\s._]*(?:-|\.[a-z0-9]{2,4}$)/i);
  if (seasonDir && ep) return { season: +seasonDir[1], episode: +ep[1] };
  return null;
}

// ---- which show does a file belong to? ----
// Folder that is only a season: "Season 1", "Series 2", "S03", "Specials"
const SEASON_DIR = /^(?:(?:season|series|staffel|saison|temporada)[\s._-]*\d{1,3}|s\d{1,2}|specials?)$/i;
// Folder for one episode or one disc — never the show itself
const EPISODE_DIR = /[Ss]\d{1,2}[\s._-]*[Ee]\d{1,3}|(?:^|[\s._-])\d{1,2}x\d{2,3}(?:[\s._-]|$)/;
const DISC_DIR = /^(?:disc|disk|cd|dvd|part|vol(?:ume)?)[\s._-]*\d+$/i;
// Show and season in one folder name: "Bluey Season 2", "Bluey - Series 1-3", "Bluey.S02.1080p.WEB", "Bluey Complete Series"
const SEASON_SUFFIXES = [
  /[\s._-]*[\[(]?(?:seasons?|series|staffel|saison|temporada)[\s._-]*\d{1,3}(?:[\s._-]*(?:-|to|&|and)[\s._-]*\d{1,3})?[\])]?.*$/i,
  /[\s._-]+s\d{1,2}(?:[\s._-]*-?[\s._-]*s?\d{1,2})?(?=$|[\s._-]).*$/i,
  /[\s._-]*[\[(]?(?:the[\s._-]+)?complete[\s._-]+(?:series|collection|seasons?|tv[\s._-]series).*$/i,
  /[\s._-]*[\[(]s(?:eason)?[\s._-]*\d{1,3}[\])].*$/i,
];
function stripSeason(name) {
  for (const re of SEASON_SUFFIXES) {
    const cut = name.replace(re, '');
    if (cut !== name && clean(cut).length >= 1) return cut;
  }
  return name;
}
/** A stable key for "the same show": lower-case title plus year if the folder gave one. */
function showKey(rawName) {
  const { title, year } = parseTitleYear(rawName);
  return title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() + (year ? ` (${year})` : '');
}
/**
 * parts = the file's path inside the library, split into folders + file name.
 * Returns { name, key, folder }: name to show/look up, key that is equal for every folder of the same show,
 * and folder = the show's own folder (for poster.jpg / theme.mp3 / tvshow.nfo) when it has exactly one.
 */
function showFromPath(parts) {
  const file = parts[parts.length - 1];
  const dirs = parts.slice(0, -1);
  const fromFile = () => {
    const m = file.match(/^(.*?)[\s._-]*(?:[Ss]\d{1,2}[\s._-]*[Ee]\d|\d{1,2}x\d{2})/);
    const name = m && clean(m[1]) ? m[1] : file.replace(/\.[a-z0-9]{2,4}$/i, '');
    return { name, key: showKey(name), folder: null };
  };
  if (!dirs.length) return fromFile();
  // The show is the folder just above the first season folder…
  let idx = dirs.findIndex(d => SEASON_DIR.test(d.trim())) - 1;
  if (idx === -1) return fromFile();            // "Season 1" sitting directly in the library
  if (idx < -1) {
    // …or, with no season folders, the deepest folder that isn't just one episode or one disc
    idx = dirs.length - 1;
    while (idx > 0 && (EPISODE_DIR.test(dirs[idx]) || DISC_DIR.test(dirs[idx].trim()))) idx--;
    if (idx === 0 && EPISODE_DIR.test(dirs[0])) return fromFile(); // "Show.S01E01.1080p/Show.S01E01.mkv" loose in the library
  }
  const raw = dirs[idx];
  const stripped = stripSeason(raw);
  return { name: stripped, key: showKey(stripped), folder: stripped === raw ? dirs.slice(0, idx + 1).join('/') : null };
}

function episodeTitleFromName(name) {
  const base = name.replace(/\.[a-z0-9]{2,4}$/i, '');
  const m = base.match(/(?:[Ss]\d{1,2}[Ee]\d{1,3}(?:-?[Ee]\d{1,3})?|\d{1,2}x\d{2,3})[\s._-]*(.*)$/);
  // "01 - Pups Make a Splash", "Episode 5 - Title", "Bluey - 07 - Fairies"
  const alt = !m && (base.match(/^(?:e|ep|episode)?[\s._-]*\d{1,3}[\s._]*[-.:][\s._]*(.+)$/i) || base.match(/[\s._]-[\s._]*\d{1,3}[\s._]*-[\s._]*(.+)$/));
  const rest = m ? m[1] : alt ? alt[1] : null;
  if (!rest) return null;
  const t = clean(rest.replace(JUNK, ''));
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

module.exports = { showFromPath, showKey, stripSeason, parseEdition, isVideo, isSample, parseTitleYear, parseEpisode, episodeTitleFromName, sortTitle, VIDEO_EXT };
