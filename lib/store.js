// 事务化 JSON 存储：v1 数据迁移、进程内写互斥、临时文件 + rename 原子落盘、
// 写盘失败时回滚内存快照。图片(base64)、指标、版本、审计在同一 JSON 里同生共死。
import { mkdir, readFile, writeFile, rename, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

const DB_VERSION = 2;

const seedSamples = [
  {
    id: "S-0001",
    code: "IS-001",
    name: "黄山松烟留样",
    smokeSource: "黄山松烟",
    glueRatio: "7.5%",
    ageYears: 8,
    storage: "恒湿柜B",
    createdAt: "2026-06-11T00:00:00.000Z",
    versions: [
      {
        version: 1,
        status: "approved",
        createdAt: "2026-06-11T00:00:00.000Z",
        createdBy: "历史导入",
        submittedBy: "历史导入",
        groups: [],
        photos: [],
        conclusion: null,
        review: { decision: "approved", at: "2026-06-11T00:00:00.000Z", by: "历史导入", comment: "试磨评分 86 分（历史数据导入）" },
        snapshot: { note: "由墨锭试磨室 v1 历史数据升级，无图像档案" },
      },
    ],
    legacy: {
      status: "已试磨",
      logs: [{ at: "2026-06-11", step: "试磨", note: "宣纸20滴水，出墨快，评分86", score: 86 }],
    },
  },
];

export class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.dbPath = join(dataDir, "ink-station.json");
    this.legacyPath = join(dataDir, "ink-stick-testing.json");
    this.tmpPath = join(dataDir, ".ink-station.tmp");
    this.chain = Promise.resolve();
    this.db = null;
    // 写盘故障注入：设置后下一次落盘会失败
    this.failNextWrite = false;
  }

  async init() {
    await mkdir(this.dataDir, { recursive: true });
    if (existsSync(this.dbPath)) {
      this.db = JSON.parse(await readFile(this.dbPath, "utf8"));
      this.db.audit ||= [];
      this.db.idempotency ||= {};
      this.db.identities ||= {}; // 旧 v2 库首次升级时补身份表
      return;
    }
    if (existsSync(this.legacyPath)) {
      const legacy = JSON.parse(await readFile(this.legacyPath, "utf8"));
      await copyFile(this.legacyPath, join(this.dataDir, "ink-stick-testing.v1-backup.json")).catch(() => {});
      this.db = migrate(legacy);
    } else {
      this.db = { dbVersion: DB_VERSION, samples: seedSamples, idempotency: {}, identities: {}, audit: [] };
    }
    // 初次建库也要原子落盘；失败直接抛出
    await this.#persist();
  }

  // 串行化所有写事务；返回值原样透传，异常透传
  async mutate(fn, meta) {
    const run = this.chain.then(async () => {
      const snapshot = JSON.stringify(this.db);
      try {
        const result = await fn(this.db);
        await this.#persist();
        return result;
      } catch (err) {
        this.db = JSON.parse(snapshot);
        throw err;
      }
    });
    // 保证链不因单次成功/失败断裂
    this.chain = run.then(() => {}, () => {});
    return run;
  }

  async #persist() {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      const err = new Error("injected_disk_failure");
      err.code = "ENOSPC";
      throw err;
    }
    await writeFile(this.tmpPath, JSON.stringify(this.db));
    await rename(this.tmpPath, this.dbPath);
  }
}

export function nowIso() { return new Date().toISOString(); }
export function newId(prefix) { return prefix + "-" + Date.now().toString(36) + randomBytes(3).toString("hex"); }

export function groupKeyOf({ paper, lighting, water }) {
  return [paper, lighting, water].map(normalizeKey).join("|");
}
function normalizeKey(s) {
  return String(s == null ? "" : s).trim().toLowerCase().replace(/\s+/g, "");
}

// 迁移旧版墨锭台账：每个墨锭转为一个留样，旧记录收进 legacy，页面仍可查看
function migrate(legacy) {
  const samples = [];
  for (const [i, it] of (legacy.items || []).entries()) {
    const logs = it.logs || [];
    const score = logs.filter(l => typeof l.score === "number").map(l => l.score).sort((a, b) => b - a)[0];
    const sample = {
      id: "S-" + String(i + 1).padStart(4, "0"),
      code: it.code || "IS-LEGACY-" + (i + 1),
      name: (it.smokeSource || "旧档墨锭") + "留样",
      smokeSource: it.smokeSource || "",
      glueRatio: it.glueRatio || "",
      ageYears: it.ageYears ?? null,
      storage: it.storage || "",
      createdAt: "2026-06-01T00:00:00.000Z",
      versions: [
        {
          version: 1,
          status: "approved",
          createdAt: "2026-06-01T00:00:00.000Z",
          createdBy: "历史导入",
          submittedBy: "历史导入",
          groups: [],
          photos: [],
          conclusion: null,
          review: {
            decision: "approved",
            at: "2026-06-01T00:00:00.000Z",
            by: "历史导入",
            comment: score != null ? "试磨评分 " + score + " 分（历史数据导入）" : "历史数据升级归档",
          },
          snapshot: { note: "由墨锭试磨室 v1 历史数据升级，无图像档案" },
        },
      ],
      legacy: {
        status: it.status || "",
        logs,
        tests: it.tests || [],
        tasks: it.tasks || [],
      },
    };
    samples.push(sample);
  }
  return {
    dbVersion: DB_VERSION, samples, idempotency: {}, identities: {},
    audit: [{ at: nowIso(), actor: "system", action: "migrate_v1", detail: { migrated: samples.length } }],
  };
}
