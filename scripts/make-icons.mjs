#!/usr/bin/env node
/* Draws the app icons (hex sigil + plus) as PNGs with no image libraries.
   Run: node scripts/make-icons.mjs */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
const BG = [5, 7, 15];
const CYAN = [95, 230, 255];
const VIOLET = [139, 92, 246];
const HEX = [[24, 3], [44, 14], [44, 34], [24, 45], [4, 34], [4, 14]];
const INNER = [[24, 11], [36, 18], [36, 30], [24, 37], [12, 30], [12, 18]];

function segDist(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy)));
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

function outlineDist(px, py, verts) {
  let d = Infinity;
  for (let i = 0; i < verts.length; i++) {
    const a = verts[i];
    const b = verts[(i + 1) % verts.length];
    d = Math.min(d, segDist(px, py, a[0], a[1], b[0], b[1]));
  }
  return d;
}

const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const smooth = (edge, width, d) => Math.max(0, Math.min(1, (width - d) / edge + 0.5));

// Concentric strokes with antialiasing; coords are in 48-unit design space.
function shade(u, v, scale) {
  const px = (u - 24) / scale + 24;
  const py = (v - 24) / scale + 24;
  const tint = mix(CYAN, VIOLET, Math.min(1, Math.max(0, py / 48)));

  let color = BG;
  const outer = smooth(1.1, 0.9, outlineDist(px, py, HEX));
  if (outer > 0) color = mix(color, tint, outer * 0.95);

  const inner = smooth(1.0, 0.45, outlineDist(px, py, INNER));
  if (inner > 0) color = mix(color, CYAN, inner * 0.5);

  const plus = Math.min(
    segDist(px, py, 24, 17.5, 24, 30.5),
    segDist(px, py, 17.5, 24, 30.5, 24)
  );
  const strength = smooth(0.9, 0.8, plus);
  if (strength > 0) color = mix(color, CYAN, strength);

  return color;
}

function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0; // no filter
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function draw(size, scale) {
  const buf = Buffer.alloc(size * size * 4);
  const samples = 3;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const u = ((x + (sx + 0.5) / samples) / size) * 48;
          const v = ((y + (sy + 0.5) / samples) / size) * 48;
          const [cr, cg, cb] = shade(u, v, scale);
          r += cr;
          g += cg;
          b += cb;
        }
      }
      const n = samples * samples;
      const at = (y * size + x) * 4;
      buf[at] = Math.round(r / n);
      buf[at + 1] = Math.round(g / n);
      buf[at + 2] = Math.round(b / n);
      buf[at + 3] = 255;
    }
  }
  return png(size, size, buf);
}

mkdirSync(OUT, { recursive: true });
writeFileSync(resolve(OUT, 'icon-192.png'), draw(192, 1));
writeFileSync(resolve(OUT, 'icon-512.png'), draw(512, 1));
writeFileSync(resolve(OUT, 'icon-maskable-512.png'), draw(512, 0.8));
console.log('icons written to public/icons');
