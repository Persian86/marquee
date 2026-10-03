/* Marquee — settings, admin, activity */
'use strict';

const LEVELS = ['All ages (G)', 'Up to PG', 'Up to M / PG-13', 'Up to MA15+ / R', 'Everything'];
const LIB_ICON = { movie: ICON.film, tv: ICON.tv, home: ICON.camera, music: ICON.music, photo: ICON.photo };

// ---------- push notifications on this device ----------
const Push = {
  supported: () => 'serviceWorker' in navigator && 'PushManager' in window && isSecureContext,
  async current() {
    if (!Push.supported()) return null;
    const reg = await navigator.serviceWorker.ready;
    return reg.pushManager.getSubscription();
  },
  async enable() {
    if (!Push.supported()) throw new Error(isSecureContext ? 'This browser can’t do notifications' : 'Open Marquee at its https:// Tailscale address to turn on notifications');
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') throw new Error('Notifications are blocked for Marquee in this browser’s settings');
    const reg = await navigator.serviceWorker.ready;
    const key = Uint8Array.from(atob(me.pushKey.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - me.pushKey.length % 4) % 4)), c => c.charCodeAt(0));
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    await api('/api/push/subscribe', { body: sub.toJSON() });
  },
  async disable() {
    const sub = await Push.current();
    if (sub) { await api('/api/push/unsubscribe', { body: { endpoint: sub.endpoint } }); await sub.unsubscribe(); }
  },
};

