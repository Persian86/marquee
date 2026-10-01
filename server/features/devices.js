// Every open Marquee screen registers here, so you can control one device from another
// ("pause the lounge TV from my phone") or hand a movie over mid-scene.
const devices = new Map(); // clientId -> device

function connect({ clientId, profile, name, res }) {
  const prev = devices.get(clientId);
  if (prev?.res) try { prev.res.end(); } catch {}
  const d = { clientId, name: String(name || 'Device').slice(0, 60), profileId: profile.id, profileName: profile.name, profileColor: profile.color, res, state: prev?.state || null, seen: Date.now() };
  devices.set(clientId, d);
  const ping = setInterval(() => { try { res.write(`event: ping\ndata: {}\n\n`); } catch {} }, 25000);
  res.on('close', () => { clearInterval(ping); if (devices.get(clientId)?.res === res) devices.delete(clientId); });
  res.write(`event: hello\ndata: ${JSON.stringify({ clientId })}\n\n`);
}

function update(clientId, state) {
  const d = devices.get(clientId);
  if (d) { d.state = state; d.seen = Date.now(); }
}

function list(profile, exceptId) {
  return [...devices.values()].filter(d => d.clientId !== exceptId && (profile.is_admin || d.profileId === profile.id))
    .map(d => ({ clientId: d.clientId, name: d.name, profileName: d.profileName, profileColor: d.profileColor, state: d.state }));
}

function command(profile, clientId, cmd) {
  const d = devices.get(clientId);
  if (!d || (!profile.is_admin && d.profileId !== profile.id)) throw new Error('That device is no longer connected');
  d.res.write(`event: command\ndata: ${JSON.stringify({ ...cmd, from: profile.name })}\n\n`);
}

module.exports = { connect, update, list, command };
