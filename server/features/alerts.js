// Warns the admin when a drive is nearly full (media, database or streaming space).
const fs = require('fs');
const { db } = require('../db');
const { CONFIG_DIR, TRANSCODE_DIR } = require('../config');
const notify = require('./notify');

const status = { checkedAt: null, disks: [] };
const lastWarned = new Map();

function check() {
  const paths = [['Marquee data', CONFIG_DIR], ['Streaming space', TRANSCODE_DIR], ...db.prepare('SELECT name, path FROM libraries').all().map(l => [l.name, l.path])];
  const seen = new Map();
  status.disks = [];
  for (const [label, p] of paths) {
    let st;
    try { st = fs.statfsSync(p); } catch { continue; }
    const total = st.blocks * st.bsize, free = st.bavail * st.bsize;
    const key = `${st.type}:${total}`; // same drive → report once
    if (seen.has(key)) { seen.get(key).labels.push(label); continue; }
    const d = { labels: [label], path: p, total, free, pct: total ? free / total : 1 };
    d.low = d.pct < 0.08 || free < 10e9;
    seen.set(key, d);
    status.disks.push(d);
  }
  status.checkedAt = Date.now();
  for (const d of status.disks) {
    if (!d.low) continue;
    const k = d.labels.join(',');
    if (Date.now() - (lastWarned.get(k) || 0) < 24 * 3600000) continue;
    lastWarned.set(k, Date.now());
    const gb = (d.free / 1e9).toFixed(1);
    notify.message({ admins: true, title: 'Storage almost full', body: `Only ${gb} GB left on the drive with ${d.labels.join(', ')}. Free up space so downloads and streaming keep working.`, url: '/#/settings' }).catch(() => {});
  }
  return status;
}

setInterval(check, 30 * 60000).unref();
setTimeout(check, 30000).unref();
module.exports = { check, status };
