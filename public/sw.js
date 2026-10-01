// Marquee service worker: instant app start, offline downloads, push notifications.
const SHELL_CACHE = 'marquee-shell-v5';
const DL_CACHE = 'marquee-downloads';
const SHELL = ['/', '/index.html', '/styles.css', '/js/core.js', '/js/media.js', '/js/downloads.js', '/js/pages.js', '/js/player.js', '/js/admin.js', '/js/extras.js', '/js/boot.js',
  '/vendor/hls.min.js', '/manifest.webmanifest', '/icons/icon.svg', '/icons/icon-192.png'];

self.addEventListener('install', e => { e.waitUntil(caches.open(SHELL_CACHE).then(c => c.addAll(SHELL)).catch(() => {})); self.skipWaiting(); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== SHELL_CACHE && k !== DL_CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});

// Serve a downloaded video from storage, honouring Range requests so seeking works offline
async function offlineVideo(req) {
  const cache = await caches.open(DL_CACHE);
  const url = new URL(req.url);
  const hit = await cache.match(url.pathname);
  if (!hit) return new Response('Not downloaded', { status: 404 });
  const range = req.headers.get('range');
  if (!range) return hit;
  const blob = await hit.blob();
  const m = /bytes=(\d*)-(\d*)/.exec(range);
  let start = m && m[1] ? +m[1] : 0;
  let end = m && m[2] ? +m[2] : blob.size - 1;
  if (m && !m[1] && m[2]) { start = blob.size - +m[2]; end = blob.size - 1; }
  end = Math.min(end, blob.size - 1);
  return new Response(blob.slice(start, end + 1), {
    status: 206,
    headers: { 'Content-Type': 'video/mp4', 'Content-Range': `bytes ${start}-${end}/${blob.size}`, 'Content-Length': String(end - start + 1), 'Accept-Ranges': 'bytes' },
  });
}

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/offline/')) return e.respondWith(offlineVideo(e.request));
  if (url.pathname.startsWith('/offline-art/')) return e.respondWith(caches.open(DL_CACHE).then(c => c.match(url.pathname)).then(r => r || new Response('', { status: 404 })));
  if (/^\/(api|img|cast|s|ext)\//.test(url.pathname) || url.pathname === '/app.apk') return;
  // App shell: network first (so updates arrive), fall back to cache when offline
  e.respondWith(fetch(e.request).then(res => {
    if (res.ok && SHELL.includes(url.pathname)) { const copy = res.clone(); caches.open(SHELL_CACHE).then(c => c.put(e.request, copy)); }
    return res;
  }).catch(() => caches.match(e.request).then(r => r || caches.match('/index.html'))));
});

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data.json(); } catch { d = { title: 'Marquee', body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Marquee', {
    body: d.body, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', image: d.image || undefined, data: { url: d.url || '/' }, tag: 'marquee-new',
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || '/';
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then(list => {
    for (const c of list) if ('focus' in c) { c.navigate(url).catch(() => {}); return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
