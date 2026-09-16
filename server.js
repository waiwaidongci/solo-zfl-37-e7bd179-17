import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, extname } from "node:path";
import { fileURLToPath } from "node:url";

import { Store, nowIso, newId, groupKeyOf } from "./lib/store.js";
import { decode } from "./lib/png.js";
import { analyzeImage, judge, hammingDistance } from "./lib/imaging.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || join(__dirname, "data");
const publicDir = join(__dirname, "public");
const port = Number(process.env.PORT || 3037);
const REQUIRED_VALID = 3;
const MAX_BODY_BYTES = 24 * 1024 * 1024; // 24MB，够一批手机照片（前端先压缩）

const store = new Store(dataDir);

// ---------- 领域辅助 ----------

function publicSample(sample) {
  // 列表/详情接口不回传图片 base64，避免载荷过大
  const versions = sample.versions.map(v => ({
    ...v,
    photos: v.photos.map(p => {
      const { dataUrl, ...rest } = p;
      void dataUrl;
      return rest;
    }),
  }));
  return { ...sample, versions };
}

function currentVersion(sample) {
  return sample.versions[sample.versions.length - 1];
}

function findSample(db, idOrCode) {
  return db.samples.find(s => s.id === idOrCode || s.code === idOrCode);
}

// 查重哈希：历史冻结版本的全部图片（驳回后不得复用旧图）+ 当前版本仅有效图
// （当前版本里因缺标定/模糊而无效的图，修正后允许重新提交同一张）
function dedupeHashes(sample, current) {
  const hashes = [];
  for (const v of sample.versions) {
    for (const p of v.photos) {
      if (!p.hash) continue;
      if (v === current) { if (p.valid) hashes.push(BigInt("0x" + p.hash)); }
      else hashes.push(BigInt("0x" + p.hash));
    }
  }
  return hashes;
}

function buildConclusion(version) {
  const byId = new Map(version.photos.map(p => [p.id, p]));
  const groups = version.groups
    .map(g => ({ g, photos: g.photoIds.map(id => byId.get(id)).filter(Boolean) }))
    .map(({ g, photos }) => ({ g, photos, validPhotos: photos.filter(p => p.valid) }))
    .filter(x => x.validPhotos.length > 0)
    .sort((a, b) => b.validPhotos.length - a.validPhotos.length);
  const target = groups[0];
  if (!target || target.validPhotos.length < REQUIRED_VALID) return null;
  const valid = target.validPhotos;
  const avg = key => valid.reduce((s, p) => s + (p.metrics[key] || 0), 0) / valid.length;
  const toneSum = new Array(valid[0].metrics.tones.length).fill(0);
  for (const p of valid) p.metrics.tones.forEach((t, i) => { toneSum[i] += t; });
  const toneAvg = toneSum.map(v => v / valid.length);
  // 扩散均匀度：各图面积的变异系数（越小越稳定）
  const areas = valid.map(p => p.metrics.areaMm2);
  const areaMean = areas.reduce((a, b) => a + b, 0) / areas.length;
  const cv = areaMean === 0 ? 0
    : Math.sqrt(areas.reduce((s, a) => s + (a - areaMean) ** 2, 0) / areas.length) / areaMean;
  return {
    at: nowIso(),
    groupKey: target.g.key,
    paper: target.g.paper,
    lighting: target.g.lighting,
    water: target.g.water,
    validPhotoCount: valid.length,
    photoIds: valid.map(p => p.id),
    areaMm2Mean: round3(areaMean),
    areaMm2Cv: round3(cv),
    sharpnessMean: round3(avg("sharpness")),
    blurScoreMean: round3(avg("blurScore")),
    compactnessMean: round3(avg("compactness")),
    inkMeanLevel: round3(avg("inkMeanLevel")),
    toneDistribution: toneAvg.map(v => Math.round(v * 100000) / 100000),
  };
}

