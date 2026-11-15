// One policy for browser, native-wrapper, casting and server playback requests.
(function (root, factory) {
  const policy = factory();
  if (typeof module === 'object' && module.exports) module.exports = policy;
  else root.PlaybackQuality = policy;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const QUALITY = '1080';
  function probe(item) { try { return typeof item?.probe === 'string' ? JSON.parse(item.probe) || {} : item?.probe || {}; } catch { return {}; } }
  function sourceHeight(item) { const h = Number(probe(item).height); return Number.isFinite(h) && h > 0 ? h : null; }
  function requiredHeight(item) { return Math.min(sourceHeight(item) || 1080, 1080); }
  function scaleFilter(item, maxHeight = 1080) {
    const p = probe(item), h = sourceHeight(item), w = Number(p.width);
    if (!h || !Number.isFinite(w) || w <= 0) return `scale=-2:'min(${maxHeight},trunc(ih/2)*2)'`;
    const outH = Math.max(2, Math.floor(Math.min(h, maxHeight) / 2) * 2);
    const outW = Math.max(2, Math.round(w * outH / h / 2) * 2);
    return `scale=${outW}:${outH}`;
  }
  function recovery(state) {
    if (state.mode === 'direct' && !state.forceHls) return { forceHls: true };
    if (!state.forceTranscode) return { forceTranscode: true };
    return null; // Stop with an explanation; never reduce resolution to mask a failure.
  }
  function label(info) {
    const h = Number(info.sourceHeight);
    const resolution = h > 0 && h < 1080 ? `Source ${h}p` : '1080p';
    return resolution + (info.prepared ? ' · Ready copy' : info.mode === 'direct' ? ' · Direct' : info.transcoding ? ' · Converting' : ' · Direct stream');
  }
  return Object.freeze({ QUALITY, probe, sourceHeight, requiredHeight, scaleFilter, recovery, label });
});
