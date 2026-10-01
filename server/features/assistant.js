// Voice commands from JARVIS, Siri Shortcuts, Google Assistant routines…
// "play Bluey on the lounge TV", "pause", "what's new", "what should we watch tonight", "start movie night"
const { db, getSetting } = require('../db');
const C = require('../common');
const devices = require('./devices');
const activity = require('./activity');
const movienight = require('./movienight');
const smartsearch = require('./smartsearch');

const norm = s => String(s || '').toLowerCase().replace(/&/g, 'and').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
const noThe = s => s.replace(/^(the|a|an) /, '');

// Best title match among movies and shows this profile can see
function findTitle(profile, query) {
  const q = noThe(norm(query));
  if (!q) return null;
  const rows = db.prepare(`SELECT i.id, i.type, i.title, i.year FROM items i JOIN libraries l ON l.id = i.library_id
    WHERE i.type IN ('movie','show','home') AND ${C.visible(profile)}`).all();
  const qWords = new Set(q.split(' '));
  let best = null, bestScore = 0;
  for (const r of rows) {
    const t = noThe(norm(r.title));
    let score = 0;
    if (t === q) score = 100;
    else if (`${t} ${r.year}` === q) score = 100;
    else if (t.startsWith(q)) score = 80;
    else if (q.startsWith(t) && t.length > 3) score = 70;
    else if (t.includes(q)) score = 60;
    else {
      const words = t.split(' ');
      const hit = words.filter(w => qWords.has(w)).length;
      score = hit ? (hit / Math.max(words.length, qWords.size)) * 50 : 0;
    }
    if (r.type === 'show') score += 1; // "play Bluey" more likely means the show
    if (score > bestScore) { best = r; bestScore = score; }
  }
  return bestScore >= 30 ? best : null;
}

function findDevice(profile, name) {
  if (!name) return null;
  const n = noThe(norm(name));
  const list = devices.list(profile);
  return list.find(d => norm(d.name) === n) || list.find(d => norm(d.name).includes(n) || n.includes(norm(d.name))) || null;
}