function audit(db, actor, action, detail) {
  db.audit.push({ id: newId("A"), at: nowIso(), actor: actor || "匿名", action, detail: detail || {} });
}

// ---------- 采集批处理：单张失败隔离，不影响同批其余照片 ----------

function processPhoto(version, sample, entry, actor) {
  const photoId = newId("P");
  const base = {
    id: photoId,
    at: nowIso(),
    uploadedBy: actor,
    clientName: String(entry.clientName || "").slice(0, 120),
    paper: strField(entry.paper),
    lighting: strField(entry.lighting),
    water: strField(entry.water),
  };

  // 1) 分组字段必须齐全（无法归组即无效）
  if (!base.paper || !base.lighting || !base.water) {
    return invalid(base, null, "missing_group", "缺少纸张/光照/水滴量，无法归组");
  }
  const key = groupKeyOf(entry);

  // 2) 解码：单张损坏不影响批次其余照片
  let image;
  try {
    const dataUrl = String(entry.dataUrl || "");
    const m = /^data:image\/png;base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl);
    if (!m) throw new Error("not_png_dataurl");
    image = decode(Buffer.from(m[1].replace(/\s/g, ""), "base64"));
  } catch (err) {
    return invalid(base, null, "decode_failed", "图片解码失败：" + describeDecodeError(err.message));
  }
  base.width = image.width;
  base.height = image.height;

  // 3) 标定
  const pxPerMm = Number(entry.pxPerMm);
  const calibrated = Number.isFinite(pxPerMm) && pxPerMm > 0;
  if (calibrated) {
    base.scale = {
      pxPerMm: round3(pxPerMm),
      markerPx: Number(entry.markerPx) || null,
      knownMm: Number(entry.knownMm) || null,
    };
  }

  // 4) 本地（服务端）提取墨迹与计量
  let metrics;
  try {
    metrics = analyzeImage(image, calibrated ? { pxPerMm } : null);
  } catch (err) {
    return invalid(base, null, "analyze_failed", "指标计算失败：" + err.message);
  }
  base.hash = metrics.hash;
  base.metrics = metrics;

  // 5) 有效性判定（无墨迹优先于标定；重复跨所有历史版本）
  const verdict = judge(metrics, {
    calibrated,
    existingHashes: dedupeHashes(sample, version),
  });
  base.valid = verdict.valid;
  base.invalidReason = verdict.reason;
  base.invalidReasonText = verdict.reasonText;

  // 6) 归组（无效图也留在对应组里，便于复核说明原因）
  let group = version.groups.find(g => g.key === key);
  if (!group) {
    group = { key, paper: base.paper, lighting: base.lighting, water: base.water, photoIds: [] };
    version.groups.push(group);
  }
  group.photoIds.push(photoId);

  return base;
}

function invalid(base, metrics, reason, text) {
  return { ...base, valid: false, invalidReason: reason, invalidReasonText: text, metrics, hash: base.hash || null };
}

function describeDecodeError(msg) {
  const map = {
    not_png: "不是 PNG 图像",
    not_png_dataurl: "图片格式应为 image/png（请在浏览器内重编码后上传）",
    png_truncated: "文件已损坏或不完整",
    png_bad_stream: "压缩数据损坏",
    png_bad_filter: "压缩数据损坏",
    png_interlace_unsupported: "暂不支持隔行扫描 PNG",
    png_bitdepth_unsupported: "暂不支持非 8bit PNG",
    png_colortype_unsupported: "不支持的色彩类型",
    png_palette_missing: "调色板缺失",
    png_too_large: "图像尺寸超过 4000px",
  };
  return map[msg] || msg;
}

function strField(v) {
  if (typeof v !== "string") return "";
  const s = v.trim();
  return s.length > 60 ? "" : s;
}

function round3(v) { return Math.round(v * 1000) / 1000; }

// ---------- HTTP ----------

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const err = new Error("payload_too_large");
      err.status = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const err = new Error("bad_json");
    err.status = 400;
    throw err;
  }
}

