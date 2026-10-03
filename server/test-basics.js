// Filename parser checks. Run: node server/test-basics.js
// PIN hashing lives in server/common.js and needs Node 22 (node:sqlite) to load with the app.
const assert = require('assert');
const parse = require('./parse');

assert.strictEqual(parse.parseTitleYear('The Matrix (1999).mkv').title, 'The Matrix');
assert.strictEqual(parse.parseTitleYear('The Matrix (1999).mkv').year, 1999);
assert.strictEqual(parse.parseTitleYear('2001.A.Space.Odyssey.1968.1080p.BluRay').year, 1968);

const ep = parse.parseEpisode('Bluey (2018)/Season 1/Bluey - S01E01.mp4');
assert.strictEqual(ep.season, 1);
assert.strictEqual(ep.episode, 1);
assert.strictEqual(parse.parseEpisode('Show/Season 2/03 - Title.mkv').episode, 3);
assert.strictEqual(parse.isSample('/Movies/extras/trailer.mkv'), true);
assert.strictEqual(parse.isVideo('film.mkv'), true);
assert.strictEqual(parse.isVideo('notes.txt'), false);

console.log('basics ok');
