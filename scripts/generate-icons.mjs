// Erzeugt assets/icon.png (256 px) und assets/icon.ico (256/48/32/16 px, PNG-komprimiert) ohne Abhängigkeiten:
// blauer Kreis mit weißem Telefonhörer. Aufruf: node scripts/generate-icons.mjs
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets');
const SIZE = 256;
const BG = [0x00, 0x66, 0xcc];

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** RGBA-Pixel (Uint8Array, size*size*4) als PNG */
function png(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/** Deckungsgrad 0..1 des Hörers an Punkt (x, y) in Einheitskoordinaten (0..1), weich gerändert */
function handset(x, y, px) {
  // Hörer = unterer Halbkreisbogen + zwei runde Kapseln an den Bogenenden, um 45° gedreht
  const a = -Math.PI / 4;
  const dx = x - 0.5, dy = y - 0.5;
  const rx = dx * Math.cos(a) - dy * Math.sin(a), ry = dx * Math.sin(a) + dy * Math.cos(a);
  const cy = 0.06, R = 0.2, t = 0.09, cap = 0.08;
  let d = Number.POSITIVE_INFINITY;
  if (ry >= cy) d = Math.abs(Math.hypot(rx, ry - cy) - R) - t / 2;
  for (const s of [-1, 1]) d = Math.min(d, Math.hypot(rx - s * R, ry - cy) - cap);
  return Math.max(0, Math.min(1, 0.5 - d / px));
}

function render(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const px = 1 / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size, v = (y + 0.5) / size;
      const circle = Math.max(0, Math.min(1, 0.5 - (Math.hypot(u - 0.5, v - 0.5) - 0.48) / px));
      const h = handset(u, v, px);
      const i = (y * size + x) * 4;
      rgba[i] = Math.round(BG[0] + (255 - BG[0]) * h);
      rgba[i + 1] = Math.round(BG[1] + (255 - BG[1]) * h);
      rgba[i + 2] = Math.round(BG[2] + (255 - BG[2]) * h);
      rgba[i + 3] = Math.round(255 * circle);
    }
  }
  return rgba;
}

function ico(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(entries.length, 4);
  const dir = [];
  const blobs = [];
  let offset = 6 + 16 * entries.length;
  for (const { size, data } of entries) {
    const e = Buffer.alloc(16);
    e[0] = size === 256 ? 0 : size; e[1] = size === 256 ? 0 : size; e[2] = 0; e[3] = 0;
    e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6); e.writeUInt32LE(data.length, 8); e.writeUInt32LE(offset, 12);
    dir.push(e); blobs.push(data); offset += data.length;
  }
  return Buffer.concat([header, ...dir, ...blobs]);
}

mkdirSync(OUT, { recursive: true });
const sizes = [256, 48, 32, 16];
const pngs = sizes.map((s) => ({ size: s, data: png(s, render(s)) }));
writeFileSync(join(OUT, 'icon.png'), pngs[0].data);
writeFileSync(join(OUT, 'icon.ico'), ico(pngs));
console.log(`assets/icon.png und assets/icon.ico geschrieben (${sizes.join('/')} px)`);