function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}
function sendError(res, status, error, extra) {
  send(res, status, { error, ...(extra || {}) });
}

function identity(req) {
  let name = "";
  try { name = decodeURIComponent(String(req.headers["x-operator-name"] || "")); } catch { name = String(req.headers["x-operator-name"] || ""); }
  name = name.trim().slice(0, 40);
  let role = String(req.headers["x-role"] || "").trim();
  if (role !== "operator" && role !== "reviewer") role = "";
  return { name, role };
}

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css" };

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname;

    // 静态资源
    if (req.method === "GET" && (p === "/" || p === "/index.html")) {
      return serveFile(res, join(publicDir, "index.html"));
    }
    const staticMatch = /^\/(lib\/[a-z-]+\.js|app\.js|styles\.css)$/.exec(p);
    if (req.method === "GET" && staticMatch) {
      const path = staticMatch[1] === "app.js" || staticMatch[1] === "styles.css"
        ? join(publicDir, staticMatch[1])
        : join(__dirname, staticMatch[1]);
      return serveFile(res, path);
    }

    // 故障注入（仅允许显式开启的测试环境）
    if (req.method === "POST" && p === "/api/testing/fail-next-write") {
      if (process.env.ALLOW_FAULTS !== "1") return sendError(res, 403, "fault_injection_disabled");
      store.failNextWrite = true;
      return send(res, 200, { ok: true });
    }

    // GET 接口
    if (req.method === "GET" && p === "/api/state") {
      return send(res, 200, {
        dbVersion: store.db.dbVersion,
        samples: store.db.samples.map(publicSample),
      });
    }
    if (req.method === "GET" && p === "/api/audit") {
      return send(res, 200, { audit: store.db.audit.slice(-300).reverse() });
    }
    const photoGet = /^\/api\/samples\/([^/]+)\/photos\/([^/]+)$/.exec(p);
    if (req.method === "GET" && photoGet) {
      const sample = findSample(store.db, decodeURIComponent(photoGet[1]));
      if (!sample) return sendError(res, 404, "sample_not_found");
      for (const v of sample.versions) {
        const ph = v.photos.find(x => x.id === photoGet[2]);
        if (ph) {
          res.writeHead(200, {
            "Content-Type": "image/png",
            "Cache-Control": "no-store",
            "X-Photo-Version": String(v.version),
          });
          const b64 = String(ph.dataUrl).split(",")[1] || "";
          return res.end(Buffer.from(b64, "base64"));
        }
      }
      return sendError(res, 404, "photo_not_found");
    }

    // 以下均为写操作：必须自报身份与角色
    const who = identity(req);
    if (req.method !== "GET") {
      if (!who.name) return sendError(res, 401, "identity_required");
      if (!who.role) return sendError(res, 401, "role_required");
    }

    // 新建留样（操作员）
    if (req.method === "POST" && p === "/api/samples") {
      if (who.role !== "operator") return sendError(res, 403, "reviewer_cannot_collect");
      const input = await readBody(req);
      const result = await idempotent(req, input, "create_sample", db => {
        const code = strField(input.code);
        if (!code) throw httpError(400, "code_required");
        if (db.samples.some(s => s.code === code)) throw httpError(409, "sample_code_exists");
        const now = nowIso();
        const sample = {
          id: newId("S"),
          code,
          name: strField(input.name) || code + " 留样",
          smokeSource: strField(input.smokeSource),
          glueRatio: strField(input.glueRatio),
          ageYears: Number.isFinite(Number(input.ageYears)) ? Number(input.ageYears) : null,
          storage: strField(input.storage),
          createdAt: now,
          versions: [{
            version: 1,
            status: "collecting",
            createdAt: now,
            createdBy: who.name,
            submittedBy: who.name,
            groups: [],
            photos: [],
            conclusion: null,
            review: null,
            snapshot: null,
          }],
        };
        db.samples.unshift(sample);
        audit(db, who.name, "sample_create", { sampleId: sample.id, code });
        return { status: 201, body: publicSample(sample) };
      });
      return send(res, result.status, result.body);
    }

    // 批量采集（操作员）
    const uploadMatch = /^\/api\/samples\/([^/]+)\/photos:batch$/.exec(p);
    if (req.method === "POST" && uploadMatch) {
      if (who.role !== "operator") return sendError(res, 403, "reviewer_cannot_collect");
      const input = await readBody(req);
      const result = await idempotent(req, input, "batch_upload", db => {
        const sample = findSample(db, decodeURIComponent(uploadMatch[1]));
        if (!sample) throw httpError(404, "sample_not_found");
        const version = currentVersion(sample);
        if (version.status === "approved") throw httpError(409, "version_approved_open_new", { hint: "当前版本已批准，如需补充请申请新版本" });
        if (version.status === "pending_review") throw httpError(409, "version_locked_for_review", { hint: "版本已提交复核并锁定，驳回后会生成新版本" });
        if (version.status === "rejected") throw httpError(409, "superseded_version");

        const entries = Array.isArray(input.photos) ? input.photos : [];
        if (!entries.length) throw httpError(400, "empty_batch");

        const results = [];
        let validCount = 0;
        for (const entry of entries) {
          try {
            const rawDataUrl = String((entry || {}).dataUrl || "");
            const photo = processPhoto(version, sample, entry || {}, who.name);
            // 只有成功解码的图片保存二进制；损坏文件不落盘
            if (photo.invalidReason !== "decode_failed"
              && photo.invalidReason !== "analyze_failed"
              && photo.invalidReason !== "missing_group") {
              photo.dataUrl = rawDataUrl;
            }
            version.photos.push(photo);
            if (photo.valid) validCount++;
            results.push({ clientName: photo.clientName, photoId: photo.id, valid: photo.valid,
              invalidReason: photo.invalidReason, invalidReasonText: photo.invalidReasonText,
              groupKey: groupKeyOf(photo), metrics: summarizeMetrics(photo.metrics) });
          } catch (err) {
            // 兜底：任何一张图的意外失败都不得拖垮同批其余照片
            results.push({ clientName: String(entry?.clientName || ""), valid: false,
              invalidReason: "unexpected", invalidReasonText: "处理异常：" + err.message });
          }
        }

        // 达到 3 张有效图：生成结论快照并锁定版本
        const totalValid = version.photos.filter(x => x.valid).length;
        if (totalValid >= REQUIRED_VALID) {
          const conclusion = buildConclusion(version);
          if (conclusion) {
            version.status = "pending_review";
            version.conclusion = conclusion;
            version.snapshot = {
              frozenAt: nowIso(),
              photoCount: version.photos.length,
              validCount: totalValid,
              groups: version.groups.map(g => ({ ...g })),
            };
          }
        }
        audit(db, who.name, "batch_upload", {
          sampleId: sample.id, version: version.version,
          received: entries.length, accepted: validCount,
          status: version.status,
        });
        return {
          status: 201,
          body: {
            sampleId: sample.id, version: version.version,
            versionStatus: version.status,
            validCount: totalValid,
            requiredValid: REQUIRED_VALID,
            conclusion: version.conclusion,
            results,
          },
        };
      });
      return send(res, result.status, result.body);
    }

    // 复核（复核人）：批准 / 驳回
    const reviewMatch = /^\/api\/samples\/([^/]+)\/review$/.exec(p);
    if (req.method === "POST" && reviewMatch) {
      if (who.role !== "reviewer") return sendError(res, 403, "only_reviewer_can_review");
      const input = await readBody(req);
      const result = await idempotent(req, input, "review", db => {
        const sample = findSample(db, decodeURIComponent(reviewMatch[1]));
        if (!sample) throw httpError(404, "sample_not_found");
        const version = currentVersion(sample);
        if (version.status !== "pending_review") throw httpError(409, "version_not_pending", { status: version.status });

        const decision = input.decision === "approve" ? "approve" : input.decision === "reject" ? "reject" : null;
        if (!decision) throw httpError(400, "decision_required");
        const comment = String(input.comment || "").trim().slice(0, 500);
        if (decision === "reject" && !comment) throw httpError(400, "reject_requires_comment");

        const review = { decision, at: nowIso(), by: who.name, comment };
        if (decision === "approve") {
          version.status = "approved";
          version.review = review;
          audit(db, who.name, "review_approve", { sampleId: sample.id, version: version.version });
        } else {
          // 驳回：旧版本完整冻结（图、尺度、结论快照均不变），另起新版本供重采
          version.status = "rejected";
          version.review = review;
          const now = nowIso();
          sample.versions.push({
            version: version.version + 1,
            status: "collecting",
            createdAt: now,
            createdBy: who.name,
            basedOnRejectedVersion: version.version,
            rejectComment: comment,
            submittedBy: null,
            groups: [],
            photos: [],
            conclusion: null,
            review: null,
            snapshot: null,
          });
          audit(db, who.name, "review_reject", {
            sampleId: sample.id, version: version.version,
            newVersion: version.version + 1, comment,
          });
        }
        return { status: 200, body: { sample: publicSample(sample) } };
      });
      return send(res, result.status, result.body);
    }

    return sendError(res, 404, "not_found");
  } catch (error) {
    if (error.status) return sendError(res, error.status, error.message, error.extra);
    console.error(error);
    sendError(res, 500, "internal_error");
  }
});

