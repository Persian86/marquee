const express = require('express');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { db, refreshDups } = require('./db');
const C = require('./common');
const scanner = require('./scanner');
const tmdb = require('./tmdb');
const core = require('./routes/core');
const library = require('./routes/library');
const admin = require('./routes/admin');
const cast = require('./features/cast');
const intro = require('./features/intro');
const notify = require('./features/notify');
const backup = require('./features/backup');
const versions = require('./features/versions');
const extra = require('./routes/extra');
const trickplay = require('./features/trickplay');
const requests = require('./features/requests');
require('./features/alerts');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'SAMEORIGIN' });
  next();
});
const bigJson = express.json({ limit: '100mb' }), smallJson = express.json({ limit: '1mb' });
app.use((req, res, next) => (req.path === '/api/admin/restore' || /^\/api\/admin\/items\/\d+\/image$/.test(req.path) || /^\/api\/admin-theme\/\d+$/.test(req.path) || req.path === '/api/admin/app-upload' ? bigJson : smallJson)(req, res, next));

// Guest share links (also served alone on SHARE_PORT for Tailscale Funnel)
const share = require('./features/share');
app.use(share.router());

// Chromecast fetches these directly (signed links, no login)
app.options('/cast/:token/:file', (req, res) => res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' }).end());
app.get('/cast/:token/video.mp4', cast.serveMedia);
app.get('/cast/:token/subs.vtt', C.wrap(cast.serveSubs));

// Keep the "which copy of a film to show" answers fresh (a no-op unless the library changed)
const background = require('./features/background');
app.use(['/api', '/ext/v1', '/img'], (req, res, next) => { if (!/^\/(devices|status|notifications)/.test(req.path)) background.touch(); next(); });
app.use('/ext/v1', require('./routes/ext').router); // other apps (FamilyNest, widgets, voice) — app-key sign-in
app.use('/api', core.router);              // includes sign-in; everything after this needs a session
app.use('/api', library.router);
app.use('/api', extra.router);
app.use('/api', require('./routes/family').router);
app.use('/api', require('./routes/watch').router);
app.use('/api', require('./routes/ext').manage);
app.use('/api/admin', admin.router);
const admin2 = require('./routes/admin2');
app.use('/api/admin', admin2.admin);
app.use('/api', admin2.open);

// Artwork
app.get('/img/tmdb/:size/:file', core.auth, C.wrap(async (req, res) => {
  const name = await tmdb.cacheTmdbPath(`tmdb/${req.params.size}/${req.params.file}`);
  if (!name) return res.status(404).end();
  res.set('Cache-Control', 'private, max-age=2592000, immutable').sendFile(path.join(tmdb.IMG_DIR, name));
}));
app.use('/img', core.auth, express.static(tmdb.IMG_DIR, { maxAge: '30d', immutable: true }));

// The Android app, for easy installs on Fire TV / Android TV with the Downloader app: put marquee.apk in the config folder
app.get('/app.apk', (req, res) => {
  const f = path.join(config.CONFIG_DIR, 'marquee.apk');
  if (!fs.existsSync(f)) return res.status(404).send('Upload the Android app in Marquee → Settings → Apps (or put marquee.apk in /DATA/AppData/marquee/config).');
  const v = require('./features/apk').current();
  res.download(f, v?.versionName ? `marquee-${v.versionName}.apk` : 'marquee.apk', { headers: { 'Content-Type': 'application/vnd.android.package-archive' } });
});

// Web app
app.get('/vendor/hls.min.js', (req, res) => res.sendFile(require.resolve('hls.js/dist/hls.min.js')));
app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html', maxAge: 0 }));
app.get(/^\/(?!api|img|cast|ext|s\/|app\.apk).*/, (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return;
  res.status(err.status || 500).json({ error: err.type === 'entity.too.large' ? 'That file is too big' : err.message || 'Server error' });
});

// ---------- start ----------
function seedLibraries() {
  if (db.prepare('SELECT COUNT(*) AS n FROM libraries').get().n > 0) return;
  const names = { movie: 'Movies', tv: 'TV Shows', home: 'Home Videos', music: 'Music', photo: 'Photos' };
  for (const pair of config.DEFAULT_LIBRARIES.split(',')) {
    const [type, p] = pair.split(':').map(s => s && s.trim());
    if (!names[type] || !p || !fs.existsSync(p)) continue;
    try { if (!fs.readdirSync(p).length && !['movie', 'tv'].includes(type)) continue; } catch { continue; }
    // Family content (home videos, music, photos) is visible to kids profiles by default
    db.prepare('INSERT OR IGNORE INTO libraries(name, type, path, kids_safe) VALUES (?, ?, ?, ?)').run(names[type], type, p, ['home', 'music', 'photo'].includes(type) ? 1 : 0);
    console.log(`Added library ${p}`);
  }
}

// After each scan: find intros, announce new arrivals, finish any restore, tidy prepared copies
scanner.onScanComplete(async added => {
  try { refreshDups(true); } catch (e) { console.warn('refreshDups:', e.message); }
  backup.applyPending();
  notify.onNewItems(added, C.visibleTo).catch(e => console.warn('Notify failed:', e.message));
  requests.checkArrivals().catch(() => {});
  versions.cleanup();
  await intro.detectAll();
  trickplay.cleanup();
  trickplay.run();
  require('./features/aisubs').autoQueue(added);
  require('./features/faces').run().catch(e => console.warn('Faces failed:', e.message));
});

seedLibraries();
try { refreshDups(true); } catch (e) { console.warn('refreshDups:', e.message); }
const DAY = 1000 * 60 * 60 * 24;
db.prepare('DELETE FROM sessions WHERE last_seen < ?').run(Date.now() - DAY * 365);
db.prepare('DELETE FROM sessions WHERE guest = 1 AND created_at < ?').run(Date.now() - DAY * 30);
app.listen(config.PORT, '0.0.0.0', () => {
  console.log(`Marquee running on http://0.0.0.0:${config.PORT}  (hwaccel: ${config.HWACCEL})`);
  setTimeout(scanner.scanAll, 2000);
  if (config.SCAN_INTERVAL_MIN > 0) setInterval(scanner.scanAll, config.SCAN_INTERVAL_MIN * 60000).unref();
  admin.restartWatcher();
  backup.schedule();
});
if (config.SHARE_PORT) share.startPublicServer(config.SHARE_PORT);
