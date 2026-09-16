// 幂等指纹的规范化序列化 —— 无分隔符的 TLV（类型标签 + 长度前缀）编码。
//
// 早期版本用 `,`、`=`、`{}`、`[]`、`s:` 等可打印分隔符拼接，字符串内容
// 原样进入输出，于是 {a:'1,"b"=n:2'} 与 {a:'1', b:2} 会编码成同一串文本，
// 造成跨请求碰撞。这里改为每个值都输出：
//
//     <1 字节类型标签><字节长度的十进制数字>:<恰好该长度的内容字节>
//
// 内容里无论出现逗号、引号、冒号、括号还是标签字符，都被长度整体跳过，
// 解析时不需要在内容里寻找任何定界符，因此对字符串注入免疫。
//
// 语义：
//   - 对象成员递归按 UTF-8 字节序排序（键书写顺序无关）
//   - 数组顺序原样保留（照片数组换序是不同请求）
//   - 类型标签区分 string/number/boolean/null/array/object（值类型不同即不同）
//   - 图片 dataUrl 作为字符串按完整字节参与，一个字节变化也会改变哈希
import { createHash } from "node:crypto";

const T_NULL = 0x7a;   // 'z'
const T_TRUE = 0x74;   // 't'
const T_FALSE = 0x66;  // 'f'
const T_NUM = 0x6e;    // 'n'
const T_STR = 0x73;    // 's'
const T_ARR = 0x61;    // 'a'
const T_OBJ = 0x6f;    // 'o'

const encoder = new TextEncoder();

function frame(tag, body) {
  // tag(1) + len(decimal ascii) + ':'(1) + body；长度即内容字节数，
  // 解析端按长度整块消费内容，绝不在内容中扫描分隔符。
  const head = Buffer.from(String.fromCharCode(tag) + body.length + ":", "ascii");
  return Buffer.concat([head, body]);
}

export function canonicalizeBytes(value) {
  if (value === null) return frame(T_NULL, Buffer.alloc(0));
  const t = typeof value;
  if (t === "string") return frame(T_STR, Buffer.from(encoder.encode(value)));
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
    const entries = Object.keys(value)
      .map(k => [Buffer.from(encoder.encode(k)), k])
      .sort((a, b) => Buffer.compare(a[0], b[0]));
    const parts = [];
    for (const [keyBytes, key] of entries) {
      parts.push(frame(T_STR, keyBytes));          // 键也走带长度的字符串帧
      parts.push(canonicalizeBytes(value[key]));   // 值自带类型与长度
    }
    return frame(T_OBJ, Buffer.concat(parts));
  }
  // undefined / function / symbol 不会出现在 JSON.parse 的结果里
  throw new Error("canonical_unsupported_type");
}

export function canonicalHash(value) {
  return createHash("sha256").update(canonicalizeBytes(value)).digest("hex");
}

// 旧版指纹 1：对原始 JSON.stringify 做 SHA-256（键序敏感）。
export function legacyFingerprint(input) {
  return createHash("sha256").update(JSON.stringify(input ?? null)).digest("hex");
}
