/**
 * 知识沉淀管线（knowledge-sedimentation，设计决策 K-A/K-B/K-D/K-E/K-I/K-J）。
 *
 * 与 poller / pipeline 平行的**第三条独立链路**：消息照常进库，沉淀异步消化 ——
 * 失败域与回复链路完全隔离（沉淀不产生任何外发，回复不依赖沉淀）。
 *
 * 轮内次序固定（K-I，各自独立水位互不阻塞）：
 *  1. 问答归档（无 LLM、低风险）：sent 任务按「技能 × 月份」追加进
 *     `knowledge/qa-archive/<skill>/<月>.md`，逐条推进 finished_at 水位（中断零丢失）；
 *  2. 公告采集：白名单群逐会话拉公告（端口可选能力，缺失诚实降级），ann_uid 幂等入库；
 *  3. 消息/公告 LLM 提取：消毒分批 → agent.complete（留痕落 sediment_logs，与回复
 *     任务 R4 语料分表）→ JSON 容错解析 → 内容指纹去重（待审条目 + 既有知识文档双侧）
 *     → 待评审队列；auto 模式免审直通写入（K-E，显式风险）。
 *     提取失败水位不推进（下轮重试同批），连续失败 ≥3 跳过提取并告警（防卡死）。
 *
 * 水位缺省（首次启用）：三类水位从 0/'' 起扫 —— 消息按轮次上限逐步回填存量，
 * 问答归档天然覆盖历史（对冲 180 天保留期），公告表本身从启用时刻累积。
 */
import { SEDIMENT_KEYS, type KnowledgeDraftInput, type SedimentRepository } from '@/infra/db/sediment-ports'
import type { WelinkRepository } from '@/infra/db/ports'
import { knowledgePort, toKnowledgeFileName, type KnowledgePort } from '@/infra/knowledge'
import type { AgentClient } from '@/infra/agent'
import { sanitizeUntrusted } from '@/infra/agent/prompt'
import type { WelinkPort } from '@/infra/welink'
import type { NormalizedAnnouncement, WelinkSettings } from '@/types/welink'
import { nowStamp } from '@/utils/time'
import { logger } from '@/utils/logger'
import type { TimerApi } from './timers'
import { realTimers } from './timers'

// ---------------- 轮内上限（K-D/K-J：批数与字数设上限，防提示词爆炸与队列灌爆） ----------------

/** 每轮参与提取的消息条数上限 */
export const MESSAGES_PER_ROUND = 80
/** 每轮参与提取的公告条数上限 */
export const ANNOUNCEMENTS_PER_ROUND = 40
/** 每轮归档的问答对条数上限 */
export const QA_PER_ROUND = 60
/** 提取提示词总长上限（字符，含材料块） */
export const MAX_PROMPT_CHARS = 8000
/** 单条材料进入提示词的长度上限（消毒截断） */
const MAX_MATERIAL_CHARS = 500
/** 单条知识正文长度上限（K-J） */
export const MAX_KNOWLEDGE_CHARS = 2000
/** 并入目标文档的最大长度（K-J：超限拒绝并入，靠月份/新建分片） */
export const MAX_DOC_CHARS = 64 * 1024
/** 提取连续失败跳过阈值 */
export const MAX_FAIL_STREAK = 3

// ---------------- 提取提示词与解析（纯函数，便于单测） ----------------

/** 一条候选材料（已消毒、已编号） */
export interface ExtractMaterial {
  /** 幂等引用键：消息 msgUid / 公告 annUid */
  ref: string
  /** 展示头（如「公告 2026-10-06」） */
  header: string
  text: string
}

/**
 * 内容指纹（djb2）：规范化（压空白、小写）后哈希。
 * 用于「重复知识不重复入库」——待审条目与既有知识文档双侧去重。
 */
