// 试墨图像计量核心：纯函数，无 Node 专有 API，浏览器与服务端共用同一份实现。
// 所有函数只处理已经解码出的 { width, height, rgba } 光栅（rgba 为长度 w*h*4 的 Uint8Array）。

export const MIN_BLUR_SCORE = 35; // 拉普拉斯方差低于此值判定为模糊
export const MIN_INK_RATIO = 0.0008; // 墨迹占比过小视为未检出墨迹
export const HASH_MAX_DISTANCE = 5; // aHash 汉明距离 <= 此值视为重复图

// Rec.601 加权灰度
export function toGray({ width, height, rgba }) {
  const gray = new Uint8ClampedArray(width * height);
  for (let i = 0, p = 0; i < rgba.length; i += 4, p++) {
    gray[p] = Math.round(0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]);
  }
  return gray;
}

// 大津法求前景/背景分割阈值
export function otsuThreshold(gray) {
  const hist = new Array(256).fill(0);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const total = gray.length;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0, wB = 0, maxVar = -1, threshold = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > maxVar) { maxVar = between; threshold = t; }
  }
  return threshold;
}

// 取最大连通域作为墨迹主体（试墨纸上通常为单一墨团；可排除孤立噪点）
export function largestComponent(width, height, predicate) {
  const n = width * height;
  const seen = new Uint8Array(n);
  const stack = new Int32Array(n);
  let best = [];
  for (let start = 0; start < n; start++) {
    if (seen[start] || !predicate(start)) continue;
    seen[start] = 1;
    let top = 0, size = 0;
    stack[top++] = start;
    const component = [];
    while (top > 0) {
      const idx = stack[--top];
      component.push(idx);
      size++;
      const x = idx % width;
      if (x > 0) { const j = idx - 1; if (!seen[j] && predicate(j)) { seen[j] = 1; stack[top++] = j; } }
      if (x + 1 < width) { const j = idx + 1; if (!seen[j] && predicate(j)) { seen[j] = 1; stack[top++] = j; } }
      if (idx >= width) { const j = idx - width; if (!seen[j] && predicate(j)) { seen[j] = 1; stack[top++] = j; } }
      if (idx + width < n) { const j = idx + width; if (!seen[j] && predicate(j)) { seen[j] = 1; stack[top++] = j; } }
    }
    if (size > best.length) best = component;
  }
  return best;
}

// 拉普拉斯方差：边缘处二阶响应大，方差小表示图像模糊
export function laplacianVariance(gray, width, height) {
  let sum = 0;
  const values = [];
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const v = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - width] - gray[i + width];
      values.push(v);
      sum += v;
    }
  }
  const mean = sum / values.length;
  let acc = 0;
  for (const v of values) acc += (v - mean) * (v - mean);
  return acc / values.length;
}

// Sobel 梯度模（只在指定像素集合上统计）
function gradientAt(gray, width, x, y) {
  const i = y * width + x;
  const gx =
    -gray[i - width - 1] + gray[i - width + 1]
    - 2 * gray[i - 1] + 2 * gray[i + 1]
    -gray[i + width - 1] + gray[i + width + 1];
  const gy =
    -gray[i - width - 1] - 2 * gray[i - width] - gray[i - width + 1]
    +gray[i + width - 1] + 2 * gray[i + width] + gray[i + width + 1];
  return Math.hypot(gx, gy);
}

// 边缘清晰度：墨迹边界处的平均 Sobel 梯度（0~255，越大越锐利）
export function edgeSharpness(gray, width, height, inInk) {
  let total = 0, count = 0;
  let max = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      if (!inInk[i]) continue;
      if (inInk[i - 1] && inInk[i + 1] && inInk[i - width] && inInk[i + width]) continue; // 内部点
      const g = gradientAt(gray, width, x, y);
      total += g; count++;
      if (g > max) max = g;
    }
  }
  return count ? { mean: total / count, max, boundaryPixels: count } : { mean: 0, max: 0, boundaryPixels: 0 };
}

// 16 阶色阶分布（0 最黑 … 15 最亮），仅统计墨迹内部
export function toneHistogram(gray, inInk, bins = 16) {
  const hist = new Array(bins).fill(0);
  let total = 0;
  for (let i = 0; i < gray.length; i++) {
    if (!inInk[i]) continue;
    let b = Math.floor(gray[i] / 256 * bins);
    if (b >= bins) b = bins - 1;
    hist[b]++;
    total++;
  }
  const mean = total
    ? hist.reduce((s, c, b) => s + c * (b + 0.5) / bins * 255, 0) / total
    : 0;
  return { bins: hist.map(c => (total ? c / total : 0)), count: total, meanLevel: mean };
}

