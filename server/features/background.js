// Keeps heavy background work (preview thumbnails, intro detection, face scanning, AI subtitles) out of the way.
// On a small box these jobs can take days after the first scan, and they must never make browsing or playback stutter:
//  • they wait while anyone is watching or using the app
//  • only one heavy job runs at a time
//  • their ffmpeg runs at the lowest priority
const { spawn, execFileSync } = require('child_process');

let lastRequest = 0;
const QUIET_MS = 45000;

let hasNice = false, hasIonice = false;
try { execFileSync('nice', ['true'], { stdio: 'ignore' }); hasNice = true; } catch {}
try { execFileSync('ionice', ['-c', '3', 'true'], { stdio: 'ignore' }); hasIonice = true; } catch {}

/** Called for every app request, so background work knows someone is here. */
function touch() { lastRequest = Date.now(); }

function busy() {
  let watching = false;
  try { watching = require('../stream').sessions.size > 0 || require('./activity').active().some(a => a.state !== 'paused'); } catch {}
  return watching || Date.now() - lastRequest < QUIET_MS;
}

/** Resolves once nobody has been watching or browsing for a little while. */
async function idle() {
  while (busy()) await new Promise(r => setTimeout(r, 10000).unref());
}

// One heavy job at a time
let chain = Promise.resolve();
function turn(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

/** spawn(), but at the lowest CPU and disk priority. */
function spawnLow(cmd, args, opts) {
  if (hasNice && hasIonice) return spawn('ionice', ['-c', '3', 'nice', '-n', '19', cmd, ...args], opts);
  if (hasNice) return spawn('nice', ['-n', '19', cmd, ...args], opts);
  return spawn(cmd, args, opts);
}

module.exports = { touch, busy, idle, turn, spawnLow };
