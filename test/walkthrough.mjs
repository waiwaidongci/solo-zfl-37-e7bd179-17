// 端到端走查：启动真实 HTTP 服务（临时数据目录 + 一份 v1 旧档），
// 实际跑通 采集 → 异常隔离 → 满3张出结论 → 复核职责分离/并发 → 驳回新版本 →
// 写盘故障回滚 → 重启持久化 → 历史数据可查看。
import { spawn } from "node:child_process";
import { mkdtemp, cp, readFile, writeFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import { sharpSet, blurryPng, blankSheet, garbagePng, fourthPng, fifthPng, lookalikePair, dataUrl } from "./fixtures.mjs";
import { canonicalHash, legacyFingerprint, legacyCanonicalFingerprint, firstNonFinitePath } from "../lib/canonical.js";
import { createHash } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const PORT = Number(process.env.TEST_PORT) || 30000 + Math.floor(Math.random() * 900);
const BASE = `http://127.0.0.1:${PORT}`;
const children = [];
function cleanup() { for (const c of children) { try { c.kill("SIGKILL"); } catch {} } }
process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(130); });
process.on("uncaughtException", err => { console.error(err); cleanup(); process.exit(1); });

let passed = 0, failed = 0;
function check(name, cond, detail = "") {
  if (cond) { passed++; console.log("  ✅", name); }
  else { failed++; console.log("  ❌", name, detail); }
}
function section(t) { console.log("\n=== " + t + " ==="); }

