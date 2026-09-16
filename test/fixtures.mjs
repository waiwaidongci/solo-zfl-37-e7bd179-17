// 合成试墨纸图片（PNG data URL 与原始 buffer），供端到端走查使用。
import { deflateSync } from "node:zlib";
import { encode } from "../lib/png.js";

// 两张合法、等长、开头完全相同、仅尾部像素不同的 PNG。
// 用未压缩 deflate（zlib 头 + 一个 stored block + adler32）重打 IDAT，
// 因此末尾字节不同不会破坏校验；用来复现「只看长度+开头」的幂等指纹漏洞。
function storedZlib(raw) {
  const n = raw.length;
  const block = Buffer.alloc(2 + 5 + n + 4);
  block[0] = 0x78; block[1] = 0x01; // zlib header（CM=deflate, 无预置字典）
  let o = 2;
  block[o++] = 0x01; // BFINAL=1, BTYPE=00
  block.writeUInt16LE(n & 0xffff, o); o += 2;
  block.writeUInt16LE((~n) & 0xffff, o); o += 2;
  raw.copy(block, o); o += n;
  let s1 = 1, s2 = 0;
  for (let i = 0; i < n; i++) { s1 = (s1 + raw[i]) % 65521; s2 = (s2 + s1) % 65521; }
  block.writeUInt32BE(((s2 << 16) | s1) >>> 0, o);
  return block;
}
function pngWithRaw(width, height, raw, colorType) {
  const channels = colorType === 0 ? 1 : 4;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = colorType;
  const idat = storedZlib(raw);
  const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  const crc = buf => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const cc = Buffer.alloc(4); cc.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, cc]);
  };
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  void channels;
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}
export function lookalikePair() {
  // 两张同样是「背景 232 + 墨团」的灰度图，只改墨团最末一个像素，文件等长同前缀
  const W = 120, H = 120;
  const mk = tailLevel => {
    const raw = Buffer.alloc((W + 1) * H);
    for (let y = 0; y < H; y++) {
      raw[y * (W + 1)] = 0;
      for (let x = 0; x < W; x++) {
        const d = Math.hypot(x - 60, y - 60);
        raw[y * (W + 1) + 1 + x] = d <= 30 ? 30 : 232;
      }
    }
    raw[H * (W + 1) - 1 - 8] = tailLevel; // 墨团内靠后的一个像素
    return pngWithRaw(W, H, raw, 0);
  };
  return [mk(30), mk(60)];
}

// 确定性伪随机，保证走查可复现
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function canvas(w, h, base = 232, noise = 6, rng = makeRng(1)) {
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const v = Math.max(0, Math.min(255, base + (rng() - 0.5) * 2 * noise));
    rgba[i * 4] = v; rgba[i * 4 + 1] = v; rgba[i * 4 + 2] = v; rgba[i * 4 + 3] = 255;
  }
  return { width: w, height: h, rgba };
}

function setPx(img, x, y, v, a = 255) {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
  const p = (y * img.width + x) * 4;
  img.rgba[p] = v; img.rgba[p + 1] = v; img.rgba[p + 2] = v; img.rgba[p + 3] = a;
}

// 画一个墨团（带渐变与少量随机飞溅，不同种子形状/位置/墨色不同）
function inkBlob(img, { cx, cy, rx, ry, level, seed, feather = 2 }) {
  const rng = makeRng(seed);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      // 轻微不规则边缘
      const ang = Math.atan2(y - cy, x - cx);
      const wobble = 1 + 0.06 * Math.sin(ang * 3 + seed) + 0.04 * Math.sin(ang * 7 + seed * 2);
      const d = Math.sqrt(((x - cx) / (rx * wobble)) ** 2 + ((y - cy) / (ry * wobble)) ** 2);
      if (d > 1.15) continue;
      let v;
      if (d <= 1 - feather / Math.max(rx, ry)) {
        v = level + (rng() - 0.5) * 10;
      } else {
        const t = Math.max(0, Math.min(1, (d - (1 - feather / Math.max(rx, ry))) / (feather / Math.max(rx, ry) + 0.15)));
        v = level + (232 - level) * t;
      }
      // 墨内深色颗粒
      if (d < 0.5 && rng() < 0.05) v -= 30 * rng();
      setPx(img, x, y, Math.max(0, Math.min(255, v)));
    }
  }
  // 边缘细毛：扩散毛刺，提高清晰度/非模糊特征
  for (let i = 0; i < 260; i++) {
    const a = rng() * Math.PI * 2;
    const r = (0.9 + rng() * 0.2) * Math.min(rx, ry);
    const x = Math.round(cx + Math.cos(a) * r * (rx / Math.min(rx, ry)));
    const y = Math.round(cy + Math.sin(a) * r * (ry / Math.min(rx, ry)));
    setPx(img, x, y, level + 40 * rng());
  }
}

function makePng(spec) {
  const rng = makeRng(spec.seed * 7 + 13);
  const img = canvas(220, 220, 232, 7, rng);
  inkBlob(img, spec);
  return encode(img);
}

// 模糊图：超大羽化 + 大半径盒模糊
function makeBlurryPng(spec) {
  const rng = makeRng(spec.seed * 7 + 13);
  const img = canvas(220, 220, 232, 0, rng);
  inkBlob(img, { ...spec, feather: 40 });
  const R = 22;
  const out = canvas(220, 220, 232, 0, rng);
  for (let y = 0; y < 220; y++) {
    for (let x = 0; x < 220; x++) {
      let s = 0, n = 0;
      for (let dy = -R; dy <= R; dy += 6) for (let dx = -R; dx <= R; dx += 6) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= 220 || yy >= 220) continue;
        s += img.rgba[(yy * 220 + xx) * 4]; n++;
      }
      const v = s / n;
      out.rgba[(y * 220 + x) * 4] = v;
      out.rgba[(y * 220 + x) * 4 + 1] = v;
      out.rgba[(y * 220 + x) * 4 + 2] = v;
    }
  }
  return encode(out);
}

function blankPng(seed = 99) {
  return encode(canvas(220, 220, 238, 0, makeRng(seed)));
}

export function dataUrl(pngBuf) {
  return "data:image/png;base64," + pngBuf.toString("base64");
}

// 三张形状/位置/墨色差异足够大的清晰图（aHash 互不重复）
export function sharpSet() {
  return [
    makePng({ seed: 101, cx: 95, cy: 100, rx: 52, ry: 46, level: 28, feather: 2 }),
    makePng({ seed: 202, cx: 140, cy: 130, rx: 34, ry: 58, level: 64, feather: 2 }),
    makePng({ seed: 303, cx: 70, cy: 150, rx: 60, ry: 30, level: 96, feather: 2 }),
  ];
}
export const blurryPng = () => makeBlurryPng({ seed: 404, cx: 105, cy: 110, rx: 44, ry: 44, level: 50 });
export const fourthPng = () => makePng({ seed: 606, cx: 150, cy: 70, rx: 40, ry: 26, level: 120, feather: 2 });
export const fifthPng = () => makePng({ seed: 707, cx: 60, cy: 60, rx: 28, ry: 50, level: 150, feather: 2 });
export const blankSheet = () => blankPng(505);
export const garbagePng = () => Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from("THIS IS NOT A REAL PNG STREAM")]);
