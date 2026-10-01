/* Marquee — the page a guest sees when you share a movie with them */
'use strict';
(() => {
  const token = location.pathname.split('/').filter(Boolean)[1];
  const app = document.getElementById('app');
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const PLAY = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
  const msg = (title, text) => { app.innerHTML = `<div class="msg"><h1>${esc(title)}</h1><p class="sub">${esc(text)}</p></div>`; };

  async function api(path, body) {
    const r = await fetch(`/s/${token}${path}`, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'Something went wrong');
    return data;
  }
  const caps = () => {
    const v = document.createElement('video');
    const can = t => !!v.canPlayType && v.canPlayType(t) !== '';
    return { h264: can('video/mp4; codecs="avc1.42E01E"'), hevc: can('video/mp4; codecs="hvc1.1.6.L93.B0"'), vp9: can('video/webm; codecs="vp9"'), av1: can('video/mp4; codecs="av01.0.05M.08"'), mkv: false };
  };

  async function show() {
    let info;
    try { info = await api('/info'); } catch (e) { return msg('Link not available', e.message); }
    document.title = `${info.title} — shared with you`;
    const until = new Date(info.expiresAt).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
    app.innerHTML = `
      <section class="hero" style="${info.backdrop ? `background-image:url('${info.backdrop}')` : ''}">
        <div class="wrap">
          ${info.poster ? `<img class="poster" src="${info.poster}" alt="">` : ''}
          <div>
            <div class="from">${esc(info.from)} shared this with you</div>
            <h1>${esc(info.title)}</h1>
            <div class="sub">${esc(info.subtitle || '')}</div>
            ${info.note ? `<p class="note">“${esc(info.note)}”</p>` : ''}
            <button class="btn" id="play">${PLAY} Watch now</button>
          </div>
        </div>
      </section>
      <section class="body">
        ${info.overview ? `<p>${esc(info.overview)}</p>` : ''}
        <p class="meta">Link works until ${esc(until)}${info.viewsLeft != null ? ` · ${info.viewsLeft} view${info.viewsLeft === 1 ? '' : 's'} left` : ''} · from ${esc(info.serverName)}</p>
      </section>`;
    document.getElementById('play').onclick = () => play(info);
  }

  async function play(info) {
    let src;
    try { src = await api('/play', { caps: caps() }); } catch (e) { return alertBox(e.message); }
    const wrap = document.createElement('div');
    wrap.className = 'player';
    wrap.innerHTML = `<button class="close" aria-label="Close">✕</button><video controls autoplay playsinline></video>`;
    document.body.appendChild(wrap);
    const video = wrap.querySelector('video');
    let hls = null;
    for (const s of src.subs || []) {
      const t = document.createElement('track');
      Object.assign(t, { kind: 'subtitles', label: s.label, srclang: s.lang || 'en', src: s.url });
      video.appendChild(t);
    }
    if (src.mode === 'hls' && !video.canPlayType('application/vnd.apple.mpegurl') && window.Hls?.isSupported()) {
      hls = new Hls({ maxBufferLength: 30 });
      hls.loadSource(src.url);
      hls.attachMedia(video);
    } else video.src = src.url;
    video.play().catch(() => {});
    const close = () => { try { hls?.destroy(); } catch {} video.pause(); video.removeAttribute('src'); video.load(); wrap.remove(); };
    wrap.querySelector('.close').onclick = close;
    video.addEventListener('error', () => { if (!wrap.isConnected) return; close(); alertBox("This video couldn't play on this device."); });
  }
  function alertBox(text) {
    const b = document.createElement('p');
    b.className = 'note';
    b.textContent = text;
    document.querySelector('.hero .wrap > div')?.appendChild(b);
  }
  show();
})();
