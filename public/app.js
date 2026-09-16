import { analyzeImage, judge } from "/lib/imaging.js";

const $ = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];

const state = {
  role: localStorage.getItem("ink.role") || "operator",
  name: localStorage.getItem("ink.name") || "",
  samples: [],
  selectedSampleId: localStorage.getItem("ink.sample") || "",
  pending: [], // { uid, file, bitmap, resizedDataUrl, fullW, fullH, paper, lighting, water, knownMm, m1:{x,y}, m2:{x,y}, metrics, preview }
  audit: [],
};

// ---------- API ----------

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (state.name) headers["X-Operator-Name"] = encodeURIComponent(state.name);
  if (state.role) headers["X-Role"] = state.role;
  if (options.body) headers["Content-Type"] = "application/json";
  const res = await fetch(path, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || "请求失败");
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}
const newKey = () => crypto.randomUUID ? crypto.randomUUID() : "k-" + Date.now() + "-" + Math.random().toString(16).slice(2);

// ---------- 身份 / 角色 ----------

$("#opName").value = state.name;
$("#opName").addEventListener("input", e => {
  state.name = e.target.value.trim();
  localStorage.setItem("ink.name", state.name);
});
$$(".role").forEach(btn => btn.addEventListener("click", () => {
  state.role = btn.dataset.role;
  localStorage.setItem("ink.role", state.role);
  renderRoles();
  renderAll();
}));
function renderRoles() {
  $$(".role").forEach(b => b.classList.toggle("active", b.dataset.role === state.role));
}

// ---------- 标签 ----------

$$(".tab").forEach(t => t.addEventListener("click", () => {
  $$(".tab").forEach(x => x.classList.toggle("active", x === t));
  $$(".tabpanel").forEach(p => p.classList.toggle("active", p.id === "tab-" + t.dataset.tab));
  if (t.dataset.tab === "review") renderReview();
  if (t.dataset.tab === "archive") renderArchive();
  if (t.dataset.tab === "audit") loadAudit();
}));

// ---------- 数据加载 ----------

async function loadState() {
  const data = await api("/api/state");
  state.samples = data.samples;
  if (!state.samples.some(s => s.id === state.selectedSampleId)) {
    state.selectedSampleId = state.samples[0]?.id || "";
  }
  localStorage.setItem("ink.sample", state.selectedSampleId);
}
function currentSample() { return state.samples.find(s => s.id === state.selectedSampleId) || null; }
function currentVersion(sample = currentSample()) { return sample ? sample.versions[sample.versions.length - 1] : null; }

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function statusLabel(st) {
  return { collecting: "采集中", pending_review: "待复核", approved: "已批准", rejected: "已驳回" }[st] || st;
}

// ---------- 采集：留样选择/建档 ----------

function renderSampleSelect() {
  const sel = $("#sampleSelect");
  sel.innerHTML = state.samples.map(s => {
    const v = currentVersion(s);
    return `<option value="${s.id}" ${s.id === state.selectedSampleId ? "selected" : ""}>${esc(s.code)} · ${esc(s.name)}（v${v.version} ${statusLabel(v.status)}）</option>`;
  }).join("");
  renderVersionHint();
}
$("#sampleSelect").addEventListener("change", async e => {
  state.selectedSampleId = e.target.value;
  localStorage.setItem("ink.sample", state.selectedSampleId);
  renderVersionHint();
});
$("#refreshBtn").addEventListener("click", refreshAll);
$("#newSampleBtn").addEventListener("click", () => $("#newSampleBox").classList.toggle("hidden"));
$("#newSampleBox").querySelector("#nsSubmit").addEventListener("click", async () => {
  const body = {
    code: $("#nsCode").value.trim(), name: $("#nsName").value.trim(),
    smokeSource: $("#nsSource").value.trim(), glueRatio: $("#nsGlue").value.trim(),
    ageYears: $("#nsAge").value, storage: $("#nsStorage").value.trim(),
  };
  if (!body.code) return alert("请填写留样编号");
  try {
    const created = await api("/api/samples", { method: "POST", headers: { "Idempotency-Key": newKey() }, body: JSON.stringify(body) });
    $("#newSampleBox").querySelectorAll("input").forEach(i => { i.value = ""; });
    $("#newSampleBox").classList.add("hidden");
    await refreshAll();
    // 建档后立即切到新留样，避免直接上传写错到旧样本
    if (created?.id) {
      state.selectedSampleId = created.id;
      localStorage.setItem("ink.sample", created.id);
      renderSampleSelect();
      renderVersionHint();
    }
  } catch (err) { alert("建档失败：" + friendly(err)); }
});
function renderVersionHint() {
  const s = currentSample();
  const v = s ? currentVersion(s) : null;
  const hint = $("#versionHint");
  if (!s) { hint.innerHTML = `<span class="pill rejected">无留样，请先建档</span>`; return; }
  const valid = v.photos.filter(p => p.valid).length;
  let msg = `<span class="pill ${v.status}">v${v.version} · ${statusLabel(v.status)}</span>
    有效图 <b>${valid}</b> / 3`;
  if (v.status === "pending_review") msg += `　<span class="pill pending_review">已锁定，等待复核；驳回后自动开新版本</span>`;
  if (v.status === "approved") msg += `　<span class="pill approved">结论已批准</span>`;
  if (v.rejectComment) msg += `<br><span class="muted">上一版驳回原因：${esc(v.rejectComment)}</span>`;
  hint.innerHTML = msg;
}

