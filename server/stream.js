// Playback: direct play when the device can handle the file, otherwise HLS via ffmpeg.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const { TRANSCODE_DIR, HWACCEL, VAAPI_DEVICE, MAX_TRANSCODES } = require('./config');

// Clear out stream folders left from last run (keeps optimized copies)
fs.mkdirSync(TRANSCODE_DIR, { recursive: true });
for (const f of fs.readdirSync(TRANSCODE_DIR)) if (f !== 'optimized') fs.rmSync(path.join(TRANSCODE_DIR, f), { recursive: true, force: true });
fs.mkdirSync(path.join(TRANSCODE_DIR, 'subs'), { recursive: true });

const QUALITIES = {
  original: { label: 'Original', height: 99999, bitrate: 0 },
  '1080': { label: '1080p · 8 Mbps', height: 1080, bitrate: 8_000_000 },
  '720': { label: '720p · 4 Mbps', height: 720, bitrate: 4_000_000 },
  '480': { label: '480p · 1.5 Mbps', height: 480, bitrate: 1_500_000 },
  '360': { label: '360p · 0.7 Mbps', height: 360, bitrate: 700_000 },
};

// What this ffmpeg build can do
let HAS_ZSCALE = false;
try { HAS_ZSCALE = /\bzscale\b/.test(execFileSync('ffmpeg', ['-hide_banner', '-filters'], { encoding: 'utf8' })); } catch {}
const hwStatus = { mode: HWACCEL, ok: HWACCEL === 'none' ? null : fs.existsSync(VAAPI_DEVICE), failures: 0 };

const sessions = new Map();

function itemProbe(item) {
  try { return JSON.parse(item.probe || 'null') || {}; } catch { return {}; }
}

// caps comes from the browser: { h264, hevc, av1, vp9, ac3, eac3, mkv }
function decide(item, quality, caps, audioIndex, burnSub = null, readyVersion = null, noDirect = false) {
  const p = itemProbe(item);
  const q = QUALITIES[quality] || QUALITIES.original;
  const fmt = p.format_name || '';
  const vc = p.video_codec;
  const audio = (p.audio || [])[audioIndex] || (p.audio || [])[0];
  const ac = audio?.codec;
  const height = p.height || 0;
  const bitrate = p.bitrate || 0;

  const videoOk = (vc === 'h264' && (p.pix_fmt || 'yuv420p') === 'yuv420p' && caps.h264 !== false) ||
    (vc === 'hevc' && caps.hevc) || (vc === 'vp9' && caps.vp9) || (vc === 'av1' && caps.av1);
  const audioOk = !ac || ['aac', 'mp3', 'opus', 'vorbis', 'flac'].includes(ac) || (ac === 'ac3' && caps.ac3) || (ac === 'eac3' && caps.eac3);
  const containerOk = /mp4|mov/.test(fmt) || (fmt.includes('webm') && ['vp8', 'vp9', 'av1'].includes(vc)) || (fmt.includes('matroska') && caps.mkv);
  const withinQuality = quality === 'original' || (height <= q.height && (!bitrate || bitrate <= q.bitrate * 1.15));
  const defaultAudio = audioIndex == null || audioIndex === 0 || (p.audio || []).length <= 1;

  if (burnSub == null && !noDirect) {
    if (videoOk && audioOk && containerOk && withinQuality && defaultAudio && !p.hdr) return { mode: 'direct' };
    // A pre-converted copy is ready — play that instantly instead of converting live
    if (readyVersion && defaultAudio && caps.h264 !== false) return { mode: 'version', version: readyVersion };
  }

  // HLS. Copy the video stream when we can (almost free), otherwise re-encode.
  const copyVideo = burnSub == null && vc === 'h264' && (p.pix_fmt || 'yuv420p') === 'yuv420p' && withinQuality && !p.hdr;
  const copyAudio = ac === 'aac' && (audio?.channels || 2) <= 2;
  return { mode: 'hls', copyVideo, copyAudio, reason: burnSub != null ? 'subtitles' : !videoOk ? 'video' : !audioOk ? 'audio' : !containerOk ? 'container' : !withinQuality ? 'bandwidth' : 'audio track' };
}

function targetSize(p, q) {
  const srcH = p.height || 1080, srcW = p.width || 1920;
  const h = Math.min(srcH, q.height);
  const w = Math.round((srcW * h / srcH) / 2) * 2;
  return { w, h: Math.round(h / 2) * 2, scaled: h < srcH };
}

