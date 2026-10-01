// Chromecast support. The TV can't log in, so it gets short-lived signed links on your home network address.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { db, getSetting } = require('../db');
const stream = require('../stream');
const versions = require('./versions');

const b64 = s => Buffer.from(s).toString('base64url');
function sign(payload) {
  const body = b64(JSON.stringify({ ...payload, exp: Date.now() + 8 * 3600000 }));
  const sig = crypto.createHmac('sha256', getSetting('secret')).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function verify(token) {
  const [body, sig] = String(token).split('.');
  if (!body || !sig) return null;
  const good = crypto.createHmac('sha256', getSetting('secret')).update(body).digest('base64url');
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  const p = JSON.parse(Buffer.from(body, 'base64url').toString());
  return p.exp > Date.now() ? p : null;
}

function itemProbe(item) { try { return JSON.parse(item.probe || '{}') || {}; } catch { return {}; } }

// Chromecasts play H.264/AAC MP4 (newer ones also HEVC). Can it play the original file as-is?
function castable(item, quality) {
  const p = itemProbe(item);
  const ac = p.audio?.[0]?.codec;
  return /mp4|mov/.test(p.format_name || '') && p.video_codec === 'h264' && (p.pix_fmt || 'yuv420p') === 'yuv420p' && ['aac', 'mp3'].includes(ac || 'aac')
    && (quality === 'original' || (p.height || 0) <= (+quality || 1080)) && !p.hdr;
}

function prepare(item, { quality = '1080', start = 0, audioIndex = 0, subKey = null, base }) {
  const ready = !castable(item, quality) && versions.bestReady(item.id, +quality || 1080);
  const direct = castable(item, quality) || !!ready;
  const token = sign({ i: item.id, q: quality, s: direct ? 0 : start, a: audioIndex, v: ready ? ready.id : null, sub: subKey });
  const out = {
    url: `${base}/cast/${token}/video.mp4`, contentType: 'video/mp4', seekable: direct, start: direct ? 0 : start,
    startTime: direct ? start : 0, duration: item.duration,
  };
  if (subKey) out.subtitleUrl = `${base}/cast/${token}/subs.vtt`;
  return out;
}

function serveMedia(req, res) {
  const t = verify(req.params.token);
  if (!t) return res.status(403).end();
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(t.i);
  if (!item) return res.status(404).end();
  res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Content-Length, Content-Range' });
  if (t.v) {
    const v = db.prepare("SELECT path FROM versions WHERE id = ? AND status = 'ready'").get(t.v);
    if (v && fs.existsSync(v.path)) return res.sendFile(v.path, { acceptRanges: true });
  }
  if (castable(item, t.q)) return res.sendFile(item.path, { dotfiles: 'allow', acceptRanges: true });
  // Live conversion into a streamable MP4
  const p = itemProbe(item);
  const maxH = +t.q || 1080;
  const h = Math.min(p.height || 1080, maxH);
  const w = Math.round(((p.width || 1920) * h / (p.height || 1080)) / 2) * 2;
  const args = ['-v', 'error', '-nostdin'];
  if (t.s > 0) args.push('-ss', String(t.s));
  args.push('-i', item.path, '-map', '0:v:0', '-map', `0:a:${t.a || 0}?`, '-sn',
    '-vf', `scale=${w}:${Math.round(h / 2) * 2},format=yuv420p`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-maxrate', '10M', '-bufsize', '20M',
    '-c:a', 'aac', '-ac', '2', '-b:a', '192k', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1');
  res.set('Content-Type', 'video/mp4');
  const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'ignore'] });
  proc.stdout.pipe(res);
  req.on('close', () => proc.kill('SIGKILL'));
}

async function serveSubs(req, res) {
  const t = verify(req.params.token);
  if (!t || !t.sub) return res.status(404).end();
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(t.i);
  if (!item) return res.status(404).end();
  res.set({ 'Access-Control-Allow-Origin': '*', 'Content-Type': 'text/vtt; charset=utf-8' });
  // Reuse the normal subtitle converter, then shift cue times when the cast stream started mid-way
  const fake = { set: () => fake, status: () => ({ end: () => res.status(404).end() }), sendFile: f => {
    let text = fs.readFileSync(f, 'utf8');
    if (t.s > 0) text = shiftVtt(text, -t.s);
    res.send(text);
  } };
  stream.serveSubtitle(item, t.sub, fake);
}

function shiftVtt(text, delta) {
  const fmt = s => { s = Math.max(0, s); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60); return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${(s % 60).toFixed(3).padStart(6, '0')}`; };
  const parse = x => { const p = x.trim().split(':').map(parseFloat); return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1]; };
  return text.replace(/^([\d:.]+)\s*-->\s*([\d:.]+)(.*)$/gm, (_, a, b, rest) => {
    const e = parse(b) + delta;
    if (e <= 0) return `00:00:00.000 --> 00:00:00.001${rest}`;
    return `${fmt(parse(a) + delta)} --> ${fmt(e)}${rest}`;
  });
}

module.exports = { prepare, serveMedia, serveSubs };