// ---------- 采集：图片载入、本机预检、标定 ----------

$("#fileInput").addEventListener("change", async e => {
  for (const file of [...e.target.files]) await addPending(file);
  e.target.value = "";
});

async function addPending(file) {
  const uid = newKey();
  const item = {
    uid, file,
    paper: $("#defPaper").value.trim(), lighting: $("#defLight").value.trim(),
    water: $("#defWater").value.trim(), knownMm: $("#defKnownMm").value,
    m1: { x: 0.2, y: 0.8 }, m2: { x: 0.8, y: 0.8 },
    preview: null, metrics: null,
  };
  state.pending.push(item);
  try {
    const bitmap = await loadBitmap(file);
    item.bitmap = bitmap;
    const canvas = await downscale(bitmap, 800);
    item.fullW = canvas.width; item.fullH = canvas.height;
    item.resizedDataUrl = canvas.toDataURL("image/png");
    await runPreview(item);
  } catch (err) {
    item.preview = { error: "本机解码失败：" + err.message };
  }
  renderPending();
}

function loadBitmap(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("无法读取该图像"));
    img.src = URL.createObjectURL(file);
  });
}
function downscale(img, maxSide) {
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth || img.width, img.naturalHeight || img.height));
  const w = Math.max(1, Math.round((img.naturalWidth || img.width) * scale));
  const h = Math.max(1, Math.round((img.naturalHeight || img.height) * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  return canvas;
}

async function runPreview(item) {
  if (!item.resizedDataUrl) return;
  const image = await decodeDataUrl(item.resizedDataUrl, item.fullW, item.fullH);
  const distMm = Number(item.knownMm);
  const dPx = markerDistPx(item);
  const pxPerMm = distMm > 0 ? dPx / distMm : null;
  item.metrics = analyzeImage(image, pxPerMm ? { pxPerMm } : null);
  item.pxPerMm = pxPerMm;
  const verdict = judge(item.metrics, {
    calibrated: pxPerMm > 0,
    existingHashes: existingHashesAcrossHistory(),
  });
  item.preview = { ...verdict, pxPerMm };
}

async function decodeDataUrl(dataUrl, w, h) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => {
      const c = document.createElement("canvas");
      c.width = w; c.height = h;
      const ctx = c.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(im, 0, 0, w, h);
      resolve({ width: w, height: h, rgba: ctx.getImageData(0, 0, w, h).data });
    };
    im.onerror = () => reject(new Error("decode"));
    im.src = dataUrl;
  });
}
function markerDistPx(item) {
  return Math.hypot((item.m2.x - item.m1.x) * item.fullW, (item.m2.y - item.m1.y) * item.fullH);
}
function existingHashesAcrossHistory() {
  const s = currentSample();
  if (!s) return [];
  const v = currentVersion(s);
  const out = [];
  for (const ver of s.versions) {
    for (const p of ver.photos) {
      if (!p.hash) continue;
      // 与服务端一致：历史版本全查；当前版本只对已判定有效的图查重
      if (ver === v) { if (p.valid) out.push(BigInt("0x" + p.hash)); }
      else out.push(BigInt("0x" + p.hash));
    }
  }
  return out;
}

$("#applyDefaults").addEventListener("click", async () => {
  for (const item of state.pending) {
    item.paper = $("#defPaper").value.trim();
    item.lighting = $("#defLight").value.trim();
    item.water = $("#defWater").value.trim();
    item.knownMm = $("#defKnownMm").value;
    await runPreview(item).catch(() => {});
  }
  renderPending();
});
$("#clearBatch").addEventListener("click", () => { state.pending = []; renderPending(); });