function buildArgs(item, opts, useHw) {
  const p = itemProbe(item);
  const q = QUALITIES[opts.quality] || QUALITIES.original;
  const dir = opts.dir;
  const args = ['-hide_banner', '-v', 'error', '-nostdin'];
  const burn = opts.burnSub != null;
  const hw = useHw && HWACCEL === 'vaapi' && !opts.copyVideo && !burn;
  if (hw) args.push('-hwaccel', 'vaapi', '-hwaccel_device', VAAPI_DEVICE, '-hwaccel_output_format', 'vaapi');
  if (opts.start > 0) args.push('-ss', opts.start.toFixed(3));
  args.push('-i', item.path);
  if (!burn) args.push('-map', '0:v:0');
  args.push('-map', `0:a:${opts.audioIndex || 0}?`, '-sn', '-dn', '-map_chapters', '-1');

  if (opts.copyVideo) {
    args.push('-c:v', 'copy');
  } else {
    const { w, h, scaled } = targetSize(p, q);
    const rate = q.bitrate || Math.max(4_000_000, Math.min(p.bitrate || 20_000_000, 40_000_000));
    if (hw) {
      const filters = [];
      if (p.hdr) filters.push('tonemap_vaapi=format=nv12:t=bt709:m=bt709:p=bt709');
      filters.push(`scale_vaapi=w=${w}:h=${h}:format=nv12`);
      args.push('-vf', filters.join(','), '-c:v', 'h264_vaapi', '-b:v', String(rate), '-maxrate', String(rate), '-bufsize', String(rate * 2));
    } else {
      const filters = [];
      if (p.hdr && HAS_ZSCALE) filters.push('zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv');
      if (scaled) filters.push(`scale=${w}:${h}`);
      filters.push('format=yuv420p');
      if (burn) {
        // Picture-based subtitles (Blu-ray/DVD) are drawn onto the video, scaled to fit
        const chain = [`[0:s:${opts.burnSub}]scale=${p.width || 1920}:${p.height || 1080}[sub]`, `[0:v:0][sub]overlay=eof_action=pass${filters.length ? ',' + filters.join(',') : ''}[vout]`];
        args.push('-filter_complex', chain.join(';'), '-map', '[vout]');
      } else args.push('-vf', filters.join(','));
      args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
        '-maxrate', String(rate), '-bufsize', String(rate * 2), '-profile:v', 'high', '-level:v', '4.1');
    }
    args.push('-force_key_frames', 'expr:gte(t,n_forced*4)', '-sc_threshold', '0');
  }
  if (opts.night) {
    // Night mode: lift dialogue (centre channel) and squash loud bangs
    const ch = (p.audio || [])[opts.audioIndex || 0]?.channels || 2;
    const af = [];
    if (ch >= 6) af.push('pan=stereo|FL=0.6*FC+0.4*FL+0.25*BL+0.25*SL|FR=0.6*FC+0.4*FR+0.25*BR+0.25*SR');
    af.push('acompressor=threshold=0.06:ratio=6:attack=5:release=250:makeup=3', 'equalizer=f=2500:t=q:w=1:g=4', 'alimiter=limit=0.9');
    args.push('-af', af.join(','), '-c:a', 'aac', '-ac', '2', '-b:a', '160k');
  } else if (opts.copyAudio) args.push('-c:a', 'copy');
  else args.push('-c:a', 'aac', '-ac', '2', '-b:a', '160k');

  args.push('-max_muxing_queue_size', '2048', '-f', 'hls', '-hls_time', '4', '-hls_list_size', '0',
    '-hls_playlist_type', 'event', '-hls_flags', 'independent_segments+temp_file',
    '-hls_segment_filename', path.join(dir, 'seg%05d.ts'), '-start_number', '0', path.join(dir, 'index.m3u8'));
  return { args, hw };
}

