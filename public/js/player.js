/* Marquee — video player: adaptive quality, intro skip, watch parties, Chromecast, AirPlay, offline */
'use strict';

const QUALITY_ORDER = ['original', '1080', '720', '480', '360'];
const QUALITY_BITRATE = { original: 25e6, '1080': 8e6, '720': 4e6, '480': 1.5e6, '360': 0.7e6 };
function qualityPref() { return store.get('mq_quality', 'auto'); }

// Quick connection check, cached for 10 minutes
async function measureSpeed() {
  const cached = store.get('mq_speed');
  if (cached && Date.now() - cached.at < 600000) return cached.mbps;
  const t0 = performance.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 6000);
  let bytes = 0;
  try {
    const res = await fetch('/api/speedtest?kb=1536', { signal: ctl.signal, cache: 'no-store' });
    const reader = res.body.getReader();
    for (;;) { const { done, value } = await reader.read(); if (done) break; bytes += value.length; }
  } catch {}
  clearTimeout(timer);
  const secs = Math.max(0.05, (performance.now() - t0) / 1000);
  const mbps = (bytes * 8 / secs) / 1e6;
  store.set('mq_speed', { mbps, at: Date.now() });
  return mbps;
}
async function autoQuality() {
  const c = navigator.connection;
  const cellular = c && (c.type === 'cellular' || c.saveData);
  const mbps = await measureSpeed();
  let q = mbps > 30 ? 'original' : mbps > 14 ? '1080' : mbps > 7 ? '720' : mbps > 3 ? '480' : '360';
  if (cellular && QUALITY_ORDER.indexOf(q) < 2) q = '720';
  return q;
}

function deviceCaps() {
  const v = document.createElement('video');
  const can = t => !!v.canPlayType(t);
  return {
    h264: can('video/mp4; codecs="avc1.640028"'), hevc: can('video/mp4; codecs="hvc1.1.6.L120.90"'),
    vp9: can('video/webm; codecs="vp9"'), av1: can('video/mp4; codecs="av01.0.05M.08"'),
    ac3: can('audio/mp4; codecs="ac-3"'), eac3: can('audio/mp4; codecs="ec-3"'), mkv: false,
  };
}

// ---------- Chromecast SDK (loaded only when it can work) ----------
const CastKit = (() => {
  let ready = null;
  const supported = () => /Chrome\//.test(navigator.userAgent) && !/iPhone|iPad|iPod|Edg\//.test(navigator.userAgent) && isSecureContext;
  function load() {
    if (!supported()) return Promise.resolve(false);
    if (ready) return ready;
    ready = new Promise(resolve => {
      window.__onGCastApiAvailable = ok => {
        if (!ok) return resolve(false);
        try {
          cast.framework.CastContext.getInstance().setOptions({
            receiverApplicationId: chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
            autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
          });
          resolve(true);
        } catch { resolve(false); }
      };
      const s = document.createElement('script');
      s.src = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1';
      s.onerror = () => resolve(false);
      document.head.appendChild(s);
      setTimeout(() => resolve(false), 8000);
    });
    return ready;
  }
  return { load, supported };
})();