// Pull "… on the lounge tv" off the end, but only if a screen with that name is connected
function splitDevice(profile, text) {
  const m = /^(.*?)\s+on\s+(?:the\s+|my\s+)?([\w' -]{2,40})$/.exec(text);
  if (m) { const d = findDevice(profile, m[2]); if (d) return { rest: m[1].trim(), device: d }; }
  return { rest: text, device: null };
}

// What to actually play for a title: a show → the next episode
function playable(profile, row) {
  if (row.type !== 'show') return { id: row.id, label: row.title };
  const core = require('../routes/core');
  const ep = core.nextEpisodeFor(profile, row.id);
  return ep ? { id: ep.id, label: `${row.title}, season ${ep.season} episode ${ep.episode}` } : null;
}

function play(profile, target, device, preferredDevice) {
  const dev = device || findDevice(profile, preferredDevice);
  const check = activity.check(profile, target.id);
  if (!check.ok) return { ok: false, speech: check.message };
  if (dev) {
    devices.command(profile, dev.clientId, { type: 'open', itemId: target.id });
    return { ok: true, speech: `Playing ${target.label} on ${dev.name}`, action: { type: 'played-on-device', itemId: target.id, device: dev.name } };
  }
  return { ok: true, speech: `Playing ${target.label}`, action: { type: 'play', itemId: target.id, url: `marquee://play/${target.id}` } };
}

function control(profile, type, device, extra = {}) {
  const list = devices.list(profile).filter(d => d.state);
  const dev = device || (list.length === 1 ? list[0] : list.find(d => d.state?.playing));
  if (!dev) return { ok: false, speech: list.length ? 'Which screen? Say, for example, pause on the lounge TV.' : "Nothing's playing on Marquee right now." };
  devices.command(profile, dev.clientId, { type, ...extra });
  const words = { pause: 'Paused', resume: 'Playing', toggle: 'Okay', stop: 'Stopped', seekBy: extra.by > 0 ? `Skipped forward ${extra.by} seconds` : `Went back ${-extra.by} seconds`, next: 'Next episode' };
  return { ok: true, speech: `${words[type] || 'Done'} on ${dev.name}`, action: { type: 'command', command: type, device: dev.name } };
}

function whatsNew(profile) {
  const since = Date.now() - 7 * 86400000;
  const movies = C.movieList(profile, 'i.added_at > ?', 'i.added_at DESC', 20, [since]);
  const shows = db.prepare(`SELECT s.title, COUNT(*) AS n FROM items e JOIN items s ON s.id = e.parent_id JOIN libraries l ON l.id = s.library_id
    WHERE e.type = 'episode' AND e.added_at > ? AND ${C.visible(profile, 's.level')} GROUP BY s.id ORDER BY MAX(e.added_at) DESC LIMIT 5`).all(since);
  const parts = [];
  if (movies.length) parts.push(movies.length === 1 ? `the movie ${movies[0].title}` : `${movies.length} movies, including ${movies.slice(0, 3).map(m => m.title).join(', ')}`);
  for (const s of shows.slice(0, 3)) parts.push(s.n === 1 ? `a new episode of ${s.title}` : `${s.n} new episodes of ${s.title}`);
  if (!parts.length) return { ok: true, speech: 'Nothing new this week.' };
  return { ok: true, speech: `This week on Marquee: ${parts.length > 1 ? parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1] : parts[0]}.`, items: movies.slice(0, 5).map(m => m.id) };
}

async function suggest(profile, mood) {
  const found = mood ? await smartsearch.search(profile, mood, { limit: 10 }) : null;
  const pool = found?.items?.length ? found.items : C.movieList(profile, '(pr.watched IS NULL OR pr.watched = 0)', '(COALESCE(i.vote, 6) + ABS(RANDOM() % 300) / 100.0) DESC', 10);
  if (!pool.length) return { ok: false, speech: "I couldn't find anything for that." };
  const pick = pool[Math.floor(Math.random() * Math.min(5, pool.length))];
  const about = pick.overview ? ' — ' + pick.overview.split(/(?<=\.)\s/)[0] : '';
  return { ok: true, speech: `How about ${pick.title}${pick.year ? ` from ${pick.year}` : ''}${about}`, action: { type: 'suggest', itemId: pick.id, url: `marquee://item/${pick.id}` } };
}

async function handle(profile, raw, { device: preferredDevice = null } = {}) {
  let text = norm(raw).replace(/^(hey |ok |okay )?(jarvis|siri|google|marquee)\b,?\s*/, '').replace(/\s*(please|thanks|thank you)$/, '').replace(/\s+(in|on|using) marquee$/, '').trim();
  if (!text) return { ok: false, speech: 'Try: play Bluey on the lounge TV.' };

  // Remote control
  let m;
  const { rest, device } = splitDevice(profile, text);
  if (/^(pause|pause it|pause the (movie|show|tv|video))$/.test(rest)) return control(profile, 'pause', device);
  if (/^(resume|unpause|keep playing|play)$/.test(rest)) return control(profile, 'resume', device);
  if (/^(stop|stop it|stop playing|stop the (movie|show|tv|video))$/.test(rest)) return control(profile, 'stop', device);
  if (/^(next|next episode|skip episode|play the next episode)$/.test(rest)) return control(profile, 'next', device);
  if ((m = /^(skip|fast forward|go forward|jump ahead|skip ahead)( (\d+) (second|seconds|minute|minutes))?$/.exec(rest))) {
    const by = m[3] ? +m[3] * (/minute/.test(m[4]) ? 60 : 1) : 30;
    return control(profile, 'seekBy', device, { by });
  }
  if ((m = /^(go back|rewind|back)( (\d+) (second|seconds|minute|minutes))?$/.exec(rest))) {
    const by = m[3] ? +m[3] * (/minute/.test(m[4]) ? 60 : 1) : 10;
    return control(profile, 'seekBy', device, { by: -by });
  }

  // Information
  if (/^(what s|whats|what is|anything) (new|been added|new on|recently added)/.test(text) || /^what s new$/.test(text)) return whatsNew(profile);
  if ((m = /^(what should (we|i) watch|recommend (something|a movie)|suggest (something|a movie)|pick (something|a movie))( tonight)?( (something )?(.+))?$/.exec(text))) return suggest(profile, m[9] || null);
  if ((m = /^how much (screen )?time (does|has|have|is) (\w+) (got |have |has )?left/.exec(text))) {
    const name = m[3] === 'i' ? profile.name : m[3];
    const p = db.prepare('SELECT * FROM profiles WHERE LOWER(name) = ?').get(name.toLowerCase());
    if (!p || (!profile.is_admin && p.id !== profile.id)) return { ok: false, speech: `I don't know ${name}.` };
    const c = activity.check(p);
    if (!c.ok) return { ok: true, speech: `${p.name} is done for today. ${c.message}` };
    if (c.remaining == null) return { ok: true, speech: `${p.name} doesn't have a time limit.` };
    return { ok: true, speech: `${p.name} has ${Math.round(c.remaining / 60)} minutes left today${c.episodesLeft != null ? ` and ${c.episodesLeft} episodes` : ''}.` };
  }
  if (/^(start|begin|let s do|lets do|have) (a )?movie night$/.test(text)) {
    const room = movienight.create(profile, { pool: 'unwatched', familyFriendly: !!profile.is_kids });
    const spaced = room.code.split('').join(' ');
    return { ok: true, speech: `Movie night started. Everyone can join with the code ${spaced}.`, action: { type: 'movienight', code: room.code, url: `marquee://movienight/${room.code}` } };
  }
  if (/^(continue|resume|keep) watching$/.test(rest)) {
    const row = db.prepare(`SELECT i.id, i.title, s.title AS show FROM progress pr JOIN items i ON i.id = pr.item_id LEFT JOIN items s ON s.id = i.parent_id
      WHERE pr.profile_id = ? AND pr.watched = 0 AND pr.position > 30 AND i.type IN ('movie','episode','home') ORDER BY pr.updated_at DESC LIMIT 1`).get(profile.id);
    if (!row) return { ok: false, speech: "You're not in the middle of anything." };
    return play(profile, { id: row.id, label: row.show ? `${row.show}, ${row.title}` : row.title }, device, preferredDevice);
  }

  // Play something
  if ((m = /^(play|watch|put on|start|open|show me|resume|continue) (.+)$/.exec(rest))) {
    let what = m[2].replace(/^(the )?(movie|film|show|tv show|series) /, '');
    const ep = /^(.+?) season (\d+) episode (\d+)$/.exec(what);
    if (ep) {
      const show = findTitle(profile, ep[1]);
      const row = show && db.prepare("SELECT id, title FROM items WHERE parent_id = ? AND season = ? AND episode = ? AND type = 'episode'").get(show.id, +ep[2], +ep[3]);
      if (!row) return { ok: false, speech: `I couldn't find season ${ep[2]} episode ${ep[3]}${show ? ` of ${show.title}` : ''}.` };
      return play(profile, { id: row.id, label: `${show.title}, season ${ep[2]} episode ${ep[3]}` }, device, preferredDevice);
    }
    what = what.replace(/^(the )?next episode of /, '');
    if (/^something\b/.test(what)) return suggest(profile, what.replace(/^something\s*/, ''));
    const row = findTitle(profile, what);
    if (!row) return { ok: false, speech: `I couldn't find ${what} on Marquee.` };
    const target = playable(profile, row);
    if (!target) return { ok: false, speech: `${row.title} has no episodes yet.` };
    return play(profile, target, device, preferredDevice);
  }

  // Anything else: treat it as a search
  const found = await smartsearch.search(profile, text, { limit: 5 });
  if (found.items.length) {
    const first = found.items[0];
    return { ok: true, speech: `I found ${found.items.slice(0, 3).map(i => i.title).join(', ')}.`, action: { type: 'open', itemId: first.id, url: `marquee://item/${first.id}` } };
  }
  if (found.chips.length) return { ok: false, speech: `I couldn't find any ${found.chips.join(', ').toLowerCase()} on Marquee.` };
  return { ok: false, speech: "Sorry, I didn't catch that. Try: play Bluey on the lounge TV, pause, or what's new." };
}

module.exports = { handle, findTitle };
