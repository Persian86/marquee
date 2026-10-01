// Runs in its own thread so finding faces never slows down the rest of Marquee.
// Everything happens on your ZimaOS box — no photos are sent anywhere.
const { parentPort } = require('worker_threads');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

let faceapi, tf;
const ORIENT = { 2: 'hflip', 3: 'transpose=1,transpose=1', 4: 'vflip', 5: 'transpose=0', 6: 'transpose=1', 7: 'transpose=3', 8: 'transpose=2' };
const MAX_SIDE = 1024;

async function init() {
  faceapi = require('@vladmandic/face-api/dist/face-api.node-wasm.js');
  tf = faceapi.tf;
  // Point the WASM backend at its files inside node_modules
  const wasmDir = path.dirname(require.resolve('@tensorflow/tfjs-backend-wasm/package.json')) + '/dist/';
  tf.wasm?.setWasmPaths?.(wasmDir);
  await tf.setBackend('wasm');
  await tf.ready();
  const modelDir = path.join(path.dirname(require.resolve('@vladmandic/face-api/package.json')), 'model');
  for (const [net, name] of [[faceapi.nets.ssdMobilenetv1, 'ssd_mobilenetv1_model'], [faceapi.nets.faceLandmark68Net, 'face_landmark_68_model'], [faceapi.nets.faceRecognitionNet, 'face_recognition_model']]) {
    const manifest = JSON.parse(fs.readFileSync(path.join(modelDir, `${name}-weights_manifest.json`), 'utf8'));
    const buf = fs.readFileSync(path.join(modelDir, `${name}.bin`));
    const weights = tf.io.decodeWeights(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), manifest.flatMap(g => g.weights));
    net.loadFromWeightMap(weights);
  }
}

// Decode with ffmpeg (handles JPEG, PNG, HEIC*, WebP…) straight into raw RGB pixels, upright and resized
function decode(file, width, height, orientation) {
  const swap = [5, 6, 7, 8].includes(orientation);
  let w = swap ? height : width, h = swap ? width : height;
  const s = Math.min(1, MAX_SIDE / Math.max(w, h));
  w = Math.max(2, Math.round(w * s / 2) * 2); h = Math.max(2, Math.round(h * s / 2) * 2);
  const vf = [ORIENT[orientation], `scale=${w}:${h}`].filter(Boolean).join(',');
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', ['-v', 'error', '-noautorotate', '-i', file, '-frames:v', '1', '-vf', vf, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
      { encoding: 'buffer', maxBuffer: MAX_SIDE * MAX_SIDE * 3 + 1024, timeout: 60000 }, (err, out) => {
        if (err || out.length !== w * h * 3) return reject(err || new Error('Could not read photo'));
        resolve({ pixels: out, w, h });
      });
  });
}

async function detect({ id, path: file, width, height, orientation }) {
  const { pixels, w, h } = await decode(file, width || 4000, height || 3000, orientation || 1);
  const img = tf.tensor3d(new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.length), [h, w, 3], 'int32');
  try {
    const found = await faceapi.detectAllFaces(img, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.6, maxResults: 30 })).withFaceLandmarks().withFaceDescriptors();
    return found
      .filter(f => f.detection.box.width >= 36 && f.detection.box.height >= 36) // tiny background faces aren't useful
      .map(f => ({ x: f.detection.box.x / w, y: f.detection.box.y / h, w: f.detection.box.width / w, h: f.detection.box.height / h,
        score: f.detection.score, descriptor: Array.from(f.descriptor) }));
  } finally { img.dispose(); }
}

let ready = null;
parentPort.on('message', async msg => {
  try {
    if (!ready) ready = init();
    await ready;
    parentPort.postMessage({ id: msg.id, faces: await detect(msg) });
  } catch (e) {
    parentPort.postMessage({ id: msg.id, error: e.message || String(e), fatal: !faceapi });
  }
});
