const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
function player() {
  const sent = [], media = { paused: false, ended: false, isConnected: true, pause() { this.paused = true; }, play() { this.paused = false; return Promise.resolve(); } };
  const context = { window: {}, me: { id: 1 }, Devices: { clientId: 'tablet-exact', connected: () => true, connectionId: () => 'connection', dispatch: c => sent.push(c) }, document: { querySelectorAll: () => [media] }, Date };
  vm.runInNewContext(fs.readFileSync('public/js/ghost.js', 'utf8'), context);
  return { bridge: context.window.GhostMarquee, sent, media, context };
}
const cmd = (id = 'one', token = 'voice:1', type = 'open') => ({ requestId: id, voiceCallId: token, type, itemId: 9 });
test('hold reports the exact connected screen, pauses media, then releases a committed command once', () => {
  const { bridge: b, sent, media } = player(); assert.equal(b.hold().clientId, 'tablet-exact'); assert.equal(media.paused, true);
  assert.equal(b.intercept(cmd()), true); assert.equal(sent.length, 0); assert.equal(b.result('one').status, 'queued');
  assert.equal(b.commit('one'), true); b.release(); b.release(); assert.equal(sent.length, 1); assert.equal(media.paused, true);
});
test('unconfirmed requests never play or resume old media', () => {
  const { bridge: b, sent, media } = player(); b.hold(); b.intercept(cmd()); b.release(); assert.equal(sent.length, 0); assert.equal(media.paused, true);
});
test('cancelled calls are blocked both before and after SSE delivery', () => {
  for (const early of [true, false]) {
    const { bridge: b, sent } = player(); b.hold(); if (early) b.cancel(['voice:1']); b.intercept(cmd()); if (!early) b.cancel(['voice:1']);
    assert.equal(b.commit('one'), false); b.release(); assert.equal(sent.length, 0); assert.equal(b.intercept(cmd('late')), true);
  }
});
test('a later movie supersedes an older request without replaying both', () => {
  const { bridge: b, sent } = player(); b.hold(); b.intercept(cmd()); b.commit('one'); b.intercept(cmd('two', 'voice:2'));
  assert.equal(b.result('one').status, 'superseded'); b.commit('two'); b.release(); assert.equal(sent[0].requestId, 'two'); assert.equal(sent.length, 1);
});
test('pause cancels a queued open; resume cannot accidentally apply to the previous movie', () => {
  const { bridge: b, sent } = player(); b.hold(); b.intercept(cmd()); b.intercept(cmd('resume', 'voice:2', 'resume'));
  assert.equal(b.result('resume').status, 'rejected'); b.intercept(cmd('pause', 'voice:3', 'pause')); b.commit('pause'); b.release(); assert.equal(sent[0].type, 'pause');
});
test('ordinary voice conversations resume the previous media', () => {
  const { bridge: b, sent, media } = player(); b.hold(); b.hold(); b.release(); assert.equal(media.paused, false); assert.equal(sent.length, 0);
});
test('sign-in and connection are mandatory; receipts are bounded', () => {
  const { bridge: b, context } = player(); context.me = null; assert.equal(b.status().ready, false); context.me = {}; context.Devices.connected = () => false; assert.equal(b.status().ready, false);
  b.hold(); for (let i = 0; i < 100; i++) b.intercept(cmd('r' + i, 't' + i)); assert.equal(b.result('r0'), null); assert.equal(b.result('r99').status, 'queued');
});
function assistant() {
  const sent = [], checked = [], queries = [], watching = { id: 2, name: 'Child', is_kids: 1, is_admin: 0 };
  const devices = { resolve: (p, id) => { if (id !== 'tablet') throw Error('Offline'); if (!p.is_admin && p.id !== 2) throw Error('Denied'); return { clientId: id, profileId: 2, connectionId: 'connection', name: 'Tablet' }; }, list: () => [{ clientId: 'tv', name: 'Lounge TV', state: { playing: true } }], command: (p, id, c) => { sent.push({ profile: p.id, id, c }); return 'receipt'; } };
  const mocks = { '../db': { db: { prepare: sql => { queries.push(sql); return { get: () => watching, all: () => [{ id: 9, title: 'Bluey', type: 'movie' }] }; } } }, '../common': { visible: p => { checked.push(['visible', p.id]); return '1=1'; } }, './devices': devices, './activity': { check: p => { checked.push(['check', p.id]); return { ok: true }; } }, './movienight': {}, './smartsearch': {} };
  const context = { module: { exports: {} }, require: k => { assert.ok(k in mocks, k); return mocks[k]; } };
  vm.runInNewContext(fs.readFileSync('server/features/assistant.js', 'utf8'), context); return { handle: context.module.exports.handle, sent, checked, devices, mocks };
}
test('exact tablet target respects the watching profile, even for an admin app key', async () => {
  const { handle, sent, checked } = assistant(); const result = await handle({ id: 1, is_admin: 1 }, 'play Bluey', { targetClientId: 'tablet', voiceCallId: 'voice:1', targetConnectionId: 'connection' });
  assert.equal(result.action.requestId, 'receipt'); assert.equal(sent[0].id, 'tablet'); assert.equal(sent[0].profile, 2); assert.equal(sent[0].c.voiceCallId, 'voice:1'); assert.ok(checked.every(x => x[1] === 2));
});
test('offline or forbidden exact target never falls back to the playing TV', async () => {
  const { handle, sent } = assistant();
  for (const [profile, target] of [[{ id: 1, is_admin: 1 }, 'offline'], [{ id: 3 }, 'tablet']]) assert.equal((await handle(profile, 'pause', { targetClientId: target, voiceCallId: 'voice:1', targetConnectionId: 'connection' })).ok, false);
  assert.equal(sent.length, 0);
});
test('named screen conflicts fail closed; legacy named-TV commands still work', async () => {
  const { handle, sent } = assistant(); const p = { id: 1, is_admin: 1 };
  assert.equal((await handle(p, 'pause on lounge tv', { targetClientId: 'tablet', voiceCallId: 'voice:1', targetConnectionId: 'connection' })).ok, false); assert.equal(sent.length, 0);
  await handle(p, 'pause on lounge tv'); assert.equal(sent[0].id, 'tv');
});
test('watching profile time limits still block exact playback', async () => {
  const { handle, mocks, sent } = assistant(); mocks['./activity'].check = p => { assert.equal(p.id, 2); return { ok: false, message: 'Time limit reached' }; };
  assert.equal((await handle({ is_admin: 1 }, 'play Bluey', { targetClientId: 'tablet', voiceCallId: 'voice:1', targetConnectionId: 'connection' })).speech, 'Time limit reached'); assert.equal(sent.length, 0);
});
test('strict targeting rejects missing or malformed connection binding', async () => {
  const { handle, sent } = assistant();
  for (const targetConnectionId of [null, '', 'bad!']) assert.equal((await handle({ is_admin: 1 }, 'pause', { targetClientId: 'tablet', voiceCallId: 'voice:1', targetConnectionId })).ok, false);
  assert.equal(sent.length, 0);
});
test('real device registry rejects replaced connections and other profiles', () => {
  const { EventEmitter } = require('node:events'), devices = require('../server/features/devices');
  const events = [], responses = [];
  const connect = profile => {
    const res = new EventEmitter(); res.write = s => events.push(s); res.end = () => res.emit('close'); responses.push(res);
    devices.connect({ clientId: 'tablet', profile, name: 'Tablet', res });
    return JSON.parse(events.at(-1).split('data: ')[1]).connectionId;
  };
  try {
    const admin = { id: 1, is_admin: 1 }, child = { id: 2 }, old = connect(child);
    assert.equal(devices.resolve(admin, 'tablet', old).profileId, 2);
    assert.throws(() => devices.resolve({ id: 3 }, 'tablet', old));
    const fresh = connect(child); assert.notEqual(fresh, old);
    assert.throws(() => devices.resolve(admin, 'tablet', old));
    assert.throws(() => devices.command(admin, 'tablet', { type: 'open', targetConnectionId: old }));
    const receipt = devices.command(admin, 'tablet', { type: 'pause', targetConnectionId: fresh });
    assert.equal(JSON.parse(events.at(-1).split('data: ')[1]).requestId, receipt);
  } finally { responses.forEach(r => r.emit('close')); }
});
