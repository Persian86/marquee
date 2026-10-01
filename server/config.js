const path = require('path');
const os = require('os');

module.exports = {
  PORT: parseInt(process.env.PORT || '8420', 10),
  CONFIG_DIR: process.env.CONFIG_DIR || path.join(__dirname, '..', 'data'),
  TRANSCODE_DIR: process.env.TRANSCODE_DIR || path.join(os.tmpdir(), 'marquee-transcode'),
  // Comma-separated "type:path" pairs created on first start, e.g. "movie:/media/movies,tv:/media/tv"
  DEFAULT_LIBRARIES: process.env.DEFAULT_LIBRARIES || 'movie:/media/movies,tv:/media/tv,home:/media/home-videos,music:/media/music,photo:/media/photos',
  // none | vaapi | qsv  (vaapi/qsv need /dev/dri passed into the container)
  HWACCEL: (process.env.HWACCEL || 'none').toLowerCase(),
  VAAPI_DEVICE: process.env.VAAPI_DEVICE || '/dev/dri/renderD128',
  MAX_TRANSCODES: parseInt(process.env.MAX_TRANSCODES || '3', 10),
  SCAN_INTERVAL_MIN: parseInt(process.env.SCAN_INTERVAL_MIN || '30', 10),
  // Guest share links only (point Tailscale Funnel here). 0 turns it off.
  SHARE_PORT: parseInt(process.env.SHARE_PORT ?? '8421', 10),
  TMDB_API_KEY: process.env.TMDB_API_KEY || '',
};