// 平均哈希（8x8 灰度，按均值二值），用于重复图检测
export function aHash(gray, width, height) {
  const N = 8;
  const vals = new Array(N * N);
  for (let by = 0; by < N; by++) {
    for (let bx = 0; bx < N; bx++) {
      const x0 = Math.floor(bx * width / N), x1 = Math.max(x0 + 1, Math.floor((bx + 1) * width / N));
      const y0 = Math.floor(by * height / N), y1 = Math.max(y0 + 1, Math.floor((by + 1) * height / N));
      let sum = 0, cnt = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { sum += gray[y * width + x]; cnt++; }
      vals[by * N + bx] = sum / cnt;
    }
  }
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  let bits = 0n;
  for (let i = 0; i < vals.length; i++) if (vals[i] >= avg) bits |= 1n << BigInt(i);
  return bits;
}

export function hammingDistance(a, b) {
  let x = a ^ b, d = 0;
  while (x) { d += Number(x & 1n); x >>= 1n; }
  return d;
}

// 对解码后的图像做完整计量。scale: { pxPerMm } 标定结果；不提供则不输出物理面积。
export function analyzeImage(image, scale) {
  const { width, height, rgba } = image;
  if (width < 16 || height < 16) throw new Error("image_too_small");
  const gray = toGray(image);
  const threshold = otsuThreshold(gray);
  const component = largestComponent(width, height, i => gray[i] <= threshold);
  const inInk = new Uint8Array(width * height);
  for (const idx of component) inInk[idx] = 1;

  const pixelCount = component.length;
  const ratio = pixelCount / (width * height);
  const blurScore = laplacianVariance(gray, width, height);
  const sharp = edgeSharpness(gray, width, height, inInk);
  const tones = toneHistogram(gray, inInk);
  const hash = aHash(gray, width, height);

  // 墨质团紧致度：4πA/P²，越接近 1 越圆整（扩散毛糙时偏小）
  const compactness = sharp.boundaryPixels
    ? (4 * Math.PI * pixelCount) / (sharp.boundaryPixels * sharp.boundaryPixels)
    : 0;

  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (const idx of component) {
    const x = idx % width, y = (idx / width) | 0;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  const bboxPx = pixelCount ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } : null;

  const result = {
    width, height,
    inkPixelCount: pixelCount,
    inkRatio: ratio,
    blurScore: round3(blurScore),
    sharpness: round3(sharp.mean),
    sharpnessMax: round3(sharp.max),
    compactness: round3(compactness),
    boundaryPixels: sharp.boundaryPixels,
    bboxPx,
    tones: tones.bins.map(round5),
    inkMeanLevel: round3(tones.meanLevel),
    threshold,
    hash: hash.toString(16),
    valid: false,
    invalidReason: null,
  };
  if (scale && Number.isFinite(scale.pxPerMm) && scale.pxPerMm > 0) {
    result.areaMm2 = round3(pixelCount / (scale.pxPerMm * scale.pxPerMm));
    result.bboxMm = bboxPx
      ? { x: round3(minX / scale.pxPerMm), y: round3(minY / scale.pxPerMm),
          width: round3(bboxPx.width / scale.pxPerMm), height: round3(bboxPx.height / scale.pxPerMm) }
      : null;
  }
  return result;
}

// 依据计量结果与上下文判定有效性。existingHashes：同留样历史全部图片的 aHash（含跨版本）。
export function judge(metrics, { calibrated, existingHashes = [] } = {}) {
  if (metrics.inkRatio < MIN_INK_RATIO) return { valid: false, reason: "no_ink", reasonText: "未检出墨迹区域" };
  if (!calibrated) return { valid: false, reason: "no_scale", reasonText: "缺少刻度标定" };
  if (metrics.blurScore < MIN_BLUR_SCORE) return { valid: false, reason: "blurry", reasonText: "图像模糊（清晰度评分 " + metrics.blurScore.toFixed(1) + " < " + MIN_BLUR_SCORE + "）" };
  const hash = BigInt("0x" + metrics.hash);
  for (const h of existingHashes) {
    if (hammingDistance(hash, h) <= HASH_MAX_DISTANCE) {
      return { valid: false, reason: "duplicate", reasonText: "与已提交图片重复" };
    }
  }
  return { valid: true, reason: null, reasonText: "" };
}

function round3(v) { return Math.round(v * 1000) / 1000; }
function round5(v) { return Math.round(v * 100000) / 100000; }
