// Memories: photos and home videos from this day (and this week) in past years,
// plus a morning "You have memories from this day" notification.
const { db, getSetting, setSetting } = require('../db');
const C = require('../common');
const notify = require('./notify');

const pad = n => String(n).padStart(2, '0');
const md = d => `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function fmt(r, thisYear) {
  return { ...C.formatItem(r), thumb: r.type === 'photo' ? `/api/photo/${r.id}/thumb` : (r.still ? C.img(r.still) : null),
    display: r.type === 'photo' ? `/api/photo/${r.id}/display` : null, yearsAgo: thisYear - new Date(r.taken_at).getFullYear() };
}
function byYear(items) {
  const groups = new Map();
  for (const it of items) {
    const y = new Date(it.takenAt).getFullYear();
    if (!groups.has(y)) groups.set(y, { year: y, yearsAgo: it.yearsAgo, items: [] });
    groups.get(y).items.push(it);
  }
  return [...groups.values()].sort((a, b) => b.year - a.year);
}

function query(profile, days, limit) {
  const thisYear = new Date().getFullYear();
  const list = days.map(d => `'${md(d)}'`).join(',');
  return db.prepare(`SELECT i.* FROM items i JOIN libraries l ON l.id = i.library_id
    WHERE i.type IN ('photo','home') AND i.taken_at IS NOT NULL
      AND strftime('%m-%d', i.taken_at / 1000, 'unixepoch', 'localtime') IN (${list})
      AND CAST(strftime('%Y', i.taken_at / 1000, 'unixepoch', 'localtime') AS INTEGER) < ?
      AND ${C.visible(profile)}
    ORDER BY i.taken_at DESC LIMIT ${limit | 0}`).all(thisYear).map(r => fmt(r, thisYear));
}

function forProfile(profile) {
  const now = new Date();
  const today = query(profile, [now], 300);
  const near = [];
  for (let k = -3; k <= 3; k++) if (k) { const d = new Date(now); d.setDate(d.getDate() + k); near.push(d); }
  const todayIds = new Set(today.map(x => x.id));
  const week = query(profile, near, 300).filter(x => !todayIds.has(x.id));
  return { date: now.toISOString().slice(0, 10), today: byYear(today), week: byYear(week), count: today.length };
}

// Once a day (default 9am) tell each person if there are memories for them today
async function morningCheck() {
  if (getSetting('memories_notify', '1') !== '1') return;
  const now = new Date();
  const hour = +getSetting('memories_hour', '9');
  const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  if (now.getHours() < hour || getSetting('memories_last') === day) return;
  setSetting('memories_last', day);
  for (const p of db.prepare('SELECT * FROM profiles WHERE hidden = 0').all()) {
    const items = query(p, [now], 50);
    if (!items.length) continue;
    const years = [...new Set(items.map(i => i.yearsAgo))].sort((a, b) => a - b);
    const yearsText = years.length === 1 ? `${years[0]} year${years[0] === 1 ? '' : 's'} ago` : `${years.slice(0, -1).join(', ')} and ${years[years.length - 1]} years ago`;
    const photos = items.filter(i => i.type === 'photo').length, videos = items.length - photos;
    const what = [photos && `${photos} photo${photos === 1 ? '' : 's'}`, videos && `${videos} video${videos === 1 ? '' : 's'}`].filter(Boolean).join(' and ');
    await notify.message({ kind: 'memory', profileId: p.id, title: '📸 On this day', body: `${what} from ${yearsText}`, url: '/#/memories' }).catch(() => {});
  }
}
setInterval(() => morningCheck().catch(e => console.warn('Memories check failed:', e.message)), 10 * 60000).unref();
setTimeout(() => morningCheck().catch(() => {}), 30000).unref();

module.exports = { forProfile, morningCheck };
