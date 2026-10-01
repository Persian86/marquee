// The Android app lives on your server so phones and TVs can update themselves.
// Upload marquee.apk in Settings; Marquee reads its version straight out of the file.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { CONFIG_DIR } = require('../config');

const APK = path.join(CONFIG_DIR, 'marquee.apk');
const INFO = APK + '.json';

// --- find AndroidManifest.xml inside the zip ---
function readZipEntry(buf, wanted) {
  // End of central directory record
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Not an APK (zip) file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (name === wanted) {
      const lNameLen = buf.readUInt16LE(local + 26), lExtraLen = buf.readUInt16LE(local + 28);
      const start = local + 30 + lNameLen + lExtraLen;
      const data = buf.subarray(start, start + csize);
      return method === 0 ? data : zlib.inflateRawSync(data);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error('AndroidManifest.xml not found — is this an Android app?');
}

// --- Android binary XML: just enough to read versionCode / versionName / package ---
function parseManifest(x) {
  const strings = [];
  let resIds = [];
  let p = x.readUInt16LE(2); // skip the file header
  while (p < x.length) {
    const type = x.readUInt16LE(p), headerSize = x.readUInt16LE(p + 2), size = x.readUInt32LE(p + 4);
    if (type === 0x0001) { // string pool
      const count = x.readUInt32LE(p + 8), flags = x.readUInt32LE(p + 16), dataStart = x.readUInt32LE(p + 20);
      const utf8 = (flags & 0x100) !== 0;
      for (let i = 0; i < count; i++) {
        let o = p + dataStart + x.readUInt32LE(p + headerSize + i * 4);
        if (utf8) {
          let n = x[o++]; if (n & 0x80) o++;            // character count (skipped)
          let len = x[o++]; if (len & 0x80) len = ((len & 0x7f) << 8) | x[o++];
          strings.push(x.toString('utf8', o, o + len));
        } else {
          let len = x.readUInt16LE(o); o += 2;
          if (len & 0x8000) { len = ((len & 0x7fff) << 16) | x.readUInt16LE(o); o += 2; }
          strings.push(x.toString('utf16le', o, o + len * 2));
        }
      }
    } else if (type === 0x0180) { // resource ids for the first strings
      resIds = [];
      for (let o = p + headerSize; o < p + size; o += 4) resIds.push(x.readUInt32LE(o));
    } else if (type === 0x0102) { // start of an element
      const name = strings[x.readUInt32LE(p + 20)];
      if (name === 'manifest') {
        const attrStart = x.readUInt16LE(p + 24), attrSize = x.readUInt16LE(p + 26), attrCount = x.readUInt16LE(p + 28);
        const out = {};
        for (let i = 0; i < attrCount; i++) {
          const a = p + 16 + attrStart + i * attrSize;
          const nameIdx = x.readUInt32LE(a + 4), raw = x.readInt32LE(a + 8), dataType = x[a + 15], data = x.readUInt32LE(a + 16);
          const attr = strings[nameIdx] || ({ 0x0101021b: 'versionCode', 0x0101021c: 'versionName' })[resIds[nameIdx]];
          const value = dataType === 0x03 ? strings[data] : dataType === 0x10 || dataType === 0x11 ? data : raw >= 0 ? strings[raw] : data;
          if (attr) out[attr] = value;
        }
        return { packageName: out.package, versionCode: +out.versionCode || null, versionName: out.versionName != null ? String(out.versionName) : null };
      }
    }
    p += size;
  }
  throw new Error("Couldn't read the app's version");
}

function inspect(buf) { return parseManifest(readZipEntry(buf, 'AndroidManifest.xml')); }

function save(buf) {
  const info = inspect(buf);
  if (info.packageName && info.packageName !== 'com.adam.marquee') throw new Error(`That's a different app (${info.packageName}), not Marquee`);
  fs.writeFileSync(APK + '.part', buf);
  fs.renameSync(APK + '.part', APK);
  const out = { ...info, size: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex'), uploadedAt: Date.now() };
  fs.writeFileSync(INFO, JSON.stringify(out));
  return out;
}

// Info for the app's update check (also picks up an APK copied in by hand)
function current() {
  if (!fs.existsSync(APK)) return null;
  const st = fs.statSync(APK);
  try {
    const saved = JSON.parse(fs.readFileSync(INFO, 'utf8'));
    if (saved.size === st.size && saved.uploadedAt >= st.mtimeMs - 5000) return saved;
  } catch {}
  try {
    const buf = fs.readFileSync(APK);
    const out = { ...inspect(buf), size: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex'), uploadedAt: st.mtimeMs };
    fs.writeFileSync(INFO, JSON.stringify(out));
    return out;
  } catch (e) { return { error: e.message, size: st.size }; }
}

module.exports = { inspect, save, current, APK };
