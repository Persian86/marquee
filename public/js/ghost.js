// Ephemeral playback handoff for Ghost's embedded player. No credentials cross this bridge.
(() => {
  let held = false, pending = null, paused = [], resumePrevious = true;
  const receipts = new Map(), cancelled = new Set();
  const remember = (map, key, value) => {
    map.set(key, value);
    while (map.size > 64) map.delete(map.keys().next().value);
  };
  function receipt(c, status) { if (c.requestId) remember(receipts, c.requestId, { status }); }
  window.GhostMarquee = {
    status: () => ({ version: 1, ready: !!me && Devices.connected(), clientId: Devices.clientId, connectionId: Devices.connectionId() }),
    hold() {
      if (!held) {
        held = true; resumePrevious = true;
        paused = window.__ghostPausedMedia || Array.from(document.querySelectorAll('video,audio')).filter(v => !v.paused && !v.ended);
        delete window.__ghostPausedMedia;
        paused.forEach(v => v.pause());
      }
      return this.status();
    },
    intercept(c) {
      // Commands for an ended/cancelled voice call must never execute, even after release.
      if (c.voiceCallId && cancelled.has(c.voiceCallId)) { receipt(c, 'cancelled'); return true; }
      if (!held) return false;
      // Only Ghost's correlated requests are held; other remote controllers are rejected
      // during the conversation rather than unexpectedly replacing a queued film.
      if (!c.voiceCallId || !c.requestId) return true;
      if (!['open', 'pause', 'stop', 'resume', 'next', 'seekBy', 'toggle'].includes(c.type)) {
        receipt(c, 'rejected'); return true;
      }
      if (pending?.type === 'open' && !['open', 'pause', 'stop'].includes(c.type)) {
        receipt(c, 'rejected'); return true;
      }
      if (pending) receipt(pending, 'superseded');
      pending = { ...c, confirmed: false, queuedAt: Date.now() }; receipt(c, 'queued'); return true;
    },
    result: id => receipts.get(id) || null,
    commit(id) {
      if (pending?.requestId !== id || cancelled.has(pending.voiceCallId)) return false;
      pending.confirmed = true; return true;
    },
    cancel(tokens) {
      for (const token of tokens) {
        cancelled.add(token);
        while (cancelled.size > 64) cancelled.delete(cancelled.values().next().value);
        if (pending?.voiceCallId === token) { receipt(pending, 'cancelled'); pending = null; resumePrevious = false; }
      }
    },
    release() {
      if (!held) {
        paused = window.__ghostPausedMedia || []; delete window.__ghostPausedMedia;
      }
      held = false;
      const command = pending; pending = null;
      if (command && command.confirmed && Date.now() - command.queuedAt < 120000) {
        receipt(command, 'released'); paused = [];
        Devices.dispatch(command);
      } else {
        if (command) receipt(command, 'expired');
        if (!command && resumePrevious) paused.forEach(v => { if (v.isConnected && v.paused && !v.ended) v.play().catch(() => {}); });
        paused = [];
      }
    }
  };
})();
