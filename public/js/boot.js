/* Marquee — TV remote navigation + start-up */
'use strict';

// Arrow keys move between buttons/cards like a TV app; OK/Enter selects; Back goes back.
(() => {
  const FOCUSABLE = 'a[href], button:not([disabled]), select, input, [tabindex="0"]';
  const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
  function move(dir) {
    const scope = document.querySelector('.modal-wrap .modal') || document.querySelector('.lightbox') || document;
    const all = [...scope.querySelectorAll(FOCUSABLE)].filter(visible);
    const cur = document.activeElement && all.includes(document.activeElement) ? document.activeElement : null;
    if (!cur) { all[0]?.focus(); return; }
    const a = cur.getBoundingClientRect();
    const ac = { x: a.left + a.width / 2, y: a.top + a.height / 2 };
    let best = null, bestScore = Infinity;
    for (const el of all) {
      if (el === cur) continue;
      const b = el.getBoundingClientRect();
      const bc = { x: b.left + b.width / 2, y: b.top + b.height / 2 };
      const dx = bc.x - ac.x, dy = bc.y - ac.y;
      const ok = dir === 'right' ? dx > 4 : dir === 'left' ? dx < -4 : dir === 'down' ? dy > 4 : dy < -4;
      if (!ok) continue;
      const main = dir === 'left' || dir === 'right' ? Math.abs(dx) : Math.abs(dy);
      const cross = dir === 'left' || dir === 'right' ? Math.abs(dy) : Math.abs(dx);
      const score = main + cross * 2.5;
      if (score < bestScore) { bestScore = score; best = el; }
    }
    if (best) { best.focus({ preventScroll: true }); best.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' }); }
  }
  addEventListener('keydown', e => {
    if (location.hash.startsWith('#/play')) return; // the player handles its own keys
    const t = e.target;
    const typing = t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT';
    const map = { ArrowRight: 'right', ArrowLeft: 'left', ArrowDown: 'down', ArrowUp: 'up' };
    if (map[e.key] && !(typing && (e.key === 'ArrowLeft' || e.key === 'ArrowRight'))) {
      if (document.querySelector('.lightbox') && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return;
      e.preventDefault();
      document.body.classList.add('tv-nav');
      move(map[e.key]);
    } else if ((e.key === 'Backspace' && !typing) || e.key === 'GoBack' || e.key === 'BrowserBack') {
      const m = document.querySelector('.modal-wrap');
      if (m) m.click(); else history.back();
      e.preventDefault();
    }
  });
  addEventListener('pointerdown', () => document.body.classList.remove('tv-nav'));
})();

// ---------- this screen as a remote-controllable device ----------
const Devices = (() => {
  const clientId = deviceId;
  const guess = () => {
    const ua = navigator.userAgent;
    if (/AFT|Fire TV/i.test(ua)) return 'Fire TV';
    if (/Android TV|GoogleTV|BRAVIA|SMART-TV|Tizen|Web0S/i.test(ua)) return 'TV';
    if (/iPad/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'iPad';
    if (/iPhone/.test(ua)) return 'iPhone';
    if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'Android phone' : 'Android tablet';
    if (/Macintosh/.test(ua)) return 'Mac';
    if (/Windows/.test(ua)) return 'Windows PC';
    return 'Browser';
  };
  let es = null, lastReport = 0;
  const name = () => store.get('mq_device_name') || guess();
  function connect() {
    if (!me || es || offline) return;
    es = new EventSource(`/api/devices/events?clientId=${encodeURIComponent(clientId)}&name=${encodeURIComponent(name())}`);
    es.addEventListener('command', e => handle(JSON.parse(e.data)));
    es.onerror = () => { if (es && es.readyState === EventSource.CLOSED) { es = null; } };
  }
  function reconnect() { if (es) es.close(); es = null; connect(); }
  function handle(c) {
    const p = window.__player;
    if (c.type === 'open') { toast(`${c.from} sent something to this screen`); go(`#/play/${c.itemId}${c.position ? `?t=${Math.floor(c.position)}` : ''}`); return; }
    if (p) {
      if (c.type === 'toggle') p.toggle();
      else if (c.type === 'pause') p.pause();
      else if (c.type === 'resume') p.resume();
      else if (c.type === 'seekBy') p.seek(p.cur() + c.by);
      else if (c.type === 'seek') p.seek(c.position);
      else if (c.type === 'next') p.next();
      else if (c.type === 'stop') p.stop();
    } else if (c.type === 'toggle' || (c.type === 'pause' && MiniPlayer.playing) || (c.type === 'resume' && !MiniPlayer.playing)) MiniPlayer.toggle();
    else if (c.type === 'seekBy') MiniPlayer.skip(c.by);
    else if (c.type === 'stop') MiniPlayer.stop();
  }
  function report(state, force) {
    if (!es || (!force && Date.now() - lastReport < 4000)) return;
    lastReport = Date.now();
    api('/api/devices/state', { body: { clientId, state } }).catch(() => {});
  }
  async function pick(title, cb) {
    const list = await api(`/api/devices?except=${encodeURIComponent(clientId)}`);
    const m = modal(`<h2>${esc(title)}</h2>${list.length ? `<div class="menu-list">${list.map((d, i) => `<button data-d="${i}">${ICON.cast}<span>${esc(d.name)} <small>${esc(d.profileName)}${d.state?.title ? ' · watching ' + esc(d.state.title) : ''}</small></span></button>`).join('')}</div>`
      : '<p class="hint">No other screens found. Open Marquee on the TV or another device first — it shows up here automatically.</p>'}`);
    $$('[data-d]', m.el).forEach(b => b.onclick = async () => { m.close(); try { await cb(list[+b.dataset.d]); } catch (e) { toast(e.message); } });
  }
  return { clientId, connect, reconnect, report, pick, name, guess };
})();
setInterval(() => Devices.connect(), 3000);
setInterval(() => { if (me && !offline) Downloads.syncSmart().catch(() => {}); }, 30 * 60000);

// Broken artwork links (e.g. a podcast image that moved) just disappear instead of showing a broken icon
addEventListener('error', e => { if (e.target?.tagName === 'IMG') e.target.style.visibility = 'hidden'; }, true);

addEventListener('hashchange', route);
addEventListener('online', () => { if (offline) { offline = false; me = null; route(); } Downloads.flush(); });
if ('serviceWorker' in navigator && isSecureContext) navigator.serviceWorker.register('/sw.js').catch(() => {});
route().then(() => { if (me) { Downloads.flush(); Downloads.poll(); Devices.connect(); Downloads.syncSmart().catch(() => {}); } });