async function api(path, opts = {}) {
  const headers = {};
  if (opts.body || opts.raw !== undefined) headers["Content-Type"] = "application/json";
  if (opts.role) headers["X-Role"] = opts.role;
  if (opts.name) headers["X-Operator-Name"] = encodeURIComponent(opts.name);
  if (opts.idem) headers["Idempotency-Key"] = opts.idem;
  const payload = opts.raw !== undefined ? opts.raw : (opts.body ? JSON.stringify(opts.body) : undefined);
  const res = await fetch((opts.base || BASE) + path, {
    method: opts.method || "GET", headers, body: payload,
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json, res };
}

function entry(pngBuf, extra = {}) {
  return {
    clientName: "photo-" + Math.random().toString(16).slice(2, 8) + ".png",
    dataUrl: dataUrl(pngBuf),
    paper: "净皮宣纸", lighting: "南向自然光", water: "20滴",
    pxPerMm: 5, markerPx: 50, knownMm: 10,
    ...extra,
  };
}

function waitForServer(child, port = PORT, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("server start timeout")), timeoutMs);
    const timer = setInterval(async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/state`);
        if (r.ok) { clearInterval(timer); clearTimeout(t); resolve(); }
      } catch {}
    }, 120);
    child.on("exit", code => { clearInterval(timer); clearTimeout(t); reject(new Error("server exited early: " + code)); });
  });
}

async function startServer(dataDir, opts = {}) {
  const port = opts.port || PORT;
  const child = spawn(process.execPath, [join(root, "server.js")], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, ALLOW_FAULTS: opts.faults ? "1" : "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", d => { logs += d; });
  child.stderr.on("data", d => { logs += d; });
  await waitForServer(child, port);
  children.push(child);
  return { child, port, get logs() { return logs; } };
}

async function main() {
  // ---- 准备临时数据目录，放一份 v1 旧档 ----
  const dataDir = await mkdtemp(join(tmpdir(), "ink-station-"));
  await cp(join(root, "data", "ink-stick-testing.json"), join(dataDir, "ink-stick-testing.json"));
  console.log("临时数据目录:", dataDir);

  section("0. 首次启动：v1 历史数据升级");
  let srv = await startServer(dataDir, { faults: true });
  let st = (await api("/api/state")).json;
  check("数据库版本升级到 v2", st.dbVersion === 2, "got " + st.dbVersion);
  const legacy = st.samples.find(s => s.code === "IS-002");
  check("旧墨锭 IS-002 仍可查看（迁移为留样）", !!legacy, JSON.stringify(st.samples.map(s => s.code)));
  check("旧档保留 v1 已批准版本与试磨记录",
    legacy.versions[0].status === "approved" && Array.isArray(legacy.legacy.logs) && legacy.legacy.logs.length >= 1);
  check("旧档原始文件已备份", existsSync(join(dataDir, "ink-stick-testing.v1-backup.json")));
  const pageRes = await fetch(BASE + "/");
  check("首页可访问", pageRes.status === 200 && (await pageRes.text()).includes("试墨图像计量与复核台"));
  const libRes = await fetch(BASE + "/lib/imaging.js");
  check("浏览器可加载共享计量库", libRes.status === 200);

  section("1. 建档与角色校验");
  const noName = await api("/api/samples", { method: "POST", role: "operator", body: { code: "IS-X" } });
  check("未署名写操作被拒 401", noName.status === 401 && noName.json.error === "identity_required");
  const create = await api("/api/samples", {
    method: "POST", role: "operator", name: "采集员甲", idem: "create-1",
    body: { code: "IS-100", name: "松烟新留样", smokeSource: "黄山松烟", glueRatio: "7.5%", ageYears: 5, storage: "恒湿柜A" },
  });
  check("操作员建档成功 201", create.status === 201, String(create.status));
  const sid = create.json.id;
  const dupCode = await api("/api/samples", {
    method: "POST", role: "operator", name: "采集员甲", idem: "create-2",
    body: { code: "IS-100", name: "重复编号" },
  });
  check("留样编号冲突 409", dupCode.status === 409 && dupCode.json.error === "sample_code_exists");
  const reviewerCollect = await api(`/api/samples/${sid}/photos:batch`, {
    method: "POST", role: "reviewer", name: "复核员乙",
    body: { photos: [entry(sharpSet()[0])] },
  });
  check("复核人不能参与采集 403", reviewerCollect.status === 403 && reviewerCollect.json.error === "reviewer_cannot_collect");

  section("2. 批量采集：正常 + 各类异常，单张失败互不影响");
  const [p1, p2, p3] = sharpSet();
  const batch1Entries = [
    entry(p1),                                   // 有效
    entry(blurryPng()),                          // 模糊
    entry(p1, { clientName: "dup.png" }),        // 与本批第一张重复
    entry(blankSheet()),                         // 未检出墨迹
    entry(garbagePng()),                         // 解码失败
    entry(p2, { pxPerMm: null, knownMm: null }), // 缺标定
    entry(p2, { paper: "" }),                    // 缺分组字段
  ];
  const batch1 = await api(`/api/samples/${sid}/photos:batch`, {
    method: "POST", role: "operator", name: "采集员甲", idem: "batch-1",
    body: { photos: batch1Entries },
  });
  check("整批受理 201（异常图不拖垮批次）", batch1.status === 201, String(batch1.status) + " " + JSON.stringify(batch1.json?.error));
  const reasons = batch1.json.results.map(r => r.invalidReason || "valid");
  check("仅第 1 张有效", batch1.json.results[0].valid === true && batch1.json.validCount === 1, JSON.stringify(reasons));
  check("模糊图被标记 blurry", reasons.includes("blurry"), JSON.stringify(reasons));
  check("重复图被标记 duplicate", reasons.includes("duplicate"));
  check("空白纸标记 no_ink", reasons.includes("no_ink"));
  check("损坏文件标记 decode_failed", reasons.includes("decode_failed"));
  check("缺标定标记 no_scale", reasons.includes("no_scale"));
  check("缺分组标记 missing_group", reasons.includes("missing_group"));

  section("3. 重复提交 / 幂等 / 跨批重复");
  const replay = await api(`/api/samples/${sid}/photos:batch`, {
    method: "POST", role: "operator", name: "采集员甲", idem: "batch-1",
    body: { photos: batch1Entries },
  });
  check("同幂等键原样重放成功且不新增数据", replay.status === 201 && replay.json.validCount === 1);
  const keyClash = await api(`/api/samples/${sid}/photos:batch`, {
    method: "POST", role: "operator", name: "采集员甲", idem: "batch-1",
    body: { photos: [entry(p3)] },
  });
  check("同键不同载荷 409", keyClash.status === 409 && keyClash.json.error.includes("idempotency"));
  const batch2 = await api(`/api/samples/${sid}/photos:batch`, {
    method: "POST", role: "operator", name: "采集员甲", idem: "batch-2",
    body: { photos: [entry(p1)] }, // 不用幂等键重放，靠图像哈希识别
  });
  check("跨批重复提交只计一次成功（图判重复）", batch2.json.results[0].invalidReason === "duplicate" && batch2.json.validCount === 1);

  section("3.1 反例：幂等指纹必须区分完整图片内容");
  const [lookA, lookB] = lookalikePair();
  check("反例构造：两张图等长", lookA.length === lookB.length);
  check("反例构造：开头相同、尾部才不同", lookA.subarray(0, lookA.length - 60).equals(lookB.subarray(0, lookB.length - 60))
    && !lookA.equals(lookB));
  const cFp = await api("/api/samples", {
    method: "POST", role: "operator", name: "采集员丁", idem: "fp-create",
    body: { code: "IS-FP" },
  });
  const sidFp = cFp.json.id;
  const firstLook = await api(`/api/samples/${sidFp}/photos:batch`, {
    method: "POST", role: "operator", name: "采集员丁", idem: "fp-key",
    body: { photos: [entry(lookA, { clientName: "look-a.png" })] },
  });
  check("第一张提交成功并落库", firstLook.status === 201 && firstLook.json.results[0].valid === true);
  const secondLook = await api(`/api/samples/${sidFp}/photos:batch`, {
    method: "POST", role: "operator", name: "采集员丁", idem: "fp-key",
    body: { photos: [entry(lookB, { clientName: "look-b.png" })] }, // 同键、图片尾部不同
  });
  check("同键但图片不同 → 409，不会误当重放", secondLook.status === 409
    && secondLook.json.error.includes("idempotency"), String(secondLook.status));
  st = (await api("/api/state")).json;
  check("第二张未被当作重放而静默丢失（库里仍只有 1 张）",
    st.samples.find(s => s.id === sidFp).versions[0].photos.length === 1);
  const replaySame = await api(`/api/samples/${sidFp}/photos:batch`, {
    method: "POST", role: "operator", name: "采集员丁", idem: "fp-key",
    body: { photos: [entry(lookA, { clientName: "look-a.png" })] },
  });
  check("同键同载荷仍正常重放（且不新增图片）",
    replaySame.status === 201 && st.samples.find(s => s.id === sidFp).versions[0].photos.length === 1);

  section("3.2 规范化指纹：忽略字段排列，保留数组顺序/值类型/图片内容");
  // —— 纯函数级断言 ——
  const payload1 = { x: null, note: "z", photos: [{ clientName: "a", water: "20滴", pxPerMm: 5, dataUrl: "IMG" }] };
  const payloadShuffled = { photos: [{ dataUrl: "IMG", pxPerMm: 5, water: "20滴", clientName: "a" }], note: "z", x: null };
  check("单元：对象成员换序（含嵌套）指纹一致", canonicalHash(payload1) === canonicalHash(payloadShuffled));
  check("单元：数组换序指纹不同", canonicalHash({ photos: [1, 2] }) !== canonicalHash({ photos: [2, 1] }));
  check("单元：值类型保留（数字≠字符串）", canonicalHash({ n: 5 }) !== canonicalHash({ n: "5" }));
  check("单元：值类型保留（null≠对象、true≠1）",
    canonicalHash({ n: null }) !== canonicalHash({ n: {} })
    && canonicalHash({ n: true }) !== canonicalHash({ n: 1 }));
  check("单元：图片内容一个字符变化指纹即变",
    canonicalHash({ photos: [{ dataUrl: "IMG-A" }] }) !== canonicalHash({ photos: [{ dataUrl: "IMG-B" }] }));
  check("单元：旧指纹确实对键序敏感（证明需要兼容双通道）",
    legacyFingerprint(payload1) !== legacyFingerprint(payloadShuffled));

  // —— 字符串边界碰撞反例：含分隔符的字符串不得伪造出别的对象结构 ——
  // 复刻被替换掉的「文本分隔符」规范化算法，用于证明旧碰撞确实存在
  function buggyCanonicalize(value) {
    if (value === null) return "0:";
    const t = typeof value;
    if (t === "string") return "s:" + value;
    if (t === "number") return "n:" + String(value);
    if (t === "boolean") return "b:" + (value ? "1" : "0");
    if (Array.isArray(value)) return "A:[" + value.map(buggyCanonicalize).join(",") + "]";
    return "O:{" + Object.keys(value).sort()
      .map(k => JSON.stringify(k) + "=" + buggyCanonicalize(value[k])).join(",") + "}";
  }
  const buggyHash = v => createHash("sha256").update(buggyCanonicalize(v)).digest("hex");
  const injectString = '1,"b"=n:2'; // 字符串内容里嵌入另一个字段的规范化片段
  const collideX = { a: injectString };
  const collideY = { a: "1", b: 2 };
  check("旧算法复现：注入字符串与真实双字段碰撞",
    buggyCanonicalize(collideX) === buggyCanonicalize(collideY)
    && buggyHash(collideX) === buggyHash(collideY));
  check("新 TLV：同一对载荷不再碰撞", canonicalHash(collideX) !== canonicalHash(collideY));
  // 分隔符字符的全覆盖：逗号/引号/等号/冒号/括号/类型标记
  const weird = 's:1, "k"=n:9 ]} [ { a:b:c ,\n\t\r""""';
  check("单元：含全套分隔符的字符串与伪造结构不碰撞",
    canonicalHash({ a: weird }) !== canonicalHash({ a: "s:1, ", k: 9 })
    && canonicalHash({ a: weird }) !== canonicalHash({ a: weird + "x" }));
  check("单元：分隔符字符串换字段顺序仍相等",
    canonicalHash({ a: weird, z: [1, weird, null] }) === canonicalHash({ z: [1, weird, null], a: weird }));
  check("单元：数字字符串与数字、布尔不碰撞",
    canonicalHash({ a: "5" }) !== canonicalHash({ a: 5 })
    && canonicalHash({ a: "true" }) !== canonicalHash({ a: true })
    && canonicalHash({ a: "null" }) !== canonicalHash({ a: null }));
  check("单元：空串/空数组/空对象可区分",
    new Set([canonicalHash({ a: "" }), canonicalHash({ a: [] }), canonicalHash({ a: {} }), canonicalHash({})]).size === 4);
  // —— 孤立代理码元（lone surrogate）保真：不能都塌成替换字符 U+FFFD ——
  const surr1 = { tag: "a\uD800z" };
  const surr2 = { tag: "a\uD801z" };
  check("单元：不同孤立代理码元（值）指纹不同", canonicalHash(surr1) !== canonicalHash(surr2));
  check("单元：孤立高/低代理、不同位置均区分",
    canonicalHash({ x: "\uD800" }) !== canonicalHash({ x: "\uDC00" })
    && canonicalHash({ x: "x\uD800" }) !== canonicalHash({ x: "\uD800x" })
    && canonicalHash({ ["k\uD800"]: 1 }) !== canonicalHash({ ["k\uD801"]: 1 })); // 键名
  check("单元：普通字符与 emoji 代理对不受影响",
    canonicalHash({ x: "中文" }) !== canonicalHash({ x: "😀" })
    && canonicalHash({ x: "𐀀" }) !== canonicalHash({ x: "𐀁" }));
  check("单元：含代理码元的字符串换字段序仍相等",
    canonicalHash({ a: "\uD800,\":1", z: [1, "\uDCFF", null] })
      === canonicalHash({ z: [1, "\uDCFF", null], a: "\uD800,\":1" }));
  // —— 旧摘要的不安全性（历史事实）：该通道已整体移除，仅保留函数做回归佐证 ——
  check("单元：旧文本摘要对普通 Unicode 换序相等（老记录因此只能原样重放）",
    legacyCanonicalFingerprint({ decision: "approve", comment: "同意，重拍" })
      === legacyCanonicalFingerprint({ comment: "同意，重拍", decision: "approve" }));
  check("单元：旧文本摘要对不同孤立代理碰撞（其不能作为重放依据的原因）",
    legacyCanonicalFingerprint({ c: "x\uD800" })
      === legacyCanonicalFingerprint({ c: "x\uD801" }));
  check("单元：旧文本摘要对分隔符注入碰撞（其不能作为重放依据的原因）",
    legacyCanonicalFingerprint({ a: "1", b: 2 })
      === legacyCanonicalFingerprint({ a: '1,"b"=n:2' }));

  // —— HTTP 反例 1：字段书写顺序不同、业务内容相同 → 视为同载荷重放 ——
  const cCanon = await api("/api/samples", {
    method: "POST", role: "operator", name: "采集员丁", idem: "canon-create", body: { code: "IS-CANON" },
  });
  const sidCanon = cCanon.json.id;
  const canonPhoto = {
    clientName: "a.png", dataUrl: dataUrl(lookA), paper: "净皮宣纸",
    lighting: "南向自然光", water: "20滴", pxPerMm: 5, markerPx: 50, knownMm: 10,
  };
  const canonRaw1 = JSON.stringify({ x: null, note: "整批备注", photos: [canonPhoto] });
  const canonRaw2 = JSON.stringify({
    photos: [{
      knownMm: 10, markerPx: 50, pxPerMm: 5, water: "20滴",
      lighting: "南向自然光", paper: "净皮宣纸", dataUrl: dataUrl(lookA), clientName: "a.png",
    }],
    note: "整批备注", x: null,
  });
  const canonFirst = await api(`/api/samples/${sidCanon}/photos:batch`, {
    method: "POST", role: "operator", name: "采集员丁", idem: "canon-key", raw: canonRaw1,
  });
  check("字段顺序 A 提交成功", canonFirst.status === 201 && canonFirst.json.validCount === 1);
  const canonReplay = await api(`/api/samples/${sidCanon}/photos:batch`, {
    method: "POST", role: "operator", name: "采集员丁", idem: "canon-key", raw: canonRaw2,
  });
  check("反例1：仅调换字段书写顺序 → 仍识别为重放 201", canonReplay.status === 201);
  check("重放不新增图片（仍为 1 张）", canonReplay.json.validCount === 1
    && canonReplay.json.results.length === 1);

  // —— HTTP 反例 2：数组换序（照片业务顺序变化）→ 必须 409 ——
  const cArr = await api("/api/samples", {
    method: "POST", role: "operator", name: "采集员丁", idem: "arr-create", body: { code: "IS-ARR" },
  });
  const sidArr = cArr.json.id;
  const pe2 = entry(p2, { clientName: "e2.png" });
  const pe3 = entry(p3, { clientName: "e3.png" });
  const arrFirst = await api(`/api/samples/${sidArr}/photos:batch`, {
    method: "POST", role: "operator", name: "采集员丁", idem: "arr-key", body: { photos: [pe2, pe3] },
  });
  check("数组顺序 [e2,e3] 提交成功（2 张有效）", arrFirst.status === 201 && arrFirst.json.validCount === 2);
  const arrSwap = await api(`/api/samples/${sidArr}/photos:batch`, {
    method: "POST", role: "operator", name: "采集员丁", idem: "arr-key", body: { photos: [pe3, pe2] },
  });
  check("反例2：照片数组换序 [e3,e2] → 409", arrSwap.status === 409
    && arrSwap.json.error.includes("idempotency"));
  // 业务值变化（水滴量 20滴 → 21滴）即使字段顺序打乱也必须 409
  const valueChanged = await api(`/api/samples/${sidArr}/photos:batch`, {
    method: "POST", role: "operator", name: "采集员丁", idem: "arr-key",
    raw: JSON.stringify({ photos: [{ knownMm: 10, markerPx: 50, pxPerMm: 5, water: "21滴", lighting: pe2.lighting, paper: pe2.paper, dataUrl: pe2.dataUrl, clientName: "e2.png" }, pe3] }),
  });
  check("业务值变化（20滴→21滴）→ 409", valueChanged.status === 409);

  // —— HTTP 反例 3 已在 3.1 覆盖：等长同前缀图片仅尾部不同 → 409 ——
  check("反例3：图片字节真实变化 → 409（见 3.1 lookalike 用例）", secondLook.status === 409);

  // —— HTTP 反例 4：分隔符字符串注入伪造结构，同键第二次不得当重放 ——
  const cInj = await api("/api/samples", {
    method: "POST", role: "operator", name: "采集员丁", idem: "inj-create", body: { code: "IS-INJ" },
  });
  const sidInj = cInj.json.id;
  const sharedPhoto = entry(lookB, { clientName: "inj.png" });
  // 精确碰撞对（与单元级同形态）：A 的 tag 字符串吞掉 B 多出的 z 字段
  const injHonest = { photos: [sharedPhoto], tag: 'x,"z"=s:y' }; // 单 tag，字符串内含伪造片段
  const injForged = { photos: [sharedPhoto], tag: "x", z: "y" }; // 实际多一个 z 字段
  check("旧算法 HTTP 形态确实碰撞（回归基准）",
    buggyCanonicalize(injHonest) === buggyCanonicalize(injForged)
    && buggyHash(injHonest) === buggyHash(injForged));
  const injFirst = await api(`/api/samples/${sidInj}/photos:batch`, {
    method: "POST", role: "operator", name: "采集员丁", idem: "inj-key", body: injHonest,
  });
  check("注入反例：首单提交成功", injFirst.status === 201 && injFirst.json.results[0].valid === true);
  const injSecond = await api(`/api/samples/${sidInj}/photos:batch`, {
    method: "POST", role: "operator", name: "采集员丁", idem: "inj-key", body: injForged,
  });
  check("反例4：字符串含逗号/引号/等号伪造字段 → 409，不当重放", injSecond.status === 409
    && injSecond.json.error.includes("idempotency"), String(injSecond.status) + " " + JSON.stringify(injSecond.json?.error));
  // 含分隔符的真实重放（同样是注入字符串，但字段书写顺序打乱、内容一致）必须仍成功
  const injShuffled = { tag: 'x,"z"=s:y', photos: [Object.fromEntries(Object.entries(sharedPhoto).reverse())] };
  const injReplay = await api(`/api/samples/${sidInj}/photos:batch`, {
    method: "POST", role: "operator", name: "采集员丁", idem: "inj-key", body: injShuffled,
  });
  const injState = (await api("/api/state")).json.samples.find(s => s.id === sidInj);
  check("含分隔符字符串的同内容换序重放 → 201 且不新增图片",
    injReplay.status === 201 && injState.versions[0].photos.length === 1,
    JSON.stringify({ r: injReplay.status, n: injState.versions[0].photos.length }));

  // —— HTTP 反例 5：不同孤立代理码元（值与键名）同键不得当重放 ——
  const cSurr = await api("/api/samples", {
    method: "POST", role: "operator", name: "采集员丁", idem: "surr-create", body: { code: "IS-SURR" },
  });
  const sidSurr = cSurr.json.id;
  const surrPhoto1 = { ...sharedPhoto, clientName: "su-a\uD800.png" };
  const surrPhoto2 = { ...sharedPhoto, clientName: "su-a\uD801.png" };
  const surrFirst = await api(`/api/samples/${sidSurr}/photos:batch`, {
    method: "POST", role: "operator", name: "采集员丁", idem: "surr-key",
    body: { note: "代理码元", photos: [surrPhoto1] },
  });
  check("反例5：含孤立代理码元的值首次提交 201", surrFirst.status === 201);
  const surrSecond = await api(`/api/samples/${sidSurr}/photos:batch`, {
    method: "POST", role: "operator", name: "采集员丁", idem: "surr-key",
    body: { note: "代理码元", photos: [surrPhoto2] }, // 仅代理码元不同
  });
  check("反例5：值中不同孤立代理码元 → 409，不当重放", surrSecond.status === 409
    && surrSecond.json.error.includes("idempotency"), String(surrSecond.status));
  // 原样重放（含孤立代理）仍命中
  const surrReplay = await api(`/api/samples/${sidSurr}/photos:batch`, {
    method: "POST", role: "operator", name: "采集员丁", idem: "surr-key",
    body: { photos: [surrPhoto1], note: "代理码元" }, // 字段顺序也换了
  });
  const surrState = (await api("/api/state")).json.samples.find(s => s.id === sidSurr);
  check("含代理码元的同内容换序重放 → 201 且不新增图片",
    surrReplay.status === 201 && surrState.versions[0].photos.length === 1);
  // 键名中的孤立代理码元差异
  const surrKeyA = await api(`/api/samples/${sidSurr}/photos:batch`, {
    method: "POST", role: "operator", name: "采集员丁", idem: "surr-key2",
    raw: JSON.stringify({ photos: [sharedPhoto], ["note\uD800"]: "k" }),
  });
  const surrKeyB = await api(`/api/samples/${sidSurr}/photos:batch`, {
    method: "POST", role: "operator", name: "采集员丁", idem: "surr-key2",
    raw: JSON.stringify({ photos: [sharedPhoto], ["note\uD801"]: "k" }),
  });
  check("反例5：键名中不同孤立代理码元 → 先 201 后 409",
    surrKeyA.status === 201 && surrKeyB.status === 409,
    JSON.stringify([surrKeyA.status, surrKeyB.status]));


  section("3.3 反例：姓名↔角色稳定绑定，换角色被拒");
  // 新姓名先用复核人身份
  const revFirst = await api(`/api/samples/${sid}/review`, {
    method: "POST", role: "reviewer", name: "临时工戊",
    body: { decision: "approve" },
  });
  // sid 已批准，返回 409 不重要，关键是该姓名已以 reviewer 落库绑定
  check("新姓名首次以复核人身份被系统记录", [409, 200].includes(revFirst.status));
  const sameNameCollect = await api("/api/samples", {
    method: "POST", role: "operator", name: "临时工戊", idem: "role-swap",
    body: { code: "IS-ROLE" },
  });
  check("同一姓名换操作员身份 → 403 identity_role_bound",
    sameNameCollect.status === 403 && sameNameCollect.json.error === "identity_role_bound");
  // 反向：已绑定操作员的姓名不能当复核人（复现报告中的越权路径）
  const jiaAsReviewer = await api(`/api/samples/${sid}/review`, {
    method: "POST", role: "reviewer", name: "采集员甲",
    body: { decision: "approve" },
  });
  check("采集人「采集员甲」切复核人角色 → 403",
    jiaAsReviewer.status === 403 && jiaAsReviewer.json.error === "identity_role_bound");

  section("3.4 非有限 JSON 数字：指纹前拒绝且不写库");
  check("单元：递归检出 Infinity/-Infinity/NaN 的路径",
    firstNonFinitePath({ a: { b: [1, { c: 1e999 }] } }) === "$.a.b[1].c"
    && firstNonFinitePath({ a: [1, -1e999] }) === "$.a[1]"
    && firstNonFinitePath({ a: NaN }) === "$.a" // NaN 无法经标准 JSON 体到达，仅纯函数防御
    && firstNonFinitePath({ ok: -0, tiny: 1e-999, big: 9007199254740993, max: 1e308 }) === null);

  const nonFiniteCases = [
    ["nonfinite-k1", "顶层指数溢出", '{"code":"IS-INF1","ageYears":1e999}'],
    ["nonfinite-k2", "深层负指数溢出", '{"code":"IS-INF2","meta":{"x":[-1e999]}}'],
    ["nonfinite-k3", "数组内指数溢出", '{"code":"IS-INF3","vals":[1,2,1e400]}'],
    ["nonfinite-k4", "负向溢出", '{"code":"IS-INF5","ageYears":-1.7976931348623157e309}'],
  ];
  for (const [idem, label, raw] of nonFiniteCases) {
    const r = await api("/api/samples", {
      method: "POST", role: "operator", name: "采集员丁", idem, raw,
    });
    check(label + " → 400 non_finite_number",
      r.status === 400 && r.json.error === "non_finite_number",
      `${r.status} ${JSON.stringify(r.json.error)}`);
  }
  // 原始体为 -0e999（解析为有限 0）：应被正常接受，证明只拦截非有限值
  const negZeroExp = await api("/api/samples", {
    method: "POST", role: "operator", name: "采集员丁", idem: "nonfinite-negzeroexp",
    raw: '{"code":"IS-INF4","ageYears":-0e999}',
  });
  check("-0e999（解析为有限 0）→ 201", negZeroExp.status === 201 && negZeroExp.json.ageYears === 0,
    `${negZeroExp.status} ${negZeroExp.json.ageYears}`);
  // 非有限请求不得毒化幂等键：同键随后提交一个合法请求必须成功
  const afterNonFinite = await api("/api/samples", {
    method: "POST", role: "operator", name: "采集员丁", idem: "nonfinite-k1",
    body: { code: "IS-AFTER-INF" },
  });
  check("非有限失败后同幂等键的合法请求仍成功（失败未写幂等记录）",
    afterNonFinite.status === 201, String(afterNonFinite.status));
  // 非有限请求不得写入身份绑定：新人以 reviewer 身份发非有限请求（review 端点允许该角色）
  const freshBad = await api(`/api/samples/${sid}/review`, {
    method: "POST", role: "reviewer", name: "超限数庚", idem: "nonfinite-fresh",
    raw: '{"decision":"approve","x":1e999}',
  });
  const freshGood = await api("/api/samples", {
    method: "POST", role: "operator", name: "超限数庚", idem: "nonfinite-fresh-ok",
    body: { code: "IS-FRESH-OK" },
  });
  check("非有限失败不绑定身份（reviewer 失败后同名人可作 operator）",
    freshBad.status === 400 && freshGood.status === 201,
    JSON.stringify([freshBad.status, freshGood.status]));

  // 边界数值：-0、下溢为 0、大整数、最大有限指数均按普通 JSON 数值接受
  const boundary = [
    ["IS-NUM-NEGZERO", { ageYears: -0 }],
    ["IS-NUM-TINY", { ageYears: 1e-999 }],
    ["IS-NUM-BIGINT", { ageYears: 9007199254740993 }],
    ["IS-NUM-MAXFIN", { ageYears: 1e308 }],
  ];
  for (const [code, extra] of boundary) {
    const r = await api("/api/samples", {
      method: "POST", role: "operator", name: "采集员丁", idem: "boundary-" + code,
      body: { code, ...extra },
    });
    check("边界数值被接受：" + code, r.status === 201 && Number.isFinite(r.json.ageYears),
      `${r.status} ${r.json.ageYears}`);
  }

  section("4. 三张有效图 → 自动分组出结论并锁定");
  const batch3 = await api(`/api/samples/${sid}/photos:batch`, {
    method: "POST", role: "operator", name: "采集员甲", idem: "batch-3",
    body: { photos: [entry(p2), entry(p3)] },
  });
  check("补齐后版本进入 pending_review", batch3.json.versionStatus === "pending_review", batch3.json.versionStatus);
  check("有效图计数为 3", batch3.json.validCount === 3);
  check("结论含面积/清晰度/色阶分布",
    batch3.json.conclusion && batch3.json.conclusion.areaMm2Mean > 0
    && batch3.json.conclusion.sharpnessMean > 0
    && Array.isArray(batch3.json.conclusion.toneDistribution));
  check("结论按纸张/光照/水滴量归组",
    batch3.json.conclusion.paper === "净皮宣纸" && batch3.json.conclusion.water === "20滴");
  const locked = await api(`/api/samples/${sid}/photos:batch`, {
    method: "POST", role: "operator", name: "采集员甲", idem: "batch-after-lock",
    body: { photos: [entry(sharpSet()[0])] },
  });
  check("锁定后再上传 409", locked.status === 409 && locked.json.error === "version_locked_for_review");

  // 分组边界：3 张有效但跨组（2+1）不出结论；同组补齐 3 张才出
  const cg = await api("/api/samples", { method: "POST", role: "operator", name: "采集员甲", idem: "create-grp", body: { code: "IS-150" } });
  const sidg = cg.json.id;
  const grpA = { paper: "净皮宣纸", lighting: "南向自然光", water: "20滴" };
  const grpB = { paper: "棉连纸", lighting: "南向自然光", water: "20滴" };
  const split = await api(`/api/samples/${sidg}/photos:batch`, {
    method: "POST", role: "operator", name: "采集员甲", idem: "grp-split",
    body: { photos: [entry(p1, grpA), entry(p2, grpA), entry(p3, grpB)] },
  });
  check("3 张有效但分组 2+1：不出结论、仍采集中",
    split.json.validCount === 3 && split.json.versionStatus === "collecting" && split.json.conclusion === null,
    JSON.stringify({ n: split.json.validCount, st: split.json.versionStatus }));
  const groupTogether = await api(`/api/samples/${sidg}/photos:batch`, {
    method: "POST", role: "operator", name: "采集员甲", idem: "grp-full",
    body: { photos: [entry(fourthPng(), grpB)] },
  });
  check("B 组补到 2 张仍不出结论", groupTogether.json.validCount === 4
    && groupTogether.json.versionStatus === "collecting" && groupTogether.json.conclusion === null);
  const groupFull = await api(`/api/samples/${sidg}/photos:batch`, {
    method: "POST", role: "operator", name: "采集员甲", idem: "grp-full2",
    body: { photos: [entry(fifthPng(), grpB)] },
  });
  check("B 组凑齐 3 张：按 B 组出结论并锁定",
    groupFull.json.versionStatus === "pending_review"
    && groupFull.json.conclusion.paper === "棉连纸"
    && groupFull.json.conclusion.validPhotoCount === 3,
    JSON.stringify(groupFull.json.conclusion));

  section("4.1 反例：采集人不能复核本版，其他复核人可以");
  // 由全新操作员「采集员己」采集一个待复核版本
  const cSoc = await api("/api/samples", {
    method: "POST", role: "operator", name: "采集员己", idem: "soc-create", body: { code: "IS-SOC" },
  });
  const sidSoc = cSoc.json.id;
  const socUp = await api(`/api/samples/${sidSoc}/photos:batch`, {
    method: "POST", role: "operator", name: "采集员己", idem: "soc-up",
    body: { photos: sharpSet().map((b, i) => entry(b, { clientName: `soc-${i}.png` })) },
  });
  check("反例留样 3 张成案", socUp.json.versionStatus === "pending_review");
  // 采集人本人复核：因姓名已绑定 operator，直接被身份绑定拦截
  const selfReview = await api(`/api/samples/${sidSoc}/review`, {
    method: "POST", role: "reviewer", name: "采集员己",
    body: { decision: "approve" },
  });
  check("采集人本人切复核角色 → 403，无法自批",
    selfReview.status === 403 && selfReview.json.error === "identity_role_bound");
  // 用一个先以 reviewer 身份绑定的名字，但把其名字伪造为采集参与者不可能；
  // 这里直接验证独立复核人可正常批准别人的版本
  const otherReview = await api(`/api/samples/${sidSoc}/review`, {
    method: "POST", role: "reviewer", name: "复核员辛", idem: "soc-approve",
    body: { decision: "approve", comment: "独立复核通过" },
  });
  check("非采集人的复核人可以批准", otherReview.status === 200);
  const socAfter = (await api("/api/state")).json.samples.find(s => s.id === sidSoc);
  check("版本记录复核人为独立复核员",
    socAfter.versions[0].review?.by === "复核员辛" && socAfter.versions[0].status === "approved");

  section("5. 复核职责分离与并发：只成功一次");
  const opReview = await api(`/api/samples/${sid}/review`, {
    method: "POST", role: "operator", name: "采集员甲",
    body: { decision: "approve" },
  });
  check("操作员不能复核 403", opReview.status === 403 && opReview.json.error === "only_reviewer_can_review");
  const badDecision = await api(`/api/samples/${sid}/review`, {
    method: "POST", role: "reviewer", name: "复核员乙",
    body: { decision: "rewrite" },
  });
  check("非法复核决定 400", badDecision.status === 400);
  const rejectNoReason = await api(`/api/samples/${sid}/review`, {
    method: "POST", role: "reviewer", name: "复核员乙",
    body: { decision: "reject", comment: "" },
  });
  check("驳回必须填写原因 400", rejectNoReason.status === 400);

  // 并发复核：两个复核人同时批准，只允许一次成功
  const conc = await Promise.all([
    api(`/api/samples/${sid}/review`, { method: "POST", role: "reviewer", name: "复核员乙", idem: "rev-conc-1", body: { decision: "approve" } }),
    api(`/api/samples/${sid}/review`, { method: "POST", role: "reviewer", name: "复核员丙", idem: "rev-conc-2", body: { decision: "approve" } }),
  ]);
  const okCount = conc.filter(r => r.status === 200).length;
  const conflictCount = conc.filter(r => r.status === 409).length;
  check("并发复核恰好一次 200、其余 409", okCount === 1 && conflictCount === 1, conc.map(r => r.status).join(","));
  st = (await api("/api/state")).json;
  let sample = st.samples.find(s => s.id === sid);
  check("版本为已批准，复核人留痕", current(sample).status === "approved" && current(sample).review?.decision === "approve");

  // 批准后不可改
  const approveAgain = await api(`/api/samples/${sid}/review`, {
    method: "POST", role: "reviewer", name: "复核员乙", idem: "rev-again", body: { decision: "approve" },
  });
  check("批准后再复核 409", approveAgain.status === 409);

  // ---- 第二个留样：走驳回 → 新版本 → 快照冻结 ----
  section("6. 驳回生成新版本，旧图/尺度/结论快照不变");
  const c2 = await api("/api/samples", { method: "POST", role: "operator", name: "采集员甲", idem: "create-3", body: { code: "IS-200", name: "油烟留样" } });
  const sid2 = c2.json.id;
  const r1 = await api(`/api/samples/${sid2}/photos:batch`, {
    method: "POST", role: "operator", name: "采集员甲", idem: "b2-1",
    body: { photos: sharpSet().map((b, i) => i < 3 ? entry(b) : null).filter(Boolean) },
  });
  check("留样2三图成案待复核", r1.status === 201 && r1.json.versionStatus === "pending_review");
  st = (await api("/api/state")).json;
  sample = st.samples.find(s => s.id === sid2);
  const v1Snapshot = JSON.parse(JSON.stringify({
    photos: current(sample).photos,
    groups: current(sample).groups,
    conclusion: current(sample).conclusion,
    snapshot: current(sample).snapshot,
  }));
  const reject = await api(`/api/samples/${sid2}/review`, {
    method: "POST", role: "reviewer", name: "复核员乙", idem: "rev-rej",
    body: { decision: "reject", comment: "光照不均，请在标准光源下重拍" },
  });
  check("驳回 200 并生成 v2 采集版本", reject.status === 200);
  st = (await api("/api/state")).json;
  sample = st.samples.find(s => s.id === sid2);
  check("保留两个版本", sample.versions.length === 2);
  const [oldV, newV] = sample.versions;
  check("旧版本为 rejected 且冻结", oldV.status === "rejected" && oldV.conclusion && oldV.snapshot.frozenAt);
  check("新版本为 collecting 且记录驳回原因", newV.status === "collecting" && newV.rejectComment.includes("光照不均"));
  check("旧图、尺度、结论快照不变",
    JSON.stringify({ photos: oldV.photos, groups: oldV.groups, conclusion: oldV.conclusion, snapshot: oldV.snapshot })
      === JSON.stringify(v1Snapshot), "snapshot mismatch");

  // 旧图仍可取回
  const oldPhoto = oldV.photos[0];
  const imgRes = await fetch(`${BASE}/api/samples/${sid2}/photos/${oldPhoto.id}`);
  check("旧版本图片仍可访问", imgRes.status === 200 && imgRes.headers.get("content-type") === "image/png");

  // 跨版本重复：旧图不能在新版本再交一次
  const crossDup = await api(`/api/samples/${sid2}/photos:batch`, {
    method: "POST", role: "operator", name: "采集员甲", idem: "b2-2",
    body: { photos: [entry(sharpSet()[0])] },
  });
  check("跨版本复用旧图判定 duplicate", crossDup.json.results[0].invalidReason === "duplicate");

  section("7. 写盘故障：图片/指标/版本/审计不得部分保存");
  st = (await api("/api/state")).json;
  const sid2v2 = st.samples.find(s => s.id === sid2).versions[1];
  const photosBeforeFault = sid2v2.photos.length; // 上一步跨版本重复的无效图已合法落盘
  const stateSig = JSON.stringify(st.samples.find(s => s.id === sid2));
  const faultOn = await api("/api/testing/fail-next-write", { method: "POST" });
  check("故障注入已开启", faultOn.status === 200);
  const faultBatch = await api(`/api/samples/${sid2}/photos:batch`, {
    method: "POST", role: "operator", name: "采集员甲", idem: "fault-batch",
    body: { photos: [entry(sharpSet()[1])] },
  });
  check("故障时整批返回 500", faultBatch.status === 500);
  st = (await api("/api/state")).json;
  sample = st.samples.find(s => s.id === sid2);
  check("内存已回滚：图片数量与故障前一致",
    current(sample).photos.length === photosBeforeFault,
    `${current(sample).photos.length} != ${photosBeforeFault}`);
  check("内存已回滚：留样状态与故障前完全一致",
    JSON.stringify(sample) === stateSig);
  const auditBefore = (await api("/api/audit")).json.audit.length;
  check("回滚后可立即继续正常写入", (await api("/api/samples", {
    method: "POST", role: "operator", name: "采集员甲", idem: "create-after-fault", body: { code: "IS-300" },
  })).status === 201);
  const auditAfter = (await api("/api/audit")).json.audit;
  check("失败事务未留下审计残影（仅多一条成功建档审计）",
    auditAfter.length === auditBefore + 1 && !auditAfter.some(a => a.detail?.idem === "fault-batch"));
  // 磁盘文件检查：临时文件不应残留，主文件完好
  check("临时文件已清理，主数据文件存在",
    !existsSync(join(dataDir, ".ink-station.tmp")) && existsSync(join(dataDir, "ink-station.json")));
  const onDisk = JSON.parse(await readFile(join(dataDir, "ink-station.json"), "utf8"));
  check("磁盘上不存在失败批次（v2 图片数未增加）",
    onDisk.samples.find(s => s.id === sid2).versions[1].photos.length === photosBeforeFault);

  section("8. 审计完整性");
  const audit = (await api("/api/audit")).json.audit;
  const actions = audit.map(a => a.action);
  check("审计含建档/采集/批准/驳回/迁移",
    ["migrate_v1", "sample_create", "batch_upload", "review_approve", "review_reject"].every(a => actions.includes(a)),
    actions.join(","));
  check("并发复核只留一条批准审计（乙/丙仅一人成功）",
    audit.filter(a => a.action === "review_approve" && a.detail.sampleId === sid).length === 1);
  check("独立复核人的批准同样留痕", audit.some(a => a.action === "review_approve" && a.actor === "复核员辛"));

  // 优雅停服，再冷启动
  section("9. 重启：数据持久化，历史仍可查看");
  // 重启前：为规范化重放与「旧指纹记录」各准备一个留样
  const cR = await api("/api/samples", {
    method: "POST", role: "operator", name: "采集员丁", idem: "restart-canon-create", body: { code: "IS-RC" },
  });
  const sidRC = cR.json.id;
  const rcPhoto = entry(p2, { clientName: "rc.png" });
  const rcRaw1 = JSON.stringify({ note: "重启用", photos: [rcPhoto] });
  const rcRaw2 = JSON.stringify({ photos: [Object.fromEntries(Object.entries(rcPhoto).reverse())], note: "重启用" });
  check("重启前规范化批次提交成功", (await api(`/api/samples/${sidRC}/photos:batch`, {
    method: "POST", role: "operator", name: "采集员丁", idem: "restart-canon-key", raw: rcRaw1,
  })).status === 201);

  const cL = await api("/api/samples", {
    method: "POST", role: "operator", name: "采集员丁", idem: "restart-legacy-create", body: { code: "IS-RL" },
  });
  const sidRL = cL.json.id;
  const legacyPayload = { photos: [entry(p3, { clientName: "rl.png" })] };
  const legacyRaw = JSON.stringify(legacyPayload);

  st = (await api("/api/state")).json;
  await stop(srv.child);

  // 停机注入一条「升级前格式」的幂等记录：只有旧指纹 fingerprint，没有规范化字段
  const diskDb = JSON.parse(await readFile(join(dataDir, "ink-station.json"), "utf8"));
  diskDb.idempotency["restart-legacy-key"] = {
    scope: "batch_upload",
    fingerprint: legacyFingerprint(legacyPayload),
    actor: "采集员丁",
    status: 201,
    body: {
      sampleId: sidRL, version: 1, versionStatus: "collecting",
      validCount: 1, requiredValid: 3, conclusion: null,
      results: [{ clientName: "rl.png", photoId: "P-LEGACYSTUB", valid: true, invalidReason: null, invalidReasonText: "", groupKey: "", metrics: null }],
      legacyStub: true,
    },
    at: "2026-09-16T00:00:00.000Z",
  };
  // 停机植入「三类指纹齐全」的历史记录：安全 TLV、旧文本摘要、原始 JSON。
  // 关键回归：只要原始请求字节相同，就必须允许精确重放，不得因安全摘要字段存在而拒绝。
  const interimPayload = { decision: "approve", comment: "同意，重拍后墨色均匀" };
  const interimRaw = JSON.stringify(interimPayload);
  diskDb.idempotency["restart-interim-key"] = {
    scope: "review",
    fingerprintSafe: canonicalHash(interimPayload),
    fingerprintCanonical: legacyCanonicalFingerprint(interimPayload),
    fingerprintLegacy: legacyFingerprint(interimPayload),
    actor: "复核员壬",
    status: 200,
    body: { interimStub: true },
    at: "2026-09-16T00:00:00.000Z",
  };
  // 含孤立代理码元的中间格式记录（旧摘要下不同码元会碰撞）
  const interimSurrogateA = { decision: "reject", comment: "边缘发虚\uD800" };
  const interimSurrogateRaw = JSON.stringify(interimSurrogateA);
  diskDb.idempotency["restart-interim-surr"] = {
    scope: "review",
    fingerprint: "BROKEN-TEXT-CANONICAL-HASH",
    fingerprintCanonical: legacyCanonicalFingerprint(interimSurrogateA),
    fingerprintLegacy: legacyFingerprint(interimSurrogateA),
    actor: "复核员壬",
    status: 200,
    body: { interimSurrStub: true },
    at: "2026-09-16T00:00:00.000Z",
  };
  // 分隔符注入对照桩：按诚实两字段载荷计算旧摘要，另构造单字段注入载荷，
  // 两者在旧摘要下精确碰撞；移除旧摘要通道后注入载荷必须 409。
  const interimHonest = { a: "1", b: 2 };
  const interimForged = { a: '1,"b"=n:2' };
  check("反例构造：注入载荷与诚实载荷在旧摘要下精确碰撞",
    legacyCanonicalFingerprint(interimHonest) === legacyCanonicalFingerprint(interimForged));
  diskDb.idempotency["restart-interim-inject"] = {
    scope: "review",
    fingerprint: "BROKEN-TEXT-CANONICAL-HASH",
    fingerprintCanonical: legacyCanonicalFingerprint(interimHonest),
    fingerprintLegacy: legacyFingerprint(interimHonest),
    actor: "复核员壬",
    status: 200,
    body: { interimInjectStub: true },
    at: "2026-09-16T00:00:00.000Z",
  };
  // 仅旧文本摘要 + 原始 JSON：没有安全 TLV，字段换序不得被旧摘要放行
  const interimCanonOnly = { decision: "approve", comment: "仅旧摘要记录" };
  const interimCanonOnlyRaw = JSON.stringify(interimCanonOnly);
  diskDb.idempotency["restart-interim-canon-only"] = {
    scope: "review",
    fingerprint: legacyFingerprint(interimCanonOnly),
    fingerprintCanonical: legacyCanonicalFingerprint(interimCanonOnly),
    fingerprintLegacy: legacyFingerprint(interimCanonOnly),
    actor: "复核员壬",
    status: 200,
    body: { interimCanonOnlyStub: true },
    at: "2026-09-16T00:00:00.000Z",
  };
  await writeFile(join(dataDir, "ink-station.json"), JSON.stringify(diskDb));

  srv = await startServer(dataDir, { faults: true });
  const st2 = (await api("/api/state")).json;
  check("重启后留样数量一致", st2.samples.length === st.samples.length, `${st2.samples.length} != ${st.samples.length}`);
  const s100 = st2.samples.find(s => s.code === "IS-100");
  const s200 = st2.samples.find(s => s.code === "IS-200");
  check("IS-100 仍为已批准", current(s100).status === "approved");
  check("IS-200 保留两版本且 v1 冻结/v2 采集",
    s200.versions.length === 2 && s200.versions[0].status === "rejected" && s200.versions[1].status === "collecting");
  const legacy2 = st2.samples.find(s => s.code === "IS-002");
  check("v1 历史数据重启后仍可查看", !!legacy2.legacy && legacy2.legacy.logs.length >= 1);
  const photoStill = await fetch(`${BASE}/api/samples/${s100.id}/photos/${s100.versions[0].photos[0].id}`);
  check("重启后图片仍可取回", photoStill.status === 200);
  // 身份绑定重启后仍生效：采集员甲（operator）重启后仍不能换 reviewer
  const bindingAfterRestart = await api(`/api/samples/${s100.id}/review`, {
    method: "POST", role: "reviewer", name: "采集员甲",
    body: { decision: "approve" },
  });
  check("重启后姓名↔角色绑定仍生效（采集员甲不能变复核人）",
    bindingAfterRestart.status === 403 && bindingAfterRestart.json.error === "identity_role_bound");

  // 重启后：新格式记录字段换序仍可重放
  const rcReplay = await api(`/api/samples/${sidRC}/photos:batch`, {
    method: "POST", role: "operator", name: "采集员丁", idem: "restart-canon-key", raw: rcRaw2,
  });
  check("重启后字段换序的同键重放仍命中（201 且不新增）",
    rcReplay.status === 201 && rcReplay.json.validCount === 1 && !rcReplay.json.legacyStub);
  const rcState = (await api("/api/state")).json.samples.find(s => s.id === sidRC);
  check("重启后重放未重复落库（仍 1 张图）", rcState.versions[0].photos.length === 1);

  // 重启后：只含旧指纹的历史幂等记录——原样请求可识别
  const legacyExact = await api(`/api/samples/${sidRL}/photos:batch`, {
    method: "POST", role: "operator", name: "采集员丁", idem: "restart-legacy-key", raw: legacyRaw,
  });
  check("重启后旧幂等记录原样请求仍可识别（201 回放）",
    legacyExact.status === 201 && legacyExact.json.legacyStub === true);
  // 旧记录换字段顺序：旧指纹不匹配、规范化指纹也没有 → 409
  const legacyShuffledRaw = JSON.stringify({
    photos: [Object.fromEntries(Object.entries(legacyPayload.photos[0]).reverse())],
  });
  const legacyShuffled = await api(`/api/samples/${sidRL}/photos:batch`, {
    method: "POST", role: "operator", name: "采集员丁", idem: "restart-legacy-key", raw: legacyShuffledRaw,
  });
  check("旧格式记录换字段顺序 → 409（旧记录维持严格识别）", legacyShuffled.status === 409);
  const rlState = (await api("/api/state")).json.samples.find(s => s.id === sidRL);
  check("旧记录回放没有真正写入图片", rlState.versions[0].photos.length === 0);

  // 重启后：分隔符注入攻击仍被拦截；含分隔符的合法换序重放仍命中
  const injForgedAfter = await api(`/api/samples/${sidInj}/photos:batch`, {
    method: "POST", role: "operator", name: "采集员丁", idem: "inj-key", body: injForged,
  });
  check("重启后注入碰撞仍 409", injForgedAfter.status === 409);
  const injShuffledAfter = await api(`/api/samples/${sidInj}/photos:batch`, {
    method: "POST", role: "operator", name: "采集员丁", idem: "inj-key", body: injShuffled,
  });
  check("重启后含分隔符的同内容换序重放仍命中", injShuffledAfter.status === 201);

  // 重启后：中间格式老记录只接受原始 JSON 原样重放（旧摘要通道已整体移除）
  const interimExact = await api(`/api/samples/${sidRL}/review`, {
    method: "POST", role: "reviewer", name: "复核员壬", idem: "restart-interim-key", raw: interimRaw,
  });
  check("三类指纹记录原样请求 → 200 回放（安全字段存在不阻断 raw 精确匹配）",
    interimExact.status === 200 && interimExact.json.interimStub === true,
    String(interimExact.status));
  const interimShuffled = await api(`/api/samples/${sidRL}/review`, {
    method: "POST", role: "reviewer", name: "复核员壬", idem: "restart-interim-key",
    raw: JSON.stringify({ comment: "同意，重拍后墨色均匀", decision: "approve" }),
  });
  check("三类指纹记录字段换序 → 200（由安全 TLV 摘要放行，旧文本摘要不参与）",
    interimShuffled.status === 200, String(interimShuffled.status));
  const interimChanged = await api(`/api/samples/${sidRL}/review`, {
    method: "POST", role: "reviewer", name: "复核员壬", idem: "restart-interim-key",
    body: { decision: "reject", comment: "同意，重拍后墨色均匀" },
  });
  check("三类指纹记录内容真实变化 → 409", interimChanged.status === 409);

  // 无安全 TLV 的旧记录：原始 JSON 可精确命中，字段换序不能借旧文本摘要命中
  const canonOnlyExact = await api(`/api/samples/${sidRL}/review`, {
    method: "POST", role: "reviewer", name: "复核员壬", idem: "restart-interim-canon-only", raw: interimCanonOnlyRaw,
  });
  check("仅旧摘要记录原样请求 → 200（原始 JSON 精确命中）",
    canonOnlyExact.status === 200 && canonOnlyExact.json.interimCanonOnlyStub === true);
  const canonOnlyShuffled = await api(`/api/samples/${sidRL}/review`, {
    method: "POST", role: "reviewer", name: "复核员壬", idem: "restart-interim-canon-only",
    raw: JSON.stringify({ comment: "仅旧摘要记录", decision: "approve" }),
  });
  check("仅旧摘要记录字段换序 → 409（旧文本摘要不参与等价判断）",
    canonOnlyShuffled.status === 409, String(canonOnlyShuffled.status));
  // 分隔符注入对照：与诚实载荷旧摘要精确碰撞的伪造载荷，不得被当重放
  const interimInject = await api(`/api/samples/${sidRL}/review`, {
    method: "POST", role: "reviewer", name: "复核员壬", idem: "restart-interim-inject",
    body: interimForged,
  });
  check("分隔符注入借旧摘要碰撞 → 409（不当重放）", interimInject.status === 409);
  // 诚实载荷的原始 JSON 重放仍然命中
  const interimInjectExact = await api(`/api/samples/${sidRL}/review`, {
    method: "POST", role: "reviewer", name: "复核员壬", idem: "restart-interim-inject",
    body: interimHonest,
  });
  check("注入对照桩的诚实原样请求仍 200 回放",
    interimInjectExact.status === 200 && interimInjectExact.json.interimInjectStub === true);

  // 含孤立代理码元的中间格式记录：换序与不同代理码元碰撞均拒绝，仅原样请求可回放
  const surrShuffled = await api(`/api/samples/${sidRL}/review`, {
    method: "POST", role: "reviewer", name: "复核员壬", idem: "restart-interim-surr",
    raw: JSON.stringify({ comment: "边缘发虚\uD800", decision: "reject" }), // 同内容换序
  });
  check("含孤立代理的旧记录换序 → 409", surrShuffled.status === 409);
  const surrOther = await api(`/api/samples/${sidRL}/review`, {
    method: "POST", role: "reviewer", name: "复核员壬", idem: "restart-interim-surr",
    raw: JSON.stringify({ decision: "reject", comment: "边缘发虚\uD801" }), // 不同代理码元：旧摘要会碰撞
  });
  check("不同孤立代理码元借旧摘要碰撞 → 409（拒绝）", surrOther.status === 409);
  // 该记录原始 JSON 指纹通道不受代理影响：原样请求仍可精确回放
  const surrExact = await api(`/api/samples/${sidRL}/review`, {
    method: "POST", role: "reviewer", name: "复核员壬", idem: "restart-interim-surr", raw: interimSurrogateRaw,
  });
  check("含代理旧记录原样请求仍经原始 JSON 通道精确识别", surrExact.status === 200
    && surrExact.json.interimSurrStub === true);

  // 重启后：孤立代理码元差异仍可区分、原样（含字段换序）仍可重放
  const surrAfterDifferent = await api(`/api/samples/${sidSurr}/photos:batch`, {
    method: "POST", role: "operator", name: "采集员丁", idem: "surr-key",
    body: { note: "代理码元", photos: [surrPhoto2] },
  });
  check("重启后不同孤立代理码元仍 409", surrAfterDifferent.status === 409);
  const surrAfterReplay = await api(`/api/samples/${sidSurr}/photos:batch`, {
    method: "POST", role: "operator", name: "采集员丁", idem: "surr-key",
    body: { photos: [surrPhoto1], note: "代理码元" },
  });
  check("重启后含代理码元的同内容换序重放仍 201", surrAfterReplay.status === 201);

  // 重启后：非有限数字仍在进入指纹/业务前被 400 拒绝，不触发版本状态机
  const nonFiniteAfterRestart = await api(`/api/samples/${sidRL}/review`, {
    method: "POST", role: "reviewer", name: "复核员壬", idem: "restart-nonfinite",
    raw: '{"decision":"approve","meta":1e999}',
  });
  check("重启后非有限 JSON 数字 → 400 且非 500",
    nonFiniteAfterRestart.status === 400
    && nonFiniteAfterRestart.json.error === "non_finite_number",
    String(nonFiniteAfterRestart.status));

  await stop(srv.child);
  console.log(`\n走查结果：${passed} 通过，${failed} 失败`);
  if (failed) process.exit(1);
}

function current(sample) { return sample.versions[sample.versions.length - 1]; }
function stop(child) {
  return new Promise(resolve => {
    child.on("exit", resolve);
    child.kill("SIGTERM");
    setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 2000);
  });
}

main().catch(err => { console.error(err); process.exit(1); });
