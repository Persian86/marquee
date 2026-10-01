// Who's watching what, viewing history, screen-time limits and bedtimes.
const os = require('os');
const fs = require('fs');
const { db } = require('../db');
const { CONFIG_DIR, TRANSCODE_DIR } = require('../config');

const nowPlaying = new Map();   // deviceId -> state
const stopFlags = new Map();    // deviceId -> message

const pad = n => String(n).padStart(2, '0');
function today(d = new Date()) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
const minutesOfDay = (d = new Date()) => d.getHours() * 60 + d.getMinutes();
const parseHM = s => { const m = /^(\d{1,2}):(\d{2})$/.exec(s || ''); return m ? +m[1] * 60 + +m[2] : null; };

function deviceName(ua = '') {
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? (/Mobile/.test(ua) ? 'Android phone' : 'Android tablet')
    : /CrKey/.test(ua) ? 'Chromecast' : /Macintosh/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows PC' : /Linux/.test(ua) ? 'Linux' : 'Device';
  const br = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  return br ? `${os} · ${br}` : os;
}

// ---- limits ----
function limitFor(profile, d = new Date()) {
  const weekend = d.getDay() === 0 || d.getDay() === 6;
  const base = weekend ? profile.limit_weekend : profile.limit_weekday;
  if (base == null) return null;
  const bonus = profile.bonus_day === today(d) ? profile.bonus_minutes || 0 : 0;
  return (base + bonus) * 60;
}
function usedToday(profileId) {
  return db.prepare('SELECT seconds FROM usage WHERE profile_id = ? AND day = ?').get(profileId, today())?.seconds || 0;
}
function inBedtime(profile, d = new Date()) {
  const s = parseHM(profile.bedtime_start), e = parseHM(profile.bedtime_end);
  if (s == null || e == null || s === e) return false;
  const m = minutesOfDay(d);
  return s < e ? m >= s && m < e : m >= s || m < e;
}
function startOfToday() { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }
// Different episodes started today (rewatching one already started today doesn't count again)
function episodesToday(profileId) {
  return db.prepare(`SELECT COUNT(DISTINCT h.item_id) AS n FROM history h JOIN items i ON i.id = h.item_id
    WHERE h.profile_id = ? AND h.started_at >= ? AND i.type = 'episode'`).get(profileId, startOfToday()).n;
}
function startedToday(profileId, itemId) {
  return !!db.prepare('SELECT 1 FROM history WHERE profile_id = ? AND item_id = ? AND started_at >= ?').get(profileId, itemId, startOfToday());
}
// { ok, reason, message, remaining, episodesLeft }
// itemId: what they're about to watch (so an episode already begun today can be finished)
function check(profile, itemId = null) {
  if (inBedtime(profile)) return { ok: false, reason: 'bedtime', message: `It's bedtime! Watching is off until ${profile.bedtime_end}.` };
  let episodesLeft = null;
  if (profile.episode_limit != null) {
    episodesLeft = Math.max(0, profile.episode_limit - episodesToday(profile.id));
    if (itemId) {
      const it = db.prepare('SELECT type FROM items WHERE id = ?').get(itemId);
      if (it?.type === 'episode' && episodesLeft <= 0 && !startedToday(profile.id, itemId)) {
        return { ok: false, reason: 'episodes', message: profile.episode_limit === 1 ? "That's your episode for today!" : profile.episode_limit === 0 ? 'No episodes today!' : `That's all ${profile.episode_limit} episodes for today!`, remaining: 0, episodesLeft: 0 };
      }
    }
  }
  const limit = limitFor(profile);
  if (limit == null) return { ok: true, remaining: null, episodesLeft };
  const remaining = limit - usedToday(profile.id);
  if (remaining <= 0) return { ok: false, reason: 'limit', message: "That's all the screen time for today!", remaining: 0, episodesLeft };
  return { ok: true, remaining, episodesLeft };
}
function grantBonus(profileId, minutes) {
  const p = db.prepare('SELECT * FROM profiles WHERE id = ?').get(profileId);
  const day = today();
  const current = p.bonus_day === day ? p.bonus_minutes || 0 : 0;
  db.prepare('UPDATE profiles SET bonus_day = ?, bonus_minutes = ? WHERE id = ?').run(day, Math.max(0, current + minutes), profileId);
}

