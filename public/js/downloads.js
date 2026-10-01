/* Marquee — downloads for offline viewing */
'use strict';

const Downloads = (() => {
  const CACHE = 'marquee-downloads';
  let pollTimer = null;
  const saved = () => store.get('mq_downloads', []);
  const jobs = () => store.get('mq_dl_jobs', []);
  const setJobs = j => { store.set('mq_dl_jobs', j); };
  const canKeepInApp = () => 'caches' in window && isSecureContext && !!navigator.serviceWorker?.controller;

  function start(item) {
    const m = modal(`<h2>Download ${esc(item.show ? item.show.title + ' · ' + epCode(item) : item.title)}</h2>
      <p class="hint">${canKeepInApp() || window.MarqueeNative?.download ? 'It’ll be saved inside Marquee so you can watch without internet — on a plane, in the car, anywhere.' : 'Marquee will prepare a phone-friendly copy, then save it as a video file on this device.'}</p>
      <div class="menu-list">
        <button data-q="720">${ICON.download}<span>Standard (720p) <small>Good on phones · about ${est(item, 3.2)}</small></span></button>
        <button data-q="480">${ICON.download}<span>Data saver (480p) <small>Smallest · about ${est(item, 1.4)}</small></span></button>
        <button data-q="1080">${ICON.download}<span>High (1080p) <small>Best for tablets · about ${est(item, 6.2)}</small></span></button>
      </div>`);
    $$('[data-q]', m.el).forEach(b => b.onclick = async () => {
      m.close();
      try { await startWith(item, b.dataset.q); toast('Preparing your download — see More → Downloads'); }
      catch (e) { toast(e.message); }
    });
  }
  async function startWith(item, quality, smart = false) {
    const v = await api('/api/versions', { body: { itemId: item.id, quality, reason: 'download' } });
    const j = jobs().filter(x => x.itemId !== item.id);
    j.push({ vid: v.id, itemId: item.id, quality, title: item.title, showTitle: item.show?.title || null, showId: item.show?.id || null, smart, code: item.show ? epCode(item) : '',
      poster: item.still || item.poster || item.show?.poster || null, duration: item.duration, state: 'preparing', pct: 0, at: Date.now() });
    setJobs(j);
    poll();
  }

  // "Smart downloads": keep the next few unwatched episodes of a show on this device, removing ones you've finished
  const smartAll = () => store.get('mq_smart', {});
  function smartFor(showId) { return smartAll()[showId] || null; }
  function smartSetup(show, redraw) {
    const curr = smartFor(show.id);
    const m = modal(`<h2>Auto-download ${esc(show.title)}</h2><p class="hint">Keeps the next unwatched episodes on this device, ready for when you're offline. Episodes you finish are removed to save space.</p>
      <div class="menu-list">${[0, 2, 3, 5].map(n => `<button data-n="${n}">${ICON.download}<span>${n ? `Keep the next ${n} episodes` : 'Off'}</span>${(curr?.count || 0) === n ? ICON.check : ''}</button>`).join('')}</div>
      <div class="field" style="margin-top:12px"><label>Quality</label><select class="input" id="sq">${[['720', 'Standard (720p)'], ['480', 'Data saver (480p)'], ['1080', 'High (1080p)']].map(([k, l]) => `<option value="${k}" ${(curr?.quality || '720') === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>`);
    $$('[data-n]', m.el).forEach(b => b.onclick = () => {
      const all = smartAll();
      const n = +b.dataset.n;
      if (n) all[show.id] = { count: n, quality: $('#sq', m.el).value, title: show.title }; else delete all[show.id];
      store.set('mq_smart', all);
      m.close();
      toast(n ? `Keeping the next ${n} episodes downloaded` : 'Auto-download off');
      syncSmart();
      redraw && redraw();
    });
  }
  async function syncSmart() {
    if (!canKeepInApp() && !window.MarqueeNative?.download && !Object.keys(smartAll()).length) return;
    for (const [showId, cfg] of Object.entries(smartAll())) {
      let show;
      try { show = await api(`/api/items/${showId}`); } catch { continue; }
      const eps = show.seasons.flatMap(s => s.episodes).filter(e => e.season !== 0);
      const start = show.nextEpisode ? Math.max(0, eps.findIndex(e => e.id === show.nextEpisode.id)) : eps.length;
      const want = eps.slice(start).filter(e => !e.progress?.watched).slice(0, cfg.count);
      const wantIds = new Set(want.map(e => e.id));
      for (const e of want) {
        if (isSaved(e.id) || jobs().some(j => j.itemId === e.id)) continue;
        try { await startWith({ ...e, show: { id: show.id, title: show.title, poster: show.poster } }, cfg.quality, true); } catch {}
      }
      for (const s of [...saved(), ...nativeItems()].filter(x => x.smart && String(x.showId) === String(showId) && !wantIds.has(x.itemId))) {
        const ep = eps.find(e => e.id === s.itemId);
        if (!ep || ep.progress?.watched) await remove(s.itemId);
      }
    }
  }
  // Downloads kept by the iPhone/iPad app (it tells us what it has)
  const nativeItems = () => window.MarqueeNative?._items || [];
  const isSaved = id => saved().some(s => s.itemId === id) || nativeItems().some(s => s.itemId === id);
  const est = (item, mbps) => item.duration ? fmtBytes(item.duration * mbps * 1e6 / 8) : '—';

  async function poll() {
    clearTimeout(pollTimer);
    const list = jobs();
    if (!list.some(j => ['preparing', 'saving'].includes(j.state))) return;
    for (const j of list.filter(x => x.state === 'preparing')) {
      try {
        const v = await api(`/api/versions/${j.vid}`);
        j.pct = Math.round((v.progress || 0) * 100);
        if (v.status === 'failed') j.state = 'failed';
        if (v.status === 'ready') {
          j.size = v.size;
          if (window.MarqueeNative?.download) {
            // iPhone/iPad app: the app saves the file itself and plays it with no internet
            MarqueeNative.download(`${location.origin}/api/versions/${j.vid}/file?download=1`, JSON.stringify({ itemId: j.itemId, title: j.title, showTitle: j.showTitle, showId: j.showId, smart: !!j.smart, code: j.code, quality: j.quality, poster: j.poster ? new URL(j.poster, location.origin).href : null, duration: j.duration }));
            j.state = 'native';
            toast(`Saving ${j.showTitle ? j.showTitle + ' · ' + j.code : j.title} to this device`);
          } else { j.state = canKeepInApp() ? 'saving' : 'file'; setJobs(list); if (j.state === 'saving') save(j); }
        }
      } catch (e) { if (e.status === 404) j.state = 'failed'; }
    }
    setJobs(list.filter(j => j.state !== 'native'));
    redraw();
    pollTimer = setTimeout(poll, 3000);
  }

  async function save(job) {
    try {
      const res = await fetch(`/api/versions/${job.vid}/file`, { credentials: 'same-origin' });
      if (!res.ok) throw new Error('Download failed');
      const total = +res.headers.get('content-length') || job.size || 0;
      // Stream straight into storage (no need to hold a whole movie in memory), counting bytes for the progress bar
      const reader = res.body.getReader();
      let got = 0, lastDraw = 0;
      const counted = new ReadableStream({
        async pull(ctrl) {
          const { done, value } = await reader.read();
          if (done) return ctrl.close();
          got += value.length;
          if (Date.now() - lastDraw > 500) { lastDraw = Date.now(); updateJob(job.itemId, { pct: total ? Math.round(got / total * 100) : 0 }); redraw(); }
          ctrl.enqueue(value);
        },
        cancel() { reader.cancel(); },
      });
      const cache = await caches.open(CACHE);
      await cache.put(`/offline/${job.itemId}`, new Response(counted, { headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(total) } }));
      const blob = { size: got };
      if (job.poster) { try { const art = await fetch(job.poster); if (art.ok) await cache.put(`/offline-art/${job.itemId}`, art); } catch {} }
      if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
      const list = saved().filter(s => s.itemId !== job.itemId);
      list.push({ itemId: job.itemId, title: job.title, showTitle: job.showTitle, showId: job.showId, smart: !!job.smart, code: job.code, quality: job.quality, size: blob.size, duration: job.duration, savedAt: Date.now(), hasArt: !!job.poster });
      store.set('mq_downloads', list);
      setJobs(jobs().filter(j => j.itemId !== job.itemId));
      toast(`${job.showTitle ? job.showTitle + ' · ' + job.code : job.title} is ready to watch offline`);
    } catch (e) {
      updateJob(job.itemId, { state: 'failed' });
      toast(e.name === 'QuotaExceededError' ? 'Not enough space on this device' : 'Download failed');
    }
    redraw();
  }
  function updateJob(itemId, patch) { setJobs(jobs().map(j => (j.itemId === itemId ? { ...j, ...patch } : j))); }

  async function remove(itemId) {
    if (nativeItems().some(s => s.itemId === itemId)) window.MarqueeNative.removeDownload(itemId);
    try { const c = await caches.open(CACHE); await c.delete(`/offline/${itemId}`); await c.delete(`/offline-art/${itemId}`); } catch {}
    store.set('mq_downloads', saved().filter(s => s.itemId !== itemId));
    setJobs(jobs().filter(j => j.itemId !== itemId));
  }

  // Progress made while offline is sent when we're back
  function queueProgress(p) { const q = store.get('mq_progress_queue', []); q.push(p); store.set('mq_progress_queue', q.slice(-200)); }
  async function flush() {
    const q = store.get('mq_progress_queue', []);
    if (!q.length) return;
    store.set('mq_progress_queue', []);
    for (const p of q) { try { await api('/api/progress', { body: p }); } catch { queueProgress(p); break; } }
  }

  let redrawFn = null;
  const redraw = () => redrawFn && redrawFn();
  return { start, startWith, poll, saved, jobs, remove, isSaved, queueProgress, flush, canKeepInApp, smartFor, smartSetup, syncSmart, setRedraw: fn => { redrawFn = fn; } };
})();

ROUTES.downloads = async () => {
  shell('more', `<div class="page settings"><h1 class="page-title">Downloads</h1><div id="dl"></div></div>`);
  const draw = async () => {
    const el = $('#dl');
    if (!el) return;
    const jobs = Downloads.jobs(), saved = Downloads.saved();
    let quota = '';
    try { const e = await navigator.storage.estimate(); quota = `Using ${fmtBytes(e.usage)} of about ${fmtBytes(e.quota)} available to Marquee on this device.`; } catch {}
    el.innerHTML = `
      ${Object.keys(store.get('mq_smart', {})).length ? `<div class="panel"><h2>Auto-downloads</h2><div class="list">${Object.entries(store.get('mq_smart', {})).map(([id, c]) => `<div class="list-item">
        <div class="grow"><div class="t">${esc(c.title)}</div><div class="s">Keeping the next ${c.count} episodes · ${c.quality}p</div></div><a class="btn small" href="#/item/${id}">Change</a></div>`).join('')}</div></div>` : ''}
      ${jobs.length ? `<div class="panel"><h2>In progress</h2><div class="list">${jobs.map(j => `<div class="list-item">
        <div class="grow"><div class="t">${esc(j.showTitle ? j.showTitle + ' · ' + j.code : j.title)}</div>
        <div class="s">${j.state === 'preparing' ? `Preparing on the server… ${j.pct}%` : j.state === 'saving' ? `Saving to this device… ${j.pct || 0}%` : j.state === 'file' ? 'Ready to save' : 'Failed'}</div>
        ${['preparing', 'saving'].includes(j.state) ? `<div class="progress-line"><i style="width:${j.pct || 0}%"></i></div>` : ''}</div>
        ${j.state === 'file' ? `<a class="btn small primary" href="/api/versions/${j.vid}/file?download=1" download data-done="${j.itemId}">Save file</a>` : ''}
        <button class="btn small" data-x="${j.itemId}">${j.state === 'failed' || j.state === 'file' ? 'Remove' : 'Cancel'}</button></div>`).join('')}</div></div>` : ''}
      ${window.MarqueeNative?.openDownloads ? `<div class="panel"><div class="list-item" style="padding:0"><div class="grow"><div class="t">Saved in the Marquee app</div><div class="s">Plays with no internet</div></div><button class="btn small primary" id="nativeDl">Open</button></div></div>` : ''}
      ${window.MarqueeNative?.openDownloads && !saved.length ? '' : `<div class="panel"><h2>On this device</h2>
        ${saved.length ? `<div class="list">${saved.map(s => `<div class="list-item">
          <a class="dl-art" href="#/play/${s.itemId}?offline=1">${s.hasArt ? `<img src="/offline-art/${s.itemId}" alt="">` : ICON.film}</a>
          <div class="grow"><div class="t">${esc(s.showTitle ? s.showTitle : s.title)}</div><div class="s">${s.showTitle ? esc(s.code + ' · ' + s.title) + ' · ' : ''}${esc(s.quality)}p · ${fmtBytes(s.size)}</div></div>
          <a class="btn small primary" href="#/play/${s.itemId}?offline=1">${ICON.play}</a><button class="btn small" data-x="${s.itemId}">${ICON.trash}</button></div>`).join('')}</div>`
        : `<p class="hint">Nothing downloaded yet. Tap ⋯ on a movie, or the ↓ next to an episode.</p>`}
        ${quota ? `<p class="hint" style="margin:12px 0 0">${quota}</p>` : ''}
        ${!Downloads.canKeepInApp() && !window.MarqueeNative?.openDownloads ? `<p class="hint" style="margin:12px 0 0">Tip: open Marquee at its <b>https://</b> Tailscale address (see the setup guide) and add it to your home screen — then downloads are kept inside the app and play with no internet.</p>` : ''}
      </div>`}`;
    $$('[data-x]', el).forEach(b => b.onclick = async () => { await Downloads.remove(+b.dataset.x); draw(); });
    if ($('#nativeDl')) $('#nativeDl').onclick = () => MarqueeNative.openDownloads();
    $$('[data-done]', el).forEach(a => a.addEventListener('click', () => setTimeout(async () => { await Downloads.remove(+a.dataset.done); draw(); }, 1500)));
  };
  Downloads.setRedraw(draw);
  onLeave(() => Downloads.setRedraw(null));
  await draw();
  if (!offline) Downloads.poll();
};