function tonesBinsHtml(tones) {
  if (!tones) return "";
  return `<div class="tones">${tones.map((v, i) => {
    const gray = Math.round((1 - i / (tones.length - 1)) * 235 + 20);
    const h = 4 + Math.sqrt(v) * 160;
    return `<span title="阶${i} 占比${(v * 100).toFixed(1)}%" style="flex:0 0 auto;width:${Math.max(1, h / 10)}px;background:rgb(${gray},${gray},${gray})"></span>`;
  }).join("")}</div>`;
}

function renderPending() {
  const box = $("#pendingList");
  box.innerHTML = state.pending.map(item => {
    const m = item.metrics;
    const pv = item.preview;
    let verdictHtml = "";
    if (pv?.error) verdictHtml = `<span class="pill invalid">${esc(pv.error)}</span>`;
    else if (m && pv) {
      verdictHtml = pv.valid
        ? `<span class="pill valid">本机预检：有效</span>`
        : `<span class="pill invalid">预检无效：${esc(pv.reasonText)}</span>`;
    }
    const area = m?.areaMm2 != null ? m.areaMm2.toFixed(1) + " mm²" : "未标定";
    return `<article class="card pending" data-uid="${item.uid}">
      <div class="thumb-wrap">
        <canvas class="thumb" data-uid="${item.uid}" width="130" height="130"></canvas>
        <svg class="markers" viewBox="0 0 130 130" data-uid="${item.uid}">
          <line x1="${item.m1.x * 130}" y1="${item.m1.y * 130}" x2="${item.m2.x * 130}" y2="${item.m2.y * 130}" stroke="#c0392b" stroke-width="2"/>
          <circle class="mk" data-which="m1" data-uid="${item.uid}" cx="${item.m1.x * 130}" cy="${item.m1.y * 130}" r="7" fill="#c0392b" style="pointer-events:auto;cursor:grab"/>
          <circle class="mk" data-which="m2" data-uid="${item.uid}" cx="${item.m2.x * 130}" cy="${item.m2.y * 130}" r="7" fill="#c0392b" style="pointer-events:auto;cursor:grab"/>
        </svg>
      </div>
      <div>
        <input class="mini" placeholder="纸张" value="${esc(item.paper)}" data-field="paper" data-uid="${item.uid}">
        <input class="mini" placeholder="光照" value="${esc(item.lighting)}" data-field="lighting" data-uid="${item.uid}">
        <input class="mini" placeholder="水滴量" value="${esc(item.water)}" data-field="water" data-uid="${item.uid}">
        <input class="mini" type="number" placeholder="标线长度 mm" value="${esc(item.knownMm || "")}" data-field="knownMm" data-uid="${item.uid}" inputmode="decimal">
        <div class="metric-line">${esc(item.file.name)} · ${item.fullW || "?"}×${item.fullH || "?"}</div>
        ${verdictHtml}
        ${m ? `<div class="metric-line">扩散面积 <b>${area}</b> · 边缘清晰度 ${m.sharpness.toFixed(1)} · 模糊分 ${m.blurScore.toFixed(1)}</div>
          <div class="metric-line">墨色均值 ${m.inkMeanLevel.toFixed(0)}（0黑/255亮）· 墨占比 ${(m.inkRatio * 100).toFixed(1)}%</div>
          ${tonesBinsHtml(m.tones)}` : ""}
        <button class="ghost" data-remove="${item.uid}" type="button">移除</button>
      </div>
    </article>`;
  }).join("");

  // 画缩略图
  for (const item of state.pending) {
    const cv = box.querySelector(`canvas[data-uid="${item.uid}"]`);
    if (cv && item.bitmap) {
      const ctx = cv.getContext("2d");
      ctx.clearRect(0, 0, 130, 130);
      fitDraw(ctx, item.bitmap, 130, 130);
    }
  }
  bindPendingEvents(box);
}

function fitDraw(ctx, img, W, H) {
  const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
  const s = Math.min(W / iw, H / ih);
  const w = iw * s, h = ih * s;
  ctx.fillStyle = "#f6f8f4"; ctx.fillRect(0, 0, W, H);
  ctx.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
}

