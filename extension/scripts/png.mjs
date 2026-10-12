// Tiny PNG encoder (RGBA, no dependencies besides node:zlib) and the brand icon drawing.
import { deflateSync } from "node:zlib";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([len, typeAndData, crc]);
}

/** Encode width*height RGBA pixels (Uint8Array, row-major) as a PNG file. */
export function encodePng(width, height, rgba) {
  if (rgba.length !== width * height * 4) throw new Error("pixel buffer size mismatch");
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------------------------
// Icon: deep plum rounded square, cream hanger, small gold sparkle (sizes >= 32).

function hex(c) {
  const n = parseInt(c.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - hw + r;
  const qy = Math.abs(py - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function distSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Coverage tests in unit coordinates (0..1). */
function hangerHit(x, y, stroke) {
  const half = stroke / 2;
  // Hook: arc around (0.53, 0.29), from the left side over the top to the lower right.
  const hx = 0.53;
  const hy = 0.29;
  const hr = 0.075;
  const ang = Math.atan2(y - hy, x - hx); // -PI..PI, 0 = right, PI/2 = down
  const onArc = Math.abs(Math.hypot(x - hx, y - hy) - hr) <= half && !(ang > 0.35 && ang < 2.9);
  if (onArc) return true;
  const segs = [
    [hx + hr * Math.cos(0.35), hy + hr * Math.sin(0.35), 0.5, 0.43], // hook tail to neck
    [0.5, 0.43, 0.17, 0.66],
    [0.5, 0.43, 0.83, 0.66],
    [0.17, 0.66, 0.83, 0.66],
  ];
  return segs.some(([ax, ay, bx, by]) => distSegment(x, y, ax, ay, bx, by) <= half);
}

function sparkleHit(x, y) {
  const cx = 0.77;
  const cy = 0.22;
  const r = 0.11;
  const dx = Math.abs(x - cx) / r;
  const dy = Math.abs(y - cy) / r;
  return Math.sqrt(dx) + Math.sqrt(dy) <= 1;
}

/** RGBA pixels of the icon at a given size, 4x4 supersampled. */
export function drawIcon(size, colors = { plum: "#3b1f4a", cream: "#fbf7f0", gold: "#d9a441" }) {
  const plum = hex(colors.plum);
  const cream = hex(colors.cream);
  const gold = hex(colors.gold);
  const out = new Uint8Array(size * size * 4);
  const ss = 4;
  const stroke = size <= 16 ? 0.11 : size <= 32 ? 0.085 : 0.07;
  const radius = 0.22;
  const showSparkle = size >= 32;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let a = 0;
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = (px + (sx + 0.5) / ss) / size;
          const y = (py + (sy + 0.5) / ss) / size;
          if (sdRoundRect(x, y, 0.5, 0.5, 0.5, 0.5, radius) > 0) continue;
          let col = plum;
          if (hangerHit(x, y, stroke)) col = cream;
          else if (showSparkle && sparkleHit(x, y)) col = gold;
          r += col[0];
          g += col[1];
          b += col[2];
          a += 1;
        }
      }
      const i = (py * size + px) * 4;
      if (a > 0) {
        out[i] = Math.round(r / a);
        out[i + 1] = Math.round(g / a);
        out[i + 2] = Math.round(b / a);
        out[i + 3] = Math.round((255 * a) / (ss * ss));
      }
    }
  }
  return out;
}

export function iconPng(size, colors) {
  return encodePng(size, size, drawIcon(size, colors));
}
