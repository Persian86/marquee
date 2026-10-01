// Minimal EXIF reader: just the capture date and orientation from JPEG files.
const fs = require('fs');

function readExif(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(256 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return parse(buf.subarray(0, n));
  } catch { return {}; } finally { if (fd != null) fs.closeSync(fd); }
}

function parse(b) {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return {};
  let off = 2;
  while (off + 4 < b.length) {
    if (b[off] !== 0xff) return {};
    const marker = b[off + 1];
    const len = b.readUInt16BE(off + 2);
    if (marker === 0xe1 && b.toString('ascii', off + 4, off + 10) === 'Exif\0\0') return parseTiff(b, off + 10);
    if (marker === 0xda) return {};
    off += 2 + len;
  }
  return {};
}

function parseTiff(b, start) {
  const le = b.toString('ascii', start, start + 2) === 'II';
  const u16 = o => (le ? b.readUInt16LE(o) : b.readUInt16BE(o));
  const u32 = o => (le ? b.readUInt32LE(o) : b.readUInt32BE(o));
  const out = {};
  const readIfd = (ifdOff, cb) => {
    const p = start + ifdOff;
    if (p + 2 > b.length) return;
    const count = u16(p);
    for (let i = 0; i < count; i++) {
      const e = p + 2 + i * 12;
      if (e + 12 > b.length) return;
      cb(u16(e), u16(e + 2), u32(e + 4), e + 8);
    }
  };
  let exifIfd = null, gpsIfd = null;
  readIfd(u32(start + 4), (tag, type, count, valOff) => {
    if (tag === 0x0112) out.orientation = u16(valOff);
    if (tag === 0x8769) exifIfd = u32(valOff);
    if (tag === 0x8825) gpsIfd = u32(valOff);
    if (tag === 0x0132 && !out.date) out.date = str(b, start + u32(valOff), count);
  });
  if (exifIfd) readIfd(exifIfd, (tag, type, count, valOff) => {
    if (tag === 0x9003) out.date = str(b, start + u32(valOff), count);
  });
  if (gpsIfd) {
    const g = {};
    const rational3 = off => { const p = start + u32(off); if (p + 24 > b.length) return null; const r = i => u32(p + i * 8) / (u32(p + i * 8 + 4) || 1); return r(0) + r(1) / 60 + r(2) / 3600; };
    readIfd(gpsIfd, (tag, type, count, valOff) => {
      if (tag === 1) g.latRef = String.fromCharCode(b[valOff]);
      if (tag === 2) g.lat = rational3(valOff);
      if (tag === 3) g.lonRef = String.fromCharCode(b[valOff]);
      if (tag === 4) g.lon = rational3(valOff);
    });
    if (g.lat != null && g.lon != null && (g.lat || g.lon)) {
      out.lat = g.latRef === 'S' ? -g.lat : g.lat;
      out.lon = g.lonRef === 'W' ? -g.lon : g.lon;
    }
  }
  if (out.date) {
    const m = out.date.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
    out.takenAt = m && +m[1] > 1900 ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : null;
  }
  return out;
}

function str(b, o, n) { return o + n <= b.length ? b.toString('ascii', o, o + n).replace(/\0+$/, '') : ''; }

// Dates in file names from phones/cameras: IMG_20230514_123456, PXL_20230514_..., 2023-05-14 12.30.00, VID-20230514-WA0001
function dateFromName(name) {
  let m = name.match(/(19|20)(\d{2})[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])(?:[ _T-]?([01]\d|2[0-3])[.:_-]?([0-5]\d)[.:_-]?([0-5]\d))?/);
  if (!m) return null;
  const t = new Date(+(m[1] + m[2]), +m[3] - 1, +m[4], +(m[5] || 12), +(m[6] || 0), +(m[7] || 0)).getTime();
  return t > Date.UTC(1970, 0, 2) && t < Date.now() + 86400000 ? t : null;
}

module.exports = { readExif, dateFromName };
