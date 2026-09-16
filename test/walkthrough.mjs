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
  if (opts.body) headers["Content-Type"] = "application/json";
  if (opts.role) headers["X-Role"] = opts.role;
  if (opts.name) headers["X-Operator-Name"] = encodeURIComponent(opts.name);
  if (opts.idem) headers["Idempotency-Key"] = opts.idem;
  const res = await fetch((opts.base || BASE) + path, {
    method: opts.method || "GET", headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
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

  section("3.2 反例：姓名↔角色稳定绑定，换角色被拒");
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
  st = (await api("/api/state")).json;
  await stop(srv.child);
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