function httpError(status, message, extra) {
  const err = new Error(message);
  err.status = status;
  err.extra = extra;
  return err;
}

function summarizeMetrics(m) {
  if (!m) return null;
  return {
    inkPixelCount: m.inkPixelCount, inkRatio: m.inkRatio,
    areaMm2: m.areaMm2 ?? null, blurScore: m.blurScore,
    sharpness: m.sharpness, compactness: m.compactness,
    inkMeanLevel: m.inkMeanLevel, tones: m.tones,
  };
}

// 幂等键 + 写互斥：重复提交/并发请求整体只成功一次。
// 首次成功的响应被缓存；键相同但载荷不同视为冲突。
function idempotent(req, input, scope, fn) {
  const key = String(req.headers["idempotency-key"] || "").trim();
  return store.mutate(async db => {
    if (key) {
      const rec = db.idempotency[key];
      if (rec) {
        if (rec.scope !== scope || rec.fingerprint !== fingerprint(input)) {
          throw httpError(409, "idempotency_key_reused_with_different_payload");
        }
        return { status: rec.status, body: rec.body, replayed: true };
      }
    }
    const result = await fn(db);
    if (key) {
      db.idempotency[key] = {
        scope, fingerprint: fingerprint(input),
        status: result.status, body: result.body, at: nowIso(),
      };
    }
    return result;
  });
}

function fingerprint(input) {
  // 仅按业务载荷指纹，避免 header 差异导致重放失败
  const { photos, ...rest } = input || {};
  const slimPhotos = Array.isArray(photos)
    ? photos.map(ph => ({
        clientName: ph.clientName, paper: ph.paper, lighting: ph.lighting, water: ph.water,
        pxPerMm: ph.pxPerMm, markerPx: ph.markerPx, knownMm: ph.knownMm,
        len: String(ph.dataUrl || "").length,
        head: String(ph.dataUrl || "").slice(0, 64),
      }))
    : photos;
  return JSON.stringify({ ...rest, photos: slimPhotos });
}

async function serveFile(res, path) {
  if (!existsSync(path)) {
    res.writeHead(404); return res.end("not found");
  }
  res.writeHead(200, { "Content-Type": MIME[extname(path)] || "application/octet-stream" });
  res.end(await readFile(path));
}

await store.init();
server.listen(port, () => console.log("试墨图像计量与复核台 listening on http://localhost:" + port + " (data: " + dataDir + ")"));