function bindPendingEvents(box) {
  box.querySelectorAll("[data-remove]").forEach(b => b.addEventListener("click", () => {
    state.pending = state.pending.filter(i => i.uid !== b.dataset.remove);
    renderPending();
  }));
  box.querySelectorAll("input[data-field]").forEach(inp => inp.addEventListener("change", async () => {
    const item = state.pending.find(i => i.uid === inp.dataset.uid);
    if (!item) return;
    item[inp.dataset.field] = inp.value;
    if (inp.dataset.field === "knownMm") await runPreview(item).catch(() => {});
    renderPending();
  }));
  // 拖标定端点（鼠标 + 触摸）
  box.querySelectorAll("svg.markers").forEach(svg => {
    const uid = svg.dataset.uid;
    svg.querySelectorAll("circle.mk").forEach(c => {
      const move = async ev => {
        ev.preventDefault();
        const item = state.pending.find(i => i.uid === uid);
        if (!item) return;
        const rect = svg.getBoundingClientRect();
        const p = ev.touches ? ev.touches[0] : ev;
        const x = Math.min(1, Math.max(0, (p.clientX - rect.left) / rect.width));
        const y = Math.min(1, Math.max(0, (p.clientY - rect.top) / rect.height));
        item[c.dataset.which] = { x, y };
        await runPreview(item).catch(() => {});
        renderPending();
      };
      const start = ev => {
        ev.preventDefault();
        const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
        window.addEventListener("pointermove", move, { passive: false });
        window.addEventListener("pointerup", up);
      };
      c.addEventListener("pointerdown", start);
    });
  });
}

// ---------- 提交整批 ----------

$("#submitBatch").addEventListener("click", async () => {
  const s = currentSample();
  if (!s) return alert("请先选择或新建留样");
  const v = currentVersion(s);
  if (!state.name) return alert("请先在右上角填写姓名");
  if (state.role !== "operator") return alert("当前角色是复核人，不能参与采集，请切换为操作员");
  if (v.status !== "collecting") return alert("当前版本为「" + statusLabel(v.status) + "」，不能继续上传");
  if (!state.pending.length) return alert("请先选择照片");

  const photos = [];
  for (const item of state.pending) {
    photos.push({
      clientName: item.file.name,
      dataUrl: item.resizedDataUrl,
      paper: item.paper, lighting: item.lighting, water: item.water,
      pxPerMm: item.pxPerMm || null,
      markerPx: item.pxPerMm && item.knownMm ? Math.round(markerDistPx(item)) : null,
      knownMm: item.pxPerMm && item.knownMm ? Number(item.knownMm) : null,
    });
  }
  const btn = $("#submitBatch");
  btn.disabled = true;
  try {
    const data = await api(`/api/samples/${encodeURIComponent(s.id)}/photos:batch`, {
      method: "POST",
      headers: { "Idempotency-Key": newKey() },
      body: JSON.stringify({ photos }),
    });
    renderBatchResult(data);
    state.pending = [];
    renderPending();
    await refreshAll();
  } catch (err) {
    alert("整批提交失败（未保存任何内容）：" + friendly(err));
  } finally {
    btn.disabled = false;
  }
});

function renderBatchResult(data) {
  const box = $("#batchResult");
  box.classList.remove("hidden");
  const rows = data.results.map(r => `<div class="result-${r.valid ? "ok" : "bad"}" style="padding:6px 0;border-bottom:1px dashed var(--line)">
    <b>${esc(r.clientName || "(未命名)")}</b>
    ${r.valid ? `<span class="pill valid">有效</span>` : `<span class="pill invalid">无效：${esc(r.invalidReasonText || r.invalidReason)}</span>`}
    ${r.metrics ? `<div class="muted">面积 ${r.metrics.areaMm2 ?? "—"} mm² · 清晰度 ${r.metrics.sharpness?.toFixed?.(1) ?? "—"} · 模糊分 ${r.metrics.blurScore?.toFixed?.(1) ?? "—"}</div>` : ""}
  </div>`).join("");
  let head = `<h2>本批结果：有效 ${data.results.filter(r => r.valid).length} / 共 ${data.results.length} 张</h2>
    <div class="muted">该版本累计有效 ${data.validCount} / ${data.requiredValid}，状态：${statusLabel(data.versionStatus)}</div>`;
  if (data.conclusion) {
    const c = data.conclusion;
    head += `<div class="panel" style="margin-top:10px;background:#f7f9f4"><b>已达到 3 张有效图，自动生成复核结论快照</b>
      <dl class="kv">
        <dt>归组</dt><dd>${esc(c.paper)} / ${esc(c.lighting)} / ${esc(c.water)}（${c.validPhotoCount} 张）</dd>
        <dt>平均扩散面积</dt><dd>${c.areaMm2Mean} mm²（变异系数 ${(c.areaMm2Cv * 100).toFixed(1)}%）</dd>
        <dt>平均边缘清晰度</dt><dd>${c.sharpnessMean}</dd>
        <dt>模糊评分均值</dt><dd>${c.blurScoreMean}</dd>
        <dt>墨色平均阶</dt><dd>${c.inkMeanLevel}</dd>
      </dl>${tonesBinsHtml(c.toneDistribution)}</div>`;
  }
  box.innerHTML = head + rows;
}

