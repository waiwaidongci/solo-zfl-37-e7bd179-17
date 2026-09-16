// 幂等指纹的规范化序列化：
//   - 递归排序对象成员（键序无关：{"a":1,"b":2} 与 {"b":2,"a":1} 视为相同）
//   - 保留数组顺序（[1,2] 与 [2,1] 不同；photos 数组顺序是业务顺序）
//   - 保留值类型（5 与 "5" 不同；null 与 {} 不同）
//   - 完整图片内容：dataUrl 字符串逐字符参与，一个字节变化也会改变哈希
// 与 JSON.parse 配合：输入来自 JSON 请求体，不会有 Map/Date 等特殊对象。
import { createHash } from "node:crypto";

const OBJECT_MARK = "O";
const ARRAY_MARK = "A";
const STRING_MARK = "s";
const NUMBER_MARK = "n";
const BOOL_MARK = "b";
const NULL_MARK = "0";

export function canonicalize(value) {
  if (value === null) return NULL_MARK + ":";
  const t = typeof value;
  if (t === "string") return STRING_MARK + ":" + value;
  if (t === "number") return NUMBER_MARK + ":" + String(value);
  if (t === "boolean") return BOOL_MARK + ":" + (value ? "1" : "0");
  if (t === "bigint") return NUMBER_MARK + ":" + value.toString();
  if (Array.isArray(value)) {
    return ARRAY_MARK + ":[" + value.map(canonicalize).join(",") + "]";
  }
  if (t === "object") {
    const keys = Object.keys(value).sort();
    return OBJECT_MARK + ":{" + keys
      .map(k => JSON.stringify(k) + "=" + canonicalize(value[k]))
      .join(",") + "}";
  }
  // undefined / function / symbol 不会出现在 JSON.parse 的结果里
  throw new Error("canonical_unsupported_type");
}

export function canonicalHash(value) {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

// 旧版指纹：对原始 JSON.stringify 做 SHA-256（键序敏感）。
// 仅用于识别升级前已落库的幂等记录，保证老记录同键同载荷重放仍命中。
export function legacyFingerprint(input) {
  return createHash("sha256").update(JSON.stringify(input ?? null)).digest("hex");
}
