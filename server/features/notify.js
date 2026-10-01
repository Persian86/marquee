// "New on Marquee" alerts: in-app list, phone push notifications, and an optional webhook (JARVIS, Discord, ntfy…)
const webpush = require('web-push');
const { db, getSetting, setSetting } = require('../db');

if (!getSetting('vapid_public')) {
  const k = webpush.generateVAPIDKeys();
  setSetting('vapid_public', k.publicKey);
  setSetting('vapid_private', k.privateKey);
}
webpush.setVapidDetails('mailto:marquee@localhost', getSetting('vapid_public'), getSetting('vapid_private'));

const publicKey = () => getSetting('vapid_public');

function subscribe(profileId, sub) {
  if (!sub || !sub.endpoint) throw new Error('Bad subscription');
  db.prepare(`INSERT INTO push_subs (endpoint, profile_id, sub, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET profile_id = excluded.profile_id, sub = excluded.sub`).run(sub.endpoint, profileId, JSON.stringify(sub), Date.now());
}
function unsubscribe(endpoint) { db.prepare('DELETE FROM push_subs WHERE endpoint = ?').run(endpoint); }

// Turn a batch of new files into one friendly message
function summarise(added) {
  const movies = [], shows = new Map(), other = { home: 0, track: 0, photo: 0 };
  for (const a of added) {
    if (a.type === 'movie') movies.push(a.id);
    else if (a.type === 'episode') { const s = shows.get(a.parent_id) || []; s.push(a.id); shows.set(a.parent_id, s); }
    else if (other[a.type] != null) other[a.type]++;
  }
  const parts = [];
  const ids = [...movies];
  const movieRows = movies.length ? db.prepare(`SELECT id, title, poster, backdrop FROM items WHERE id IN (${movies.map(() => '?').join(',')})`).all(...movies) : [];
  if (movieRows.length === 1) parts.push(movieRows[0].title);
  else if (movieRows.length) parts.push(`${movieRows.length} movies (${movieRows.slice(0, 3).map(m => m.title).join(', ')}${movieRows.length > 3 ? '…' : ''})`);
  for (const [showId, eps] of shows) {
    const s = db.prepare('SELECT id, title FROM items WHERE id = ?').get(showId);
    if (!s) continue;
    ids.push(showId);
    parts.push(eps.length === 1 ? `a new episode of ${s.title}` : `${eps.length} new episodes of ${s.title}`);
  }
  if (other.home) parts.push(`${other.home} home video${other.home > 1 ? 's' : ''}`);
  if (other.track) parts.push(`${other.track} song${other.track > 1 ? 's' : ''}`);
  if (other.photo) parts.push(`${other.photo} photo${other.photo > 1 ? 's' : ''}`);
  if (!parts.length) return null;
  const img = movieRows[0]?.backdrop || movieRows[0]?.poster || (shows.size ? db.prepare('SELECT backdrop, poster FROM items WHERE id = ?').get([...shows.keys()][0]) : null);
  return {
    title: 'New on ' + getSetting('server_name', 'Marquee'),
    body: parts.length === 1 ? cap(parts[0]) + ' just arrived' : cap(parts.slice(0, -1).join(', ')) + ' and ' + parts[parts.length - 1],
    ids, image: typeof img === 'string' ? img : img?.backdrop || img?.poster || null,
  };
}
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

