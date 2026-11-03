// Generates the toolbar icons at build time with node builtins only, so no binaries are committed.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';

const ACCENT = [0x15, 0x68, 0x5b];
const MARK = [0xe7, 0xf2, 0xef];

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

// Capture bracket: four corner brackets around a centered square dot, on the accent field.
function draw(size) {
  const px = new Uint8Array(size * size * 3);
  const fill = (x0, y0, x1, y1, rgb) => {
    for (let y = Math.round(y0); y < Math.round(y1); y++)
      for (let x = Math.round(x0); x < Math.round(x1); x++) px.set(rgb, (y * size + x) * 3);
  };
  fill(0, 0, size, size, ACCENT);
  const lo = size * 0.2, hi = size * 0.8, arm = size * 0.22, t = Math.max(1, size * 0.09);
  for (const [cx, sx] of [[lo, 1], [hi, -1]]) {
    for (const [cy, sy] of [[lo, 1], [hi, -1]]) {
      const ax = sx > 0 ? cx : cx - arm, ay = sy > 0 ? cy : cy - t;
      fill(ax, ay, ax + arm, ay + t, MARK);
      const bx = sx > 0 ? cx : cx - t, by = sy > 0 ? cy : cy - arm;
      fill(bx, by, bx + t, by + arm, MARK);
    }
  }
  const d = size * 0.1;
  fill(size / 2 - d, size / 2 - d, size / 2 + d, size / 2 + d, MARK);
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    Buffer.from(px.buffer, y * size * 3, size * 3).copy(raw, y * (size * 3 + 1) + 1);
  }
  const head = Buffer.alloc(13);
  head.writeUInt32BE(size, 0);
  head.writeUInt32BE(size, 4);
  head.set([8, 2, 0, 0, 0], 8);
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([sig, chunk('IHDR', head), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

mkdirSync('dist/icons', { recursive: true });
for (const size of [16, 48, 128]) writeFileSync(`dist/icons/icon${size}.png`, draw(size));