function startSession(item, opts) {
  // One stream per device; also cap total transcodes
  for (const [id, s] of sessions) if (s.deviceId === opts.deviceId) stopSession(id);
  if (sessions.size >= MAX_TRANSCODES) {
    const oldest = [...sessions.values()].sort((a, b) => a.lastAccess - b.lastAccess)[0];
    if (oldest) stopSession(oldest.id);
  }
  const id = crypto.randomBytes(8).toString('hex');
  const dir = path.join(TRANSCODE_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  const s = { id, dir, item, opts: { ...opts, dir }, deviceId: opts.deviceId, profileId: opts.profileId, start: opts.start || 0,
    lastAccess: Date.now(), lastSegment: 0, paused: false, finished: false, error: null, proc: null };
  sessions.set(id, s);
  launch(s, hwStatus.ok !== false && HWACCEL !== 'none');
  return s;
}

function launch(s, useHw) {
  const { args, hw } = buildArgs(s.item, s.opts, useHw);
  const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  s.proc = proc; s.hw = hw;
  let stderr = '';
  const startedAt = Date.now();
  proc.stderr.on('data', d => { stderr = (stderr + d).slice(-4000); });
  proc.on('exit', code => {
    if (s.proc !== proc) return;
    s.proc = null;
    if (code === 0) { s.finished = true; return; }
    if (s.killed) return;
    // Hardware path failed straight away — fall back to software for this and future streams
    if (hw && Date.now() - startedAt < 15000 && !fs.existsSync(path.join(s.dir, 'seg00001.ts'))) {
      hwStatus.failures++;
      if (hwStatus.failures >= 2) hwStatus.ok = false;
      console.warn('Hardware transcode failed, falling back to software:', stderr.trim().split('\n').slice(-2).join(' '));
      for (const f of fs.readdirSync(s.dir)) fs.rmSync(path.join(s.dir, f), { force: true });
      return launch(s, false);
    }
    s.error = stderr.trim().split('\n').slice(-3).join('\n') || `ffmpeg exited with ${code}`;
    console.error('Transcode error:', s.error);
  });
}

function stopSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  s.killed = true;
  if (s.proc) {
    try { if (s.paused) s.proc.kill('SIGCONT'); s.proc.kill('SIGKILL'); } catch {}
  }
  setTimeout(() => fs.rm(s.dir, { recursive: true, force: true }, () => {}), 500);
}

function countSegments(dir) {
  try { return fs.readdirSync(dir).filter(f => f.endsWith('.ts')).length; } catch { return 0; }
}

// Pause ffmpeg when it's far ahead of the viewer (saves CPU + disk), resume when they catch up; drop idle sessions
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.lastAccess > 120000) { stopSession(id); continue; }
    if (!s.proc) continue;
    const made = countSegments(s.dir);
    if (!s.paused && made - s.lastSegment > 75) { s.proc.kill('SIGSTOP'); s.paused = true; }
    else if (s.paused && made - s.lastSegment < 40) { s.proc.kill('SIGCONT'); s.paused = false; }
  }
}, 3000).unref();

async function waitFor(fn, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await new Promise(r => setTimeout(r, 200));
  }
  return null;
}

