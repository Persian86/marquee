// Holiday themes: for the month of each holiday Marquee changes colour, shows a countdown on Home with a row of
// matching films and shows from your own library (and the episodes made for it), and can start a movie night
// with just those films. Same holidays as FamilyNest. Settings → Holiday themes: Automatic, Off, or keep one on.
const { db, getSetting } = require('../db');
const C = require('../common');

// Easter Sunday (Anonymous Gregorian algorithm)
function easter(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(y, month - 1, day);
}
// The nth Sunday of a month (Australian Mother's Day = 2nd Sunday of May, Father's Day = 1st Sunday of September)
function nthSunday(y, month, n) {
  const first = new Date(y, month - 1, 1);
  return new Date(y, month - 1, 1 + ((7 - first.getDay()) % 7) + 7 * (n - 1));
}

// accent / ink: the app's highlight colour and the text that sits on it; glow: the banner's second colour.
// titles: well-known films for the day, matched against your library by name. words: matched in titles and
// descriptions. genres: a weaker match (any Romance film is a Valentine's pick, but a lesser one).
const HOLIDAYS = [
  {
    id: 'australia-day', name: 'Australia Day', emoji: '🇦🇺', accent: '#ffcd00', ink: '#1d1600', glow: '#00843d',
    particles: ['☀️', '🦘', '🌊', '⭐'], date: y => new Date(y, 0, 26), row: 'Aussie picks',
    words: ['australia', 'australian', 'aussie', 'outback', 'kangaroo', 'sydney', 'melbourne'],
    titles: ['Bluey', 'Crocodile Dundee', 'Babe', 'Happy Feet', 'Finding Nemo', 'Red Dog', 'Storm Boy', 'Peter Rabbit', 'The Castle', 'Australia', 'Paper Planes', 'Blinky Bill', 'Ferngully', 'Rabbit-Proof Fence', 'Strictly Ballroom', 'Lion'],
  },
  {
    id: 'valentines', name: "Valentine's Day", emoji: '💝', accent: '#ff5c8a', ink: '#2a0612', glow: '#b3124a',
    particles: ['💖', '💕', '🌹', '💗'], date: y => new Date(y, 1, 14), row: 'Love stories',
    words: ['valentine', 'romance', 'romantic', 'falls in love', 'fall in love', 'love story', 'wedding'], genres: ['Romance'],
    titles: ['The Notebook', 'Love Actually', 'Notting Hill', 'The Princess Bride', 'Pride & Prejudice', 'Crazy Rich Asians', 'La La Land', 'Titanic', 'Lady and the Tramp', 'Tangled', 'Beauty and the Beast', 'Up', 'WALL·E', 'Sleepless in Seattle', "When Harry Met Sally..."],
  },
  {
    id: 'st-patricks', name: "St Patrick's Day", emoji: '☘️', accent: '#3ccf6e', ink: '#04210f', glow: '#0b6b34',
    particles: ['☘️', '🍀', '🌈', '💚'], date: y => new Date(y, 2, 17), row: 'A bit of Irish luck',
    words: ['ireland', 'irish', 'dublin', 'leprechaun', 'celtic'],
    titles: ['Song of the Sea', 'The Secret of Kells', 'Wolfwalkers', "Darby O'Gill and the Little People", 'Leap Year', 'P.S. I Love You', 'The Commitments', 'Sing Street', 'Brooklyn', 'The Quiet Man', 'Once'],
  },
  {
    id: 'easter', name: 'Easter', emoji: '🐣', accent: '#b48cff', ink: '#180a33', glow: '#5f3dc4',
    particles: ['🐣', '🥚', '🌷', '🐰'], date: y => easter(y), row: 'Easter picks',
    words: ['easter', 'bunny', 'bunnies', 'rabbit', 'egg hunt', 'chick'],
    titles: ['Hop', 'Peter Rabbit', 'Peter Rabbit 2: The Runaway', 'Rise of the Guardians', 'Zootopia', 'Zootropolis', 'The Prince of Egypt', 'Easter Parade', 'Wallace & Gromit: The Curse of the Were-Rabbit', 'Chicken Run', 'Here Comes Peter Cottontail', 'Charlotte\'s Web'],
  },
  {
    id: 'mothers-day', name: "Mother's Day", emoji: '💐', accent: '#ff8fb1', ink: '#2b0a15', glow: '#c2185b',
    particles: ['💐', '🌸', '💗', '🌷'], date: y => nthSunday(y, 5, 2), row: 'For Mum',
    words: ['mother', 'mum', 'mom', 'mama', 'mummy', 'mommy'],
    titles: ['Freaky Friday', 'Mamma Mia!', 'Mamma Mia! Here We Go Again', 'Coco', 'Brave', 'Mrs. Doubtfire', 'Turning Red', 'Encanto', 'Little Women', 'Moana', 'Lilo & Stitch', 'Bad Moms', 'Mary Poppins'],
  },
  {
    id: 'fathers-day', name: "Father's Day", emoji: '🏆', accent: '#4fa3ff', ink: '#04162b', glow: '#1757a8',
    particles: ['🏆', '👔', '⚽', '🍔'], date: y => nthSunday(y, 9, 1), row: 'For Dad',
    words: ['father', 'dad', 'daddy', 'fatherhood'],
    titles: ['Finding Nemo', 'Big Fish', 'The Incredibles', 'Incredibles 2', 'Cheaper by the Dozen', 'The Lion King', 'Paddington', 'Paddington 2', 'Despicable Me', 'Hook', 'Back to the Future', 'Field of Dreams', 'Chitty Chitty Bang Bang', 'Elf'],
  },
  {
    id: 'halloween', name: 'Halloween', emoji: '🎃', accent: '#ff7a1a', ink: '#1f0c00', glow: '#6a1fb0',
    particles: ['🎃', '👻', '🦇', '🕸️'], date: y => new Date(y, 9, 31), row: 'Spooky picks',
    words: ['halloween', 'haunted', 'haunting', 'ghost', 'witch', 'witches', 'vampire', 'pumpkin', 'spooky', 'monster', 'zombie', 'skeleton', 'trick-or-treat', 'trick or treat'], genres: ['Horror'],
    titles: ['Hocus Pocus', 'Hocus Pocus 2', 'Hotel Transylvania', 'Monsters, Inc.', 'The Nightmare Before Christmas', 'Coraline', 'Casper', 'Ghostbusters', 'Beetlejuice', 'The Addams Family', 'Corpse Bride', 'ParaNorman', 'Frankenweenie', 'Halloweentown', 'Monster House', 'Goosebumps', 'The Witches', 'Coco', 'It\'s the Great Pumpkin, Charlie Brown', 'Scooby-Doo'],
  },
  {
    id: 'christmas', name: 'Christmas', emoji: '🎄', accent: '#ff4d4d', ink: '#2a0505', glow: '#1b7f3b',
    particles: ['❄️', '⭐', '🎄', '🎁'], date: y => new Date(y, 11, 25), row: 'Christmas favourites',
    words: ['christmas', 'xmas', 'santa', 'grinch', 'reindeer', 'sleigh', 'snowman', 'north pole', 'nativity', 'mistletoe', 'scrooge'],
    titles: ['Elf', 'Home Alone', 'Home Alone 2: Lost in New York', 'The Polar Express', 'Arthur Christmas', 'Klaus', 'The Grinch', 'How the Grinch Stole Christmas', 'The Muppet Christmas Carol', 'A Christmas Carol', 'A Boy Called Christmas', 'The Santa Clause', 'Jingle All the Way', 'Love Actually', 'The Holiday', 'Die Hard', 'Frozen', 'Miracle on 34th Street', 'It\'s a Wonderful Life', 'The Snowman', 'National Lampoon\'s Christmas Vacation', 'Noelle', 'Spirited'],
  },
];
const BY_ID = new Map(HOLIDAYS.map(h => [h.id, h]));

