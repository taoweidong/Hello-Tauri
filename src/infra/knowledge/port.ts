import { nowStamp } from '@/utils/time'
import { toKnowledgeFileName, type KnowledgeDoc, type KnowledgeDocSource } from '@/types/knowledge'

export { toKnowledgeFileName }
export type { KnowledgeDoc, KnowledgeDocSource }

/**
 * 本地 Markdown 知识库端口（knowledge-base / knowledge-sedimentation K-G）。
 *
 * 知识源 = 数据根 `knowledge/*.md`，清单真源 = `knowledge/index.json`。此前清单
 * 读写逻辑住在 KnowledgeCard.vue（视图直连 bridge），沉淀管线也要读写同一份清单
 * 后出现了「双真源」风险 —— 本端口把清单结构与对账次序收口到一处，UI（经 store
 * 装配）与编排层（harvester / pipeline）共用同一实现。
 *
 * 语义约定（spec：knowledge-base + knowledge-sedimentation）：
 *  * 清单条目记录 file/title/updatedAt/source；老清单缺 source 一律视为 manual；
 *  * 写入恒为「先写文件、后登记清单」的对账次序 —— 失败重试可对账（重跑即覆盖）；
 *  * 下架 = 仅移清单、文件保留（fs 通道无删文件能力）；
 *  * 登记 = 手动放入 knowledge/ 的文件录入清单（应用无列目录能力，登记即对账）；
 *  * 技能绑定解析（resolveDocs）=「仅保留清单内文件名」的消费侧落点（K-F）。
 */

/** 知识端口错误分类：unavailable = 文件通道不可用（web）；missing = 文件不存在；exists = 同名已在清单；fs = 通道读写失败 */
export type KnowledgeErrorKind = 'unavailable' | 'missing' | 'exists' | 'fs'

export class KnowledgeError extends Error {
  constructor(
    readonly kind: KnowledgeErrorKind,
    message: string,
  ) {
    super(message)
    this.name = 'KnowledgeError'
  }
}

/** 文档写入入参；`overwrite=false`（默认）时同名文件已在清单中报 exists */
export interface KnowledgeSaveInput {
  file: string
  title: string
  content: string
  source: KnowledgeDocSource
  overwrite?: boolean
}

export interface KnowledgePort {
  /** 清单全量（读不到清单文件 = 空清单；清单 JSON 损坏报 fs 错误，防盲写覆盖） */
  listDocs(): Promise<KnowledgeDoc[]>
  /** 读正文；文件不存在返回 null（「文件已被移走」提示的数据源） */
  readDoc(file: string): Promise<string | null>
  /** 写正文 + 登记/刷新清单（先文件后清单）；新文件与既有条目同名时按 overwrite 决定 */
  saveDoc(input: KnowledgeSaveInput): Promise<KnowledgeDoc>
  /** 并入既有文档：读旧 + 拼接 + 覆写 + 清单时间刷新；不在清单或文件丢失报 missing */
  appendDoc(input: { file: string; content: string }): Promise<KnowledgeDoc>
  /** 下架：仅移清单、文件保留；返回是否真的有条目被移除 */
  offShelf(file: string): Promise<boolean>
  /** 登记手动文件：文件必须已存在（读得到正文才算），清单内重复报 exists */
  registerDoc(input: { file: string; title: string }): Promise<KnowledgeDoc>
  /**
   * 解析技能绑定（K-F 消费侧）：按入参顺序返回**清单内存在**的文档，缺失文件静默剔除、
   * 重复绑定去重 —— 「绑定清洗只保留清单内文件名」的行为落点。
   */
  resolveDocs(files: string[]): Promise<KnowledgeDoc[]>
}

/** 清单文件（数据根相对路径） */
export const KNOWLEDGE_INDEX_FILE = 'knowledge/index.json'

/** 文档路径安全校验：必须 .md 结尾；拒绝绝对路径/反斜杠/空段/越界段（fs 通道之外的二道闸） */
function assertSafeDocFile(file: string): string {
  const trimmed = file.trim()
  const segments = trimmed.split('/')
  const ok =
    trimmed.toLowerCase().endsWith('.md') &&
    !trimmed.startsWith('/') &&
    !trimmed.includes('\\') &&
    segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..')
  if (!ok) throw new KnowledgeError('fs', `非法的知识文档路径：${file}`)
  return trimmed
}

const SOURCES: KnowledgeDocSource[] = ['manual', 'extract', 'qa']

/** 清单条目归一化：缺 source / 错 source 视为 manual（老清单零迁移），字段错型兜底 */
function normalizeEntry(raw: unknown): KnowledgeDoc | null {
  const item = (raw ?? {}) as Partial<KnowledgeDoc>
  if (typeof item.file !== 'string' || !item.file.trim()) return null
  const source =
    typeof item.source === 'string' && SOURCES.includes(item.source as KnowledgeDocSource)
      ? (item.source as KnowledgeDocSource)
      : 'manual'
  return {
    file: item.file.trim(),
    title: typeof item.title === 'string' && item.title.trim() ? item.title.trim() : item.file.trim(),
    updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : '',
    source,
  }
}