async function servePlaylist(req, res) {
  const s = sessions.get(req.params.sid);
  if (!s) return res.status(404).send('Stream ended');
  s.lastAccess = Date.now();
  const file = path.join(s.dir, 'index.m3u8');
  const ready = await waitFor(() => s.error || (fs.existsSync(file) && /#EXTINF/.test(fs.readFileSync(file, 'utf8'))), 45000);
  if (s.error) return res.status(500).send(s.error);
  if (!ready) return res.status(504).send('Transcoder is taking too long to start');
  let text = fs.readFileSync(file, 'utf8');
  // Start at the beginning of this session rather than the "live edge"
  if (!/EXT-X-START/.test(text)) text = text.replace('#EXTM3U', '#EXTM3U\n#EXT-X-START:TIME-OFFSET=0,PRECISE=YES');
  res.set({ 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' }).send(text);
}

async function serveSegment(req, res) {
  const s = sessions.get(req.params.sid);
  if (!s) return res.status(404).end();
  const m = req.params.seg.match(/^seg(\d{5})\.ts$/);
  if (!m) return res.status(400).end();
  const n = parseInt(m[1], 10);
  s.lastAccess = Date.now();
  s.lastSegment = n;
  if (s.paused && s.proc) { s.proc.kill('SIGCONT'); s.paused = false; }
  const file = path.join(s.dir, req.params.seg);
  const ok = await waitFor(() => fs.existsSync(file) || s.error || (s.finished && !fs.existsSync(file) && 'gone'), 30000);
  if (!ok || ok === 'gone' || !fs.existsSync(file)) return res.status(404).end();
  res.set({ 'Content-Type': 'video/mp2t', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}

function sessionInfo(s) {
  return { id: s.id, start: s.start, hw: !!s.hw, copyVideo: !!s.opts.copyVideo };
}

// ---------- Subtitles ----------
const SUB_EXT = ['.srt', '.vtt', '.ass', '.ssa'];
const LANG_NAMES = { en: 'English', eng: 'English', es: 'Spanish', spa: 'Spanish', fr: 'French', fre: 'French', fra: 'French', de: 'German', ger: 'German', deu: 'German', it: 'Italian', ita: 'Italian', ja: 'Japanese', jpn: 'Japanese', ko: 'Korean', kor: 'Korean', zh: 'Chinese', chi: 'Chinese', zho: 'Chinese', pt: 'Portuguese', por: 'Portuguese', nl: 'Dutch', dut: 'Dutch', ru: 'Russian', rus: 'Russian', ar: 'Arabic', ara: 'Arabic', hi: 'Hindi', hin: 'Hindi' };

function langName(code) { return code && code !== 'und' ? (LANG_NAMES[code.toLowerCase()] || code.toUpperCase()) : null; }

function listSubtitles(item) {
  const out = [];
  const dir = path.dirname(item.path);
  const base = path.basename(item.path, path.extname(item.path));
  try {
    const files = fs.readdirSync(dir).filter(f => SUB_EXT.includes(path.extname(f).toLowerCase()) && f.startsWith(base)).sort();
    files.forEach((f, i) => {
      const tags = f.slice(base.length, -path.extname(f).length).split('.').filter(Boolean);
      const lang = tags.find(t => t.length <= 3 && /^[a-z]+$/i.test(t));
      const forced = tags.some(t => /forced/i.test(t));
      const sdh = tags.some(t => /sdh|cc|hi/i.test(t) && t.length <= 3);
      out.push({ key: `ext-${i}`, file: f, label: [langName(lang) || 'Subtitles', forced && 'Forced', sdh && 'SDH'].filter(Boolean).join(' · ') + ' (file)', lang });
    });
  } catch {}
  // Downloaded from OpenSubtitles
  require('./features/subtitles').downloaded(item.id).forEach((d, i) => {
    out.push({ key: `dl-${i}`, file: d.file, absolute: true, label: `${langName(d.lang) || 'Subtitles'} (${/\.ai-translated\./.test(d.file) ? 'AI translation' : /\.ai\./.test(d.file) ? 'made by AI' : 'downloaded'})`, lang: d.lang });
  });
  for (const s of itemProbe(item).subs || []) {
    const label = [langName(s.language) || 'Track ' + (s.index + 1), s.title, s.forced && 'Forced'].filter(Boolean).join(' · ');
    if (s.text) out.push({ key: `emb-${s.index}`, label, lang: s.language });
    else if (s.image || ['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle'].includes(s.codec)) out.push({ key: `img-${s.index}`, label: label + ' (picture)', lang: s.language, burn: true });
  }
  return out;
}

function serveSubtitle(item, key, res) {
  const subs = listSubtitles(item);
  const sub = subs.find(s => s.key === key);
  if (!sub || sub.burn) return res.status(404).end();
  const cache = path.join(TRANSCODE_DIR, 'subs', crypto.createHash('sha1').update(item.path + key + (sub.file || '') + (item.mtime || '')).digest('hex') + '.vtt');
  const send = () => res.set('Content-Type', 'text/vtt; charset=utf-8').sendFile(cache);
  if (fs.existsSync(cache)) return send();
  const input = sub.absolute ? sub.file : sub.file ? path.join(path.dirname(item.path), sub.file) : item.path;
  const args = ['-v', 'error', '-y', '-i', input];
  if (!sub.file) args.push('-map', `0:s:${key.slice(4)}`);
  args.push('-f', 'webvtt', cache);
  const proc = spawn('ffmpeg', args, { stdio: 'ignore' });
  proc.on('exit', code => code === 0 && fs.existsSync(cache) ? send() : res.status(500).end());
}

function audioTracks(item) {
  return (itemProbe(item).audio || []).map(a => ({
    index: a.index,
    label: [langName(a.language) || `Track ${a.index + 1}`, a.title, a.codec?.toUpperCase(), a.channels > 2 ? `${a.channels === 6 ? '5.1' : a.channels === 8 ? '7.1' : a.channels + 'ch'}` : null].filter(Boolean).join(' · '),
    default: a.default,
  }));
}

module.exports = { QUALITIES, decide, startSession, stopSession, sessions, servePlaylist, serveSegment, sessionInfo, listSubtitles, serveSubtitle, audioTracks, hwStatus, HAS_ZSCALE };