ROUTES.settings = async () => {
  shell('settings', `<div class="page settings"><h1 class="page-title">Settings</h1><div id="s">${loading()}</div></div>`);
  let pushOn = false;
  try { pushOn = !!(await Push.current()); } catch {}
  const draw = async () => {
    const o = me.isAdmin ? await api('/api/admin/overview') : null;
    const s = $('#s');
    if (!s) return;
    const qp = qualityPref();
    s.innerHTML = `
      <div class="panel">
        <div class="list-item" style="padding-top:0">${avatar(me, 44, 12)}
          <div class="grow"><div class="t">${esc(me.name)}${me.isAdmin ? '<span class="pill accent">Admin</span>' : ''}${me.isKids ? '<span class="pill">Kids</span>' : ''}</div><div class="s">${LEVELS[me.maxLevel]}</div></div>
          <button class="btn small" id="switch">Switch profile</button></div>
        <div class="list-item"><div class="grow"><div class="t">Streaming quality on this device</div><div class="s">Auto tests your connection and adjusts if things start buffering</div></div>
          <select class="select" id="qpref">${[['auto', 'Auto'], ['original', 'Original'], ['1080', '1080p'], ['720', '720p'], ['480', '480p'], ['360', '360p']].map(([k, l]) => `<option value="${k}" ${qp === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div class="list-item"><div class="grow"><div class="t">Cinema mode</div><div class="s">A couple of trailers from your library before a movie, like at the pictures</div></div>
          <label class="switch"><input type="checkbox" id="cinema" ${me.cinemaMode ? 'checked' : ''}><span></span></label></div>
        <div class="list-item"><div class="grow"><div class="t">Theme songs</div><div class="s">Play a show's theme quietly when you open it</div></div>
          <label class="switch"><input type="checkbox" id="themes" ${me.themeMusic !== false ? 'checked' : ''}><span></span></label></div>
        ${me.guest ? '' : `<div class="list-item"><div class="grow"><div class="t">Signed-in devices</div><div class="s">See every phone, TV and browser signed in, and sign any out</div></div><a class="btn small" href="#/devices">Open</a></div>`}
        <div class="list-item"><div class="grow"><div class="t">Skip intros automatically</div><div class="s">Jumps past TV theme songs. You can always tap “Skip intro” instead.</div></div>
          <label class="switch"><input type="checkbox" id="autoskip" ${me.autoSkipIntro ? 'checked' : ''}><span></span></label></div>
        ${window.MarqueeNative ? `<div class="list-item"><div class="grow"><div class="t">Marquee app ${esc(MarqueeNative.version())}</div><div class="s">Connected to ${esc(MarqueeNative.server())}. New arrivals show as phone notifications automatically.</div></div>${MarqueeNative.checkUpdates ? '<button class="btn small" id="appUpd">Check for updates</button>' : ''}<button class="btn small" id="appServer">Change server</button></div>`
        : `<div class="list-item"><div class="grow"><div class="t">Notify this device about new arrivals</div><div class="s">${Push.supported() ? 'A notification when new movies, episodes or family videos land' : 'Needs the https:// Tailscale address — see the setup guide'}</div></div>
          ${pushOn ? '<button class="btn small" id="pushTest">Test</button>' : ''}<label class="switch"><input type="checkbox" id="push" ${pushOn ? 'checked' : ''}><span></span></label></div>`}
        <div class="list-item"><div class="grow"><div class="t">Downloads</div><div class="s">${Downloads.saved().length} saved on this device</div></div><a class="btn small" href="#/downloads">Open</a></div>
        ${me.sections?.subtitles ? `<div class="list-item"><div class="grow"><div class="t">Get subtitles automatically</div><div class="s">When a film has none in your language, fetch them from OpenSubtitles</div></div>
          <select class="select" id="subLang">${[['en', 'English'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['it', 'Italian'], ['zh-cn', 'Chinese'], ['ja', 'Japanese'], ['ko', 'Korean'], ['ar', 'Arabic'], ['hi', 'Hindi'], ['pt-br', 'Portuguese']].map(([k, l]) => `<option value="${k}" ${(me.subLang || 'en') === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
          <label class="switch"><input type="checkbox" id="autoSubs" ${me.autoSubs ? 'checked' : ''}><span></span></label></div>` : ''}
        <div class="list-item"><div class="grow"><div class="t">This device's name</div><div class="s">Shown when you control or send things between screens</div></div>
          <input class="input" id="devName" style="max-width:180px;height:38px" value="${esc(Devices.name())}"></div>
        <div class="list-item"><div class="grow"><div class="t">Trakt</div><div class="s" id="traktS">Sync what you watch and rate with trakt.tv</div></div><div id="traktB"></div></div>
        <div class="list-item"><div class="grow"><div class="t">Letterboxd</div><div class="s">Export the films you've watched and rated, then import on letterboxd.com</div></div><a class="btn small" href="/api/letterboxd.csv" download>Export</a></div>
        <div class="list-item"><div class="grow"><div class="t">Your year in Marquee</div><div class="s">Hours watched, favourites and biggest binges</div></div><a class="btn small" href="#/wrapped">Open</a></div>
      </div>
      ${o ? adminPanels(o) : ''}`;
    $('#switch').onclick = async () => { await api('/api/logout', { method: 'POST' }); me = null; go('#/who'); };
    $('#qpref').onchange = e => { store.set('mq_quality', e.target.value); toast('Saved for this device'); };
    $('#cinema').onchange = async e => { await api('/api/me', { method: 'PATCH', body: { cinemaMode: e.target.checked } }); me.cinemaMode = e.target.checked; toast(e.target.checked ? 'Trailers before movies' : 'Cinema mode off'); };
    $('#themes').onchange = async e => { await api('/api/me', { method: 'PATCH', body: { themeMusic: e.target.checked } }); me.themeMusic = e.target.checked; if (!e.target.checked) ThemeMusic.stop(); toast('Saved'); };
    $('#autoskip').onchange = async e => { await api('/api/me', { method: 'PATCH', body: { autoSkipIntro: e.target.checked } }); me.autoSkipIntro = e.target.checked; };
    if ($('#appServer')) $('#appServer').onclick = () => MarqueeNative.openAppSettings();
    if ($('#appUpd')) $('#appUpd').onclick = () => MarqueeNative.checkUpdates();
    if ($('#push')) $('#push').onchange = async e => {
      try { if (e.target.checked) { await Push.enable(); pushOn = true; toast('Notifications on'); } else { await Push.disable(); pushOn = false; } draw(); }
      catch (err) { e.target.checked = false; toast(err.message, 4500); }
    };
    if ($('#autoSubs')) {
      $('#autoSubs').onchange = async e => { await api('/api/me', { method: 'PATCH', body: { autoSubs: e.target.checked } }); me.autoSubs = e.target.checked; toast('Saved'); };
      $('#subLang').onchange = async e => { await api('/api/me', { method: 'PATCH', body: { subLang: e.target.value } }); me.subLang = e.target.value; toast('Saved'); };
    }
    $('#devName').onchange = e => { store.set('mq_device_name', e.target.value.trim() || null); Devices.reconnect(); toast('Saved'); };
    traktUI();
    if ($('#pushTest')) $('#pushTest').onclick = async () => { const r = await api('/api/push/test', { method: 'POST' }); toast(r.sent ? 'Sent — check your notifications' : 'Couldn’t reach this device'); };
    if (o) { wireAdmin(o, draw); loadExtrasPanels(); }
    return o;
  };
  const o = await draw();
  if (o) {
    let wasRunning = o.scan.running;
    const poll = setInterval(async () => {
      try {
        const ov = await api('/api/admin/overview');
        const el = $('#scanStatus');
        if (el) el.innerHTML = scanStatusHTML(ov.scan, ov.intros);
        const vl = $('#versionList');
        if (vl && ov.versions.pending) vl.innerHTML = await versionsHTML();
        if (wasRunning && !ov.scan.running) draw();
        wasRunning = ov.scan.running;
      } catch {}
    }, 2500);
    onLeave(() => clearInterval(poll));
  }
};

async function traktUI() {
  const box = $('#traktB'), info = $('#traktS');
  if (!box) return;
  const t = await api('/api/trakt').catch(() => null);
  if (!t) return;
  if (!t.configured) { info.textContent = me.isAdmin ? 'Add your Trakt app details further down this page to turn this on' : 'Not set up on this server yet'; return; }
  if (t.linked) {
    info.textContent = `Linked${t.username ? ' to ' + t.username : ''} — things you finish and rate are sent to Trakt`;
    box.innerHTML = '<div class="btn-row" style="flex-wrap:nowrap"><button class="btn small" id="tImp">Import history</button><button class="btn small" id="tOff">Unlink</button></div>';
    $('#tImp').onclick = async () => { try { const r = await api('/api/trakt/import', { method: 'POST' }); toast(`${r.marked} items marked watched`); } catch (e) { toast(e.message); } };
    $('#tOff').onclick = async () => { await api('/api/trakt', { method: 'DELETE' }); traktUI(); };
  } else {
    box.innerHTML = '<button class="btn small primary" id="tOn">Link</button>';
    $('#tOn').onclick = async () => {
      try {
        const d = await api('/api/trakt/link', { method: 'POST' });
        const m = modal(`<h2>Link Trakt</h2><p class="hint">On any device, go to <b>${esc(d.url)}</b> and enter this code:</p><div class="big-code">${esc(d.code)}</div><p class="hint" id="tw">Waiting for you to approve…</p>`);
        const poll = setInterval(async () => {
          if (!m.el.isConnected) return clearInterval(poll);
          const r = await api('/api/trakt/poll', { method: 'POST' }).catch(() => ({ state: 'waiting' }));
          if (r.state === 'linked') { clearInterval(poll); m.close(); toast('Trakt linked'); traktUI(); }
          else if (['expired', 'denied'].includes(r.state)) { clearInterval(poll); $('#tw', m.el).textContent = r.state === 'denied' ? 'Linking was declined.' : 'The code expired — try again.'; }
        }, 5000);
      } catch (e) { toast(e.message, 4500); }
    };
  }
}

function scanStatusHTML(st, intros) {
  let h;
  if (st.running) {
    const pct = st.total ? Math.round(st.done / st.total * 100) : 0;
    h = `<div class="s">${esc(st.phase)}${st.library ? ` — ${esc(st.library)}` : ''} · ${st.done}/${st.total}</div><div class="progress-line"><i style="width:${pct}%"></i></div>`;
  } else h = `<div class="s">${st.lastRun ? `Last scan ${ago(st.lastRun)}` : 'Not scanned yet'}${st.lastError ? ` · <span style="color:#ff9a87">${esc(st.lastError)}</span>` : ''}</div>`;
  if (intros?.running) h += `<div class="s">Finding TV intros… ${intros.done}/${intros.total} seasons</div>`;
  return h;
}

async function versionsHTML() {
  const list = await api('/api/admin/versions');
  if (!list.length) return '<p class="hint" style="margin:0">None yet.</p>';
  return list.slice(0, 40).map(v => `<div class="list-item"><div class="grow"><div class="t">${esc(v.show_title ? `${v.show_title} · S${v.season}E${v.episode}` : v.title)} <span class="pill">${v.quality}p</span><span class="pill">${v.reason}</span></div>
    <div class="s">${v.status === 'ready' ? fmtBytes(v.size) : v.status === 'working' ? `Converting… ${Math.round(v.progress * 100)}%` : v.status === 'failed' ? `Failed: ${esc(v.error || '')}` : 'Waiting'}</div>
    ${v.status === 'working' ? `<div class="progress-line"><i style="width:${Math.round(v.progress * 100)}%"></i></div>` : ''}</div>
    <button class="btn small" data-delv="${v.id}">${ICON.trash}</button></div>`).join('');
}

function adminPanels(o) {
  const st = o.stats || {};
  const set = o.settings;
  const stat = (n, l) => n ? `<div class="stat"><b>${n}</b><span>${l}</span></div>` : '';
  return `
    <div class="stats">${stat(st.movies, 'Movies')}${stat(st.shows, 'Shows')}${stat(st.episodes, 'Episodes')}${stat(st.tracks, 'Songs')}${stat(st.photos, 'Photos')}${stat(st.homeVideos, 'Home videos')}
      <div class="stat"><b>${fmtBytes(st.bytes)}</b><span>Library size</span></div></div>
    <div class="tiles small"><a class="tile" href="#/activity">${ICON.pulse}<span>Activity & history</span></a><a class="tile" href="#/health">${ICON.check}<span>Library health</span></a><a class="tile" href="#/devices">${ICON.lock}<span>Signed-in devices</span></a><a class="tile" href="#/shares">${ICON.share}<span>Shared links</span></a><a class="tile" href="#/duplicates">${ICON.stack}<span>Duplicate finder</span></a>
      <a class="tile" href="#/requests">${ICON.plus}<span>Requests${o.pendingRequests ? ` <span class="pill accent">${o.pendingRequests} waiting</span>` : ''}</span></a><a class="tile" href="#/wrapped">${ICON.star}<span>Family Wrapped</span></a></div>
    ${o.disks.filter(d => d.low).map(d => `<div class="st-banner off" style="margin-bottom:14px">${ICON.pulse}<div><b>Storage almost full: ${fmtBytes(d.free)} left</b><span>On the drive with ${esc(d.labels.join(', '))}. Free up some space.</span></div></div>`).join('')}

    <div class="panel">
      <h2>Libraries</h2><p class="hint">Folders Marquee watches. New files are noticed straight away${o.watcher.failed.length ? ' (where possible)' : ''}, and checked again every 30 minutes.</p>
      <div class="list">${o.libraries.map(l => `<div class="list-item">
        <span class="lib-ico">${LIB_ICON[l.type] || ICON.folder}</span>
        <div class="grow"><div class="t">${esc(l.name)}${l.kids_safe ? '<span class="pill accent">Kids safe</span>' : ''}${l.exists ? '' : '<span class="pill bad">Folder missing</span>'}</div><div class="s">${esc(l.path)} · ${l.count} item${l.count === 1 ? '' : 's'}</div></div>
        <button class="btn small" data-lib="${l.id}">Edit</button></div>`).join('') || '<p class="hint">No libraries yet.</p>'}</div>
      <div class="btn-row" style="margin-top:12px"><button class="btn small primary" id="addLib">${ICON.plus} Add library</button><button class="btn small" id="scan" ${o.scan.running ? 'disabled' : ''}>${ICON.refresh} Scan now</button></div>
      <div id="scanStatus" style="margin-top:12px">${scanStatusHTML(o.scan, o.intros)}</div>
      ${o.watcher.failed.length ? `<p class="hint" style="margin:8px 0 0">${o.watcher.failed.map(esc).join('<br>')}</p>` : ''}
    </div>

    <div class="panel">
      <h2>Posters & info</h2>
      <p class="hint">Artwork, descriptions, cast, trailers and age ratings come from The Movie Database. Get a free key at <a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noopener">themoviedb.org/settings/api</a> (sign up, then “Create → Developer”). Paste either the API Key or the Read Access Token.</p>
      <form id="tmdbF" class="btn-row" style="flex-wrap:nowrap"><input class="input" name="k" placeholder="${o.tmdbKeySet ? 'Key saved ' + esc(o.tmdbKeyHint) + ' — paste to replace' : 'Paste your TMDB key'}" autocomplete="off"><button class="btn primary">Save</button></form>
      ${st.unmatched ? `<p class="hint" style="margin:12px 0 0">${st.unmatched} title${st.unmatched === 1 ? '' : 's'} without a match. Open one, tap ⋯ → Fix match.</p>` : ''}
      <div class="btn-row" style="margin-top:12px"><button class="btn small" id="refreshAll">${ICON.refresh} Refresh all info</button></div>
    </div>

    <div class="panel">
      <h2>Family profiles</h2><p class="hint">Everyone gets their own history and My List. Kids profiles see a simpler home screen, only titles at or below their rating (plus “kids safe” libraries), and can have screen-time limits and a bedtime.</p>
      <div class="list">${o.profiles.map(p => `<div class="list-item">${avatar(p)}
        <div class="grow"><div class="t">${esc(p.name)}${p.isAdmin ? '<span class="pill accent">Admin</span>' : ''}${p.isKids ? '<span class="pill">Kids</span>' : ''}${p.hasPin ? '<span class="pill">PIN</span>' : ''}</div>
        <div class="s">${LEVELS[p.maxLevel]}${p.limitToday != null ? ` · ${fmtMins(p.usedToday)} of ${fmtMins(p.limitToday)} used today` : p.usedToday ? ` · ${fmtMins(p.usedToday)} today` : ''}${p.episodeLimit != null ? ` · ${p.episodesToday ?? 0} of ${p.episodeLimit} episodes` : ''}${p.bedtimeStart ? ` · bedtime ${p.bedtimeStart}–${p.bedtimeEnd}` : ''}</div>
        ${p.isKids && p.week?.some(d => d.minutes) ? weekChart(p.week, p.limitToday) : ''}</div>
        ${p.limitToday != null ? `<button class="btn small" data-bonus="${p.id}" title="Give 30 more minutes today">+30m</button>` : ''}
        <button class="btn small" data-prof="${p.id}">Edit</button></div>`).join('')}</div>
      <div class="btn-row" style="margin-top:12px"><button class="btn small primary" id="addProf">${ICON.plus} Add profile</button></div>
    </div>

    <div class="panel">
      <h2>Prepared copies</h2>
      <p class="hint">Marquee can convert things ahead of time into phone-friendly copies, so they start instantly and use less of the box's power while you watch. Downloads use these too.</p>
      <div class="list-item"><div class="grow"><div class="t">Prepare the next episodes automatically</div><div class="s">For shows people are watching, the next 2 episodes are made ready overnight-style in the background</div></div>
        <label class="switch"><input type="checkbox" id="autoOpt" ${set.autoOptimize ? 'checked' : ''}><span></span></label></div>
      <div class="list-item"><div class="grow"><div class="t">Quality</div></div><select class="select" id="optQ">${['1080', '720', '480'].map(q => `<option ${set.autoOptimizeQuality === q ? 'selected' : ''} value="${q}">${q}p</option>`).join('')}</select></div>
      <div class="list-item"><div class="grow"><div class="t">Space to use</div><div class="s">Oldest copies are removed first. Currently ${fmtBytes(o.versions.bytes)}.</div></div>
        <select class="select" id="optGb">${[10, 25, 50, 100, 250, 500].map(g => `<option ${set.optimizeMaxGb === g ? 'selected' : ''} value="${g}">${g} GB</option>`).join('')}</select></div>
      <h3 class="sub-h">Copies</h3><div class="list" id="versionList">${loading()}</div>
    </div>

    <div class="panel">
      <h2>Storage</h2>
      ${o.disks.map(d => `<div class="wr-bar disk"><span>${esc(d.labels.join(', '))}</span><div class="progress-line ${d.low ? 'bad' : ''}"><i style="width:${Math.round((1 - d.pct) * 100)}%"></i></div><b>${fmtBytes(d.free)} free</b></div>`).join('')}
      <p class="hint" style="margin:10px 0 0">You'll get a notification if a drive drops below 8% (or 10 GB) free.</p>
    </div>
    <div id="extrasPanels"></div>

    <div class="panel">
      <h2>Scrub previews</h2><p class="hint">Little pictures appear above the progress bar while you drag it, so you can find a scene. They're made in the background, a few seconds per film. ${o.trickplay.done} ready${o.trickplay.running ? ` · working ${o.trickplay.done}/${o.trickplay.total}` : ''}.</p>
      <div class="list-item" style="border:0;padding:0"><div class="grow"><div class="t">Make scrub previews</div></div><label class="switch"><input type="checkbox" id="trickOn" ${o.trickplay.enabled ? 'checked' : ''}><span></span></label></div>
    </div>

    <div class="panel">
      <h2>TV intros</h2><p class="hint">Marquee listens to the start of each episode and finds the theme song that repeats, so you can skip it. ${o.intros.available ? `${o.intros.found} episodes have a skippable intro so far.` : 'This ffmpeg build can’t fingerprint audio — only chapter markers will be used.'}</p>
      <div class="btn-row"><button class="btn small" id="introRun">${ICON.refresh} Look again</button></div>
    </div>

    <div class="panel">
      <h2>Requests (Radarr & Sonarr)</h2>
      <p class="hint">Let the family ask for movies and shows. Approved requests go to <a href="https://radarr.video" target="_blank" rel="noopener">Radarr</a> (movies) and <a href="https://sonarr.tv" target="_blank" rel="noopener">Sonarr</a> (TV) to be downloaded automatically, and Marquee tells the person when it's ready. Both are in the ZimaOS App Store. Find each API key in their Settings → General.</p>
      ${['radarr', 'sonarr'].map(k => `<form class="arr" data-arr="${k}"><h3 class="sub-h">${k === 'radarr' ? 'Radarr (movies)' : 'Sonarr (TV)'}</h3>
        <div class="two"><input class="input" name="url" placeholder="http://192.168.1.50:${k === 'radarr' ? 7878 : 8989}" value="${esc(set[k + 'Url'])}"><input class="input" name="key" placeholder="${set[k + 'KeySet'] ? 'API key saved — paste to replace' : 'API key'}" autocomplete="off"></div>
        <div class="btn-row" style="margin-top:8px"><button class="btn small">Save & test</button><span class="hint arr-status" style="margin:0">${set[k + 'Root'] ? `Saving to ${esc(set[k + 'Root'])}` : ''}</span></div>
        <div class="two arr-opts hidden" style="margin-top:8px"><select class="input" name="root"></select><select class="input" name="profile"></select></div></form>`).join('')}
      <div class="list-item" style="border:0;padding:12px 0 0"><div class="grow"><div class="t">Approve grown-ups' requests automatically</div><div class="s">Kids' requests always wait for you</div></div><label class="switch"><input type="checkbox" id="reqAuto" ${set.requestsAuto ? 'checked' : ''}><span></span></label></div>
    </div>

    <div class="panel">
      <h2>Subtitles (OpenSubtitles)</h2>
      <p class="hint">Make a free account at <a href="https://www.opensubtitles.com" target="_blank" rel="noopener">opensubtitles.com</a>, then create an API key under <i>API consumers</i>. Your username and password raise the daily download limit.</p>
      <form id="osF"><div class="two"><input class="input" name="key" placeholder="${set.osApiKeySet ? 'API key saved — paste to replace' : 'API key'}" autocomplete="off"><input class="input" name="langs" value="${esc(set.osLanguages)}" placeholder="Languages, e.g. en,es"></div>
        <div class="two" style="margin-top:8px"><input class="input" name="user" value="${esc(set.osUsername)}" placeholder="Username (optional)" autocomplete="off"><input class="input" name="pass" type="password" placeholder="Password (optional)" autocomplete="new-password"></div>
        <button class="btn small" style="margin-top:8px">Save</button></form>
    </div>

    <div class="panel">
      <h2>Trakt</h2>
      <p class="hint">To let family members sync with trakt.tv, create an app at <a href="https://trakt.tv/oauth/applications/new" target="_blank" rel="noopener">trakt.tv/oauth/applications</a> (any name; redirect URI <span class="code">urn:ietf:wg:oauth:2.0:oob</span>) and paste its details here. Each person then links their own account in their Settings.</p>
      <form id="trF"><div class="two"><input class="input" name="id" value="${esc(set.traktClientId)}" placeholder="Client ID" autocomplete="off"><input class="input" name="secret" placeholder="${set.traktSecretSet ? 'Secret saved — paste to replace' : 'Client secret'}" autocomplete="off"></div>
        <button class="btn small" style="margin-top:8px">Save</button></form>
    </div>

    <div class="panel">
      <h2>Notifications & casting</h2>
      <form id="hookF" class="field"><label>Webhook (optional) — get a message in JARVIS, Discord, Slack or ntfy when new things arrive</label>
        <div class="btn-row" style="flex-wrap:nowrap"><input class="input" name="u" value="${esc(set.webhookUrl)}" placeholder="https://…"><button class="btn">Save</button></div></form>
      <form id="lanF" class="field"><label>Home network address — needed for Chromecast (your TV can't use the Tailscale address)</label>
        <div class="btn-row" style="flex-wrap:nowrap"><input class="input" name="u" value="${esc(set.lanUrl)}" placeholder="http://192.168.1.50:8420"><button class="btn">Save</button></div></form>
    </div>

    <div class="panel">
      <h2>Backups</h2><p class="hint">Profiles, PINs, watch history, My Lists, family lists and settings — not your media files. Artwork you uploaded, scrub previews, downloaded subtitles and face names live next to the database and are not inside this file. A backup is also saved automatically every night (last 7 kept).</p>
      <div class="btn-row"><a class="btn small primary" href="/api/admin/backup" download>${ICON.download} Download backup</a>
        <label class="btn small">Restore from file…<input type="file" accept=".json,application/json" id="restoreFile" hidden></label></div>
      ${o.backups.length ? `<div class="list" style="margin-top:10px">${o.backups.map(b => `<div class="list-item"><div class="grow"><div class="t">${esc(b.name)}</div><div class="s">${fmtBytes(b.size)}</div></div><a class="btn small" href="/api/admin/backups/${encodeURIComponent(b.name)}" download>${ICON.download}</a></div>`).join('')}</div>` : ''}
    </div>

    <div class="panel">
      <h2>Server</h2>
      <form id="nameF" class="field"><label>Server name</label><div class="btn-row" style="flex-wrap:nowrap"><input class="input" name="n" value="${esc(o.serverName)}" maxlength="40"><button class="btn">Save</button></div></form>
      <div class="facts" style="margin-top:4px">
        <b>Transcoding</b><span>${o.transcoding.hwaccel === 'none' ? 'Software (CPU)' : `Intel/AMD GPU (${esc(o.transcoding.hwaccel)})${o.transcoding.hwAvailable === false ? ' — <span style="color:#ff9a87">not working, using CPU</span>' : ''}`}</span>
        <b>Live streams</b><span>${o.transcoding.activeStreams}</span>
        <b>Away from home</b><span>Install Tailscale on the server and your devices, then open Marquee at your server’s Tailscale name. See the setup guide.</span>
      </div>
    </div>`;
}

function wireAdmin(o, redraw) {
  $('#scan').onclick = async () => { await api('/api/admin/scan', { method: 'POST' }); toast('Scanning…'); $('#scan').disabled = true; };
  $('#refreshAll').onclick = async () => { await api('/api/admin/refresh', { method: 'POST' }); toast('Refreshing all posters & info…'); };
  $('#introRun').onclick = async () => { await api('/api/admin/intros', { body: { redo: true } }); toast('Looking for intros in the background'); };
  $('#tmdbF').onsubmit = async e => {
    e.preventDefault();
    const k = new FormData(e.target).get('k').trim();
    if (!k) return;
    try { await api('/api/admin/settings', { method: 'PUT', body: { tmdbApiKey: k } }); toast('Key works — fetching posters'); redraw(); }
    catch (err) { toast(err.message, 4000); }
  };
  const saveSetting = async (body, msg = 'Saved') => { try { await api('/api/admin/settings', { method: 'PUT', body }); toast(msg); } catch (e) { toast(e.message, 4000); } };
  $('#nameF').onsubmit = async e => { e.preventDefault(); await saveSetting({ serverName: new FormData(e.target).get('n') }); await refreshMe(); ROUTES.settings(); };
  $('#hookF').onsubmit = e => { e.preventDefault(); saveSetting({ webhookUrl: new FormData(e.target).get('u') }); };
  $('#lanF').onsubmit = e => { e.preventDefault(); saveSetting({ lanUrl: new FormData(e.target).get('u') }); };
  $('#trickOn').onchange = e => saveSetting({ trickplay: e.target.checked }, e.target.checked ? 'Making scrub previews in the background' : 'Turned off');
  $('#reqAuto').onchange = e => saveSetting({ requestsAuto: e.target.checked });
  $('#osF').onsubmit = e => { e.preventDefault(); const f = new FormData(e.target); saveSetting({ osApiKey: f.get('key'), osLanguages: f.get('langs'), osUsername: f.get('user'), osPassword: f.get('pass') }); };
  $('#trF').onsubmit = e => { e.preventDefault(); const f = new FormData(e.target); saveSetting({ traktClientId: f.get('id'), traktClientSecret: f.get('secret') }); };
  $$('form.arr').forEach(form => {
    const k = form.dataset.arr, status = $('.arr-status', form), opts = $('.arr-opts', form);
    const showOpts = async () => {
      try {
        const o2 = await api(`/api/admin/arr/${k}`);
        status.textContent = `Connected (v${o2.version})`;
        opts.classList.remove('hidden');
        const set2 = o.settings;
        $('[name=root]', form).innerHTML = o2.roots.map(r => `<option value="${esc(r.path)}" ${r.path === set2[k + 'Root'] ? 'selected' : ''}>${esc(r.path)} (${fmtBytes(r.free)} free)</option>`).join('');
        $('[name=profile]', form).innerHTML = o2.profiles.map(p => `<option value="${p.id}" ${String(p.id) === String(set2[k + 'Profile']) ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
        const saveOpts = () => saveSetting({ [k + 'Root']: $('[name=root]', form).value, [k + 'Profile']: $('[name=profile]', form).value });
        $('[name=root]', form).onchange = saveOpts; $('[name=profile]', form).onchange = saveOpts;
        if (!set2[k + 'Root']) saveOpts();
      } catch (err) { status.textContent = err.message; }
    };
    form.onsubmit = async e => {
      e.preventDefault();
      const f = new FormData(form);
      try { await api('/api/admin/settings', { method: 'PUT', body: { [k + 'Url']: f.get('url'), [k + 'Key']: f.get('key') } }); status.textContent = 'Testing…'; showOpts(); }
      catch (err) { toast(err.message, 4000); }
    };
    if (o.settings[k + 'Url'] && o.settings[k + 'KeySet']) showOpts();
  });
  $('#autoOpt').onchange = e => saveSetting({ autoOptimize: e.target.checked }, e.target.checked ? 'Next episodes will be prepared automatically' : 'Turned off');
  $('#optQ').onchange = e => saveSetting({ autoOptimizeQuality: e.target.value });
  $('#optGb').onchange = e => saveSetting({ optimizeMaxGb: +e.target.value });
  versionsHTML().then(h => { const el = $('#versionList'); if (el) { el.innerHTML = h; bindVersions(); } });
  function bindVersions() { $$('[data-delv]').forEach(b => b.onclick = async () => { await api(`/api/admin/versions/${b.dataset.delv}`, { method: 'DELETE' }); $('#versionList').innerHTML = await versionsHTML(); bindVersions(); }); }
  $('#restoreFile').onchange = async e => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (!confirm('Restore this backup? Current profiles, history and lists will be replaced, and everyone will need to pick their profile again.')) return;
      const r = await api('/api/admin/restore', { body: data });
      toast(`Restored${r.waiting ? ` — ${r.waiting} items will finish after the scan` : ''}`, 4000);
      me = null; go('#/who');
    } catch (err) { toast(err.message || 'That file isn’t a Marquee backup', 4000); }
  };
  $('#addLib').onclick = () => libraryModal(null, o, redraw);
  $$('[data-lib]').forEach(b => b.onclick = () => libraryModal(o.libraries.find(l => l.id === +b.dataset.lib), o, redraw));
  $('#addProf').onclick = () => profileModal(null, redraw, o);
  $$('[data-prof]').forEach(b => b.onclick = () => profileModal(o.profiles.find(p => p.id === +b.dataset.prof), redraw, o));
  $$('[data-bonus]').forEach(b => b.onclick = async () => { await api(`/api/admin/profiles/${b.dataset.bonus}/bonus`, { body: { minutes: 30 } }); toast('30 more minutes today'); redraw(); });
}

function libraryModal(lib, o, redraw) {
  if (lib) {
    const m = modal(`<h2>${esc(lib.name)}</h2><p class="hint">${esc(lib.path)}</p>
      <div class="field"><label>Name</label><input class="input" id="ln" value="${esc(lib.name)}"></div>
      <div class="list-item" style="border:0;padding:0 0 16px"><div class="grow"><div class="t">Kids safe</div><div class="s">Kids profiles see everything in here, rated or not</div></div>
        <label class="switch"><input type="checkbox" id="lk" ${lib.kids_safe ? 'checked' : ''}><span></span></label></div>
      <div class="btn-row"><button class="btn primary" id="ls">Save</button><button class="btn danger" id="ld">Remove library</button></div>
      <p class="hint" style="margin-top:12px">Removing a library only removes it from Marquee — your files are never touched.</p>`);
    $('#ls', m.el).onclick = async () => { await api(`/api/admin/libraries/${lib.id}`, { method: 'PATCH', body: { name: $('#ln', m.el).value, kidsSafe: $('#lk', m.el).checked } }); m.close(); redraw(); };
    $('#ld', m.el).onclick = async e => { if (!confirmTwice(e.target, 'Tap again to remove')) return; await api(`/api/admin/libraries/${lib.id}`, { method: 'DELETE' }); m.close(); redraw(); };
    return;
  }
  let path = '/media';
  const types = o.libraryTypes;
  const m = modal(`<h2>Add library</h2>
    <div class="field"><label>What's in it?</label><div class="type-pick">${Object.entries(types).map(([k, l], i) => `<button data-t="${k}" class="${i ? '' : 'on'}">${LIB_ICON[k]}<span>${l}</span></button>`).join('')}</div></div>
    <div class="field"><label>Name</label><input class="input" id="ln" value="Movies"></div>
    <div class="field"><label>Folder</label><div class="code" id="lp" style="padding:10px 12px"></div></div>
    <div class="folder-list" id="fl"></div>
    <div class="list-item" style="border:0;padding:0 0 16px"><div class="grow"><div class="t">Kids safe</div><div class="s">Kids profiles see everything in here</div></div><label class="switch"><input type="checkbox" id="lk"><span></span></label></div>
    <button class="btn primary" id="la" style="width:100%">Add this folder</button>
    <p class="hint" style="margin-top:12px">Only folders shared with the Marquee app are visible — on ZimaOS that's anything mounted under <span class="code">/media</span> in the app settings.</p>`);
  let type = 'movie';
  $$('[data-t]', m.el).forEach(b => b.onclick = () => {
    type = b.dataset.t;
    $$('[data-t]', m.el).forEach(x => x.classList.toggle('on', x === b));
    $('#ln', m.el).value = types[type];
    $('#lk', m.el).checked = ['home', 'music', 'photo'].includes(type);
  });
  const browse = async p => {
    try {
      const r = await api(`/api/admin/browse?path=${encodeURIComponent(p)}`);
      path = r.path;
      $('#lp', m.el).textContent = path;
      $('#fl', m.el).innerHTML = (r.parent ? `<button data-p="${esc(r.parent)}">${ICON.arrowLeft}<span>Up a level</span></button>` : '') +
        (r.dirs.map(d => `<button data-p="${esc((path === '/' ? '' : path) + '/' + d)}">${ICON.folder}<span>${esc(d)}</span></button>`).join('') || '<p class="hint" style="padding:12px 14px;margin:0">No subfolders</p>');
      $$('#fl button', m.el).forEach(b => b.onclick = () => browse(b.dataset.p));
    } catch (e) { if (p !== '/') browse('/'); else toast(e.message); }
  };
  $('#la', m.el).onclick = async () => {
    try { await api('/api/admin/libraries', { body: { name: $('#ln', m.el).value, type, path, kidsSafe: $('#lk', m.el).checked } }); m.close(); toast('Library added — scanning'); redraw(); }
    catch (e) { toast(e.message, 4000); }
  };
  browse(path);
}

// Last 7 days of watching, as little bars
function weekChart(week, limit) {
  const max = Math.max(limit ? limit / 60 : 0, ...week.map(d => d.minutes), 30);
  return `<div class="week-chart" title="Last 7 days">${week.map(d => `<span><i style="height:${Math.max(2, Math.round(d.minutes / max * 34))}px" class="${limit && d.minutes * 60 > limit ? 'over' : ''}"></i><small>${esc(d.label[0])}</small></span>`).join('')}</div>`;
}

function profileModal(p, redraw, o) {
  const colors = ['#f0b429', '#e0533d', '#3d9be0', '#45b36b', '#a65fd9', '#e05d9b', '#22b5b0', '#f07c2a'];
  let color = p?.color || colors[Math.floor(Math.random() * colors.length)];
  const mins = v => (v == null ? '' : v);
  const m = modal(`<h2>${p ? 'Edit profile' : 'New profile'}</h2>
    <div class="field"><label>Name</label><input class="input" id="pn" value="${esc(p?.name || '')}" maxlength="30" placeholder="e.g. Zoey"></div>
    <div class="field"><label>Colour</label><div class="swatches">${colors.map(c => `<button style="background:${c}" data-c="${c}" class="${c === color ? 'on' : ''}"></button>`).join('')}</div></div>
    <div class="list-item" style="border:0;padding:4px 0 14px"><div class="grow"><div class="t">Kids profile</div><div class="s">Simpler home screen, no settings or search</div></div><label class="switch"><input type="checkbox" id="pk" ${p?.isKids ? 'checked' : ''}><span></span></label></div>
    <div class="field"><label>Can watch</label><select class="input" id="pl">${LEVELS.map((l, i) => `<option value="${i}" ${(p ? p.maxLevel : 4) === i ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    <div class="field"><label>Daily screen time (minutes, blank = no limit)</label><div class="two">
      <input class="input" id="lwd" inputmode="numeric" placeholder="School days" value="${mins(p?.limitWeekday)}"><input class="input" id="lwe" inputmode="numeric" placeholder="Weekends" value="${mins(p?.limitWeekend)}"></div></div>
    <div class="field"><label>Bedtime — no watching between (optional)</label><div class="two">
      <input class="input" id="bs" type="time" value="${p?.bedtimeStart || ''}"><input class="input" id="be" type="time" value="${p?.bedtimeEnd || ''}"></div></div>
    <div class="field"><label>Episodes per day (blank = no limit)</label><input class="input" id="pel" inputmode="numeric" placeholder="e.g. 3" value="${mins(p?.episodeLimit)}"></div>
    <div class="list-item" style="border:0;padding:0 0 14px"><div class="grow"><div class="t">Let them finish the episode</div><div class="s">When time runs out mid-episode, it plays to the end and then says goodbye — instead of stopping mid-scene</div></div><label class="switch"><input type="checkbox" id="plf" ${p?.letFinish ? 'checked' : ''}><span></span></label></div>
    <div class="field"><label>PIN ${p?.hasPin ? '(leave blank to keep the current one)' : '(optional, 4–8 digits)'}</label><input class="input" id="pp" inputmode="numeric" type="password" autocomplete="new-password" placeholder="${p?.hasPin ? '••••' : 'No PIN'}"></div>
    ${p?.hasPin && !p.isAdmin ? `<label style="display:flex;gap:8px;align-items:center;margin:-4px 0 14px;color:var(--muted);font-size:13.5px"><input type="checkbox" id="pr"> Remove PIN</label>` : ''}
    <div class="field"><label>Highest streaming quality</label><select class="input" id="pq">${[['', 'No limit'], ['1080', '1080p'], ['720', '720p'], ['480', '480p — good for friends far away'], ['360', '360p']].map(([k, l]) => `<option value="${k}" ${(p?.maxQuality || '') === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    <div class="field"><label>Libraries this profile can open</label>
      <p class="hint">Untick a library and it disappears for this profile, including search. A kids profile should only have Zoey Movies and Zoey TV ticked. Mark those libraries “Safe for kids” when you add them.</p>
      <div class="lib-checks">${o.libraries.map(l => `<label><input type="checkbox" value="${l.id}" data-safe="${l.kids_safe ? 1 : 0}" ${!p || !p.libraries?.length || p.libraries.includes(l.id) ? 'checked' : ''}> ${esc(l.name)}${l.kids_safe ? ' · kids' : ''}</label>`).join('')}</div></div>
    <div class="list-item" style="border:0;padding:0 0 14px"><div class="grow"><div class="t">Guest (friends & grandparents)</div><div class="s">Hidden from “Who's watching?”. They sign in with an invite link instead.</div></div><label class="switch"><input type="checkbox" id="ph" ${p?.hidden ? 'checked' : ''}><span></span></label></div>
    ${p && !p.isAdmin ? `<div class="field"><label>Invite links</label>${(p.invites || []).map(i => `<div class="invite-row"><span class="code">…${esc(i.token.slice(-6))}</span><span class="hint" style="margin:0">${i.expires_at ? `until ${fmtDate(i.expires_at)}` : 'no expiry'} · used ${i.uses}×</span><button class="btn small" data-copy="${esc(i.token)}">Copy</button><button class="btn small danger" data-revoke="${esc(i.token)}">Remove</button></div>`).join('')}
      <button class="btn small" id="newInv">${ICON.plus} Make an invite link</button></div>` : ''}
    ${p && p.id !== me.id ? `<div class="list-item" style="border:0;padding:0 0 14px"><div class="grow"><div class="t">Admin</div><div class="s">Can change settings, libraries and profiles</div></div><label class="switch"><input type="checkbox" id="pa" ${p.isAdmin ? 'checked' : ''}><span></span></label></div>` : ''}
    <div class="btn-row"><button class="btn primary" id="ps">${p ? 'Save' : 'Create'}</button>${p && p.id !== me.id ? '<button class="btn danger" id="pd">Delete</button>' : ''}</div>`);
  $$('.swatches button', m.el).forEach(b => b.onclick = () => { color = b.dataset.c; $$('.swatches button', m.el).forEach(x => x.classList.toggle('on', x === b)); });
  $('#pk', m.el).onchange = e => {
    $('#pl', m.el).value = e.target.checked ? '1' : '4';
    if (e.target.checked) $$('.lib-checks input', m.el).forEach(c => { if (c.dataset.safe !== '1') c.checked = false; });
  };
  $('#ps', m.el).onclick = async () => {
    const num = v => (v.trim() === '' ? null : parseInt(v, 10));
    const allLibs = $$('.lib-checks input', m.el), libs = allLibs.filter(c => c.checked).map(c => +c.value);
    if (!libs.length) return toast('Pick at least one library');
    const body = { maxQuality: $('#pq', m.el).value || null, hidden: $('#ph', m.el).checked, libraries: ($('#pk', m.el).checked || libs.length !== allLibs.length) ? libs : [],
      name: $('#pn', m.el).value, color, isKids: $('#pk', m.el).checked, maxLevel: +$('#pl', m.el).value,
      limitWeekday: num($('#lwd', m.el).value), limitWeekend: num($('#lwe', m.el).value), bedtimeStart: $('#bs', m.el).value, bedtimeEnd: $('#be', m.el).value,
      episodeLimit: num($('#pel', m.el).value), letFinish: $('#plf', m.el).checked };
    if ((body.bedtimeStart && !body.bedtimeEnd) || (!body.bedtimeStart && body.bedtimeEnd)) return toast('Set both bedtime times, or neither');
    const pin = $('#pp', m.el).value.trim();
    if (pin) body.pin = pin;
    if ($('#pr', m.el)?.checked) body.pin = null;
    if ($('#pa', m.el)) body.isAdmin = $('#pa', m.el).checked;
    try {
      if (p) await api(`/api/admin/profiles/${p.id}`, { method: 'PATCH', body }); else await api('/api/admin/profiles', { body });
      m.close(); toast('Saved');
      if (p?.id === me.id) await refreshMe();
      redraw();
    } catch (e) { toast(e.message, 4000); }
  };
  const inviteUrl = t => `${location.origin}/#/invite/${t}`;
  $$('[data-copy]', m.el).forEach(b => b.onclick = () => shareInvite(inviteUrl(b.dataset.copy), p.name));
  $$('[data-revoke]', m.el).forEach(b => b.onclick = async () => { await api(`/api/admin/invites/${b.dataset.revoke}?signOut=1`, { method: 'DELETE' }); m.close(); toast('Invite removed and their devices signed out'); redraw(); });
  if ($('#newInv', m.el)) $('#newInv', m.el).onclick = async () => {
    const r = await api('/api/admin/invites', { body: { profileId: p.id, days: 14 } });
    m.close(); redraw();
    shareInvite(inviteUrl(r.token), p.name);
  };
  if ($('#pd', m.el)) $('#pd', m.el).onclick = async e => {
    if (!confirmTwice(e.target, 'Tap again to delete')) return;
    await api(`/api/admin/profiles/${p.id}`, { method: 'DELETE' }); m.close(); redraw();
  };
}

// ---------- activity ----------
ROUTES.activity = async () => {
  if (!me.isAdmin) return go('#/', true);
  shell('more', `<div class="page settings"><h1 class="page-title">Activity</h1><div id="act">${loading()}</div><div id="hist"></div></div>`);
  let filter = '';
  const drawLive = async () => {
    const a = await api('/api/admin/activity');
    const el = $('#act');
    if (!el) return;
    const sys = a.system;
    const memPct = Math.round((1 - sys.memFree / sys.memTotal) * 100);
    const cpuPct = Math.min(100, Math.round(sys.load / sys.cpus * 100));
    const disk = sys.transcodeDisk;
    el.innerHTML = `
      <div class="stats">
        <div class="stat"><b>${cpuPct}%</b><span>Processor busy</span><div class="progress-line"><i style="width:${cpuPct}%"></i></div></div>
        <div class="stat"><b>${memPct}%</b><span>Memory used</span><div class="progress-line"><i style="width:${memPct}%"></i></div></div>
        ${disk ? `<div class="stat"><b>${fmtBytes(disk.free)}</b><span>Free for streaming</span></div>` : ''}
        <div class="stat"><b>${a.nowPlaying.length}</b><span>Watching now</span></div>
      </div>
      <div class="panel"><h2>Watching now</h2>
      ${a.nowPlaying.length ? a.nowPlaying.map(n => `<div class="np-row">
        <div class="np-poster">${n.poster ? `<img src="/img/${n.poster}" alt="">` : ICON.film}</div>
        <div class="grow"><div class="t">${esc(n.showTitle ? `${n.showTitle} · S${n.season}E${n.episode}` : n.title)}</div>
          <div class="s">${avatar({ name: n.profileName, color: n.profileColor }, 18, 5)} ${esc(n.profileName)} · ${esc(n.device)} · ${n.state === 'paused' ? 'Paused' : 'Playing'}</div>
          <div class="s">${n.mode === 'direct' ? 'Direct play' : n.transcoding ? `Converting${n.hw ? ' (GPU)' : ''} · ${n.quality === 'original' ? 'original' : n.quality + 'p'}` : 'Direct stream'}</div>
          <div class="progress-line"><i style="width:${n.duration ? Math.min(100, n.position / n.duration * 100) : 0}%"></i></div></div>
        <button class="btn small danger" data-stop="${esc(n.deviceId)}">Stop</button></div>`).join('') : '<p class="hint" style="margin:0">Nobody is watching right now.</p>'}</div>`;
    $$('[data-stop]', el).forEach(b => b.onclick = async () => {
      const msg = prompt('Message to show on their screen', 'Playback was stopped by the server admin.');
      if (msg === null) return;
      await api('/api/admin/activity/stop', { body: { deviceId: b.dataset.stop, message: msg } });
      toast('Stopping…');
    });
  };
  const drawHistory = async () => {
    const [h, ov] = await Promise.all([api(`/api/admin/history${filter ? `?profileId=${filter}` : ''}`), api('/api/admin/overview')]);
    const el = $('#hist');
    if (!el) return;
    el.innerHTML = `<div class="panel"><div class="section-head"><h2>History</h2>
      <select class="select" id="hf"><option value="">Everyone</option>${ov.profiles.map(p => `<option value="${p.id}" ${String(p.id) === filter ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>
      ${h.usage.length ? `<div class="usage">${h.usage.slice().reverse().map(u => `<div title="${u.day}: ${fmtMins(u.seconds)}"><i style="height:${Math.min(100, u.seconds / 72)}%"></i><span>${new Date(u.day).toLocaleDateString(undefined, { weekday: 'narrow' })}</span></div>`).join('')}</div>` : ''}
      ${h.history.length ? `<div class="list">${h.history.map(x => `<div class="list-item">${avatar({ name: x.profile_name, color: x.profile_color }, 28, 8)}
        <div class="grow"><div class="t">${x.item_id ? `<a href="#/item/${x.item_id}">${esc(x.title)}</a>` : esc(x.title)}</div><div class="s">${esc(x.profile_name)} · ${esc(x.device || '')} · ${ago(x.started_at)} · watched ${fmtMins(x.seconds)}</div></div></div>`).join('')}</div>`
        : '<p class="hint">No viewing yet.</p>'}</div>`;
    $('#hf').onchange = e => { filter = e.target.value; drawHistory(); };
  };
  await Promise.all([drawLive(), drawHistory()]);
  const t = setInterval(drawLive, 5000);
  onLeave(() => clearInterval(t));
};

ROUTES.duplicates = async () => {
  if (!me.isAdmin) return go('#/', true);
  shell('more', `<div class="page settings"><h1 class="page-title">Duplicate finder</h1>${loading()}</div>`);
  const groups = await api('/api/admin/duplicates');
  $('#main').innerHTML = `<div class="page settings"><h1 class="page-title">Duplicate finder</h1>
    <p class="hint">Films you have more than one copy of. Marquee already shows only the best copy in your library — these lists help you free up space. Nothing is deleted from here; remove extra files from ZimaOS Files.</p>
    ${groups.length ? groups.map(g => `<div class="panel"><h2>${esc(g.title)} ${g.year ? `<span style="color:var(--muted)">(${g.year})</span>` : ''}</h2><div class="list">${g.files.map(f => `<div class="list-item">
      <div class="grow"><div class="t">${f.id === g.keep ? '<span class="pill accent">Best</span>' : '<span class="pill">Extra</span>'} ${f.width}×${f.height} · ${esc((f.codec || '').toUpperCase())} · ${fmtBytes(f.size)}</div><div class="s" title="${esc(f.path)}">${esc(f.path)}</div></div></div>`).join('')}</div>
      <p class="hint" style="margin:10px 0 0">Removing the extras would free ${fmtBytes(g.files.filter(f => f.id !== g.keep).reduce((s, f) => s + (f.size || 0), 0))}.</p></div>`).join('')
      : emptyView(ICON.check, 'No duplicates', 'Every film in your library is there just once.')}</div>`;
};


function shareInvite(url, name) {
  const text = `You're invited to watch on our Marquee! 1) Install Tailscale and accept the share I sent you. 2) Open this link: ${url}`;
  const m = modal(`<h2>Invite for ${esc(name)}</h2><p class="hint">This link signs them straight into the <b>${esc(name)}</b> profile. They also need Tailscale — share your Marquee machine with them from the Tailscale admin page (see the setup guide).</p>
    <div class="code" style="padding:12px;word-break:break-all;margin-bottom:12px">${esc(url)}</div>
    <div class="btn-row">${navigator.share ? '<button class="btn primary" id="sh">Share…</button>' : ''}<button class="btn" id="cp">Copy link</button></div>`);
  if ($('#sh', m.el)) $('#sh', m.el).onclick = () => navigator.share({ title: 'Marquee invite', text, url }).catch(() => {});
  $('#cp', m.el).onclick = () => { navigator.clipboard?.writeText(text).then(() => toast('Copied'), () => toast('Copy the link above')); };
}
