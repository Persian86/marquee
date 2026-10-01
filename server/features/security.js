// Sign-in protection: limits PIN guesses (per profile and per network address, with growing lock-outs),
// keeps a sign-in log, remembers known devices, and tells admins about sign-ins from new devices.
const crypto = require('crypto');
const { db } = require('../db');
const notify = require('./notify');

const ipFails = new Map();      // ip -> { times: [], until, strikes }
const profileFails = new Map(); // profileId -> { n, until, strikes }
const IP_WINDOW = 15 * 60000, IP_MAX = 10;

function clientIp(req) { return String(req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, ''); }

// null = allowed, otherwise a message to show
function blocked(req, profileId) {
  const now = Date.now();
  const ip = ipFails.get(clientIp(req));
  if (ip?.until > now) return `Too many wrong PINs from this device — try again in ${wait(ip.until - now)}`;
  const p = profileFails.get(profileId);
  if (p?.until > now) return `Too many tries — wait ${wait(p.until - now)}`;
  return null;
}
const wait = ms => (ms < 60000 ? `${Math.ceil(ms / 1000)} seconds` : `${Math.ceil(ms / 60000)} minutes`);

function failed(req, profile) {
  const now = Date.now(), addr = clientIp(req);
  log(req, profile?.id, false, 'wrong PIN');
  // Per profile: 5 wrong → locked 30s, then 1, 2, 4… minutes (up to an hour)
  const p = profileFails.get(profile.id) || { n: 0, until: 0, strikes: 0 };
  p.n++;
  if (p.n >= 5) { p.strikes++; p.until = now + Math.min(3600000, 30000 * 2 ** (p.strikes - 1)); p.n = 0; }
  profileFails.set(profile.id, p);
  // Per network address: 10 wrong in 15 minutes (any profile) → that address is blocked for a while, and admins hear about it
  const ip = ipFails.get(addr) || { times: [], until: 0, strikes: 0 };
  ip.times = ip.times.filter(t => now - t < IP_WINDOW).concat(now);
  if (ip.times.length >= IP_MAX) {
    ip.strikes++; ip.until = now + Math.min(24 * 3600000, 15 * 60000 * 2 ** (ip.strikes - 1)); ip.times = [];
    notify.message({ admins: true, title: '⚠️ Lots of wrong PINs', body: `Someone at ${addr} got the PIN wrong ${IP_MAX} times (last tried: ${profile.name}). That address is blocked for ${wait(ip.until - now)}.`, url: '/#/settings' }).catch(() => {});
  }
  ipFails.set(addr, ip);
}

function succeeded(req, res, profile) {
  profileFails.delete(profile.id);
  const ip = ipFails.get(clientIp(req));
  if (ip) ip.times = [];
  log(req, profile.id, true, null);
  // A long-lived device cookie tells us whether this is a phone/computer we've seen before
  let dev = require('../common').parseCookies(req).mq_dev;
  if (!dev || !/^[a-f0-9]{32}$/.test(dev)) {
    dev = crypto.randomBytes(16).toString('hex');
    appendCookie(res, `mq_dev=${dev}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 730}${isHttps(req) ? '; Secure' : ''}`);
  }
  const known = db.prepare('SELECT 1 FROM known_devices WHERE profile_id = ? AND device_id = ?').get(profile.id, dev);
  if (!known) {
    const hadOthers = db.prepare('SELECT COUNT(*) AS n FROM known_devices WHERE profile_id = ?').get(profile.id).n > 0;
    db.prepare('INSERT OR IGNORE INTO known_devices (profile_id, device_id, first_seen) VALUES (?, ?, ?)').run(profile.id, dev, Date.now());
    if (hadOthers) {
      const what = require('./activity').deviceName(req.headers['user-agent'] || '');
      notify.message({ admins: true, title: '🔐 New device signed in', body: `${profile.name} signed in on a new ${what} (${clientIp(req)}). If that wasn't someone in the family, remove it in Settings → Signed-in devices.`, url: '/#/settings' }).catch(() => {});
    }
  }
  return dev;
}

function log(req, profileId, ok, reason) {
  db.prepare('INSERT INTO signins (at, profile_id, ip, ua, ok, reason) VALUES (?, ?, ?, ?, ?, ?)').run(Date.now(), profileId || null, clientIp(req), String(req.headers['user-agent'] || '').slice(0, 300), ok ? 1 : 0, reason);
  db.prepare('DELETE FROM signins WHERE at < ?').run(Date.now() - 90 * 86400000);
}

function isHttps(req) { return !!(req.secure || req.headers['x-forwarded-proto'] === 'https'); }
function appendCookie(res, cookie) {
  const prev = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', prev ? [].concat(prev, cookie) : cookie);
}

// Sessions are listed by a short fingerprint, never the token itself
const sessionId = token => crypto.createHash('sha256').update(token).digest('hex').slice(0, 12);
function sessions(profile, currentToken) {
  const rows = profile.is_admin
    ? db.prepare('SELECT s.*, p.name AS profile_name, p.color FROM sessions s JOIN profiles p ON p.id = s.profile_id ORDER BY s.last_seen DESC').all()
    : db.prepare('SELECT s.*, p.name AS profile_name, p.color FROM sessions s JOIN profiles p ON p.id = s.profile_id WHERE s.profile_id = ? ORDER BY s.last_seen DESC').all(profile.id);
  const name = require('./activity').deviceName;
  return rows.map(s => ({ id: sessionId(s.token), profile: s.profile_name, color: s.color, device: s.ua ? name(s.ua) : 'Unknown device', ip: s.ip || null,
    guest: !!s.guest, createdAt: s.created_at, lastSeen: s.last_seen, current: s.token === currentToken }));
}
function revoke(profile, id) {
  for (const s of db.prepare('SELECT token, profile_id FROM sessions').all()) {
    if (sessionId(s.token) === id && (profile.is_admin || s.profile_id === profile.id)) { db.prepare('DELETE FROM sessions WHERE token = ?').run(s.token); return true; }
  }
  return false;
}
function recentSignins(limit = 50) {
  return db.prepare('SELECT s.at, s.ip, s.ua, s.ok, s.reason, p.name AS profile FROM signins s LEFT JOIN profiles p ON p.id = s.profile_id ORDER BY s.at DESC LIMIT ?').all(limit)
    .map(x => ({ ...x, ok: !!x.ok, device: require('./activity').deviceName(x.ua || '') }));
}
function blockedAddresses() {
  const now = Date.now();
  return [...ipFails].filter(([, v]) => v.until > now).map(([ip, v]) => ({ ip, until: v.until }));
}
function unblock(ip) { ipFails.delete(ip); }

module.exports = { blocked, failed, succeeded, log, isHttps, appendCookie, sessions, revoke, recentSignins, blockedAddresses, unblock, clientIp, sessionId };
