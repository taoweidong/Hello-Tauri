/**
 * 子进程输出解码（设计 §9 的「UTF-8 → GBK 兜底」）。
 *
 * 为什么需要这一层：Windows 上的中文程序（尤其老旧/国产 CLI）默认输出 **GBK**
 * 而非 UTF-8，直接 `TextDecoder('utf-8')` 会得到一屏 `\uFFFD`。Rust 侧不做编码猜测
 * （回传原始字节的 base64），编码判定集中在这里，只做两件事：
 *
 *  1. base64 → 字节；
 *  2. 先按 **严格** UTF-8 解码；抛错说明不是 UTF-8（字节序列非法），再用 GBK 兜底。
 *
 * 为什么用严格模式而不是 `fatal:false`：宽容模式下 `TextDecoder` 会把非法字节
 * 替换成 U+FFFD 而不报错，我们就失去了「这份输出不是 UTF-8」这个判据。
 *
 * 两种解码都失败时回退到**可打印化的 utf-8-lossy**，宁可显示几个乱码字符，
 * 也不能让整条消息因为编码问题丢失。
 */

/** 严格 UTF-8 解码器：非法字节序列直接抛错（TypeError），这就是我们的判据 */
const strictUtf8 = new TextDecoder('utf-8', { fatal: true })
/** GBK 兜底解码器：Windows 简体中文环境的默认 ANSI 代码页 */
const gbk = new TextDecoder('gbk')

export type TextEncoding = 'utf-8' | 'gbk' | 'lossy'

export interface DecodeResult {
  text: string
  /** 实际使用的编码，便于日志与排查 */
  encoding: TextEncoding
}

/**
 * base64 → 字节数组。
 *
 * 用 `atob` 而非 `Uint8Array.from(atob(x), c => c.charCodeAt(0))`：后者对
 * 数十万字节的输出会产生大量中间字符串，这里一次性分配目标数组。
 * 非法 base64（长度不符/含非法字符）会抛错，由调用方决定降级策略。
 */
export function base64ToBytes(input: string): Uint8Array {
  const normalized = input.replace(/\s+/g, '')
  if (!normalized) return new Uint8Array(0)
  const binary = atob(normalized)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

/** 字节 → base64（测试与 mock 夹具构造用） */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk))
  }
  return btoa(binary)
}

/** 解码字节：严格 UTF-8 → GBK → lossy，返回文本与实际编码 */
export function decodeBytes(bytes: Uint8Array): DecodeResult {
  if (bytes.length === 0) return { text: '', encoding: 'utf-8' }
  try {
    return { text: strictUtf8.decode(bytes), encoding: 'utf-8' }
  } catch {
    try {
      return { text: gbk.decode(bytes), encoding: 'gbk' }
    } catch {
      return { text: new TextDecoder('utf-8').decode(bytes), encoding: 'lossy' }
    }
  }
}

/** 便利封装：base64 直接解成文本（非法 base64 返回空串而不是抛，调用方多为日志路径） */
export function decodeBase64Text(base64: string): DecodeResult {
  try {
    return decodeBytes(base64ToBytes(base64))
  } catch {
    return { text: '', encoding: 'lossy' }
  }
}

/** 文本 → UTF-8 字节（测试夹具与 mock 入参用） */
export function utf8Bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

/** 文本 → GBK 字节。浏览器的 `TextEncoder` 只支持 UTF-8，
 *  因此 GBK 编码走查表实现（覆盖常用汉字与 ASCII 标点，够测试与 mock 用）。 */
export function gbkBytes(text: string): Uint8Array {
  const out: number[] = []
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (code < 0x80) {
      out.push(code)
      continue
    }
    const pair = GBK_TABLE[char]
    if (pair) {
      out.push(pair[0], pair[1])
    } else {
      // 表外字符用 '?' 占位：GBK 表无法表达（与真实 CLI 行为一致）
      out.push(0x3f)
    }
  }
  return new Uint8Array(out)
}

/** 常用汉字 → GBK 双字节表（首字节高、次字节低），仅覆盖测试语料所需字符 */
const GBK_TABLE: Record<string, [number, number]> = {
  中: [0xd6, 0xd0],
  文: [0xce, 0xc4],
  测: [0xb2, 0xe2],
  试: [0xca, 0xd4],
  错: [0xb4, 0xed],
  误: [0xce, 0xf3],
  群: [0xc8, 0xba],
  聊: [0xc1, 0xc4],
  消: [0xcf, 0xfb],
  息: [0xcf, 0xa2],
  发: [0xb7, 0xa2],
  送: [0xcb, 0xcd],
  好: [0xba, 0xc3],
  收: [0xca, 0xd5],
  到: [0xb5, 0xbd],
  网: [0xcd, 0xf8],
  关: [0xb9, 0xd8],
  失: [0xca, 0xa7],
  败: [0xb0, 0xdc],
  成: [0xb3, 0xc9],
  功: [0xb9, 0xa6],
  你: [0xc4, 0xe3],
  我: [0xce, 0xd2],
  他: [0xcb, 0xfb],
  在: [0xd4, 0xda],
  吗: [0xc2, 0xf0],
  的: [0xb5, 0xc4],
  是: [0xca, 0xc7],
  不: [0xb2, 0xbb],
  一: [0xd2, 0xbb],
  二: [0xb6, 0xfe],
  三: [0xc8, 0xfd],
  早: [0xd4, 0xe7],
  上: [0xc9, 0xcf],
  下: [0xcf, 0xc2],
  午: [0xce, 0xe7],
  报: [0xb1, 0xa8],
  告: [0xb8, 0xe6],
  数: [0xca, 0xfd],
  据: [0xbe, 0xdd],
  库: [0xbf, 0xe2],
  欢: [0xbb, 0xb6],
  迎: [0xd3, 0xad],
  请: [0xc7, 0xeb],
  问: [0xce, 0xca],
  题: [0xcc, 0xe2],
  回: [0xbb, 0xd8],
  复: [0xb8, 0xb4],
  自: [0xd7, 0xd4],
  动: [0xb6, 0xaf],
  员: [0xd4, 0xb1],
  工: [0xb9, 0xa4],
  // 常用中文标点（GBK 中的 A3 区）。真实 CLI 输出含这些符号，
  // 缺失时 gbkBytes 会退化成 '?'，使「往返保真」类的断言失真。
  '：': [0xa3, 0xba],
  '，': [0xa3, 0xac],
  '。': [0xa1, 0xa3],
  '！': [0xa3, 0xa1],
  '？': [0xa3, 0xbf],
  '（': [0xa3, 0xa8],
  '）': [0xa3, 0xa9],
}
