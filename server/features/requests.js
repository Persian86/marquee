// "Request a movie/show": family members ask, the admin approves (or it's automatic), Radarr/Sonarr fetch it,
// and the requester is told when it lands in the library.
const { db, getSetting } = require('../db');
const tmdb = require('../tmdb');
const notify = require('./notify');

const cfg = kind => ({ url: (getSetting(`${kind}_url`) || '').replace(/\/$/, ''), key: getSetting(`${kind}_key`) || '',
  root: getSetting(`${kind}_root`) || '', profile: parseInt(getSetting(`${kind}_profile`), 10) || null });
const configured = kind => { const c = cfg(kind); return !!(c.url && c.key); };

async function arr(kind, endpoint, opts = {}) {
  const c = cfg(kind);
  if (!c.url || !c.key) throw new Error(`${kind === 'radarr' ? 'Radarr' : 'Sonarr'} isn't set up yet`);
  const res = await fetch(`${c.url}/api/v3${endpoint}`, {
    method: opts.method || 'GET', headers: { 'X-Api-Key': c.key, 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined, signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) {
    const msg = Array.isArray(data) ? data.map(e => e.errorMessage).join('; ') : data?.message || `HTTP ${res.status}`;
    throw new Error(`${kind === 'radarr' ? 'Radarr' : 'Sonarr'}: ${msg}`);
  }
  return data;
}

// For the settings screen: check the connection and list folders / quality profiles to choose from
async function options(kind) {
  const [status, roots, profiles] = await Promise.all([arr(kind, '/system/status'), arr(kind, '/rootfolder'), arr(kind, '/qualityprofile')]);
  return { version: status.version, roots: roots.map(r => ({ path: r.path, free: r.freeSpace })), profiles: profiles.map(p => ({ id: p.id, name: p.name })) };
}

function inLibrary(tmdbId, type) {
  return db.prepare("SELECT id FROM items WHERE tmdb_id = ? AND type = ?").get(tmdbId, type === 'tv' ? 'show' : 'movie')?.id || null;
}

function annotate(results, profileId) {
  return results.map(r => {
    const req = db.prepare('SELECT id, status, profile_id FROM requests WHERE tmdb_id = ? AND media_type = ? ORDER BY id DESC').get(r.tmdbId, r.type);
    return { ...r, libraryId: inLibrary(r.tmdbId, r.type), request: req ? { id: req.id, status: req.status, mine: req.profile_id === profileId } : null };
  });
}

async function send(reqRow) {
  if (reqRow.media_type === 'movie') {
    const c = cfg('radarr');
    if (!c.root || !c.profile) throw new Error('Choose a Radarr folder and quality in Settings');
    const existing = await arr('radarr', `/movie?tmdbId=${reqRow.tmdb_id}`);
    if (existing.length) return;
    await arr('radarr', '/movie', { method: 'POST', body: { tmdbId: reqRow.tmdb_id, title: reqRow.title, year: reqRow.year, qualityProfileId: c.profile, rootFolderPath: c.root, monitored: true, minimumAvailability: 'released', addOptions: { searchForMovie: true } } });
  } else {
    const c = cfg('sonarr');
    if (!c.root || !c.profile) throw new Error('Choose a Sonarr folder and quality in Settings');
    const ids = await tmdb.externalIds('tv', reqRow.tmdb_id);
    if (!ids.tvdb_id) throw new Error("Sonarr needs a TVDB id and TMDB doesn't have one for this show");
    const lookup = await arr('sonarr', `/series/lookup?term=tvdb:${ids.tvdb_id}`);
    const series = lookup[0];
    if (!series) throw new Error("Sonarr couldn't find this show");
    if (series.id) return; // already added
    await arr('sonarr', '/series', { method: 'POST', body: { ...series, qualityProfileId: c.profile, languageProfileId: 1, rootFolderPath: c.root, seasonFolder: true, monitored: true,
      addOptions: { searchForMissingEpisodes: true, monitor: 'all' } } });
  }
}

async function create(profile, { tmdbId, type }) {
  if (!['movie', 'tv'].includes(type)) throw new Error('Unknown type');
  if (inLibrary(tmdbId, type)) throw new Error('That’s already in the library');
  const dup = db.prepare("SELECT * FROM requests WHERE tmdb_id = ? AND media_type = ? AND status IN ('pending','approved')").get(tmdbId, type);
  if (dup) throw new Error('Someone has already asked for that');
  const d = type === 'movie' ? await tmdb.movieDetails(tmdbId) : await tmdb.showDetails(tmdbId);
  const r = db.prepare('INSERT INTO requests (profile_id, tmdb_id, media_type, title, year, poster, overview, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(profile.id, tmdbId, type, d.title, d.year, d.poster, d.overview, 'pending', Date.now(), Date.now());
  const id = Number(r.lastInsertRowid);
  const auto = profile.is_admin || (getSetting('requests_auto', '0') === '1' && !profile.is_kids);
  if (auto) await approve(id).catch(() => {});
  else notify.message({ admins: true, title: 'New request', body: `${profile.name} would like ${d.title}${d.year ? ` (${d.year})` : ''}`, url: '/#/requests' }).catch(() => {});
  return db.prepare('SELECT * FROM requests WHERE id = ?').get(id);
}

async function approve(id) {
  const r = db.prepare('SELECT * FROM requests WHERE id = ?').get(id);
  if (!r) throw new Error('Not found');
  try {
    await send(r);
    db.prepare("UPDATE requests SET status = 'approved', note = NULL, updated_at = ? WHERE id = ?").run(Date.now(), id);
  } catch (e) {
    db.prepare("UPDATE requests SET status = 'failed', note = ?, updated_at = ? WHERE id = ?").run(e.message, Date.now(), id);
    throw e;
  }
}
function decline(id, note) {
  db.prepare("UPDATE requests SET status = 'declined', note = ?, updated_at = ? WHERE id = ?").run(note || null, Date.now(), id);
  const r = db.prepare('SELECT * FROM requests WHERE id = ?').get(id);
  if (r) notify.message({ profileId: r.profile_id, title: 'Request declined', body: `${r.title}${note ? ' — ' + note : ''}`, url: '/#/requests' }).catch(() => {});
}

// After each scan: anything requested that has now arrived?
async function checkArrivals() {
  for (const r of db.prepare("SELECT * FROM requests WHERE status IN ('pending','approved','failed')").all()) {
    const id = inLibrary(r.tmdb_id, r.media_type);
    if (!id) continue;
    db.prepare("UPDATE requests SET status = 'available', updated_at = ? WHERE id = ?").run(Date.now(), r.id);
    await notify.message({ profileId: r.profile_id, title: 'Your request is ready 🎉', body: `${r.title} is now in the library`, url: `/#/item/${id}`, itemIds: [id], image: r.poster }).catch(() => {});
  }
}

function list(profile) {
  const rows = profile.is_admin ? db.prepare('SELECT r.*, p.name AS who, p.color FROM requests r JOIN profiles p ON p.id = r.profile_id ORDER BY r.created_at DESC LIMIT 200').all()
    : db.prepare('SELECT r.*, p.name AS who, p.color FROM requests r JOIN profiles p ON p.id = r.profile_id WHERE r.profile_id = ? ORDER BY r.created_at DESC').all(profile.id);
  return rows.map(r => ({ id: r.id, tmdbId: r.tmdb_id, type: r.media_type, title: r.title, year: r.year, poster: r.poster ? `/img/${r.poster}` : null, overview: r.overview,
    status: r.status, note: r.note, who: r.who, color: r.color, at: r.created_at, libraryId: r.status === 'available' ? inLibrary(r.tmdb_id, r.media_type) : null }));
}

module.exports = { create, approve, decline, list, annotate, checkArrivals, options, configured };