/** The holiday whose month it is, if any. When Easter falls in March it takes March over St Patrick's. */
function forDate(d = new Date()) {
  const m = d.getMonth() + 1, easterMonth = easter(d.getFullYear()).getMonth() + 1;
  return BY_ID.get({ 1: 'australia-day', 2: 'valentines', 3: easterMonth === 3 ? 'easter' : 'st-patricks', 4: easterMonth === 4 ? 'easter' : null,
    5: 'mothers-day', 9: 'fathers-day', 10: 'halloween', 12: 'christmas' }[m]) || null;
}

/** Settings → Holiday themes: "auto" (by the month), "off", or a holiday id to keep that theme on. */
function current(d = new Date()) {
  const mode = getSetting('holiday_mode', 'auto') || 'auto';
  if (mode === 'off') return null;
  return BY_ID.get(mode) || forDate(d);
}

const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** What the apps need to dress up: colours, decorations and the day itself (the countdown is worked out on the device). */
function info(h, d = new Date()) {
  if (!h) return null;
  let day = h.date(d.getFullYear());
  // A theme kept on outside its month counts down to the next one
  if (day < new Date(d.getFullYear(), d.getMonth(), d.getDate()) && day.getMonth() !== d.getMonth()) day = h.date(d.getFullYear() + 1);
  return { id: h.id, name: h.name, emoji: h.emoji, accent: h.accent, ink: h.ink, glow: h.glow, particles: h.particles, row: h.row, date: ymd(day) };
}

