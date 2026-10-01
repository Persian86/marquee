// Watch together: everyone in a room stays in sync (play, pause, seek), plus emoji reactions.
const crypto = require('crypto');

const rooms = new Map(); // code -> room
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function newCode() {
  let c;
  do { c = Array.from(crypto.randomBytes(5), b => LETTERS[b % LETTERS.length]).join(''); } while (rooms.has(c));
  return c;
}

function create(itemId, profile) {
  const code = newCode();
  rooms.set(code, { code, itemId, host: profile.id, members: new Map(), state: { playing: false, position: 0, at: Date.now(), by: null }, emptySince: Date.now() });
  return code;
}

function get(code) { return rooms.get(String(code || '').toUpperCase()); }

function send(res, event, data) {
  try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch {}
}
function members(room) {
  return [...room.members.values()].map(m => ({ clientId: m.clientId, name: m.name, color: m.color }));
}
function broadcast(room, event, data, except) {
  for (const m of room.members.values()) if (m.clientId !== except) send(m.res, event, data);
}

function join(room, { clientId, profile, res }) {
  room.members.set(clientId, { clientId, name: profile.name, color: profile.color, res });
  room.emptySince = null;
  send(res, 'hello', { code: room.code, itemId: room.itemId, state: room.state, serverNow: Date.now(), members: members(room) });
  broadcast(room, 'members', { members: members(room), joined: profile.name }, clientId);
  const ping = setInterval(() => send(res, 'ping', { serverNow: Date.now() }), 20000);
  res.on('close', () => {
    clearInterval(ping);
    const m = room.members.get(clientId);
    if (m && m.res === res) room.members.delete(clientId);
    broadcast(room, 'members', { members: members(room), left: profile.name });
    if (!room.members.size) room.emptySince = Date.now();
  });
}

function action(room, { clientId, profile, type, position, playing, emoji, itemId }) {
  if (type === 'reaction') {
    broadcast(room, 'reaction', { emoji: String(emoji || '').slice(0, 8), name: profile.name, color: profile.color });
    return;
  }
  if (type === 'item' && itemId) { // e.g. host moved on to the next episode
    room.itemId = itemId;
    room.state = { playing: true, position: 0, at: Date.now(), by: profile.name };
    broadcast(room, 'item', { itemId, by: profile.name, serverNow: Date.now() }, clientId);
    return;
  }
  room.state = { playing: !!playing, position: +position || 0, at: Date.now(), by: profile.name, type };
  broadcast(room, 'state', { ...room.state, serverNow: Date.now() }, clientId);
}

setInterval(() => {
  for (const [code, r] of rooms) if (r.emptySince && Date.now() - r.emptySince > 15 * 60000) rooms.delete(code);
}, 60000).unref();

module.exports = { create, get, join, action };