ROUTES.play = async id => {
  const ps = params();
  const explicitStart = ps.has('t') ? +ps.get('t') : null;
  const offlineMode = ps.get('offline') === '1';
  let roomCode = ps.get('room');
  MiniPlayer.pauseForVideo();

  app.innerHTML = `<div class="player" id="pl">
    <video id="v" playsinline webkit-playsinline preload="auto" x-webkit-airplay="allow"></video>
    <div class="p-status" id="pst"><div class="spinner"></div></div>
    <div class="p-flash l" id="fl">−10s</div><div class="p-flash r" id="fr">+10s</div>
    <div class="p-reactions" id="preact"></div>
    <div class="p-ui" id="ui">
      <div class="p-top"><button class="icon-btn" id="pback" aria-label="Back">${ICON.arrowLeft}</button><div class="p-title" id="ptitle"></div>
        <span class="p-badge hidden" id="pparty"></span><span class="p-badge hidden" id="pbadge"></span>
        <button class="icon-btn hidden" id="ppip" aria-label="Picture in picture">${ICON.pip}</button>
        <button class="icon-btn hidden" id="pairplay" aria-label="AirPlay">${ICON.airplay}</button>
        <button class="icon-btn hidden" id="pcast" aria-label="Cast to TV">${ICON.cast}</button></div>
      <div class="p-center"><button id="pb10" aria-label="Back 10 seconds">${ICON.back10}</button><button class="big" id="pplay" aria-label="Play">${ICON.play}</button><button id="pf30" aria-label="Forward 30 seconds">${ICON.fwd30}</button></div>
      <div class="p-bottom">
        <div class="p-skip"><button class="btn small hidden" id="precap">Skip recap ${ICON.chevron}</button><button class="btn small hidden" id="pskip">Skip intro ${ICON.chevron}</button></div>
        <div class="seek" id="seek"><div class="trick hidden" id="trick"><div id="trickImg"></div><span id="trickT"></span></div><div class="track"><div class="buf" id="sbuf"></div><div class="intro-mark hidden" id="imark"></div><div class="fill" id="sfill"></div><div class="knob" id="sknob"></div></div><div class="tip" id="stip"></div></div>
        <div class="p-controls"><span class="p-time" id="ptime">0:00 / 0:00</span>
          <button class="icon-btn hidden" id="pnext" aria-label="Next">${ICON.next}</button>
          <button class="icon-btn" id="pmenuBtn" aria-label="Quality, audio, subtitles and watch party">${ICON.settings}</button>
          <button class="icon-btn" id="pfs" aria-label="Full screen">${ICON.expand}</button></div>
      </div>
    </div>
  </div>`;
  const root = $('#pl'), video = $('#v'), ui = $('#ui');
  const S = {
    info: null, item: null, offset: 0, mode: null, hls: null, auto: qualityPref() === 'auto', quality: qualityPref() === 'auto' ? null : qualityPref(),
    audioIndex: 0, subKey: store.get('mq_subs_on', null), burnKey: null, subCache: {}, track: null, loadingSeq: 0, loading: false,
    lastSaved: 0, closed: false, upnextShown: false, menu: null, dragging: false, introSkipped: false, warned: false,
    stalls: [], stallStart: 0, loadedAt: 0, lastUpCheck: 0, cast: null, room: null, remoteAt: 0, clockOffset: 0, members: [],
    night: store.get('mq_night', false), audioCtx: null, trick: null, recapSkipped: false, rate: store.get('mq_rate', 1) || 1, sleepTimer: null, sleepAt: 0,
  };
  const clientId = deviceId + '-' + Math.random().toString(36).slice(2, 7);

  // ---------- time helpers (work for local, cast and offline) ----------
  const remote = () => S.cast && S.cast.player;
  const cur = () => (remote() ? S.cast.offset + (S.cast.player.currentTime || 0) : S.offset + (video.currentTime || 0));
  const dur = () => S.info?.duration || S.item?.duration || (isFinite(video.duration) ? video.duration : 0);
  const paused = () => (remote() ? S.cast.player.isPaused : video.paused);
  const available = () => {
    if (S.mode === 'direct') return dur();
    if (S.hls) { const d = S.hls.levels?.[0]?.details; return d ? d.totalduration : 0; }
    return video.seekable.length ? video.seekable.end(video.seekable.length - 1) : 0;
  };
  const busy = on => { const el = $('#pst'); if (el && !el.dataset.locked) el.innerHTML = on ? '<div class="spinner"></div>' : ''; };

  // ---------- progress heartbeats ----------
  const beat = async force => {
    if (!S.item || !dur()) return;
    const t = cur();
    if (!force && Math.abs(t - S.lastSaved) < 3) return;
    S.lastSaved = t;
    const body = { itemId: S.item.id, position: t, duration: dur(), deviceId, state: paused() ? 'paused' : 'playing' };
    if (offlineMode) { Downloads.queueProgress(body); return; }
    try {
      const r = await api('/api/progress', { body, keepalive: true });
      if (r.stop) blocked(r.stop, r.reason);
      else if (r.finishing && !S.noNext) { S.noNext = r.finishing; S.noNextReason = r.reason; toast('Time’s up after this episode — enjoy the end!', 5000); }
      else if (r.remaining != null && r.remaining <= 300 && !S.warned) { S.warned = true; toast(`${Math.ceil(r.remaining / 60)} minutes of watching left today`, 4000); }
    } catch {}
  };
  const beatTimer = setInterval(() => { if (!paused()) beat(); }, 10000);

  function blocked(message, reason, finished = false) {
    try { video.pause(); } catch {}
    if (remote()) { try { S.cast.controller.playOrPause(); } catch {} }
    const el = $('#pst');
    el.dataset.locked = '1';
    el.style.pointerEvents = 'auto';
    el.innerHTML = `<div class="p-error">${reason === 'bedtime' ? '<div class="big-emoji">🌙</div>' : finished ? '<div class="big-emoji">👋</div>' : reason ? '<div class="big-emoji">⏰</div>' : ''}<h2>${esc(finished ? "That's it for today!" : message)}</h2>
      ${finished ? `<p>${esc(message)} See you next time.</p>` : reason ? '<p>Ask a grown-up if you need more time.</p>' : ''}<button class="btn primary" id="pblockBack">OK</button></div>`;
    $('#pblockBack').onclick = () => close();
    root.classList.remove('idle');
  }

  // ---------- night mode: calmer loud bits, clearer voices ----------
  const isIOSDevice = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  function nightOnServer() { return isIOSDevice || !(window.AudioContext || window.webkitAudioContext); }
  function applyNight() {
    if (nightOnServer()) return;
    try {
      if (!S.audioCtx) {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const src = ctx.createMediaElementSource(video);
        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = -30; comp.knee.value = 20; comp.ratio.value = 8; comp.attack.value = 0.005; comp.release.value = 0.25;
        const voice = ctx.createBiquadFilter(); voice.type = 'peaking'; voice.frequency.value = 2500; voice.Q.value = 1; voice.gain.value = 5;
        const gain = ctx.createGain(); gain.gain.value = 1.6;
        S.audioCtx = { ctx, src, comp, voice, gain };
      }
      const a = S.audioCtx;
      a.src.disconnect(); a.comp.disconnect(); a.voice.disconnect(); a.gain.disconnect();
      if (S.night) { a.src.connect(a.voice); a.voice.connect(a.comp); a.comp.connect(a.gain); a.gain.connect(a.ctx.destination); }
      else a.src.connect(a.ctx.destination);
      if (a.ctx.state === 'suspended') a.ctx.resume();
    } catch (e) { console.warn('Night mode unavailable', e); }
  }

  // ---------- loading streams ----------
  async function load(start, autoplay = true) {
    const seq = ++S.loadingSeq;
    S.loading = true;
    busy(true);
    if (S.hls) { S.hls.destroy(); S.hls = null; }
    if (offlineMode) {
      const saved = Downloads.saved().find(s => s.itemId === +id);
      S.info = { itemId: +id, duration: saved?.duration, subtitles: [], audioTracks: [], qualities: [], mode: 'direct' };
      S.mode = 'direct'; S.offset = 0;
      video.src = `/offline/${id}`;
      await new Promise(r => video.addEventListener('loadedmetadata', r, { once: true }));
      if (start > 0) video.currentTime = start;
    } else {
      if (S.auto && !S.quality) S.quality = await autoQuality();
      let info;
      try {
        info = await api(`/api/play/${id}`, { body: { quality: S.quality, caps: deviceCaps(), audioIndex: S.audioIndex, start, deviceId, subKey: S.burnKey, forceStream: !!S.forceHls, forceTranscode: !!S.forceTranscode, night: S.night && nightOnServer() } });
      } catch (e) {
        if (e.status === 403) return blocked(e.message, e.data?.code);
        throw e;
      }
      if (seq !== S.loadingSeq || S.closed) return;
      S.info = info; S.mode = info.mode; S.offset = info.mode === 'direct' ? 0 : info.start;
      const badge = $('#pbadge');
      badge.classList.toggle('hidden', info.mode === 'direct' && S.quality === 'original');
      badge.textContent = info.prepared ? `Ready copy · ${info.prepared}p` : info.mode === 'direct' ? (info.hdr ? 'Direct · HDR' : 'Direct') : info.transcoding ? `${S.auto ? 'Auto · ' : ''}${S.quality === 'original' ? 'Converting' : S.quality + 'p'}${info.hw ? ' · GPU' : ''}${info.hdr ? ' · HDR' : ''}` : 'Direct stream';
      const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
      const native = !!video.canPlayType('application/vnd.apple.mpegurl') && (isIOS || !(window.Hls && Hls.isSupported()));
      if (info.mode === 'direct') {
        video.src = info.url;
        await new Promise(r => video.addEventListener('loadedmetadata', r, { once: true }));
        if (start > 0) video.currentTime = start;
      } else if (native || !window.Hls || !Hls.isSupported()) {
        video.src = info.url;
      } else {
        const hls = new Hls({ startPosition: 0, maxBufferLength: 40, maxMaxBufferLength: 120, backBufferLength: 120,
          manifestLoadingTimeOut: 60000, manifestLoadingMaxRetry: 2, fragLoadingTimeOut: 60000, levelLoadingTimeOut: 60000 });
        S.hls = hls;
        let mediaRecoveries = 0;
        hls.on(Hls.Events.ERROR, (_, d) => {
          if (!d.fatal) return;
          if (d.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRecoveries++ < 1) hls.recoverMediaError();
          else if (d.type === Hls.ErrorTypes.MEDIA_ERROR) failover(d.details);
          else if (d.type === Hls.ErrorTypes.NETWORK_ERROR && !S.netRetry) { S.netRetry = true; setTimeout(() => load(cur(), !video.paused), 1000); }
          else failover(d.details || 'The stream stopped unexpectedly.');
        });
        hls.loadSource(info.url);
        hls.attachMedia(video);
      }
      S.netRetry = false;
    }
    S.loadedAt = Date.now();
    S.stalls = [];
    applySubs();
    if (S.night || S.audioCtx) applyNight();
    video.playbackRate = S.rate || 1;
    paintChapters();
    if (autoplay) video.play().catch(() => { busy(false); paint(); });
    setTimeout(() => { S.loading = false; }, 600);
    mediaSession();
  }

  // When this device can't play what it was sent, try the next-safest way before giving up:
  // original file → streamed copy → fully converted → lower quality.
  function failover(detail) {
    if (S.closed) return;
    const again = note => { if (note) toast(note, 3500); return load(cur(), true).catch(() => showError('This device couldn’t play the file.')); };
    if (offlineMode) return showError('This download couldn’t be played.');
    if (S.mode === 'direct' && !S.forceHls) { S.forceHls = true; return again(); }
    if (!S.forceTranscode) {
      S.forceTranscode = true;
      if (!S.quality || S.quality === 'original') S.quality = '1080';
      return again('Converting this one for your device…');
    }
    if (!S.steppedDown) {
      S.steppedDown = true; S.auto = false;
      S.quality = S.quality === '480' || S.quality === '360' ? '360' : S.quality === '720' ? '480' : '720';
      return again('Trying a lower quality…');
    }
    console.warn('Playback failed:', detail);
    showError('This device couldn’t play this video, even after converting it. Try again, or try another device.');
  }

  function showError(msg) {
    busy(false);
    const el = $('#pst');
    el.innerHTML = `<div class="p-error"><h2>Can't play this</h2><p>${esc(msg)}</p><div class="btn-row" style="justify-content:center">
      <button class="btn primary" id="perrRetry">Try again</button>${offlineMode ? '' : '<button class="btn" id="perrLow">Try lower quality</button>'}</div></div>`;
    el.style.pointerEvents = 'auto';
    $('#perrRetry').onclick = () => { el.style.pointerEvents = ''; load(cur()); };
    if ($('#perrLow')) $('#perrLow').onclick = () => { el.style.pointerEvents = ''; S.auto = false; S.quality = '480'; load(cur()); };
  }

  // ---------- adaptive quality ----------
  function onStall() {
    if (!S.auto || S.loading || S.mode === 'direct' && S.quality === 'original' && false) return;
    if (Date.now() - S.loadedAt < 8000 || S.seeking) return;
    S.stallStart = Date.now();
    S.stalls.push(Date.now());
    S.stalls = S.stalls.filter(t => Date.now() - t < 60000);
    if (S.stalls.length >= 2) stepDown();
  }
  function onResume() {
    if (S.stallStart && Date.now() - S.stallStart > 5000 && Date.now() - S.loadedAt > 8000) stepDown();
    S.stallStart = 0;
  }
  function stepDown() {
    const i = QUALITY_ORDER.indexOf(S.quality);
    if (i < 0 || i >= QUALITY_ORDER.length - 1 || offlineMode || remote()) return;
    S.quality = QUALITY_ORDER[i + 1];
    store.set('mq_speed', null);
    toast(`Connection is slow — switching to ${S.quality}p`, 3000);
    load(cur(), true);
  }
  setInterval(() => { // step back up when the connection improves (hls.js measures bandwidth for us)
    if (!S.auto || !S.hls || paused() || Date.now() - S.loadedAt < 90000 || S.stalls.length) return;
    const i = QUALITY_ORDER.indexOf(S.quality);
    if (i <= 0) return;
    const up = QUALITY_ORDER[i - 1];
    if ((S.hls.bandwidthEstimate || 0) > QUALITY_BITRATE[up] * 2.5) { S.quality = up; toast(`Connection improved — switching to ${up === 'original' ? 'original quality' : up + 'p'}`, 3000); load(cur(), true); }
  }, 30000);

  // ---------- subtitles (cues shifted to match where the stream started) ----------
  function parseVTT(text) {
    const cues = [];
    const toSec = t => { const p = t.trim().split(':').map(parseFloat); return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1]; };
    for (const block of text.replace(/\r/g, '').split(/\n\n+/)) {
      const lines = block.split('\n');
      const i = lines.findIndex(l => l.includes('-->'));
      if (i < 0) continue;
      const [a, b] = lines[i].split('-->');
      cues.push({ start: toSec(a), end: toSec(b.trim().split(/\s+/)[0]), text: lines.slice(i + 1).join('\n').replace(/<(?!\/?[ibu]>)[^>]+>/g, '') });
    }
    return cues;
  }
  async function applySubs() {
    if (!S.track) S.track = video.addTextTrack('subtitles', 'Subtitles', 'en');
    const tr = S.track;
    tr.mode = 'hidden';
    while (tr.cues && tr.cues.length) tr.removeCue(tr.cues[0]);
    const sub = S.info?.subtitles?.find(s => s.key === S.subKey && !s.burn);
    if (!sub) return;
    try {
      if (!S.subCache[sub.url]) S.subCache[sub.url] = parseVTT(await (await fetch(sub.url)).text());
      const off = S.offset;
      for (const c of S.subCache[sub.url]) {
        if (c.end - off <= 0) continue;
        const cue = new VTTCue(Math.max(0, c.start - off), c.end - off, c.text);
        cue.line = -3;
        tr.addCue(cue);
      }
      tr.mode = 'showing';
    } catch { toast('Couldn’t load subtitles'); }
  }

  // ---------- seeking & play control ----------
  function seek(t, fromRemote) {
    t = Math.max(0, Math.min(t, Math.max(0, dur() - 1)));
    if (S.item?.intro && t >= S.item.intro.end - 1) S.introSkipped = true;
    if (!fromRemote) party('seek', t);
    if (remote()) {
      if (S.cast.seekable) { S.cast.player.currentTime = t - S.cast.offset; S.cast.controller.seek(); }
      else castLoad(t);
      paint(t);
      return;
    }
    S.seeking = true; setTimeout(() => { S.seeking = false; }, 1500);
    if (S.mode === 'direct') { video.currentTime = t; return paint(t); }
    const rel = t - S.offset;
    if (rel >= 0 && rel <= available() - 2) video.currentTime = rel;
    else load(t, true);
    paint(t);
  }
  function togglePlay(fromRemote) {
    if (remote()) { S.cast.controller.playOrPause(); if (!fromRemote) party(S.cast.player.isPaused ? 'play' : 'pause'); return; }
    if (video.paused) video.play().catch(() => {}); else video.pause();
  }

  // ---------- UI painting ----------
  function paint(forced) {
    const d = dur(), t = forced ?? cur();
    if (!S.dragging) {
      const pct = d ? Math.min(100, t / d * 100) : 0;
      $('#sfill').style.width = pct + '%'; $('#sknob').style.left = pct + '%';
    }
    let bufEnd = 0;
    if (!remote()) for (let i = 0; i < video.buffered.length; i++) if (video.buffered.start(i) <= video.currentTime + 1) bufEnd = Math.max(bufEnd, video.buffered.end(i));
    $('#sbuf').style.width = (d && !remote() ? Math.min(100, (S.offset + bufEnd) / d * 100) : 0) + '%';
    $('#ptime').textContent = `${fmtTime(t)} / ${fmtTime(d)}`;
    $('#pplay').innerHTML = paused() ? ICON.play : ICON.pause;
    // recap ("Previously on…")
    const recap = S.item?.recap;
    if (recap) {
      const inRecap = t >= recap.start && t < recap.end - 1;
      $('#precap').classList.toggle('hidden', !inRecap);
      if (inRecap && !S.recapSkipped && me?.autoSkipIntro && !paused() && !S.loading) { S.recapSkipped = true; seek(recap.end); toast('Skipped recap'); }
    }
    if (window.__player && S.item) Devices.report({ itemId: S.item.id, title: S.item.show ? `${S.item.show.title} · ${epCode(S.item)}` : S.item.title, position: t, duration: d, playing: !paused() });
    // intro
    const intro = S.item?.intro;
    if (intro && d) {
      const m = $('#imark'); m.classList.remove('hidden');
      m.style.left = (intro.start / d * 100) + '%'; m.style.width = ((intro.end - intro.start) / d * 100) + '%';
      const inIntro = t >= intro.start - 0.5 && t < intro.end - 1.5;
      $('#pskip').classList.toggle('hidden', !inIntro);
      if (inIntro && !S.introSkipped && me?.autoSkipIntro && !paused() && !S.loading) { S.introSkipped = true; seek(intro.end); toast('Skipped intro'); }
    }
  }
  video.addEventListener('timeupdate', () => { if (!remote()) { paint(); checkUpNext(); } });
  video.addEventListener('progress', () => paint());
  video.addEventListener('play', () => { paint(); bump(); if (!S.loading) party('play'); window.MarqueeNative?.playing(true); });
  video.addEventListener('pause', () => { window.MarqueeNative?.playing(false); paint(); if (!S.closed && !S.loading) { beat(true); party('pause'); } showUI(true); });
  video.addEventListener('waiting', () => { busy(true); onStall(); });
  video.addEventListener('playing', () => { busy(false); onResume(); });
  video.addEventListener('canplay', () => busy(false));
  video.addEventListener('ended', () => {
    beat(true);
    if (S.noNext) return blocked(S.noNext, S.noNextReason || 'limit', true);
    if (S.stopAfter) { S.stopAfter = false; toast('Stopped after this episode'); return showUI(true); }
    if (S.item?.nextId && !offlineMode) playNext(); else showUI(true);
  });
  video.addEventListener('error', () => {
    if (!video.error || !S.mode || S.closed) return;
    failover(video.error.message || 'Playback error');
  });

  // ---------- controls visibility ----------
  let hideT;
  function showUI(stay) { root.classList.remove('idle'); clearTimeout(hideT); if (!stay) hideT = setTimeout(() => { if (!paused() && !S.menu && !S.dragging) root.classList.add('idle'); }, 3200); }
  const bump = () => showUI(false);
  root.addEventListener('pointermove', e => { if (e.pointerType === 'mouse') bump(); });
  let lastTap = 0, tapT;
  ui.addEventListener('click', e => {
    if (e.target.closest('button, a, .seek, .p-menu, .upnext, .p-resume, .party-bar')) { bump(); return; }
    if (S.menu) { closeMenu(); return; }
    const touch = matchMedia('(pointer:coarse)').matches;
    const now = Date.now();
    const x = e.clientX / innerWidth;
    if (now - lastTap < 300 && (x < .35 || x > .65)) {
      clearTimeout(tapT); lastTap = 0;
      seek(cur() + (x < .5 ? -10 : 10));
      const f = $(x < .5 ? '#fl' : '#fr'); f.classList.add('on'); setTimeout(() => f.classList.remove('on'), 350);
      return;
    }
    lastTap = now;
    clearTimeout(tapT);
    tapT = setTimeout(() => {
      if (touch) { root.classList.contains('idle') ? bump() : (paused() ? null : root.classList.add('idle')); }
      else { togglePlay(); bump(); }
    }, touch ? 280 : 200);
  });
  $('#pplay').onclick = () => togglePlay();
  $('#pb10').onclick = () => seek(cur() - 10);
  $('#pf30').onclick = () => seek(cur() + 30);
  $('#pback').onclick = () => close();
  $('#pskip').onclick = () => { S.introSkipped = true; seek(S.item.intro.end); };
  $('#precap').onclick = () => { S.recapSkipped = true; seek(S.item.recap.end); };

  // fullscreen
  const fsEnabled = document.fullscreenEnabled || document.webkitFullscreenEnabled;
  $('#pfs').onclick = async () => {
    if (fsEnabled) {
      if (document.fullscreenElement || document.webkitFullscreenElement) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      else { try { await (root.requestFullscreen || root.webkitRequestFullscreen).call(root); } catch {} screen.orientation?.lock?.('landscape').catch(() => {}); }
    } else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
  };
  if (!fsEnabled && !video.webkitEnterFullscreen) $('#pfs').classList.add('hidden');

  // Picture-in-picture: keep watching in a small window while using other apps
  const pipStd = document.pictureInPictureEnabled && video.requestPictureInPicture;
  const pipWebkit = typeof video.webkitSupportsPresentationMode === 'function' && video.webkitSupportsPresentationMode('picture-in-picture');
  if (pipStd || pipWebkit) {
    $('#ppip').classList.remove('hidden');
    $('#ppip').onclick = async () => {
      try {
        if (pipStd) { if (document.pictureInPictureElement) await document.exitPictureInPicture(); else await video.requestPictureInPicture(); }
        else video.webkitSetPresentationMode(video.webkitPresentationMode === 'picture-in-picture' ? 'inline' : 'picture-in-picture');
      } catch { toast('Picture-in-picture isn’t available right now'); }
    };
  }
  // AirPlay (Safari)
  if (window.WebKitPlaybackTargetAvailabilityEvent) {
    video.addEventListener('webkitplaybacktargetavailabilitychanged', e => $('#pairplay').classList.toggle('hidden', e.availability !== 'available'));
    $('#pairplay').onclick = () => video.webkitShowPlaybackTargetPicker();
  }

  // seek bar dragging
  const seekEl = $('#seek');
  const posFrom = e => { const r = seekEl.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); };
  // Scrub preview pictures
  function preview(p) {
    const tr = S.trick, box = $('#trick');
    if (!tr || remote()) return box.classList.add('hidden');
    const t = p * dur();
    const n = Math.min(tr.count - 1, Math.floor(t / tr.interval));
    const per = tr.cols * tr.rows, sheet = Math.floor(n / per) + 1, k = n % per;
    const img = $('#trickImg');
    img.style.width = tr.width + 'px'; img.style.height = tr.height + 'px';
    img.style.backgroundImage = `url(/api/trickplay/${S.item.id}/${sheet}.jpg)`;
    img.style.backgroundPosition = `-${(k % tr.cols) * tr.width}px -${Math.floor(k / tr.cols) * tr.height}px`;
    $('#trickT').textContent = fmtTime(t);
    const w = seekEl.clientWidth, half = tr.width / 2 + 4;
    box.style.left = Math.max(half, Math.min(w - half, p * w)) + 'px';
    box.classList.remove('hidden');
  }
  seekEl.addEventListener('pointermove', e => { if (!S.dragging && e.pointerType === 'mouse') preview(posFrom(e)); });
  seekEl.addEventListener('pointerleave', () => { if (!S.dragging) $('#trick').classList.add('hidden'); });
  seekEl.addEventListener('pointerdown', e => {
    S.dragging = true; seekEl.classList.add('drag'); seekEl.setPointerCapture(e.pointerId);
    const move = ev => { const p = posFrom(ev); $('#sfill').style.width = p * 100 + '%'; $('#sknob').style.left = p * 100 + '%'; const tip = $('#stip'); tip.style.left = p * 100 + '%'; tip.textContent = fmtTime(p * dur()); preview(p); };
    move(e);
    const up = ev => {
      seekEl.removeEventListener('pointermove', move); seekEl.removeEventListener('pointerup', up); seekEl.removeEventListener('pointercancel', up);
      S.dragging = false; seekEl.classList.remove('drag'); $('#trick').classList.add('hidden');
      seek(posFrom(ev) * dur()); bump();
    };
    seekEl.addEventListener('pointermove', move); seekEl.addEventListener('pointerup', up); seekEl.addEventListener('pointercancel', up);
  });

  // ---------- settings menu ----------
  function closeMenu() { if (S.menu) { S.menu.remove(); S.menu = null; bump(); } }
  $('#pmenuBtn').onclick = () => {
    if (S.menu) return closeMenu();
    const i = S.info; if (!i) return;
    const m = document.createElement('div');
    m.className = 'p-menu';
    const qs = [...(i.qualities || [])].reverse();
    m.innerHTML = offlineMode ? `<h4>Downloaded</h4><p class="pm-note">Playing your offline copy.</p>` : `
      <h4>Quality</h4><button data-q="auto" class="${S.auto ? 'on' : ''}">Auto${S.auto && S.quality ? ` <small>(${S.quality === 'original' ? 'original' : S.quality + 'p'})</small>` : ''}</button>
      ${qs.filter(q => !i.maxQuality || QUALITY_ORDER.indexOf(q.key) >= QUALITY_ORDER.indexOf(i.maxQuality)).map(q => `<button data-q="${q.key}" class="${!S.auto && q.key === S.quality ? 'on' : ''}">${esc(q.label)}</button>`).join('')}
      ${i.audioTracks.length > 1 ? `<h4>Audio</h4>${i.audioTracks.map(a => `<button data-a="${a.index}" class="${a.index === S.audioIndex ? 'on' : ''}">${esc(a.label)}</button>`).join('')}` : ''}
      <h4>Subtitles</h4><button data-s="" class="${!S.subKey && !S.burnKey ? 'on' : ''}">Off</button>
      ${i.subtitles.map(s => `<button data-s="${s.key}" class="${s.key === S.subKey || s.key === S.burnKey ? 'on' : ''}">${esc(s.label)}</button>`).join('')}
      ${!i.subtitles.length ? '<p class="pm-note">No subtitles found. Put an .srt next to the video with the same name.</p>' : ''}
      <h4>Watch together</h4>
      ${S.room ? `<button data-p="share">${ICON.share} Invite · code <b>${S.room}</b></button><button data-p="leave">Leave watch party</button>`
        : `<button data-p="start">${ICON.users} Start a watch party</button>`}
      ${me?.sections?.subtitles ? '<button data-p="findsubs">Find subtitles online…</button>' : ''}
      <h4>Sound</h4><button data-p="night" class="${S.night ? 'on' : ''}">Night mode <small>quieter bangs, clearer voices</small></button>
      <h4>Speed</h4>
      ${[0.75, 1, 1.25, 1.5, 2].map(r => `<button data-rate="${r}" class="${(S.rate || 1) === r ? 'on' : ''}">${r === 1 ? 'Normal' : r + '×'}</button>`).join('')}
      <h4>Sleep</h4>
      <button data-sleep="0" class="${!S.sleepAt ? 'on' : ''}">Off</button>
      ${[15, 30, 45, 60].map(m => `<button data-sleep="${m}">${m} min</button>`).join('')}
      <button data-p="stopafter" class="${S.stopAfter ? 'on' : ''}">Stop after this episode</button>
      ${(i.chapters || []).length ? `<h4>Chapters</h4>${i.chapters.map(c => `<button data-ch="${c.start}">${esc(c.title || fmtTime(c.start))}</button>`).join('')}` : ''}
      <h4>More</h4><button data-p="send">${ICON.cast} Play on another device…</button>
      ${!me?.isKids ? `<button data-p="autoskip" class="${me?.autoSkipIntro ? 'on' : ''}">Skip intros & recaps automatically</button>` : ''}
      ${me?.isAdmin && S.item?.type === 'episode' ? `<button data-p="markintro">Intro ends here</button><button data-p="markseason">Use this intro for the season</button><button data-p="markcredits">Credits start here</button>` : ''}
      ${i.maxQuality ? `<p class="pm-note">This profile is limited to ${i.maxQuality}p.</p>` : ''}
      <p class="pm-note">${i.prepared ? 'Playing a prepared copy — no converting needed' : i.mode === 'direct' ? 'Playing the original file' : i.transcoding ? `Converting on the fly (${esc(i.reason)})` : 'Repackaging without re-encoding'}</p>`;
    m.addEventListener('click', e => e.stopPropagation());
    ui.appendChild(m); S.menu = m; showUI(true);
    $$('[data-q]', m).forEach(b => b.onclick = () => {
      closeMenu();
      if (b.dataset.q === 'auto') { S.auto = true; S.quality = null; store.set('mq_quality', 'auto'); }
      else { S.auto = false; S.quality = b.dataset.q; store.set('mq_quality', b.dataset.q); }
      if (remote()) (window.__nativeCast ? nativeLoad : castLoad)(cur()); else load(cur(), !paused());
    });
    $$('[data-a]', m).forEach(b => b.onclick = () => { S.audioIndex = +b.dataset.a; closeMenu(); remote() ? (window.__nativeCast ? nativeLoad : castLoad)(cur()) : load(cur(), !paused()); });
    $$('[data-s]', m).forEach(b => b.onclick = () => {
      closeMenu();
      const sub = i.subtitles.find(s => s.key === b.dataset.s);
      const hadBurn = S.burnKey;
      if (sub?.burn) { S.burnKey = sub.key; S.subKey = null; toast('Adding picture subtitles…'); load(cur(), !paused()); return; }
      S.burnKey = null;
      S.subKey = b.dataset.s || null;
      store.set('mq_subs_on', S.subKey);
      if (remote()) (window.__nativeCast ? nativeLoad : castLoad)(cur());
      else if (hadBurn) load(cur(), !paused());
      else applySubs();
    });
    $$('[data-p]', m).forEach(b => b.onclick = async () => {
      closeMenu();
      const a = b.dataset.p;
      if (a === 'start') { try { const r = await api('/api/rooms', { body: { itemId: S.item.id } }); joinRoom(r.code, true); shareRoom(); } catch (e) { toast(e.message); } }
      if (a === 'share') shareRoom();
      if (a === 'leave') leaveRoom();
      if (a === 'night') {
        S.night = !S.night; store.set('mq_night', S.night);
        toast(S.night ? 'Night mode on' : 'Night mode off');
        if (nightOnServer()) load(cur(), !paused()); else applyNight();
      }
      if (a === 'findsubs') findSubtitles();
      if (a === 'markintro' || a === 'markseason' || a === 'markcredits') {
        const body = a === 'markcredits' ? { creditsStart: cur() } : { introEnd: cur(), applySeason: a === 'markseason' };
        try { await api(`/api/items/${id}/markers`, { body }); toast(a === 'markcredits' ? 'Credits marked' : a === 'markseason' ? 'Intro saved for this season' : 'Intro marked'); } catch (e) { toast(e.message); }
      }
      if (a === 'stopafter') { S.stopAfter = !S.stopAfter; toast(S.stopAfter ? 'Will stop after this episode' : 'Will keep playing'); }
      if (a === 'send') Devices.pick('Continue on…', async dev => {
        await api(`/api/devices/${dev.clientId}/command`, { body: { type: 'open', itemId: S.item.id, position: cur() } });
        video.pause(); toast(`Now playing on ${dev.name}`);
      });
      if (a === 'autoskip') { const v = !me.autoSkipIntro; await api('/api/me', { method: 'PATCH', body: { autoSkipIntro: v } }); me.autoSkipIntro = v; toast(v ? 'Intros will be skipped automatically' : 'Auto-skip turned off'); }
    });
    $$('[data-rate]', m).forEach(b => b.onclick = () => {
      S.rate = +b.dataset.rate || 1;
      video.playbackRate = S.rate;
      store.set('mq_rate', S.rate);
      closeMenu();
      toast(S.rate === 1 ? 'Normal speed' : `Playing at ${S.rate}×`);
    });
    $$('[data-sleep]', m).forEach(b => b.onclick = () => {
      clearTimeout(S.sleepTimer);
      clearInterval(S.fadeTimer);
      const mins = +b.dataset.sleep || 0;
      S.sleepAt = mins ? Date.now() + mins * 60000 : 0;
      if (mins) S.sleepTimer = setTimeout(() => fadeOut(), mins * 60000);
      closeMenu();
      toast(mins ? `Sleep timer: ${mins} min` : 'Sleep timer off');
    });
    $$('[data-ch]', m).forEach(b => b.onclick = () => { closeMenu(); seek(+b.dataset.ch); });
  };

  // ---------- subtitles from OpenSubtitles ----------
  async function findSubtitles() {
    const m = modal(`<h2>Find subtitles</h2><div class="btn-row" style="margin-bottom:12px"><select class="select" id="fsl">${[['en', 'English'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['it', 'Italian'], ['zh-cn', 'Chinese'], ['ja', 'Japanese'], ['ko', 'Korean'], ['ar', 'Arabic'], ['hi', 'Hindi'], ['pt-br', 'Portuguese']].map(([k, l]) => `<option value="${k}" ${(me.subLang || 'en') === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div><div id="fsr">${loading()}</div>`);
    const run = async () => {
      $('#fsr', m.el).innerHTML = loading();
      try {
        const res = await api(`/api/subtitles/search/${S.item.id}?lang=${$('#fsl', m.el).value}`);
        $('#fsr', m.el).innerHTML = res.length ? `<div class="menu-list">${res.map((r, i) => `<button data-s="${i}">${ICON.download}<span>${esc(r.release)}<small>${r.downloads} downloads${r.hearingImpaired ? ' · SDH' : ''}${r.machine ? ' · machine translated' : ''}</small></span></button>`).join('')}</div>` : '<p class="hint">No subtitles found in that language.</p>';
        $$('[data-s]', m.el).forEach(b => b.onclick = async () => {
          b.disabled = true;
          try {
            const r = res[+b.dataset.s];
            await api(`/api/subtitles/download/${S.item.id}`, { body: { fileId: r.fileId, language: r.language } });
            m.close(); toast('Subtitles added');
            const keep = cur(), playing = !paused();
            await load(keep, playing);
            const added = S.info.subtitles.filter(x => x.key.startsWith('dl-')).pop();
            if (added) { S.subKey = added.key; store.set('mq_subs_on', added.key); applySubs(); }
          } catch (e) { toast(e.message, 5000); b.disabled = false; }
        });
      } catch (e) { $('#fsr', m.el).innerHTML = `<p class="hint">${esc(e.message)}</p>`; }
    };
    $('#fsl', m.el).onchange = run;
    run();
  }

  // ---------- next episode / next video ----------
  function checkUpNext() {
    const n = S.item?.nextId;
    if (!n || S.upnextShown || !dur() || offlineMode) return;
    const triggerAt = S.item.creditsStart || dur() - 25;
    if (cur() >= triggerAt && cur() > 30) {
      S.upnextShown = true;
      if (S.noNext) return goodbyeCard(S.noNext);
      // Kids with an episode or time limit get a friendly goodbye instead of "Up next"
      api(`/api/screen-time?itemId=${n}`).then(st => { if (st.ok) upNextCard(n); else { S.noNext = st.message; S.noNextReason = st.reason; goodbyeCard(st.message); } }).catch(() => upNextCard(n));
    }
  }
  function goodbyeCard(message) {
    const box = document.createElement('div');
    box.className = 'upnext';
    box.innerHTML = `<div class="k">All done</div><b>${esc(message)}</b><div class="btn-row"><button class="btn small" id="unHide">OK</button></div>`;
    ui.appendChild(box);
    $('#pnext').classList.add('hidden');
    $('#unHide').onclick = () => box.remove();
  }
  function upNextCard(n) {
    {
      const box = document.createElement('div');
      box.className = 'upnext';
      box.innerHTML = `<div class="k">Up next</div><b id="unTitle">${S.item.type === 'home' ? 'Next video' : 'Next episode'}</b><div class="btn-row"><button class="btn primary small" id="unPlay">${ICON.play} Play now</button><button class="btn small" id="unHide">Hide</button></div>`;
      ui.appendChild(box);
      $('#unPlay').onclick = playNext;
      $('#unHide').onclick = () => box.remove();
      api(`/api/items/${n}`).then(e => { const el = $('#unTitle'); if (el) el.textContent = e.type === 'episode' ? `${epCode(e)} · ${e.title}` : e.title; }).catch(() => {});
    }
  }
  function fadeOut() {
    const started = video.volume;
    let left = 20;
    S.fadeTimer = setInterval(() => {
      left--;
      video.volume = Math.max(0, started * (left / 20));
      if (left <= 0) { clearInterval(S.fadeTimer); video.pause(); video.volume = started; toast('Sleep timer — faded out'); }
    }, 500);
  }
  function paintChapters() {
    const track = $('.track', ui);
    if (!track) return;
    track.querySelectorAll('.chapter-tick').forEach(n => n.remove());
    const d = dur();
    if (!d) return;
    for (const c of S.info?.chapters || []) {
      if (!c.start) continue;
      const tick = document.createElement('i');
      tick.className = 'chapter-tick';
      tick.style.cssText = `position:absolute;top:0;bottom:0;width:2px;background:rgba(255,255,255,.55);left:${Math.min(99, c.start / d * 100)}%`;
      tick.title = c.title || fmtTime(c.start);
      track.appendChild(tick);
    }
  }
  function playNext() {
    if (!S.item?.nextId) return;
    if (S.noNext) return blocked(S.noNext, S.noNextReason || 'limit', true);
    beat(true);
    if (S.room) party('item', null, S.item.nextId);
    const room = S.room;
    teardown({ keepRoom: false });
    go(`#/play/${S.item.nextId}${room ? `?room=${room}` : ''}`, true);
  }
  $('#pnext').onclick = playNext;

  // ---------- watch together ----------
  let es = null;
  function joinRoom(code, host) {
    S.room = code;
    S.isHost = !!host;
    history.replaceState(null, '', `#/play/${id}?room=${code}`);
    es = new EventSource(`/api/rooms/${code}/events?clientId=${encodeURIComponent(clientId)}`);
    const sync = st => {
      S.clockOffset = (st.serverNow || Date.now()) - Date.now();
      if (!st.by && !st.type) return;
      S.remoteAt = Date.now();
      const target = st.position + (st.playing ? (Date.now() + S.clockOffset - st.at) / 1000 : 0);
      if (Math.abs(cur() - target) > 1.5) seek(target, true);
      if (st.playing && paused()) { remote() ? togglePlay(true) : video.play().catch(() => {}); }
      if (!st.playing && !paused()) { remote() ? togglePlay(true) : video.pause(); }
    };
    es.addEventListener('hello', e => { const d = JSON.parse(e.data); S.members = d.members; drawParty(); if (!host) sync({ ...d.state, serverNow: d.serverNow }); });
    es.addEventListener('state', e => {
      const d = JSON.parse(e.data);
      sync(d);
      const what = d.type === 'pause' ? 'paused' : d.type === 'play' ? 'pressed play' : 'jumped to ' + fmtTime(d.position);
      toast(`${d.by} ${what}`, 1800);
    });
    es.addEventListener('members', e => {
      const d = JSON.parse(e.data); S.members = d.members; drawParty();
      if (d.joined) {
        toast(`${d.joined} joined the watch party`);
        // The host brings newcomers up to speed
        if (S.isHost) setTimeout(() => { S.remoteAt = 0; party(paused() ? 'pause' : 'play'); }, 400);
      }
      if (d.left) toast(`${d.left} left`);
    });
    es.addEventListener('reaction', e => floatEmoji(JSON.parse(e.data)));
    es.addEventListener('item', e => { const d = JSON.parse(e.data); toast(`${d.by} started the next one`); teardown(); go(`#/play/${d.itemId}?room=${code}`, true); });
    es.onerror = () => { if (es && es.readyState === EventSource.CLOSED) { toast('Watch party ended'); leaveRoom(); } };
    drawParty();
  }
  function leaveRoom() {
    if (es) es.close();
    es = null; S.room = null; S.members = [];
    history.replaceState(null, '', `#/play/${id}`);
    drawParty();
  }
  function party(type, position, itemId) {
    if (!S.room || Date.now() - S.remoteAt < 1200 || S.loading) return;
    api(`/api/rooms/${S.room}/action`, { body: { clientId, type, position: position ?? cur(), playing: type === 'play' || (type === 'seek' && !paused()), itemId } }).catch(() => {});
  }
  function shareRoom() {
    const url = `${location.origin}/#/party?code=${S.room}`;
    const text = `Watch ${S.item?.show ? S.item.show.title : S.item?.title} with me on Marquee — code ${S.room}`;
    if (navigator.share) navigator.share({ title: 'Watch party', text, url }).catch(() => {});
    else { navigator.clipboard?.writeText(`${text}\n${url}`).catch(() => {}); toast(`Watch party code: ${S.room}`, 5000); }
  }
  function drawParty() {
    const b = $('#pparty');
    if (!b) return;
    b.classList.toggle('hidden', !S.room);
    b.innerHTML = S.room ? `${ICON.users} ${S.members.length || 1} · ${S.room}` : '';
    let bar = $('#partyBar');
    if (S.room && !bar) {
      bar = document.createElement('div');
      bar.id = 'partyBar'; bar.className = 'party-bar';
      bar.innerHTML = ['😂', '😮', '❤️', '👏', '😱', '🍿'].map(e => `<button data-e="${e}">${e}</button>`).join('');
      $$('[data-e]', bar).forEach(x => x.onclick = () => { api(`/api/rooms/${S.room}/action`, { body: { clientId, type: 'reaction', emoji: x.dataset.e } }).catch(() => {}); floatEmoji({ emoji: x.dataset.e, name: 'You' }); });
      $('.p-bottom', ui).prepend(bar);
    } else if (!S.room && bar) bar.remove();
  }
  function floatEmoji({ emoji, name }) {
    const el = document.createElement('div');
    el.className = 'float-emoji';
    el.style.left = (15 + Math.random() * 70) + '%';
    el.innerHTML = `<span>${esc(emoji)}</span><small>${esc(name)}</small>`;
    $('#preact').appendChild(el);
    setTimeout(() => el.remove(), 3000);
  }

  // ---------- Chromecast ----------
  // Inside the Android app, casting goes through the phone's own Chromecast support
  function setupNativeCast() {
    const N = window.MarqueeNative;
    const btn = $('#pcast');
    const upd = () => btn.classList.toggle('hidden', !N.castAvailable());
    upd();
    const avail = setInterval(upd, 4000);
    onLeave(() => { clearInterval(avail); window.__nativeCast = null; });
    window.__nativeCast = {
      connected: () => { if (!S.closed) nativeLoad(cur()); },
      status: st => {
        if (!S.cast) return;
        if (st.connected === false) {
          const at = cur();
          S.cast = null;
          root.classList.remove('casting'); btn.classList.remove('on');
          if (!S.closed) { toast('Back on this device'); seek(at); video.play().catch(() => {}); }
          return;
        }
        const wasPaused = S.cast.player.isPaused;
        if (st.position != null) S.cast.player.currentTime = st.position;
        if (st.paused != null) S.cast.player.isPaused = st.paused;
        paint(); checkUpNext();
        if (wasPaused !== S.cast.player.isPaused) beat(true);
      },
    };
    btn.onclick = () => { if (remote()) N.castStop(); else N.castPick(); };
    if (N.castConnected && N.castConnected()) nativeLoad(cur());
  }
  async function nativeLoad(start) {
    let info;
    try { info = await api(`/api/cast/${id}`, { body: { quality: S.quality && S.quality !== 'original' ? S.quality : '1080', start, audioIndex: S.audioIndex, subKey: S.subKey } }); }
    catch (e) { toast(e.message, 5000); return; }
    video.pause();
    window.MarqueeNative.castLoad(JSON.stringify({ url: info.url, contentType: info.contentType, title: info.showTitle ? `${info.showTitle} · ${info.title}` : info.title,
      duration: info.seekable ? info.duration : Math.max(1, info.duration - info.start), startTime: info.startTime || 0, subtitleUrl: info.subtitleUrl || null }));
    const N = window.MarqueeNative;
    S.cast = { player: { currentTime: info.startTime || 0, isPaused: false, isConnected: true },
      controller: { playOrPause: () => N.castPlayPause(), seek: () => N.castSeek(S.cast.player.currentTime) }, offset: info.start || 0, seekable: info.seekable };
    root.classList.add('casting');
    $('#pcast').classList.add('on');
    $('#pst').innerHTML = `<div class="cast-msg">${ICON.cast}<b>Playing on ${esc(N.castDeviceName() || 'your TV')}</b><span>Use these controls as a remote</span></div>`;
  }
  async function setupCast() {
    if (offlineMode || S.closed) return;
    if (window.MarqueeNative?.castAvailable) return setupNativeCast();
    if (!(await CastKit.load()) || S.closed) return;
    const ctx = cast.framework.CastContext.getInstance();
    const btn = $('#pcast');
    const upd = () => btn.classList.toggle('hidden', ctx.getCastState() === cast.framework.CastState.NO_DEVICES_AVAILABLE);
    ctx.addEventListener(cast.framework.CastContextEventType.CAST_STATE_CHANGED, upd);
    upd();
    btn.onclick = async () => {
      if (remote()) { ctx.endCurrentSession(true); return; }
      try { await ctx.requestSession(); castLoad(cur()); } catch {}
    };
    if (ctx.getCurrentSession()) castLoad(cur());
  }
  async function castLoad(start) {
    const session = cast.framework.CastContext.getInstance().getCurrentSession();
    if (!session) return;
    let info;
    try { info = await api(`/api/cast/${id}`, { body: { quality: S.quality && S.quality !== 'original' ? S.quality : '1080', start, audioIndex: S.audioIndex, subKey: S.subKey } }); }
    catch (e) { toast(e.message, 5000); return; }
    const mi = new chrome.cast.media.MediaInfo(info.url, info.contentType);
    mi.streamType = chrome.cast.media.StreamType.BUFFERED;
    mi.duration = info.seekable ? info.duration : Math.max(1, info.duration - info.start);
    mi.metadata = new chrome.cast.media.GenericMediaMetadata();
    mi.metadata.title = info.showTitle ? `${info.showTitle} · ${info.title}` : info.title;
    const req = new chrome.cast.media.LoadRequest(mi);
    if (info.subtitleUrl) {
      const tr = new chrome.cast.media.Track(1, chrome.cast.media.TrackType.TEXT);
      tr.trackContentId = info.subtitleUrl; tr.trackContentType = 'text/vtt'; tr.subtype = chrome.cast.media.TextTrackType.SUBTITLES; tr.name = 'Subtitles'; tr.language = 'en';
      mi.tracks = [tr]; req.activeTrackIds = [1];
    }
    req.currentTime = info.startTime || 0;
    req.autoplay = true;
    video.pause();
    try { await session.loadMedia(req); }
    catch (e) { toast('The TV couldn’t play this — try a lower quality'); return; }
    if (!S.cast) {
      const player = new cast.framework.RemotePlayer();
      const controller = new cast.framework.RemotePlayerController(player);
      S.cast = { player, controller };
      controller.addEventListener(cast.framework.RemotePlayerEventType.CURRENT_TIME_CHANGED, () => { paint(); checkUpNext(); });
      controller.addEventListener(cast.framework.RemotePlayerEventType.IS_PAUSED_CHANGED, () => { paint(); beat(true); });
      controller.addEventListener(cast.framework.RemotePlayerEventType.IS_CONNECTED_CHANGED, () => {
        if (player.isConnected || !S.cast) return;
        const at = cur();
        S.cast = null;
        root.classList.remove('casting');
        $('#pcast').classList.remove('on');
        if (!S.closed) { toast('Back on this device'); seek(at); video.play().catch(() => {}); }
      });
    }
    S.cast.offset = info.start || 0;
    S.cast.seekable = info.seekable;
    root.classList.add('casting');
    $('#pcast').classList.add('on');
    $('#pst').innerHTML = `<div class="cast-msg">${ICON.cast}<b>Playing on ${esc(session.getCastDevice().friendlyName)}</b><span>Use these controls as a remote</span></div>`;
  }

  // ---------- lock screen / headphone controls ----------
  function mediaSession() {
    if (!('mediaSession' in navigator) || !S.item) return;
    const it = S.item;
    const art = it.still || it.poster || it.show?.poster || it.backdrop;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({ title: it.title, artist: it.show ? `${it.show.title} · ${epCode(it)}` : String(it.year || ''), artwork: art ? [{ src: location.origin + art, sizes: '512x512', type: 'image/jpeg' }] : [] });
      navigator.mediaSession.setActionHandler('play', () => togglePlay());
      navigator.mediaSession.setActionHandler('pause', () => togglePlay());
      navigator.mediaSession.setActionHandler('seekbackward', () => seek(cur() - 10));
      navigator.mediaSession.setActionHandler('seekforward', () => seek(cur() + 30));
      navigator.mediaSession.setActionHandler('seekto', d => seek(d.seekTime));
      if (it.nextId) navigator.mediaSession.setActionHandler('nexttrack', playNext);
    } catch {}
  }

  // ---------- keyboard / remote control ----------
  const onKey = e => {
    if (e.target.tagName === 'INPUT') return;
    const k = e.key;
    if (k === ' ' || k === 'k' || k === 'MediaPlayPause' || (k === 'Enter' && !e.target.closest('button'))) { e.preventDefault(); togglePlay(); }
    else if (k === 'ArrowLeft' && !S.menu) { e.preventDefault(); seek(cur() - 10); }
    else if (k === 'ArrowRight' && !S.menu) { e.preventDefault(); seek(cur() + 10); }
    else if (k === 'f') $('#pfs').click();
    else if ((k === 'Escape' || k === 'Backspace' || k === 'GoBack' || k === 'BrowserBack') && !document.fullscreenElement) { e.preventDefault(); if (S.menu) closeMenu(); else close(); }
    else if (k === 's' && !$('#pskip').classList.contains('hidden')) $('#pskip').click();
    else return;
    bump();
  };
  addEventListener('keydown', onKey, true);
  const onHide = () => { if (document.visibilityState === 'hidden') beat(true); };
  document.addEventListener('visibilitychange', onHide);

  window.__player = { toggle: () => togglePlay(), seek: t => seek(t), cur, next: () => playNext(), stop: () => close(), paused: () => paused(),
    pause: () => { if (!paused()) togglePlay(); }, resume: () => { if (paused()) togglePlay(); },
    chapter: dir => {
      const list = (S.info?.chapters || []).map(c => c.start).filter(n => n > 0).sort((a, b) => a - b);
      const now = cur();
      const target = dir > 0 ? list.find(t => t > now + 1) : [...list].reverse().find(t => t < now - 1);
      if (target != null) seek(target);
    } };
  function teardown() {
    if (S.closed) return;
    S.closed = true;
    window.__player = null;
    window.MarqueeNative?.playerClosed();
    Devices.report({}, true);
    if (S.audioCtx) try { S.audioCtx.ctx.close(); } catch {}
    clearInterval(beatTimer); clearTimeout(hideT);
    removeEventListener('keydown', onKey, true);
    document.removeEventListener('visibilitychange', onHide);
    if (es) es.close();
    if (S.info?.sessionId) fetch(`/api/hls/${S.info.sessionId}`, { method: 'DELETE', keepalive: true }).catch(() => {});
    if (!offlineMode) fetch('/api/play-stop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId }), keepalive: true }).catch(() => {});
    if (S.hls) S.hls.destroy();
    video.removeAttribute('src'); video.load();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    try { navigator.mediaSession.metadata = null; } catch {}
  }
  function close() {
    beat(true);
    const item = S.item;
    teardown();
    if (history.length > 1) history.back(); else go(offlineMode ? '#/downloads' : item?.show ? `#/item/${item.show.id}` : `#/item/${id}`, true);
  }
  onLeave(() => { beat(true); teardown(); });

  // ---------- cinema mode: trailers (and your own intro clip) before the film ----------
  async function cinemaPreshow(it) {
    let list = [];
    try { list = (await api(`/api/cinema/${it.id}`)).items || []; } catch {}
    if (!list.length) return;
    busy(false);
    const box = document.createElement('div');
    box.className = 'preshow';
    root.appendChild(box);
    let skipAll = false, current = null;
    const finish = () => { skipAll = true; current && current(); };
    const onMsg = e => { try { const d = JSON.parse(e.data); if (d.event === 'onStateChange' && d.info === 0) current && current(); } catch {} };
    addEventListener('message', onMsg);
    for (const [i, x] of list.entries()) {
      if (skipAll || S.closed) break;
      const label = x.kind === 'preroll' ? 'Feature presentation' : `Coming up in your library · ${i + 1} of ${list.filter(y => y.kind !== 'preroll').length}`;
      box.innerHTML = `<div class="preshow-top"><div class="ps-text"><span>${esc(label)}</span>${x.kind !== 'preroll' ? `<b>${esc(x.title)}${x.year ? ` (${x.year})` : ''}</b>` : ''}</div>
        ${x.kind !== 'preroll' && i < list.length - 1 ? '<button class="btn small" id="psNext">Next</button>' : ''}<button class="btn small primary" id="psSkip">Start the movie ${ICON.chevron}</button></div>
        ${x.kind === 'youtube' ? `<iframe id="psYt" src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(x.key)}?autoplay=1&rel=0&controls=0&modestbranding=1&enablejsapi=1&origin=${encodeURIComponent(location.origin)}" allow="autoplay; encrypted-media"></iframe>`
          : `<video id="psV" src="${x.url}" autoplay playsinline></video>`}`;
      await new Promise(done => {
        let t = null;
        current = () => { clearTimeout(t); current = null; done(); };
        $('#psSkip', box).onclick = finish;
        if ($('#psNext', box)) $('#psNext', box).onclick = () => current && current();
        const v = $('#psV', box);
        if (v) { v.onended = () => current && current(); v.onerror = () => current && current(); v.play().catch(() => {}); }
        const yt = $('#psYt', box);
        if (yt) {
          yt.onload = () => { try { yt.contentWindow.postMessage(JSON.stringify({ event: 'listening', id: 1 }), '*'); } catch {} };
          t = setTimeout(() => current && current(), 150000); // trailers are rarely longer than 2½ minutes
        }
      });
    }
    removeEventListener('message', onMsg);
    box.remove();
    busy(true);
  }

  // ---------- go ----------
  try {
    if (offlineMode) {
      const s = Downloads.saved().find(x => x.itemId === +id);
      if (!s) throw new Error('That download is no longer on this device');
      S.item = { id: +id, title: s.title, duration: s.duration, show: s.showTitle ? { title: s.showTitle } : null };
      $('#ptitle').innerHTML = s.showTitle ? `<b>${esc(s.showTitle)}</b><span>${esc(s.code)} · ${esc(s.title)} · offline</span>` : `<b>${esc(s.title)}</b><span>Offline</span>`;
      const local = store.get('mq_offline_pos', {})[id] || 0;
      await load(explicitStart ?? local);
      const savePos = setInterval(() => { const all = store.get('mq_offline_pos', {}); all[id] = cur(); store.set('mq_offline_pos', all); }, 5000);
      onLeave(() => clearInterval(savePos));
    } else {
      S.item = await api(`/api/items/${id}`);
      const it = S.item;
      $('#ptitle').innerHTML = it.show ? `<b>${esc(it.show.title)}</b><span>${esc(epCode(it))} · ${esc(it.title)}</span>` : `<b>${esc(it.title)}</b><span>${esc(it.type === 'home' ? fmtDate(it.takenAt) : it.year || '')}</span>`;
      if (it.nextId) $('#pnext').classList.remove('hidden');
      if (it.trickplay) api(`/api/trickplay/${it.id}`).then(t => { S.trick = t; }).catch(() => {});
      const resume = explicitStart ?? (roomCode ? 0 : it.progress && !it.progress.watched && it.progress.position > 30 ? it.progress.position : 0);
      if (it.type === 'movie' && !resume && !roomCode && me?.cinemaMode && explicitStart == null) await cinemaPreshow(it);
      if (S.closed) return;
      await load(resume);
      if (explicitStart == null && resume > 0) {
        const pill = document.createElement('div');
        pill.className = 'p-resume';
        pill.innerHTML = `<span>Resumed at ${fmtTime(resume)}</span><button class="btn small" id="restart">Start over</button>`;
        ui.appendChild(pill);
        $('#restart').onclick = () => { pill.remove(); seek(0); };
        setTimeout(() => pill.remove(), 7000);
      }
      if (roomCode) joinRoom(roomCode, ps.get('host') === '1');
      if (ps.get('host') === '1') shareRoom();
      setupCast();
    }
    bump();
  } catch (e) {
    if (e.message !== 'Signed out') showError(e.message);
  }
};