export function fingerprint(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase()
  let hash = 5381
  for (let index = 0; index < normalized.length; index++) {
    hash = (((hash << 5) + hash) ^ normalized.charCodeAt(index)) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** 组装提取提示词：材料已编号，超出总长上限即截断（K-D） */
export function buildExtractPrompt(materials: ExtractMaterial[]): string {
  const lines: string[] = [
    '你是企业知识管理员。下面是 WeLink 群消息与群公告的候选材料（已编号）。',
    '请提取「值得长期保留的企业知识」：办理口径、流程步骤、接口人、值班安排、常见问题答案、公告要点等。',
    '要求：',
    '1. 只输出 JSON 数组，不要任何其它文字或代码块标记；',
    '2. 每个元素形如 {"title":"简短标题","topic":"主题","content":"自包含、可独立阅读的知识正文","refs":[材料编号]}；',
    '3. content 必须基于材料原文整理，不得编造材料中没有的信息；',
    '4. 没有值得提取的内容时输出 []。',
    '',
    '【候选材料】',
  ]
  let total = lines.join('\n').length
  for (let index = 0; index < materials.length; index++) {
    const line = `[${index + 1}] (${materials[index].header}) ${materials[index].text}`
    if (total + line.length > MAX_PROMPT_CHARS) break
    lines.push(line)
    total += line.length
  }
  return lines.join('\n')
}

/** 提取条目（模型输出的宽松形状） */
export interface ExtractedEntry {
  title: string
  topic: string
  content: string
  /** 材料编号（1-based）→ 由调用方映射回 ref 键 */
  refs: number[]
}

/** JSON 容错解析：取首个「[ 到最后一个 ]」片段解析，逐条校验形状，坏条目丢弃（K-D） */
export function parseExtractReply(response: string): ExtractedEntry[] {
  const start = response.indexOf('[')
  const end = response.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(response.slice(start, end + 1))
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const out: ExtractedEntry[] = []
  for (const raw of parsed) {
    const item = (raw ?? {}) as Record<string, unknown>
    const title = typeof item.title === 'string' ? item.title.trim() : ''
    const content = typeof item.content === 'string' ? item.content.trim() : ''
    if (!title || !content) continue
    const refs = Array.isArray(item.refs)
      ? item.refs.filter((value): value is number => typeof value === 'number' && Number.isInteger(value) && value > 0)
      : []
    out.push({
      title: sanitizeUntrusted(title, 80),
      topic: typeof item.topic === 'string' ? sanitizeUntrusted(item.topic, 40) : '',
      content: sanitizeUntrusted(content, MAX_KNOWLEDGE_CHARS),
      refs,
    })
  }
  return out
}

// ---------------- 管线本体 ----------------

export interface HarvesterOptions {
  /** 沉淀域仓储（水位/公告/待评审/留痕） */
  sediment: SedimentRepository
  /** welink 仓储（白名单会话对象查询；原料扫描都在沉淀仓储内） */
  welink: WelinkRepository
  /** welink 端口工厂（公告拉取；可选能力，缺失降级） */
  port: () => WelinkPort
  /** 知识库端口（文件与清单读写；缺省走 infra/knowledge 工厂，测试注入） */
  knowledge?: KnowledgePort
  /** 大模型客户端（提取） */
  agent: AgentClient
  settings: () => WelinkSettings
  timers?: TimerApi
  now?: () => Date
}

/** 一轮沉淀的报告（SedimentCard「最近提取记录」的数据源） */
export interface SedimentRoundReport {
  ranAt: string
  /** 参与提取的消息 / 公告条数 */
  messageCount: number
  announcementCount: number
  /** 本轮归档的问答对条数 */
  qaArchived: number
  /** 新入库的待评审条数（auto 模式含直通条数） */
  draftCount: number
  /** 跳过原因：disabled = 总开关关；fail_streak = 提取连续失败达阈值 */
  skipped: 'disabled' | 'fail_streak' | null
  /** 非空 = 本轮局部失败（水位未推进的部分下轮重试） */
  error: string
}

/** 评审通过目标：不给 file = 按标题派生新建；给 file = 并入既有文档（同名时也并入） */
export interface ApproveTarget {
  file?: string
}

export interface KnowledgeHarvester {
  /** 立即执行一轮（与自动调度共用 single-flight 锁） */
  runOnce(): Promise<SedimentRoundReport>
  /** 启动周期调度（幂等；间隔每轮按当前配置重取，配置热更新无需重启） */
  start(): void
  stop(): void
  /** 评审通过：写知识库（并入或新建）→ 条目置 approved（K-E；先写文件后置终态，写失败可重试） */
  approve(pk: number, patch: { title: string; content: string }, target?: ApproveTarget): Promise<boolean>
  /** 评审拒绝：条目退出队列（rejected），知识库不变 */
  reject(pk: number, note: string): Promise<boolean>
}

export function createKnowledgeHarvester(options: HarvesterOptions): KnowledgeHarvester {
  const timers = options.timers ?? realTimers
  const now = options.now ?? (() => new Date())
  const sediment = options.sediment
  const knowledge = options.knowledge ?? knowledgePort()

  let running = false
  let started = false
  let timerId: unknown = null
  /** 单飞行锁：自动轮次与「立即提取」共用，防并发双跑（水位只在锁内串行推进） */
  let inFlight: Promise<SedimentRoundReport> | null = null

  // —— 原料消毒与分批（K-D） ——

  function toMaterials(
    messages: Awaited<ReturnType<SedimentRepository['listInMessagesSince']>>,
    announcements: Awaited<ReturnType<SedimentRepository['listAnnouncementsSince']>>,
  ): { materials: ExtractMaterial[]; consumedMessages: number; consumedAnnouncements: number } {
    const materials: ExtractMaterial[] = []
    for (const item of announcements) {
      materials.push({
        ref: item.annUid,
        header: `公告 ${item.publishedAt.slice(0, 10)}`,
        text: sanitizeUntrusted(`【${item.title}】${item.content}`, MAX_MATERIAL_CHARS),
      })
    }
    let consumedMessages = 0
    for (const message of messages) {
      // 非文本只是占位存档，无知识可提 —— 但同样按水位消费掉（下轮不再扫）
      if (message.msgType !== 'text') continue
      materials.push({
        ref: message.msgUid,
        header: `消息 ${message.sentAt.slice(5, 16)} ${message.senderName || message.senderId}`,
        text: sanitizeUntrusted(message.content, MAX_MATERIAL_CHARS),
      })
      consumedMessages += 1
    }
    return { materials, consumedMessages, consumedAnnouncements: announcements.length }
  }

  /** 既有知识文档的内容指纹集合（与待审条目双侧去重） */
  async function knownDocHashes(): Promise<Set<string>> {
    const docs = await knowledge.listDocs()
    const hashes = new Set<string>()
    for (const doc of docs) {
      const content = await knowledge.readDoc(doc.file)
      if (content !== null) hashes.add(fingerprint(content))
    }
    return hashes
  }

  async function stateNumber(key: string): Promise<number> {
    return Number((await sediment.getState(key)) ?? 0)
  }

  /**
   * 提取段：扫描 → 消毒分批 → LLM → 去重 → 入待评审（或 auto 直通）。
   * 成功（含零候选）推进水位；失败向上抛（水位不推进，下轮重试同批）。
   */
  async function extractRound(
    settings: WelinkSettings,
  ): Promise<{ messageCount: number; announcementCount: number; draftCount: number }> {
    const [msgBatch, annBatch] = await Promise.all([
      sediment.listInMessagesSince(
        await stateNumber(SEDIMENT_KEYS.messagePk),
        settings.sediment.sessions,
        MESSAGES_PER_ROUND,
      ),
      sediment.listAnnouncementsSince(await stateNumber(SEDIMENT_KEYS.announcementPk), ANNOUNCEMENTS_PER_ROUND),
    ])
    const { materials, consumedMessages } = toMaterials(msgBatch, annBatch)

    if (!materials.length) {
      // 无候选（含全部为非文本的情况）：水位直接消费掉，不发起模型调用
      if (msgBatch.length) await sediment.setState(SEDIMENT_KEYS.messagePk, String(msgBatch.at(-1)!.pk))
      if (annBatch.length) await sediment.setState(SEDIMENT_KEYS.announcementPk, String(annBatch.at(-1)!.pk))
      return { messageCount: 0, announcementCount: annBatch.length, draftCount: 0 }
    }

    const prompt = buildExtractPrompt(materials)
    const startedAt = now().getTime()
    let response: string
    try {
      response = await options.agent.complete(prompt)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await sediment
        .insertSedimentLog({
          prompt,
          response: '',
          status: 'error',
          latencyMs: now().getTime() - startedAt,
          error: message,
        })
        .catch(() => undefined)
      throw error
    }
    await sediment
      .insertSedimentLog({ prompt, response, status: 'ok', latencyMs: now().getTime() - startedAt, error: '' })
      .catch(() => undefined)

    const entries = parseExtractReply(response)
    const knownHashes = await knownDocHashes()
    const refByIndex = materials.map((material) => material.ref)
    const inputs: KnowledgeDraftInput[] = []
    const seen = new Set<string>()
    for (const entry of entries) {
      const hash = fingerprint(`${entry.title}\n${entry.content}`)
      if (knownHashes.has(hash) || seen.has(hash)) continue
      seen.add(hash)
      inputs.push({
        title: entry.title,
        content: entry.content,
        topic: entry.topic,
        sourceType: 'message',
        sourceRefs: entry.refs.map((index) => refByIndex[index - 1]).filter((ref): ref is string => Boolean(ref)),
        contentHash: hash,
      })
    }
    const inserted = await sediment.insertDrafts(inputs)

    // 消费成功 → 水位推进到本批末尾（下轮从新水位继续）
    if (msgBatch.length) await sediment.setState(SEDIMENT_KEYS.messagePk, String(msgBatch.at(-1)!.pk))
    if (annBatch.length) await sediment.setState(SEDIMENT_KEYS.announcementPk, String(annBatch.at(-1)!.pk))

    if (settings.sediment.mode === 'auto') {
      for (const draft of inserted) {
        try {
          await approve(draft.pk, { title: draft.title, content: draft.content })
        } catch (error) {
          // 直通写入失败：条目留在待评审队列（人工兜底），不阻断本轮其余条目
          logger.warn(`沉淀条目直通入库失败（draft ${draft.pk}）：${String(error)}`)
        }
      }
    }
    return { messageCount: consumedMessages, announcementCount: annBatch.length, draftCount: inserted.length }
  }

  // —— 问答归档（K-I：追加语义，逐条推进水位，中断零丢失） ——

  async function archiveQaRound(): Promise<number> {
    const watermark = (await sediment.getState(SEDIMENT_KEYS.qaFinishedAt)) ?? ''
    const records = await sediment.listSentQaSince(watermark, QA_PER_ROUND)
    if (!records.length) return 0
    const known = new Set((await knowledge.listDocs()).map((doc) => doc.file))
    let archived = 0
    for (const record of records) {
      const month = record.finishedAt.slice(0, 7)
      const skillKey = (toKnowledgeFileName(record.skillId || 'fallback', 'fallback') || 'fallback.md').replace(
        /\.md$/,
        '',
      )
      const file = `qa-archive/${skillKey}/${month}.md`
      const title = `问答归档·${record.skillName || '未分类'}·${month}`
      const section = `### ${record.finishedAt}${record.rating === 'up' ? '（赞）' : ''}\n\n**问**：${sanitizeUntrusted(record.question, 500)}\n\n**答**：${sanitizeUntrusted(record.answer, 1000)}\n`
      if (known.has(file)) {
        const current = await knowledge.readDoc(file)
        if (current !== null && current.length > MAX_DOC_CHARS) {
          // 文档超限（K-J）：跳过该条并推进水位，避免无限膨胀；下月自动分片
          await sediment.setState(SEDIMENT_KEYS.qaFinishedAt, record.finishedAt)
          continue
        }
        await knowledge.appendDoc({ file, content: section })
      } else {
        await knowledge.saveDoc({ file, title, content: `# ${title}\n\n${section}`, source: 'qa' })
        known.add(file)
      }
      await sediment.setState(SEDIMENT_KEYS.qaFinishedAt, record.finishedAt)
      archived += 1
    }
    return archived
  }

  // —— 公告采集（K-C：端口可选能力，缺失诚实降级） ——

  async function collectAnnouncements(settings: WelinkSettings): Promise<number> {
    if (!settings.sediment.sessions.length) return 0
    const port = options.port()
    if (!port || !('pullAnnouncements' in port) || typeof port.pullAnnouncements !== 'function') {
      logger.warn('当前数据源不支持公告抓取（[CLI-ASSUME] 待对接），本轮跳过公告采集')
      return 0
    }
    let stored = 0
    for (const convId of settings.sediment.sessions) {
      const conv = await options.welink.getConversation(convId)
      if (!conv) continue
      let items: NormalizedAnnouncement[]
      try {
        items = await port.pullAnnouncements(conv, ANNOUNCEMENTS_PER_ROUND)
      } catch (error) {
        logger.warn(`公告拉取失败（${convId}）：${String(error)}`)
        continue
      }
      stored += (await sediment.applyAnnouncements(items)).length
    }
    return stored
  }

  // —— 评审流转（K-E：先写文件后置终态，写失败可重试） ——

  async function approve(
    pk: number,
    patch: { title: string; content: string },
    target?: ApproveTarget,
  ): Promise<boolean> {
    const file = target?.file?.trim() || toKnowledgeFileName('', patch.title)
    if (!file) throw new Error('无法从标题派生文件名，请指定目标文档')
    if (patch.content.length > MAX_KNOWLEDGE_CHARS) {
      throw new Error(`知识正文超长（${patch.content.length} > ${MAX_KNOWLEDGE_CHARS}）`)
    }
    const section = `### ${patch.title}\n\n${patch.content}\n`
    const existing = (await knowledge.listDocs()).find((doc) => doc.file === file)
    if (existing) {
      const current = await knowledge.readDoc(file)
      if (current !== null && current.length > MAX_DOC_CHARS) throw new Error('目标文档已超长，请改用新建标题')
      await knowledge.appendDoc({ file, content: section })
    } else {
      await knowledge.saveDoc({
        file,
        title: patch.title,
        content: `# ${patch.title}\n\n${patch.content}\n`,
        source: 'extract',
      })
    }
    return sediment.approveDraft(pk, patch)
  }

  // —— 单轮（single-flight；轮内次序固定，各段独立容错） ——

  function runRound(): Promise<SedimentRoundReport> {
    if (inFlight) return inFlight
    inFlight = (async (): Promise<SedimentRoundReport> => {
      const settings = options.settings()
      const report: SedimentRoundReport = {
        ranAt: nowStamp(now()),
        messageCount: 0,
        announcementCount: 0,
        qaArchived: 0,
        draftCount: 0,
        skipped: null,
        error: '',
      }
      if (!settings.sediment.enabled) {
        report.skipped = 'disabled'
        return report
      }

      const errors: string[] = []

      // 1) 问答归档（无 LLM；qaArchive 关闭零写入）
      if (settings.sediment.qaArchive) {
        try {
          report.qaArchived = await archiveQaRound()
        } catch (error) {
          errors.push(`问答归档失败：${error instanceof Error ? error.message : String(error)}`)
        }
      }

      // 2) 公告采集（失败不影响归档与提取）
      try {
        await collectAnnouncements(settings)
      } catch (error) {
        errors.push(`公告采集失败：${error instanceof Error ? error.message : String(error)}`)
      }

      // 3) 消息/公告提取（连续失败达阈值跳过本轮，防卡死）
      const failStreak = await stateNumber(SEDIMENT_KEYS.failStreak)
      if (failStreak >= MAX_FAIL_STREAK) {
        report.skipped = 'fail_streak'
        logger.warn(`知识提取连续失败 ${failStreak} 次，本轮跳过（问题排除后可手动「立即提取」重试）`)
        report.error = errors.join('；')
        return report
      }
      try {
        const extracted = await extractRound(settings)
        report.messageCount = extracted.messageCount
        report.announcementCount = extracted.announcementCount
        report.draftCount = extracted.draftCount
        await sediment.setState(SEDIMENT_KEYS.failStreak, '0')
      } catch (error) {
        const streak = failStreak + 1
        await sediment.setState(SEDIMENT_KEYS.failStreak, String(streak)).catch(() => undefined)
        const message = error instanceof Error ? error.message : String(error)
        errors.push(`知识提取失败（连续第 ${streak} 次）：${message}`)
        logger.warn(`知识提取失败（连续第 ${streak} 次）：${message}`)
      }

      report.error = errors.join('；')
      return report
    })()
    return inFlight.finally(() => {
      inFlight = null
    })
  }

  return {
    runOnce: runRound,

    start() {
      if (started) return
      started = true
      running = true
      // setTimeout 链（不用 setInterval，与 poller/retention 同原则）：每轮重新读
      // 配置取间隔 —— intervalHours 热更新无需重启；沉淀不受窗口隐藏 ×3 影响（无外发）
      const schedule = () => {
        if (!running) return
        const hours = options.settings().sediment.intervalHours
        timerId = timers.set(
          async () => {
            if (!running) return
            try {
              await runRound()
            } catch (error) {
              logger.warn(`知识沉淀轮次异常：${String(error)}`)
            }
            schedule()
          },
          Math.max(1, hours) * 3_600_000,
        )
      }
      schedule()
    },

    stop() {
      running = false
      started = false
      if (timerId !== null) {
        timers.clear(timerId)
        timerId = null
      }
    },

    async approve(pk, patch, target) {
      return approve(pk, patch, target)
    },

    async reject(pk, note) {
      return sediment.rejectDraft(pk, note)
    },
  }
}