// ---- playback lifecycle ----
function startPlay({ profile, item, deviceId, ua, ip, info }) {
  const prev = nowPlaying.get(deviceId);
  let historyId = prev && prev.itemId === item.id && Date.now() - prev.updatedAt < 30 * 60000 ? prev.historyId : null;
  if (!historyId) {
    const title = item.show_title ? `${item.show_title} — S${item.season}E${item.episode} ${item.title}` : item.title;
    historyId = Number(db.prepare('INSERT INTO history (profile_id, item_id, title, device, started_at, last_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(profile.id, item.id, title, deviceName(ua), Date.now(), Date.now()).lastInsertRowid);
  }
  nowPlaying.set(deviceId, {
    deviceId, historyId, profileId: profile.id, profileName: profile.name, profileColor: profile.color, itemId: item.id,
    title: item.title, showTitle: item.show_title || null, season: item.season, episode: item.episode, poster: item.poster || item.show_poster || null,
    duration: item.duration, position: info.start || 0, state: 'loading', mode: info.mode, transcoding: !!info.transcoding, hw: !!info.hw,
    quality: info.quality, sessionId: info.sessionId || null, device: deviceName(ua), ip, startedAt: Date.now(), updatedAt: Date.now(), lastBeat: Date.now(),
  });
  stopFlags.delete(deviceId);
  return historyId;
}

// Called with each progress heartbeat. Returns anything the player must act on.
function heartbeat({ profile, deviceId, itemId, position, state }) {
  const np = nowPlaying.get(deviceId);
  const t = Date.now();
  if (np && np.itemId === itemId) {
    const delta = Math.min(30, (t - np.lastBeat) / 1000);
    if (state === 'playing' && np.state === 'playing' && delta > 0) {
      db.prepare(`INSERT INTO usage (profile_id, day, seconds) VALUES (?, ?, ?)
        ON CONFLICT(profile_id, day) DO UPDATE SET seconds = seconds + excluded.seconds`).run(profile.id, today(), Math.round(delta));
      db.prepare('UPDATE history SET seconds = seconds + ?, last_at = ? WHERE id = ?').run(Math.round(delta), t, np.historyId);
    }
    Object.assign(np, { position, state, updatedAt: t, lastBeat: t });
  }
  const out = {};
  if (stopFlags.has(deviceId)) { out.stop = stopFlags.get(deviceId); stopFlags.delete(deviceId); nowPlaying.delete(deviceId); }
  const c = check(profile);
  if (!c.ok) {
    // "Let them finish the episode": time ran out mid-episode, so finish it and stop at the end instead
    const it = np && db.prepare('SELECT type FROM items WHERE id = ?').get(np.itemId);
    if (profile.let_finish && it?.type === 'episode' && c.reason !== 'episodes') { out.finishing = c.message; out.reason = c.reason; }
    else { out.stop = out.stop || c.message; out.reason = c.reason; }
  }
  if (c.remaining != null) out.remaining = c.remaining;
  if (c.episodesLeft != null) out.episodesLeft = c.episodesLeft;
  return out;
}

function endPlay(deviceId) {
  const np = nowPlaying.get(deviceId);
  if (np) np.state = 'stopped';
  nowPlaying.delete(deviceId);
}

function active() {
  const cutoff = Date.now() - 45000;
  for (const [k, v] of nowPlaying) if (v.updatedAt < cutoff) nowPlaying.delete(k);
  return [...nowPlaying.values()];
}

function requestStop(deviceId, message) {
  stopFlags.set(deviceId, message || 'Playback was stopped by the server admin.');
  return nowPlaying.get(deviceId);
}

function system() {
  const disk = p => { try { const s = fs.statfsSync(p); return { free: s.bavail * s.bsize, total: s.blocks * s.bsize }; } catch { return null; } };
  return {
    load: os.loadavg()[0], cpus: os.cpus().length, memTotal: os.totalmem(), memFree: os.freemem(), uptime: os.uptime(),
    configDisk: disk(CONFIG_DIR), transcodeDisk: disk(TRANSCODE_DIR),
  };
}

function history({ profileId, limit = 150 } = {}) {
  return db.prepare(`SELECT h.*, p.name AS profile_name, p.color AS profile_color FROM history h JOIN profiles p ON p.id = h.profile_id
    WHERE (? IS NULL OR h.profile_id = ?) ORDER BY h.started_at DESC LIMIT ?`).all(profileId ?? null, profileId ?? null, limit);
}

// Minutes watched on each of the last n days, oldest first: [{ day: '2026-09-25', label: 'Thu', minutes: 42 }]
function lastDays(profileId, n = 7) {
  const out = [];
  for (let k = n - 1; k >= 0; k--) {
    const d = new Date(); d.setDate(d.getDate() - k);
    const day = today(d);
    const s = db.prepare('SELECT seconds FROM usage WHERE profile_id = ? AND day = ?').get(profileId, day)?.seconds || 0;
    out.push({ day, label: d.toLocaleDateString('en-AU', { weekday: 'short' }), minutes: Math.round(s / 60) });
  }
  return out;
}
function usageSummary(profileId) {
  const rows = db.prepare('SELECT day, seconds FROM usage WHERE profile_id = ? ORDER BY day DESC LIMIT 14').all(profileId);
  return rows;
}

module.exports = { lastDays, episodesToday, startPlay, heartbeat, endPlay, active, requestStop, system, history, check, grantBonus, usedToday, limitFor, usageSummary, deviceName, today };