function friendly(err) {
  const map = {
    identity_required: "缺少姓名",
    role_required: "缺少角色",
    reviewer_cannot_collect: "复核人不能参与采集",
    only_reviewer_can_review: "只有复核人可以复核",
    version_locked_for_review: "版本已锁定待复核，不能再上传",
    version_approved_open_new: "版本已批准",
    idempotency_key_reused_with_different_payload: "幂等键被不同请求复用",
    sample_code_exists: "留样编号已存在",
    payload_too_large: "批次过大，请减少张数",
    identity_role_bound: "该姓名已绑定另一角色，请使用原角色或更换姓名",
    reviewer_is_collector: "采集人不能复核自己参与采集的版本",
  };
  return map[err.message] || err.message + (err.data?.hint ? `（${err.data.hint}）` : "");
}

// ---------- 复核 ----------

function renderReview() {
  const list = $("#reviewList");
  const hint = $("#reviewRoleHint");
  if (state.role !== "reviewer") {
    hint.classList.remove("hidden");
    hint.innerHTML = `<span class="pill invalid">当前是操作员身份。为保证职责分离，复核操作请在右上角切换为「复核人」。</span>`;
  } else {
    hint.classList.add("hidden");
  }
  const pending = state.samples.filter(s => currentVersion(s).status === "pending_review");
  if (!pending.length) {
    list.innerHTML = `<div class="panel muted">暂无待复核版本。</div>`;
    return;
  }
  list.innerHTML = pending.map(s => {
    const v = currentVersion(s);
    const c = v.conclusion;
    const photos = v.photos;
    return `<article class="card" data-review="${s.id}">
      <h3>${esc(s.code)} · ${esc(s.name)} <span class="pill pending_review">v${v.version} 待复核</span></h3>
      <div class="muted">提交人：${esc(v.submittedBy || v.createdBy)} · 图片 ${photos.length} 张（有效 ${photos.filter(p => p.valid).length}）</div>
      ${c ? `<dl class="kv">
        <dt>归组</dt><dd>${esc(c.paper)} / ${esc(c.lighting)} / ${esc(c.water)}（${c.validPhotoCount} 张有效）</dd>
        <dt>平均扩散面积</dt><dd>${c.areaMm2Mean} mm²（CV ${(c.areaMm2Cv * 100).toFixed(1)}%）</dd>
        <dt>边缘清晰度</dt><dd>${c.sharpnessMean}</dd>
        <dt>墨色平均阶</dt><dd>${c.inkMeanLevel}</dd>
      </dl>${tonesBinsHtml(c.toneDistribution)}` : ""}
      <div class="photo-grid">${photos.map(p =>
        `<div><img src="/api/samples/${encodeURIComponent(s.id)}/photos/${p.id}" loading="lazy" alt="${esc(p.clientName)}">
        <div class="muted">${p.valid ? "有效" : "无效：" + esc(p.invalidReasonText || p.invalidReason)}</div></div>`).join("")}</div>
      <div class="row" style="margin-top:10px">
        <button data-decision="approve" data-sample="${s.id}" class="primary" ${state.role !== "reviewer" ? "disabled" : ""}>批准结论</button>
        <textarea data-comment="${s.id}" placeholder="驳回需填写原因（将冻结本版并生成新版本）"></textarea>
        <button data-decision="reject" data-sample="${s.id}" class="danger" ${state.role !== "reviewer" ? "disabled" : ""}>驳回</button>
      </div>
    </article>`;
  }).join("");

  list.querySelectorAll("[data-decision]").forEach(btn => btn.addEventListener("click", async () => {
    const sid = btn.dataset.sample;
    const comment = list.querySelector(`[data-comment="${sid}"]`).value.trim();
    const decision = btn.dataset.decision;
    if (decision === "reject" && !comment) return alert("驳回必须填写原因");
    if (!confirm(decision === "approve" ? "确认批准该结论？批准后版本冻结。" : "确认驳回？将生成新版本供重新采集。")) return;
    try {
      await api(`/api/samples/${encodeURIComponent(sid)}/review`, {
        method: "POST",
        headers: { "Idempotency-Key": newKey() },
        body: JSON.stringify({ decision, comment }),
      });
      await refreshAll();
    } catch (err) {
      alert("复核失败：" + friendly(err));
    }
  }));
}

