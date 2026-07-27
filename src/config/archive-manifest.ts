/**
 * 归档文件业务清单配置
 * 依据 docs/业务场景.md 定义：
 * - 必需文件（VERSION.txt 必须存在）
 * - 类型识别规则：特殊名称 → 后缀 → 前缀 → 不支持
 *
 * 业务规则原文：
 * > 按照文件名进行解析，同一种类型的文件文件名称前缀相同，只有后缀不同。
 * > 后缀明确的按照文件后缀解析。
 */

/** 文件名匹配规则 */
export interface NameRule {
  /** 正则匹配模式 */
  pattern: RegExp
  /** 匹配后的业务类型标识 */
  type: string
}

/** 归档文件清单配置 */
export const ARCHIVE_MANIFEST = {
  /** 必需文件列表（缺失则判定压缩包不支持） */
  required: ['VERSION.txt'],

  /**
   * 特殊名称规则（优先级最高）
   * 用于同后缀但业务语义不同的文件
   */
  nameRules: [
    { pattern: /_table_tree\.csv$/i, type: 'table-tree' },
  ] as NameRule[],

  /**
   * 后缀匹配规则（优先级 1：主策略）
   * 后缀明确的文件按后缀解析
   */
  suffixRules: [
    { pattern: /\.json$/i, type: 'json' },
    { pattern: /\.csv$/i, type: 'csv' },
    { pattern: /\.tsv$/i, type: 'csv' },
    { pattern: /\.txt$/i, type: 'text' },
    { pattern: /\.md$/i, type: 'text' },
    { pattern: /\.log$/i, type: 'log' },
  ] as NameRule[],

  /**
   * 前缀匹配规则（优先级 2：补充策略）
   * 无后缀文件，同类文件共享前缀
   */
  prefixRules: [
    { pattern: /^APPLOG/i, type: 'log' },
    { pattern: /^MSGLOG/i, type: 'log' },
  ] as NameRule[],
} as const

/** 不支持类型的标识 */
export const UNSUPPORTED_TYPE = 'unsupported'

/**
 * 根据清单规则解析文件名对应的业务类型（纯函数，无外部依赖）
 * 优先级：nameRules → suffixRules → prefixRules → unsupported
 * 供 PluginRegistry、ManifestValidator 等消费方共用，避免重复实现
 * @param fileName - 文件名
 * @returns 业务类型标识（未命中任何规则时返回 UNSUPPORTED_TYPE）
 */
export function resolveTypeByManifest(fileName: string): string {
  // 第一层：特殊名称规则（最高优先，如 _table_tree.csv）
  for (const rule of ARCHIVE_MANIFEST.nameRules) {
    if (rule.pattern.test(fileName)) return rule.type
  }
  // 第二层：后缀规则（主策略：后缀明确的按后缀解析）
  for (const rule of ARCHIVE_MANIFEST.suffixRules) {
    if (rule.pattern.test(fileName)) return rule.type
  }
  // 第三层：前缀规则（补充策略：无后缀文件，同类前缀相同）
  for (const rule of ARCHIVE_MANIFEST.prefixRules) {
    if (rule.pattern.test(fileName)) return rule.type
  }
  // 未命中任何规则 → 不支持
  return UNSUPPORTED_TYPE
}