// visibleTo(profile, itemId) is supplied by index.js so kids don't get told about grown-up films
async function onNewItems(added, visibleTo) {
  if (!added.length) return;
  // Don't announce the very first scan of a whole library
  if (added.length > 200 && !db.prepare('SELECT COUNT(*) AS n FROM notifications').get().n) return;
  const n = summarise(added);
  if (!n) return;
  db.prepare("INSERT INTO notifications (created_at, title, body, item_ids, image, kind) VALUES (?, ?, ?, ?, ?, 'new')").run(Date.now(), n.title, n.body, JSON.stringify(n.ids), n.image);
  db.prepare('DELETE FROM notifications WHERE id NOT IN (SELECT id FROM notifications ORDER BY id DESC LIMIT 100)').run();

  // Push to each subscribed device whose profile can see at least one of the items
  for (const s of db.prepare('SELECT ps.*, p.* FROM push_subs ps JOIN profiles p ON p.id = ps.profile_id').all()) {
    const visibleIds = n.ids.filter(id => visibleTo(s, id));
    if (n.ids.length && !visibleIds.length) continue;
    const payload = JSON.stringify({ title: n.title, body: n.body, url: visibleIds.length === 1 ? `/#/item/${visibleIds[0]}` : '/#/', image: n.image ? `/img/${n.image}` : null });
    try { await webpush.sendNotification(JSON.parse(s.sub), payload, { TTL: 86400 }); }
    catch (e) { if (e.statusCode === 404 || e.statusCode === 410) unsubscribe(s.endpoint); }
  }

  const hook = getSetting('webhook_url');
  if (hook) {
    const text = `${n.title}: ${n.body}`;
    const isNtfy = /ntfy/.test(hook);
    try {
      await fetch(hook, isNtfy
        ? { method: 'POST', headers: { Title: n.title, Tags: 'clapper' }, body: n.body, signal: AbortSignal.timeout(10000) }
        : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event: 'new_media', title: n.title, body: n.body, text, content: text, items: n.ids }), signal: AbortSignal.timeout(10000) });
    } catch (e) { console.warn('Webhook failed:', e.message); }
  }
}

// Send a push to every device of the matching profiles
async function pushTo(filter, payload) {
  for (const s of db.prepare('SELECT ps.endpoint, ps.sub, p.* FROM push_subs ps JOIN profiles p ON p.id = ps.profile_id').all()) {
    if (!filter(s)) continue;
    try { await webpush.sendNotification(JSON.parse(s.sub), JSON.stringify(payload), { TTL: 86400 }); }
    catch (e) { if (e.statusCode === 404 || e.statusCode === 410) unsubscribe(s.endpoint); }
  }
}
async function webhook(event, title, body, extra = {}) {
  const hook = getSetting('webhook_url');
  if (!hook) return;
  const text = `${title}: ${body}`;
  try {
    await fetch(hook, /ntfy/.test(hook)
      ? { method: 'POST', headers: { Title: title, Tags: event === 'alert' ? 'warning' : 'clapper' }, body, signal: AbortSignal.timeout(10000) }
      : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event, title, body, text, content: text, ...extra }), signal: AbortSignal.timeout(10000) });
  } catch (e) { console.warn('Webhook failed:', e.message); }
}
// A message for one person (e.g. "your request is ready") or for admins (kind 'alert')
async function message({ kind = 'info', profileId = null, title, body, url = '/#/', itemIds = [], image = null, admins = false }) {
  db.prepare('INSERT INTO notifications (created_at, title, body, item_ids, image, kind, profile_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(Date.now(), title, body, JSON.stringify(itemIds), image, admins ? 'alert' : kind, profileId);
  await pushTo(p => (admins ? p.is_admin : p.id === profileId), { title, body, url });
  if (admins) await webhook('alert', title, body);
}

async function test(profileId) {
  const subs = db.prepare('SELECT * FROM push_subs WHERE profile_id = ?').all(profileId);
  let sent = 0;
  for (const s of subs) {
    try { await webpush.sendNotification(JSON.parse(s.sub), JSON.stringify({ title: 'Marquee', body: 'Notifications are working 🎬', url: '/#/' })); sent++; }
    catch (e) { if (e.statusCode === 404 || e.statusCode === 410) unsubscribe(s.endpoint); }
  }
  return sent;
}

function list(limit = 40) {
  return db.prepare('SELECT * FROM notifications ORDER BY id DESC LIMIT ?').all(limit).map(n => ({ ...n, item_ids: JSON.parse(n.item_ids || '[]') }));
}

module.exports = { publicKey, subscribe, unsubscribe, onNewItems, list, test, message, pushTo, webhook };
