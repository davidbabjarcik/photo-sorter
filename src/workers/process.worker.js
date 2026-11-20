// Analýza jednej fotky: SHA-256, EXIF, rozmery, zmenšený náhľad (JPEG), perceptual hash (dHash).
// HEIC sa dekóduje cez libheif (WASM), načíta sa len keď je naozaj potrebný.
import exifr from 'exifr';
import { imageSize } from './imgsize.js';

let heifLib = null;
async function getHeif() {
  if (!heifLib) {
    const mod = await import('libheif-js/libheif-wasm/libheif-bundle.mjs');
    let lib = mod.default();
    if (lib && typeof lib.then === 'function' && !lib.HeifDecoder) lib = await lib;
    if (lib?.ready) await lib.ready;
    heifLib = lib;
  }
  return heifLib;
}

async function decodeHeic(buf) {
  const lib = await getHeif();
  const decoder = new lib.HeifDecoder();
  const images = decoder.decode(new Uint8Array(buf));
  if (!images?.length) throw new Error('HEIC: žiadny obrázok');
  const img = images[0];
  const width = img.get_width();
  const height = img.get_height();
  const imageData = new ImageData(width, height);
  await new Promise((res, rej) => img.display(imageData, (d) => (d ? res(d) : rej(new Error('HEIC: dekódovanie zlyhalo')))));
  img.free?.();
  return { imageData, width, height };
}

function toHex(buf) {
  const b = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
}

// dHash 64 bit: 9x8 odtiene šedej, porovnanie susedných pixelov.
function dHash(bitmap) {
  const c = new OffscreenCanvas(9, 8);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, 9, 8);
  const d = ctx.getImageData(0, 0, 9, 8).data;
  const g = new Float32Array(72);
  for (let i = 0; i < 72; i++) g[i] = d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114;
  let hex = '';
  for (let y = 0; y < 8; y++) {
    let byte = 0;
    for (let x = 0; x < 8; x++) byte = (byte << 1) | (g[y * 9 + x] > g[y * 9 + x + 1] ? 1 : 0);
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

// Podiel „plochých“ susedných pixelov – screenshoty a dokumenty majú veľa jednofarebných plôch.
function flatness(bitmap) {
  const c = new OffscreenCanvas(32, 32);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, 32, 32);
  const d = ctx.getImageData(0, 0, 32, 32).data;
  let same = 0;
  for (let i = 4; i < d.length; i += 4) {
    if (Math.abs(d[i] - d[i - 4]) + Math.abs(d[i + 1] - d[i - 3]) + Math.abs(d[i + 2] - d[i - 2]) < 6) same++;
  }
  return same / (d.length / 4);
}

const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif' };

async function analyze({ file, ext, thumbSize }) {
  const buf = await file.arrayBuffer();
  const sha256 = toHex(await crypto.subtle.digest('SHA-256', buf));

  let exif = null;
  try {
    exif = await exifr.parse(buf, {
      tiff: true, exif: true, gps: false, xmp: false, icc: false, iptc: false, jfif: false,
      pick: ['DateTimeOriginal', 'CreateDate', 'Make', 'Model', 'Software', 'Orientation'],
      translateValues: false,
      reviveValues: true,
    });
  } catch { /* bez EXIF */ }

  let width, height, small;
  const rotated = typeof exif?.Orientation === 'number' && exif.Orientation >= 5;

  if (ext === 'heic' || ext === 'heif') {
    const dec = await decodeHeic(buf);
    width = dec.width; height = dec.height;
    const scale = Math.min(1, thumbSize / Math.min(width, height));
    small = await createImageBitmap(dec.imageData, {
      resizeWidth: Math.max(1, Math.round(width * scale)),
      resizeHeight: Math.max(1, Math.round(height * scale)),
      resizeQuality: 'medium',
    });
  } else {
    const size = imageSize(new Uint8Array(buf, 0, Math.min(buf.byteLength, 256 * 1024)));
    const blob = new Blob([buf], { type: MIME[ext] || 'application/octet-stream' });
    if (size) {
      width = rotated ? size.height : size.width;
      height = rotated ? size.width : size.height;
      const scale = Math.min(1, thumbSize / Math.min(width, height));
      // Zadávame len šírku -> pomer strán sa zachová vždy, aj pri rotácii z EXIF.
      small = await createImageBitmap(blob, {
        imageOrientation: 'from-image',
        resizeQuality: 'medium',
        resizeWidth: Math.max(1, Math.round((rotated ? height : width) * scale)),
      });
    } else {
      const full = await createImageBitmap(blob, { imageOrientation: 'from-image' });
      width = full.width; height = full.height;
      const scale = Math.min(1, thumbSize / Math.min(width, height));
      small = await createImageBitmap(full, { resizeWidth: Math.max(1, Math.round(width * scale)), resizeQuality: 'medium' });
      full.close();
    }
  }

  const dhash = dHash(small);
  const flat = flatness(small);
  const c = new OffscreenCanvas(small.width, small.height);
  c.getContext('2d').drawImage(small, 0, 0);
  small.close();
  const thumb = await c.convertToBlob({ type: 'image/jpeg', quality: 0.78 });

  const date = exif?.DateTimeOriginal || exif?.CreateDate;
  return {
    sha256, dhash, flat, width, height, thumb,
    exifDate: date instanceof Date && !isNaN(date) ? date.getTime() : null,
    make: exif?.Make ? String(exif.Make).trim() : null,
    model: exif?.Model ? String(exif.Model).trim() : null,
    software: exif?.Software ? String(exif.Software).trim() : null,
  };
}

self.onmessage = async (e) => {
  const { id, job } = e.data;
  try {
    const res = await analyze(job);
    self.postMessage({ id, ok: true, res });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err?.message || err) });
  }
};