/** 清单归一化：{ docs: [...] }；损坏 JSON 由调用方按 fs 错误处理 */
export function parseKnowledgeIndex(raw: string): KnowledgeDoc[] {
  const parsed = JSON.parse(raw) as { docs?: unknown }
  const list = Array.isArray(parsed.docs) ? parsed.docs : []
  return list.map(normalizeEntry).filter((item): item is KnowledgeDoc => item !== null)
}

export function serializeKnowledgeIndex(docs: KnowledgeDoc[]): string {
  return JSON.stringify({ docs }, null, 2)
}

/**
 * 共享核心：清单与文档的全部语义只在这里实现，fs / mock 两个适配器只提供
 * 「按相对路径读写文本」的 IO —— 双实现天然契约一致（对齐 infra/db 的端口夹具思路）。
 */
export function createKnowledgeCore(io: {
  readFile(relative: string): Promise<string | null>
  writeFile(relative: string, content: string): Promise<void>
}): KnowledgePort {
  async function loadIndex(): Promise<KnowledgeDoc[]> {
    const raw = await io.readFile(KNOWLEDGE_INDEX_FILE)
    if (raw === null) return []
    try {
      return parseKnowledgeIndex(raw)
    } catch {
      throw new KnowledgeError('fs', `知识库清单损坏（${KNOWLEDGE_INDEX_FILE}），请修复后再操作`)
    }
  }

  async function persistIndex(docs: KnowledgeDoc[]): Promise<void> {
    await io.writeFile(KNOWLEDGE_INDEX_FILE, serializeKnowledgeIndex(docs))
  }

  const docPath = (file: string) => `knowledge/${file}`

  return {
    async listDocs() {
      return loadIndex()
    },

    async readDoc(file) {
      return io.readFile(docPath(file))
    },

    async saveDoc(input) {
      const file = assertSafeDocFile(input.file)
      const docs = await loadIndex()
      const existing = docs.find((item) => item.file === file)
      if (existing && !input.overwrite) throw new KnowledgeError('exists', `同名文件已在清单中：${file}`)
      const entry: KnowledgeDoc = {
        file,
        title: input.title.trim() || file,
        updatedAt: nowStamp(),
        source: input.source,
      }
      // 对账次序（K-G）：先写文件、后登记清单 —— 中断后重跑同一操作即可对账
      await io.writeFile(docPath(file), input.content)
      await persistIndex(existing ? docs.map((item) => (item.file === file ? entry : item)) : [...docs, entry])
      return entry
    },

    async appendDoc({ file, content }) {
      const docs = await loadIndex()
      const existing = docs.find((item) => item.file === file)
      if (!existing) throw new KnowledgeError('missing', `目标文档不在清单中：${file}`)
      const old = await io.readFile(docPath(file))
      if (old === null) throw new KnowledgeError('missing', `文件已被移走：${file}（可重新登记或下架该条目）`)
      const merged = `${old.trimEnd()}\n\n${content.trim()}\n`
      await io.writeFile(docPath(file), merged)
      const entry: KnowledgeDoc = { ...existing, updatedAt: nowStamp() }
      await persistIndex(docs.map((item) => (item.file === file ? entry : item)))
      return entry
    },

    async offShelf(file) {
      const docs = await loadIndex()
      const next = docs.filter((item) => item.file !== file)
      if (next.length === docs.length) return false
      await persistIndex(next)
      return true
    },

    async registerDoc({ file: rawFile, title }) {
      const file = assertSafeDocFile(rawFile)
      const docs = await loadIndex()
      if (docs.some((item) => item.file === file)) throw new KnowledgeError('exists', `该文件已在清单中：${file}`)
      const content = await io.readFile(docPath(file))
      if (content === null) throw new KnowledgeError('missing', `knowledge/ 目录下未找到 ${file}，请确认文件已放入`)
      const entry: KnowledgeDoc = { file, title: title.trim() || file, updatedAt: nowStamp(), source: 'manual' }
      await persistIndex([...docs, entry])
      return entry
    },

    async resolveDocs(files) {
      const docs = await loadIndex()
      const byFile = new Map(docs.map((item) => [item.file, item]))
      const seen = new Set<string>()
      const out: KnowledgeDoc[] = []
      for (const raw of files) {
        const file = typeof raw === 'string' ? raw.trim() : ''
        if (!file || seen.has(file)) continue
        const entry = byFile.get(file)
        if (!entry) continue // 清单外/已下架的绑定文件静默剔除（K-F）
        seen.add(file)
        out.push(entry)
      }
      return out
    },
  }
}