const norm = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').trim();
const hasWord = (text, w) => new RegExp(`(^|[^a-z])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(s|es)?($|[^a-z])`).test(text);

/** Films and shows from this profile's library that suit the holiday, best matches first. */
function picks(profile, h, limit = 30) {
  if (!h) return [];
  const titles = new Set(h.titles.map(norm));
  const like = [...h.words.map(w => `%${w}%`)];
  const textCond = like.map(() => '(LOWER(i.title) LIKE ? OR LOWER(COALESCE(i.overview, \'\')) LIKE ?)').join(' OR ');
  const genreCond = (h.genres || []).map(() => `(', ' || COALESCE(i.genres, '') || ', ') LIKE ?`).join(' OR ');
  const titleCond = `LOWER(i.title) IN (${h.titles.map(() => '?').join(',')})`;
  const where = `(${[textCond, genreCond, titleCond].filter(Boolean).join(' OR ')})`;
  const params = [...like.flatMap(l => [l, l]), ...(h.genres || []).map(g => `%, ${g}, %`), ...h.titles.map(t => t.toLowerCase())];
  const rows = [...C.movieList(profile, where, 'i.sort_title', 400, params), ...C.showList(profile, where, 'i.sort_title', 200, params)];
  const seen = new Set();
  const scored = [];
  for (const r of rows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    const t = norm(r.title), o = norm(r.overview);
    let score = 0;
    if (titles.has(t)) score += 100;
    if (h.words.some(w => hasWord(t, norm(w)))) score += 40;
    if (h.words.some(w => hasWord(o, norm(w)))) score += 15;
    if ((h.genres || []).some(g => (r.genres || []).includes(g))) score += 8;
    if (!score) continue;
    score += (r.vote || 0) / 2; // better-rated first among equals
    scored.push({ r, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map(({ r }) => r);
}

/** Episodes made for the holiday ("Christmas Swim", "The Haunted House"), from shows this profile can watch. */
function episodes(profile, h, limit = 20) {
  if (!h) return [];
  const words = h.words.filter(w => w.length > 3);
  if (!words.length) return [];
  const rows = db.prepare(`SELECT i.*, ${C.PROGRESS_COLS}, s.title AS show_title, s.poster AS show_poster, s.backdrop AS show_backdrop
    FROM items i JOIN items s ON s.id = i.parent_id JOIN libraries l ON l.id = i.library_id ${C.PROGRESS_JOIN}
    WHERE i.type = 'episode' AND ${C.visible(profile, 'COALESCE(s.level, i.level)')} AND (${words.map(() => 'LOWER(i.title) LIKE ?').join(' OR ')})
    ORDER BY s.sort_title, i.season, i.episode LIMIT 300`).all(profile.id, ...words.map(w => `%${w}%`));
  return rows.filter(r => words.some(w => hasWord(norm(r.title), norm(w)))).slice(0, limit).map(C.formatItem);
}

// Home asks on every visit; the answer only changes when the library does, so keep it for a few minutes
const cache = new Map();
function forHome(profile, h) {
  if (!h) return null;
  const key = `${profile.id}:${h.id}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 5 * 60000) return hit.value;
  const value = { picks: picks(profile, h), episodes: episodes(profile, h) };
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return value;
}

/** Movie ids for a holiday movie night. */
function movieIds(profile, h) {
  return picks(profile, h, 200).filter(x => x.type === 'movie').map(x => x.id);
}

module.exports = { HOLIDAYS, forDate, current, info, picks, episodes, forHome, movieIds, easter, nthSunday, BY_ID };
