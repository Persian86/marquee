// Join "The Boys Season 1" and "The Boys Season 2" into one show, the way Plex does.
const { db } = require('./db');

function strip(name) {
  return String(name || '')
    .replace(/[\s._-]*[\[(]?(?:seasons?|series|staffel|saison|temporada)[\s._-]*\d{1,3}.*$/i, '')
    .replace(/[\s._-]+s\d{1,2}(?:[\s._-]*e\d{1,3})?.*$/i, '')
    .replace(/[\s._-]*[\[(]?(?:the[\s._-]+)?complete[\s._-]+(?:series|collection|seasons?).*$/i, '')
    .trim();
}
function key(name) {
  return strip(name).toLowerCase().replace(/^(the|a|an)\s+/, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

function run() {
  const libs = db.prepare("SELECT id, name FROM libraries WHERE type = 'tv'").all();
  let merged = 0;
  for (const lib of libs) {
    const shows = db.prepare("SELECT id, title FROM items WHERE library_id = ? AND type = 'show' ORDER BY id").all(lib.id);
    const groups = new Map();
    for (const s of shows) {
      const k = key(s.title);
      if (k.length < 2) continue;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(s);
    }
    for (const [k, list] of groups) {
      if (list.length < 2) continue;
      const keep = list[0];
      const title = strip(keep.title) || keep.title;
      for (const other of list.slice(1)) {
        db.prepare('UPDATE items SET parent_id = ? WHERE parent_id = ?').run(keep.id, other.id);
        db.prepare('DELETE FROM items WHERE id = ?').run(other.id);
        merged++;
      }
      db.prepare('UPDATE items SET title = ?, sort_title = ?, scan_key = ?, metadata_done = 0 WHERE id = ?')
        .run(title, title.toLowerCase().replace(/^(the|a|an)\s+/, ''), k, keep.id);
    }
  }
  console.log(merged ? `Grouped ${merged} season folder(s) into their shows` : 'Season grouping checked — nothing to join');
  return merged;
}

module.exports = { run };
