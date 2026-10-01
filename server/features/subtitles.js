// Subtitle downloads from OpenSubtitles.com (free account + API key). Files are saved in Marquee's own folder,
// so your media stays untouched.
const fs = require('fs');
const path = require('path');
const { db, getSetting } = require('../db');
const { CONFIG_DIR } = require('../config');

const DIR = path.join(CONFIG_DIR, 'subtitles');
fs.mkdirSync(DIR, { recursive: true });
const API = 'https://api.opensubtitles.com/api/v1';
let token = null, tokenAt = 0;

const configured = () => !!getSetting('os_api_key');
function headers(extra = {}) {
  return { 'Api-Key': getSetting('os_api_key') || '', 'User-Agent': 'Marquee v2', Accept: 'application/json', 'Content-Type': 'application/json', ...extra };
}
async function login() {
  const user = getSetting('os_username'), pass = getSetting('os_password');
  if (!user || !pass) return null;
  if (token && Date.now() - tokenAt < 20 * 3600000) return token;
  const r = await fetch(`${API}/login`, { method: 'POST', headers: headers(), body: JSON.stringify({ username: user, password: pass }), signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(r.status === 401 ? 'OpenSubtitles username or password is wrong' : `OpenSubtitles login failed (${r.status})`);
  token = (await r.json()).token; tokenAt = Date.now();
  return token;
}

async function search(item, lang) {
  if (!configured()) throw new Error('Add an OpenSubtitles API key in Settings first');
  const q = new URLSearchParams({ languages: lang || getSetting('os_languages', 'en') });
  if (item.type === 'episode') {
    const show = db.prepare('SELECT tmdb_id, title FROM items WHERE id = ?').get(item.parent_id);
    if (show?.tmdb_id) q.set('parent_tmdb_id', show.tmdb_id); else q.set('query', show?.title || item.title);
    if (item.season != null) q.set('season_number', item.season);
    if (item.episode != null) q.set('episode_number', item.episode);
  } else if (item.tmdb_id) q.set('tmdb_id', item.tmdb_id);
  else { q.set('query', item.title); if (item.year) q.set('year', item.year); }
  const r = await fetch(`${API}/subtitles?${q}`, { headers: headers(), signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(r.status === 401 || r.status === 403 ? 'OpenSubtitles rejected the API key' : `OpenSubtitles search failed (${r.status})`);
  const data = (await r.json()).data || [];
  return data.filter(d => d.attributes?.files?.length).map(d => ({
    fileId: d.attributes.files[0].file_id, language: d.attributes.language, release: d.attributes.release || d.attributes.files[0].file_name,
    downloads: d.attributes.download_count, hearingImpaired: !!d.attributes.hearing_impaired, machine: !!d.attributes.machine_translated || !!d.attributes.ai_translated,
  })).sort((a, b) => (a.machine - b.machine) || (b.downloads - a.downloads)).slice(0, 25);
}

async function download(item, fileId, language = 'en') {
  const t = await login().catch(() => null);
  const r = await fetch(`${API}/download`, { method: 'POST', headers: headers(t ? { Authorization: `Bearer ${t}` } : {}), body: JSON.stringify({ file_id: fileId, sub_format: 'srt' }), signal: AbortSignal.timeout(20000) });
  if (r.status === 406 || r.status === 429) throw new Error('Daily OpenSubtitles download limit reached — adding your username and password raises it');
  if (!r.ok) throw new Error(`OpenSubtitles download failed (${r.status})`);
  const { link } = await r.json();
  const srt = await (await fetch(link, { signal: AbortSignal.timeout(30000) })).text();
  const dir = path.join(DIR, String(item.id));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${language}.${fileId}.srt`);
  fs.writeFileSync(file, srt);
  return file;
}

function downloaded(itemId) {
  const dir = path.join(DIR, String(itemId));
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.srt')).sort().map(f => ({ file: path.join(dir, f), lang: f.split('.')[0] }));
}

// Grab the best match automatically when a profile asks for subtitles and there are none in their language
const busy = new Set();
async function autoFetch(item, lang) {
  if (!configured() || busy.has(item.id)) return;
  busy.add(item.id);
  try {
    const best = (await search(item, lang)).find(s => !s.machine);
    if (best) await download(item, best.fileId, best.language);
  } catch (e) { console.warn('Auto subtitles:', e.message); }
  finally { busy.delete(item.id); db.prepare('UPDATE items SET subs_checked = 1 WHERE id = ?').run(item.id); }
}

module.exports = { search, download, downloaded, autoFetch, configured, DIR };
