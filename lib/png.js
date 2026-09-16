// 最小 PNG 编解码（仅 8bit、非隔行；覆盖试墨场景用到的灰度/RGB/RGBA/调色板）。
import { inflateSync, deflateSync } from "node:zlib";

const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

// { width, height, rgba: Uint8Array } -> PNG Buffer（编码为 8bit 灰度，体积小）
export function encode({ width, height, rgba }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 0;  // color type: grayscale
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const stride = width;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      raw[y * (stride + 1) + 1 + x] = Math.round(
        0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2]
      );
    }
  }
  return Buffer.concat([
    SIG,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

// PNG Buffer -> { width, height, rgba: Uint8Array }
export function decode(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (buf.length < 24 || !buf.subarray(0, 8).equals(SIG)) throw new Error("not_png");
  let pos = 8, width = 0, height = 0, bitDepth = 0, colorType = -1, interlaced = 0;
  let palette = null;
  const idat = [];
  while (pos < buf.length) {
    if (pos + 8 > buf.length) throw new Error("png_truncated");
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const dataStart = pos + 8;
    if (dataStart + len + 4 > buf.length) throw new Error("png_truncated");
    const data = buf.subarray(dataStart, dataStart + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9]; interlaced = data[12];
    } else if (type === "PLTE") {
      palette = data;
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    pos = dataStart + len + 4;
  }
  if (interlaced) throw new Error("png_interlace_unsupported");
  if (bitDepth !== 8) throw new Error("png_bitdepth_unsupported");
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error("png_colortype_unsupported");
  if (colorType === 3 && !palette) throw new Error("png_palette_missing");
  if (width > 4000 || height > 4000) throw new Error("png_too_large");

  const inflated = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const expected = (stride + 1) * height;
  if (inflated.length !== expected) throw new Error("png_bad_stream");

  const rgba = new Uint8Array(width * height * 4);
  const prev = Buffer.alloc(stride);
  const line = Buffer.alloc(stride);
  let src = 0, dst = 0;
  for (let y = 0; y < height; y++) {
    const filter = inflated[src++];
    inflated.copy(line, 0, src, src + stride);
    src += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? line[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      switch (filter) {
        case 0: break;
        case 1: line[x] = (line[x] + a) & 255; break;
        case 2: line[x] = (line[x] + b) & 255; break;
        case 3: line[x] = (line[x] + ((a + b) >> 1)) & 255; break;
        case 4: line[x] = (line[x] + paeth(a, b, c)) & 255; break;
        default: throw new Error("png_bad_filter");
      }
    }
    for (let x = 0; x < width; x++) {
      let r, g, bl, al = 255;
      if (colorType === 0) { r = g = bl = line[x]; }
      else if (colorType === 4) { r = g = bl = line[2 * x]; al = line[2 * x + 1]; }
      else if (colorType === 2) { r = line[3 * x]; g = line[3 * x + 1]; bl = line[3 * x + 2]; }
      else if (colorType === 6) { r = line[4 * x]; g = line[4 * x + 1]; bl = line[4 * x + 2]; al = line[4 * x + 3]; }
      else { // 3: palette index -> RGB
        const idx = line[x] * 3;
        r = palette[idx]; g = palette[idx + 1]; bl = palette[idx + 2];
      }
      rgba[dst++] = r; rgba[dst++] = g; rgba[dst++] = bl; rgba[dst++] = al;
    }
    line.copy(prev);
  }
  return { width, height, rgba };
}