// ---------- 档案 ----------

function renderArchive() {
  const q = ($("#archiveSearch").value || "").trim().toLowerCase();
  const list = $("#archiveList");
  const samples = state.samples.filter(s => !q || JSON.stringify({ c: s.code, n: s.name, sm: s.smokeSource }).toLowerCase().includes(q));
  list.innerHTML = samples.map(s => {
    const blocks = s.versions.map(v => {
      const c = v.conclusion;
      const invalid = v.photos.filter(p => !p.valid);
      return `<div class="version-block">
        <b>v${v.version}</b> <span class="pill ${v.status}">${statusLabel(v.status)}</span>
        <span class="muted">${v.createdAt.replace("T", " ").slice(0, 19)}</span>
        ${v.review ? `<div class="muted">复核：${v.review.decision === "approve" ? "批准" : "驳回"} by ${esc(v.review.by)}${v.review.comment ? " — " + esc(v.review.comment) : ""}</div>` : ""}
        ${c ? `<dl class="kv">
          <dt>归组</dt><dd>${esc(c.paper)} / ${esc(c.lighting)} / ${esc(c.water)}（${c.validPhotoCount} 张）</dd>
          <dt>面积</dt><dd>${c.areaMm2Mean} mm²（CV ${(c.areaMm2Cv * 100).toFixed(1)}%） · 清晰度 ${c.sharpnessMean} · 墨阶 ${c.inkMeanLevel}</dd>
        </dl>` : `<div class="muted">${v.photos.length ? "有效图不足 3 张，未生成结论" : "本版本无图片"}</div>`}
        ${v.photos.length ? `<div class="photo-grid">${v.photos.map(p =>
          `<div><img src="/api/samples/${encodeURIComponent(s.id)}/photos/${p.id}" loading="lazy">
          <div class="muted">${p.valid ? "有效" : "无效：" + esc(p.invalidReasonText || p.invalidReason)}</div></div>`).join("")}</div>` : ""}
        ${v.snapshot?.note ? `<div class="muted">${esc(v.snapshot.note)}</div>` : ""}
      </div>`;
    }).join("");
    return `<article class="card">
      <h3>${esc(s.code)} · ${esc(s.name)} <span class="pill ${currentVersion(s).status}">当前 ${statusLabel(currentVersion(s).status)}</span></h3>
      <div class="muted">${esc(s.smokeSource)} · 胶 ${esc(s.glueRatio)} · 陈 ${s.ageYears ?? "—"} 年 · ${esc(s.storage)}</div>
      ${blocks}
      ${s.legacy ? `<details style="margin-top:8px"><summary class="muted">历史升级数据（v1 墨锭试磨室）</summary>
        <div class="muted">旧状态：${esc(s.legacy.status)}</div>
        ${(s.legacy.logs || []).map(l => `<div class="muted">${esc(l.at)} ${esc(l.step)}：${esc(l.note)}</div>`).join("")}
      </details>` : ""}
    </article>`;
  }).join("") || `<div class="panel muted">没有匹配的留样</div>`;
}
$("#archiveSearch").addEventListener("input", renderArchive);

// ---------- 审计 ----------

async function loadAudit() {
  const data = await api("/api/audit");
  state.audit = data.audit;
  const labels = {
    sample_create: "新建留样", batch_upload: "批量采集", review_approve: "批准结论",
    review_reject: "驳回并开新版本", migrate_v1: "历史数据升级",
  };
  $("#auditList").innerHTML = state.audit.map(a => `<div class="audit-item">
    <time>${a.at.replace("T", " ").slice(0, 19)}</time>
    <b>${esc(labels[a.action] || a.action)}</b> · ${esc(a.actor)}
    <span class="muted">${esc(JSON.stringify(a.detail))}</span>
  </div>`).join("") || `<div class="muted">暂无审计记录</div>`;
}

// ---------- 启动 ----------

async function refreshAll() {
  await loadState();
  renderSampleSelect();
  renderVersionHint();
  if ($("#tab-review").classList.contains("active")) renderReview();
  if ($("#tab-archive").classList.contains("active")) renderArchive();
}
renderRoles();
refreshAll().catch(err => alert("加载失败：" + err.message));
