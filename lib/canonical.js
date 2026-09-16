// 幂等指纹的规范化序列化 —— 无分隔符的 TLV（类型标签 + 长度前缀）编码。
//
// 每个值输出：
//
//     <1 字节类型标签><长度的十进制数字>:<恰好该长度的内容>
//
// 解析端按长度整块消费内容，绝不在内容里寻找定界符，因此逗号/引号/等号/
// 括号/标签字符出现在字符串中都无法伪造结构（无分隔符注入）。
//
// 字符串与对象键的内容采用 UTF-16BE 码元序列（与 JS 字符串索引一一对应，
// 每个码元固定 2 字节），长度 = code unit 数。这样：
//   - 普通字符、中文、emoji（代理对两个码元）逐码元保留；
//   - 孤立代理项（lone surrogate，如 \uD800、\uD801）原样保留，不会像
//     TextEncoder(UTF-8) 那样被统一替换成 U+FFFD 而产生碰撞；
//   - 长度固定 2 字节/码元，帧仍可无歧义切分。
//
// 语义：
//   - 对象成员递归按码元字典序排序（键书写顺序无关）
//   - 数组顺序原样保留（照片数组换序是不同请求）
//   - 类型标签区分 string/number/boolean/null/array/object（值类型不同即不同）
//   - 图片 dataUrl 按完整码元参与，一个字符变化也会改变哈希
import { createHash } from "node:crypto";

const T_NULL = 0x7a;   // 'z'
const T_TRUE = 0x74;   // 't'
const T_FALSE = 0x66;  // 'f'
const T_NUM = 0x6e;    // 'n'
const T_STR = 0x73;    // 's'
const T_ARR = 0x61;    // 'a'
const T_OBJ = 0x6f;    // 'o'

// JS 字符串 -> UTF-16BE 字节（每个 UTF-16 码元 2 字节，孤立代理项原样保留）
function encodeUtf16Units(str) {
  const units = str.length;
  const buf = Buffer.alloc(units * 2);
  for (let i = 0; i < units; i++) buf.writeUInt16BE(str.charCodeAt(i), i * 2);
  return buf;
}

function frame(tag, body, unitCount) {
  // tag(1) + len(decimal ascii) + ':'(1) + body。
  // 字符串帧长度按码元计；其它类型按字节计。
  const declared = unitCount === undefined ? body.length : unitCount;
  const head = Buffer.from(String.fromCharCode(tag) + declared + ":", "ascii");
  return Buffer.concat([head, body]);
}

function stringFrame(value) {
  // 长度声明为码元数；内容字节数 = 码元数 * 2，靠固定宽度自对齐
  const body = encodeUtf16Units(value);
  return frame(T_STR, body, value.length);
}

export function canonicalizeBytes(value) {
  if (value === null) return frame(T_NULL, Buffer.alloc(0));
  const t = typeof value;
  if (t === "string") return stringFrame(value);
  if (t === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical_unsupported_number");
    return frame(T_NUM, Buffer.from(value === 0 ? "0" : String(value), "ascii"));
  }
  if (t === "boolean") return frame(value ? T_TRUE : T_FALSE, Buffer.alloc(0));
  if (t === "bigint") return frame(T_NUM, Buffer.from(value.toString(), "ascii"));
  if (Array.isArray(value)) {
    return frame(T_ARR, Buffer.concat(value.map(canonicalizeBytes)));
  }
  if (t === "object") {
    // 键按 UTF-16 码元字典序排序（与编码方式一致）
    const keys = Object.keys(value).sort();
    const parts = [];
    for (const key of keys) {
      parts.push(stringFrame(key));                 // 键也走码元帧
      parts.push(canonicalizeBytes(value[key]));    // 值自带类型与长度
    }
    return frame(T_OBJ, Buffer.concat(parts));
  }
  // undefined / function / symbol 不会出现在 JSON.parse 的结果里
  throw new Error("canonical_unsupported_type");
}

export function canonicalHash(value) {
  return createHash("sha256").update(canonicalizeBytes(value)).digest("hex");
}

// 旧版指纹 1：对原始 JSON.stringify 做 SHA-256（键序敏感；孤立代理被 JSON
// 转义成 \uXXXX 文本，不同码元不碰撞）。
export function legacyFingerprint(input) {
  return createHash("sha256").update(JSON.stringify(input ?? null)).digest("hex");
}

// 旧版指纹 2（中间版本）：可打印分隔符文本规范化摘要（键序无关）。
// 该格式不安全：分隔符注入碰撞、不同孤立代理码元都塌成 U+FFFD 碰撞。
// 服务端已不再用它做匹配；仅保留给测试构造历史记录、佐证其碰撞缺陷。
export function legacyCanonicalFingerprint(input) {
  return createHash("sha256").update(legacyTextCanonical(input), "utf8").digest("hex");
}

function legacyTextCanonical(value) {
  if (value === null) return "0:";
  const t = typeof value;
  if (t === "string") return "s:" + value;
  if (t === "number") return "n:" + String(value);
  if (t === "boolean") return "b:" + (value ? "1" : "0");
  if (Array.isArray(value)) return "A:[" + value.map(legacyTextCanonical).join(",") + "]";
  return "O:{" + Object.keys(value).sort()
    .map(k => JSON.stringify(k) + "=" + legacyTextCanonical(value[k]))
    .join(",") + "}";
}
