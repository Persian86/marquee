// Admin settings for the newer features: faces, AI subtitles & search, cinema mode, memories, space saver,
// library health, share links, connected apps and the Android app file.
const express = require('express');
const fs = require('fs');
const { db, getSetting, setSetting } = require('../db');
const C = require('../common');
const faces = require('../features/faces');
const aisubs = require('../features/aisubs');
const smartsearch = require('../features/smartsearch');
const spacesaver = require('../features/spacesaver');
const health = require('../features/health');
const apk = require('../features/apk');
const config = require('../config');

const { wrap } = C;
const admin = express.Router();
admin.use((req, res, next) => (req.profile.is_admin ? next() : res.status(403).json({ error: 'Admin only' })));
const fail = (res, e, code = 400) => res.status(code).json({ error: e.message || String(e) });

function settings() {
  return {
    facesEnabled: getSetting('faces_enabled', '1') === '1',
    memoriesNotify: getSetting('memories_notify', '1') === '1', memoriesHour: +getSetting('memories_hour', '9'),
    aiSubsModel: getSetting('ai_subs_model', 'base'), aiSubsAuto: getSetting('ai_subs_auto', 'off'), aiSubsLanguage: getSetting('ai_subs_language', ''),
    aiProvider: getSetting('ai_provider', 'none'), ollamaUrl: getSetting('ollama_url', ''), ollamaModel: getSetting('ollama_model', 'llama3.2'),
    anthropicKeySet: !!getSetting('anthropic_key'),
    cinemaTrailers: +getSetting('cinema_trailers', '2'),
    spaceSaver: getSetting('space_saver', '0') === '1', spaceSaverStart: +getSetting('space_saver_start', '1'), spaceSaverEnd: +getSetting('space_saver_end', '6'),
    spaceSaverMinGb: +getSetting('space_saver_min_gb', '1'), spaceSaverKeepDays: +getSetting('space_saver_keep_days', '7'), spaceSaverCrf: +getSetting('space_saver_crf', '23'),
    shareUrl: getSetting('share_url', ''), shareQuality: getSetting('share_quality', '1080'), sharePort: config.SHARE_PORT,
  };
}

admin.get('/extras', (req, res) => {
  res.json({
    settings: settings(),
    faces: faces.summary(),
    aiSubs: aisubs.summary(),
    spaceSaver: spacesaver.summary(),
    android: apk.current(),
    prerolls: (() => { try { return fs.readdirSync(require('path').join(config.CONFIG_DIR, 'prerolls')).filter(f => !f.startsWith('.')); } catch { return []; } })(),
  });
});

admin.put('/extras', wrap(async (req, res) => {
  const b = req.body || {};
  const bool = (k, key) => { if (b[k] != null) setSetting(key, b[k] ? '1' : '0'); };
  const num = (k, key, min, max) => { if (b[k] != null && isFinite(+b[k])) setSetting(key, String(Math.max(min, Math.min(max, +b[k])))); };
  bool('facesEnabled', 'faces_enabled');
  bool('memoriesNotify', 'memories_notify');
  num('memoriesHour', 'memories_hour', 0, 23);
  if (b.aiSubsModel && aisubs.MODELS[b.aiSubsModel]) setSetting('ai_subs_model', b.aiSubsModel);
  if (['off', 'home', 'missing'].includes(b.aiSubsAuto)) setSetting('ai_subs_auto', b.aiSubsAuto);
  if (b.aiSubsLanguage != null) setSetting('ai_subs_language', /^[a-z]{2}$/.test(b.aiSubsLanguage) ? b.aiSubsLanguage : '');
  if (['none', 'ollama', 'anthropic'].includes(b.aiProvider)) setSetting('ai_provider', b.aiProvider);
  if (b.ollamaUrl != null) {
    const u = String(b.ollamaUrl).trim().replace(/\/$/, '');
    if (u && !/^https?:\/\//.test(u)) return fail(res, new Error('The Ollama address should look like http://192.168.1.20:11434'));
    setSetting('ollama_url', u);
  }
  if (b.ollamaModel) setSetting('ollama_model', String(b.ollamaModel).trim().slice(0, 60));
  if (b.anthropicKey) setSetting('anthropic_key', String(b.anthropicKey).trim());
  if (b.anthropicKey === null) setSetting('anthropic_key', '');
  num('cinemaTrailers', 'cinema_trailers', 0, 4);
  bool('spaceSaver', 'space_saver');
  num('spaceSaverStart', 'space_saver_start', 0, 23);
  num('spaceSaverEnd', 'space_saver_end', 0, 23);
  num('spaceSaverMinGb', 'space_saver_min_gb', 0, 100);
  num('spaceSaverKeepDays', 'space_saver_keep_days', 0, 60);
  num('spaceSaverCrf', 'space_saver_crf', 18, 30);
  if (b.shareUrl != null) {
    const u = String(b.shareUrl).trim().replace(/\/$/, '');
    if (u && !/^https:\/\/[^/]+$/.test(u)) return fail(res, new Error('Use the form https://zimaos.tail1234.ts.net:8443'));
    setSetting('share_url', u);
  }
  if (['original', '1080', '720', '480'].includes(b.shareQuality)) setSetting('share_quality', b.shareQuality);
  if (b.facesEnabled) faces.run().catch(() => {});
  res.json({ ok: true, settings: settings() });
}));

// Try the AI search set-up with a sample question
admin.post('/extras/test-ai', wrap(async (req, res) => {
  if (!smartsearch.aiConfig()) return fail(res, new Error('Choose Ollama or Claude and fill in its details first'));
  const r = await smartsearch.search(req.profile, req.body?.q || 'funny family movies under 2 hours', { limit: 5 });
  if (r.aiError) return fail(res, new Error(`The AI didn't answer: ${r.aiError}`));
  res.json({ ok: true, understood: r.chips, used: r.used, found: r.items.map(i => i.title) });
}));

// Faces
admin.post('/faces/run', (req, res) => { faces.run().catch(() => {}); res.json({ ok: true }); });
admin.post('/faces/reset', (req, res) => { faces.resetAll(); res.json({ ok: true }); });

// Space saver
admin.post('/space-saver/run', (req, res) => { spacesaver.runNow().catch(() => {}); res.json({ ok: true }); });
admin.post('/space-saver/stop', (req, res) => { spacesaver.stop(); res.json({ ok: true }); });
admin.post('/space-saver/queue/:id', (req, res) => { spacesaver.queue(+req.params.id); res.json({ ok: true }); });
admin.post('/space-saver/restore/:id', (req, res) => { try { spacesaver.restore(+req.params.id); res.json({ ok: true }); } catch (e) { fail(res, e); } });

// Library health
admin.get('/health', wrap(async (req, res) => res.json(await health.report({ fresh: req.query.fresh === '1' }))));

// Android app file (upload once; phones and TVs then update themselves)
admin.post('/app-upload', (req, res) => {
  try {
    const buf = Buffer.from(String(req.body?.data || '').replace(/^data:[^,]+,/, ''), 'base64');
    if (buf.length < 100) return fail(res, new Error('Choose the marquee.apk file'));
    res.json(apk.save(buf));
  } catch (e) { fail(res, e); }
});

// For the apps (any signed-in profile)
const open = express.Router();
open.get('/app/android', (req, res) => {
  const a = apk.current();
  res.json(a && !a.error ? { available: true, versionCode: a.versionCode, versionName: a.versionName, size: a.size, sha256: a.sha256, url: '/app.apk' } : { available: false });
});

module.exports = { admin, open };
