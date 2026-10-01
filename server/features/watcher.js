// Spots new or removed files the moment they land, instead of waiting for the next scheduled scan.
const fs = require('fs');
const { db } = require('../db');

let watchers = [];
let timer = null;
const status = { watching: 0, failed: [] };

function start(onChange) {
  stop();
  status.failed = [];
  for (const lib of db.prepare('SELECT * FROM libraries').all()) {
    if (!fs.existsSync(lib.path)) continue;
    try {
      const w = fs.watch(lib.path, { recursive: true, persistent: false }, (event, file) => {
        if (file && /(^|\/)\.|\.part$|\.tmp$|\.!qB$|\.crdownload$/.test(file)) return; // ignore half-downloaded files
        clearTimeout(timer);
        // Wait for things to settle (copies can take a while)
        timer = setTimeout(onChange, 20000);
      });
      w.on('error', e => { status.failed.push(`${lib.name}: ${e.message}`); });
      watchers.push(w);
    } catch (e) {
      status.failed.push(`${lib.name}: ${e.code === 'ENOSPC' ? 'too many folders to watch (scheduled scans still work)' : e.message}`);
    }
  }
  status.watching = watchers.length;
}

function stop() {
  for (const w of watchers) try { w.close(); } catch {}
  watchers = [];
}

module.exports = { start, stop, status };
