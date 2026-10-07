/**
 * 本地 Markdown 知识库领域类型（knowledge-base / knowledge-sedimentation）。
 *
 * 真值放 types 层：UI（KnowledgeCard / SedimentCard / SkillsSection）与 infra、
 * orchestrator 共用同一形状，而 UI 层禁止直触 @/infra/**（ESLint D4）——
 * 类型与纯函数住这里，infra/knowledge 端口 re-export 保持 infra 侧引用不变。
 */

/** 知识条目来源：manual 手动创建 | extract 沉淀提取 | qa 问答归档 */
export type KnowledgeDocSource = 'manual' | 'extract' | 'qa'

export interface KnowledgeDoc {
  /** 文件名（含 .md 后缀，相对 knowledge/ 目录；支持 qa-archive/<skill>/<月份>.md 子目录） */
  file: string
  title: string
  updatedAt: string
  source: KnowledgeDocSource
}

/** 来源标识的展示文案（UI 与测试共用） */
export const KNOWLEDGE_SOURCE_LABEL: Record<KnowledgeDocSource, string> = {
  manual: '手动',
  extract: '沉淀',
  qa: '问答',
}

/**
 * 文件名收敛：小写/数字/中文/连字符；空 → 由标题派生；保证 .md 后缀。
 * 仅用于「从标题派生文件名」的入口（UI 新建、问答归档落名）；端口写入侧对
 * 调用方给定的文件名只做安全校验，支持子目录路径。
 */
export function toKnowledgeFileName(input: string, title: string): string {
  const base = (input || title)
    .trim()
    .toLowerCase()
    .replace(/[\s\\/:*?"<>|]+/g, '-')
    .replace(/^-+|-+$/g, '')
  const name = base.endsWith('.md') ? base : `${base}.md`
  return name === '.md' ? '' : name
}
