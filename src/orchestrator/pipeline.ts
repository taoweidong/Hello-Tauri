/**
 * 回复管线（设计 §6.2 / §5B.1-O1 / §7.3）。
 *
 * **两段式 worker**（O1/D12）是这一层的核心不变量：
 *
 * ```
 * 生成段（并发 N=2）              外发段（严格串行 =1）
 * ─────────────────────          ──────────────────────
 * discussing → 拉上下文           Gate.check
 *   → Agent.complete                ├ send  → sending → sent
 *   → 落 agent_logs                 ├ skip  → skipped
 *   → commitDraft（要点3）          ├ hold  → ready+hold_reason
 *   → 入外发队列 ────────────►      └ defer → ready（下轮重试）
 * ```
 *
 * 为什么生成段能并发而外发段不能：
 *  * 生成段**无副作用**（只读上下文 + 调 Agent + 写 agent_logs），等待 Agent 的
 *    2–60s 是主要吞吐瓶颈，并发 2 直接翻倍（O1）；
 *  * 外发段是 S1–S3 配额扣减、`sending` 唯一性、防双发的**唯一发生点**，
 *    串行才能保证「配额准确」与「同一 job 不会被发两次」（D12）。
 *
 * 三条要点3 相关的铁律（改动前必读）：
 *  1. 外发前置检查恒为 `status='ready'`（`markStatus(pk,'sending','ready')` 乐观锁）；
 *  2. 草稿必须先 `commitDraft` 落库（draft 与 ready 同一条 UPDATE）才能进外发队列；
 *  3. 失败重发前必须 `hasOutgoingReceipt` 核对 —— 若上一次「发出去了但没记上」，
 *     补记 sent 而**不是**重发（否则群里会出现两条一样的回复）。
 *
 * 恢复路径的配额立场：只有**证据确凿的成功发送**才 `gate.onSent`（扣配额 + 刷新 S1
 * 基线）。崩溃恢复的补记不动配额 —— 宁可少算（保守，不滥发），也不要多算后
 * 让配额提前耗尽而漏回正常消息。
 */
import type { AgentClient, AgentCallRecord } from '@/infra/agent'
import { AgentError } from '@/infra/agent'
import { renderPrompt, sanitizeReply, sanitizeTrustedContent, sanitizeUntrusted } from '@/infra/agent/prompt'
import type { KnowledgePort } from '@/infra/knowledge'
import type { RagClient, RagChunk } from '@/infra/rag'
import type { WelinkPort } from '@/infra/welink'
import type { WelinkRepository } from '@/infra/db'
import type { WelinkJob, WelinkRagSettings, WelinkSettings, WelinkSkill } from '@/types/welink'
import { FALLBACK_SKILL_ID } from '@/types/welink'
import { logger } from '@/utils/logger'
import { nowStamp } from '@/utils/time'
import type { EventSink } from './events'
import type { SafetyGate } from './safety-gate'
import { routeSkill } from './skill-router'
import { realTimers, type TimerApi } from './timers'

/** 生成段最多尝试次数（耗尽 → failed） */
export const MAX_ATTEMPTS = 3
/** 第 1 次生成失败后的等待（毫秒），后续翻倍；见 `retryGenerate` 的注释 */
export const GENERATE_RETRY_MS = 1500
/** 生成段并发（O1：只读+无外发，可并行） */
export const GENERATE_CONCURRENCY = 2
/** 外发段失败的重试上限（超过转 failed 交人工） */
export const MAX_SEND_ATTEMPTS = 3

export interface PipelineOptions {
  repo: WelinkRepository
  gate: SafetyGate
  agent: AgentClient
  /**
   * RAG 检索客户端工厂（rag-retrieval）。用 getter 而非固定实例：ragClient 工厂
   * 的缓存键含连接配置，配置变更后下一次检索自动取到新实例（热更新）；缺省 =
   * 不装配检索，测试兼容老用例。
   */
  rag?: () => RagClient
  /**
   * 本地知识文档端口工厂（knowledge-sedimentation K-F）。用 getter 与 rag 对称；
   * 缺省 = 不装配（老用例零改动）。仅当模板含 {{docs}} 且技能绑定了文档时才会读取。
   */
  knowledge?: () => KnowledgePort
  /** 消息端口获取函数（外发需要 send）。默认走端口工厂；测试注入 mock */
  port: (settings: WelinkSettings) => WelinkPort
  settings: () => WelinkSettings
  emit: EventSink
  timers?: TimerApi
  now?: () => Date
  /** `defer`（静默时段/全局配额）后的队列重试间隔，默认 30s */
  retryDelayMs?: number
}

export interface Pipeline {
  /** 启动两段 worker（幂等） */
  start(): void
  /** 停止（在飞的工作让其自然结束；不再消费队列） */
  stop(): void
  running(): boolean
  /** 新任务入队（poller 建 job 后调用；重复入队自动去重） */
  enqueue(jobPk: number): void
  /** 批量入队（启动恢复用，§6.3） */
  enqueueMany(jobPks: number[]): void
  /** 立刻把队列跑到当前能跑到的程度；返回本次接手的 job 数 */
  drain(): Promise<number>
  /** 队列长度（UI 待办角标） */
  pending(): { generate: number; send: number }
  /** 人工发送入口（编辑并发送 / 重发）：绕过 manual 拦截，其余 Gate 规则照走 */
  sendNow(jobPk: number): Promise<boolean>
}

export function createPipeline(options: PipelineOptions): Pipeline {
  const timers = options.timers ?? realTimers
  const now = options.now ?? (() => new Date())
  const retryDelayMs = options.retryDelayMs ?? 30_000

  let running = false
  /** 生成队列（FIFO，按 jobPk 去重） */
  const generateQueue: number[] = []
  /**
   * 生成失败、等待延时重试的任务。
   *
   * 为什么不直接推回 `generateQueue`：冲刷循环末尾有个「生成任务完成后若队列
   * 非空就 0ms 再冲刷一次」的重排，**它会立刻把刚失败的任务重跑一遍** ——
   * 于是 `scheduleFlush(1500)` 那句延时形同虚设，真实表现是「Agent 一抖，
   * 三次尝试在毫秒内全部烧完，直接判 failed 交人工」。
   * 放到独立队列里，由 `scheduleRetry(1500)` 到点再放回，延时才是真的。
   */
  const retryGenerate: number[] = []
  /** 外发队列（FIFO，严格串行消费） */
  const sendQueue: number[] = []
  /** 在飞的生成任务（drain 等它们回落） */
  const inflightGenerate = new Set<Promise<void>>()
  let sendActive = false
  let flushTimer: unknown = null
  /**
   * 重试定时器（与 `flushTimer` 分开，见 `scheduleRetry` 的注释）。
   *
   * 分开的理由：挂起任务的 30s 重试不能被「新草稿就绪」的 0ms 冲刷顶掉。
   */
  let retryTimer: unknown = null
  /** 生成段的尝试计数（按 jobPk）。定时器共用，靠它算每个任务的退避倍数 */
  const generateRetries = new Map<number, number>()
  /** 人工明确发起的发送：需要绕过 manual 自动拦截（其余 Gate 规则仍生效） */
  const manualOverride = new Set<number>()

  /**
   * Agent 调用记录归属（R4）。
   *
   * `onCall` 是客户端级钩子，不带 job 上下文；生成段并发 2 时不能用「当前 job」
   * 这样的全局变量（会串台）。这里按 **prompt 精确匹配**归属：每个在飞生成任务
   * 登记自己的 prompt，记录到达时就近认领（FIFO，同名取最早未认领者）。
   */
  const promptOwners: Array<{ prompt: string; jobPk: number; claimed: boolean }> = []

  options.agent.onCall((record: AgentCallRecord) => {
    const owner = promptOwners.find((item) => !item.claimed && item.prompt === record.prompt)
    if (!owner) return
    owner.claimed = true
    void options.repo
      .insertAgentLog({
        jobPk: owner.jobPk,
        prompt: record.prompt,
        response: record.response,
        status: record.status,
        latencyMs: record.latencyMs,
        error: record.error,
      })
      .catch((error: unknown) => logger.warn(`回溯语料落库失败（job ${owner.jobPk}）：${String(error)}`))
  })

  /**
   * 任务状态流转事件。
   *
   * `holdReason` 必须随事件带出去（O7）：转审是 `ready → ready` 的同状态流转，
   * store 若只看到 `from/to` 根本判断不出「刚被转人工了」，「待审 N」徽标就会滞后。
   */
  function emitStatus(
    jobPk: number,
    from: WelinkJob['status'] | 'unknown',
    to: WelinkJob['status'],
    reason: string,
    holdReason = '',
  ) {
    options.emit({ type: 'jobStatusChanged', jobPk, from, to, reason, holdReason })
  }

  // ---------------------------------------------------------------- 生成段

  /** 生成一个 job 的草稿：discussing → Agent → commitDraft → 入外发队列 */
  async function generateOne(jobPk: number): Promise<void> {
    const settings = options.settings()
    const job = await options.repo.getJob(jobPk)
    if (!job) return
    // 幂等：启动恢复可能把同一 job 又排一次，以库中状态为准
    if (job.status === 'sent' || job.status === 'skipped') return

    /**
     * **按库中状态分流**（这条判断修掉过一个真实缺陷）。
     *
     * 入队方不止「新建 job」一处：启动恢复（§6.3 / `bootstrap.ts`）会把重启前
     * 遗留的**未终态**任务整体重投，其中有 `ready`（草稿早已生成，只差发送）
     * 与 `sending`（崩溃窗口）。
     *
     * 早期版本在这里无脑 `markStatus(pk,'discussing','pending')`：对 `ready`
     * 必然拿不到锁 → `moved=false` 且 `job.status !== 'discussing'` → 直接 return。
     * 那些 job 于是**既没被生成、也没被外发**，卡在 ready 里再也不会被处理
     * ——「重启后待发送的草稿发不出去」。
     *
     * 分流规则：
     *  * `ready`   → 走外发队列（草稿在库，绝不重调 Agent 覆盖人工编辑）；
     *  * `sending` → 也交外发段，由它的崩溃恢复分支凭回执判定「补记 sent / 回落 ready」；
     *  * 其余（pending / discussing / failed 落回）→ 走生成段。
     */
    if (job.status === 'ready' || job.status === 'sending') {
      sendQueue.push(jobPk)
      scheduleFlush(0)
      return
    }

    // mark 先行落库（§7.3：pending → discussing 是「worker 出队」的可见标志）
    const moved = await options.repo.markStatus(jobPk, 'discussing', 'pending')
    if (!moved && job.status !== 'discussing') return
    if (moved) emitStatus(jobPk, job.status, 'discussing', 'worker 出队')

    const conv = await options.repo.getConversation(job.targetId)
    const context = conv ? await options.repo.recentContext(conv.pk, settings.agent.maxContextMsgs) : []
    const trigger = context.find((message) => message.pk === job.triggerMsgPk) ?? null

    // —— 技能路由（skill-routing）：规则 → LLM 兜底（可开关）→ 兜底技能 ——
    //
    // 分类只发生在生成段（无外发风险，D1）；兜底技能不落配置数组，运行时由
    // `promptTemplate` 字段现拼（D4，老配置零迁移）。分类调用经同一 agent 客户端
    // 发出，onCall → agent_logs 自动留痕；`onClassifyPrompt` 在调用发起前把归属
    // 槽位登记进 promptOwners（按 prompt 精确匹配，分类与生成两条记录都归本 job）。
    const agentSettings = settings.agent
    const fallbackSkill: WelinkSkill = {
      id: FALLBACK_SKILL_ID,
      name: '通用助手',
      description: '未命中任何技能时的通用企业沟通回复',
      enabled: true,
      keywords: [],
      promptTemplate: agentSettings.promptTemplate,
      knowledge: agentSettings.fallbackKnowledge,
      reviewMode: 'auto',
      retrieval: { enabled: settings.rag.fallbackRetrieve },
      knowledgeDocs: [],
    }
    const ownedSlots: Array<{ prompt: string; jobPk: number; claimed: boolean }> = []
    const registerSlot = (slotPrompt: string) => {
      const slot = { prompt: slotPrompt, jobPk, claimed: false }
      ownedSlots.push(slot)
      promptOwners.push(slot)
    }
    const decision = await routeSkill({
      question: trigger?.content ?? job.triggerSummary,
      context: context.filter((message) => message.pk !== job.triggerMsgPk),
      candidates: [fallbackSkill, ...agentSettings.skills],
      fallback: fallbackSkill,
      llmClassify: agentSettings.llmClassifyFallback,
      agent: options.agent,
      onClassifyPrompt: registerSlot,
    })

    // —— 知识检索（rag-retrieval D-E/D-H）：技能路由后按绑定取知识片段 ——
    // 检索是增强不是依赖：失败/超时/零命中一律空串降级（logger.warn），不重试、
    // 不阻断生成主链路；检索结果注入 prompt 后随 onCall 落 R4 语料可回溯。
    const ragSettings = settings.rag
    const retrievalOn =
      decision.skill.id === FALLBACK_SKILL_ID
        ? ragSettings.fallbackRetrieve
        : (decision.skill.retrieval?.enabled ?? false)
    let retrieved = ''
    if (retrievalOn && options.rag) {
      try {
        const chunks = await options.rag().retrieve({
          // 与 prompt 侧 question 同款消毒：控制字符/换行拍平/截断，防脏数据直传检索服务
          query: sanitizeUntrusted(trigger?.content ?? job.triggerSummary),
          filter: decision.skill.retrieval?.filter,
          topK: ragSettings.topK,
        })
        retrieved = formatRetrieved(chunks, ragSettings)
        // 运行日志可见检索结果（UI 可见性 P2-7：不看 prompt 全文也知道命中了几条）
        if (retrieved) {
          logger.info(`知识检索命中 ${chunks.length} 条（job ${jobPk} · 技能「${decision.skill.name}」）`)
        } else {
          logger.info(`知识检索零命中，按无检索生成（job ${jobPk} · 技能「${decision.skill.name}」）`)
        }
      } catch (error) {
        logger.warn(
          `知识检索失败，降级无检索生成（job ${jobPk}）：${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }

    // 模板按命中技能切换；技能模板为空时回退兜底模板（归一化允许空串，D4）
    const template = decision.skill.promptTemplate.trim() || agentSettings.promptTemplate

    // —— 本地知识文档注入（knowledge-sedimentation K-F）：技能绑定文档按 {{docs}} 口径注入 ——
    // 与 {{knowledge}}（静态块）/ {{retrieved}}（外挂检索）三口径分离；文件丢失/读失败
    // 一律空串降级（logger.warn），不重试、不阻断生成主链路。零开销门控：模板不含
    // {{docs}} 或技能未绑定（老配置零迁移）时不读取任何文件。
    let docs = ''
    const boundFiles = decision.skill.knowledgeDocs ?? []
    if (template.includes('{{docs}}') && boundFiles.length && options.knowledge) {
      try {
        const loaded = await formatBoundDocs(options.knowledge(), boundFiles, settings.sediment.docsMaxChars)
        docs = loaded.text
        if (docs) {
          logger.info(`本地知识文档命中 ${loaded.hit} 篇（job ${jobPk} · 技能「${decision.skill.name}」）`)
        } else {
          logger.info(`本地知识文档零命中，按未绑定生成（job ${jobPk} · 技能「${decision.skill.name}」）`)
        }
        for (const file of loaded.missing) {
          logger.warn(`绑定知识文档丢失：${file}（job ${jobPk}），可重新登记或下架后改绑`)
        }
      } catch (error) {
        logger.warn(
          `本地知识文档读取失败，降级无文档生成（job ${jobPk}）：${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }

    const prompt = renderPrompt({
      template,
      knowledge: decision.skill.knowledge,
      retrieved,
      docs,
      target: conv,
      context: context.filter((message) => message.pk !== job.triggerMsgPk),
      trigger,
      targetFallback: job.targetTitle || job.targetId,
    })
    registerSlot(prompt)

    let draft = ''
    let failure = ''
    try {
      draft = await options.agent.complete(prompt)
    } catch (error) {
      failure = error instanceof AgentError ? `${error.kind}：${error.message}` : String(error)
    } finally {
      // 记录已由 onCall 异步落库；这里只回收归属槽（分类 + 生成两个），避免数组无限增长
      for (const slot of ownedSlots) {
        const at = promptOwners.indexOf(slot)
        if (at >= 0) promptOwners.splice(at, 1)
      }
    }

    if (failure) {
      // attempts 以**库中值 + 1** 为准（job 可能是上一次崩溃留下的 discussing，
      // 本地计数会丢；库里那个数是唯一可信的重试轨迹）
      const attempts = job.attempts + 1
      if (attempts < MAX_ATTEMPTS) {
        await options.repo.recordAttemptFailure(jobPk, 'pending', failure)
        emitStatus(jobPk, 'discussing', 'pending', `生成失败，第 ${attempts} 次重试：${failure}`)
        logger.warn(`生成失败，重试 ${attempts}/${MAX_ATTEMPTS}（job ${jobPk}）：${failure}`)
        // 进**延时重试队列**而不是立刻重排（见 retryGenerate / scheduleRetry 的注释）
        retryGenerate.push(jobPk)
        scheduleRetry(GENERATE_RETRY_MS * 2 ** (generateRetries.get(jobPk) ?? 0))
        generateRetries.set(jobPk, (generateRetries.get(jobPk) ?? 0) + 1)
      } else {
        await options.repo.recordAttemptFailure(jobPk, 'failed', failure)
        emitStatus(jobPk, 'discussing', 'failed', `重试 ${attempts} 次耗尽：${failure}`)
        logger.error(`生成耗尽（job ${jobPk}）：${failure}`)
      }
      return
    }

    // 要点3：draft 与 status='ready' 同一条 UPDATE（commitDraft）
    //
    // 清洗必须在**落库之前**（D-2）：模型常带包裹痕迹（``` 代码块、`回复：` 前缀、
    // 整体引号），若原样落库，群里看到的会是「```」而不是一句话。清洗放在这里而不是
    // mock 内部，是因为 mock 只是调试替身 —— 真实内网模型同样会输出这些痕迹，
    // 清洗必须作用于**所有**生成路径。
    //
    // 顺序要求：先 sanitize 再落库，于是 S6 的长度校验（Gate 里 `draftProblem`）
    // 判的是清洗后的文本 —— 否则「包裹了一堆 ``` 的超长输出」会被清洗后变短，
    // 出现「库里合规、实际外发超长」的错位。
    const cleaned = sanitizeReply(draft)
    const committed = await options.repo.commitDraft(
      jobPk,
      cleaned,
      prompt,
      // 技能三列与草稿同条 UPDATE（skill-routing D5）：留痕与「要点3」原子一致
      { id: decision.skill.id, name: decision.skill.name, source: decision.source },
    )
    if (!committed) {
      // 并发下已被别的 worker 接管 —— 不重复入队，避免双发
      logger.warn(`草稿提交未生效（job ${jobPk}），可能已被其他 worker 处理`)
      return
    }
    if (cleaned !== draft) {
      logger.info(`草稿已清洗模型包裹痕迹（job ${jobPk}：${draft.length} → ${cleaned.length} 字）`)
    }
    // 技能要求人工审核（S-G）：与 S7 blacklist 的 hold 语义对齐 —— 草稿已落库、
    // 停 ready + hold_reason 计入待审聚合，但**不入自动外发队列**；人工放行走
    // sendNow（manualOverride 绕 manual 拦截，Gate 其余规则照走）。
    if (decision.skill.reviewMode === 'manual') {
      await options.repo.holdJob(jobPk, 'skill_review')
      emitStatus(jobPk, 'discussing', 'ready', `技能「${decision.skill.name}」策略需人工审核`, 'skill_review')
      logger.info(`技能策略转审（job ${jobPk} → ${decision.skill.name}）`)
      return
    }
    emitStatus(jobPk, 'discussing', 'ready', '草稿已生成')
    sendQueue.push(jobPk)
    scheduleFlush(0)
  }

  // ---------------------------------------------------------------- 外发段

  /** 崩溃恢复专用：凭既有回执把 job 从 sending 补记为 sent（不重复写消息、不动配额） */
  async function recoverAsSent(jobPk: number, note: string): Promise<void> {
    const recovered = await options.repo.markStatus(jobPk, 'sent', 'sending')
    if (!recovered) {
      // 已被并发处理（比如另一个 recovery 分支先跑到）—— 幂等退出
      logger.warn(`崩溃恢复补记未生效（job ${jobPk}），可能已被其他路径处理`)
      return
    }
    emitStatus(jobPk, 'sending', 'sent', note)
  }

  /**
   * 外发一个 job：Gate → send → markSent（严格串行）。
   *
   * 返回值 = **本 job 是否真的发出去了**，调用方用它避免在同一轮冲刷里反复
   * 重试刚被挂起的任务（见 `flush()` 的 `deferredThisPass`）。
   */
  async function sendOne(jobPk: number): Promise<boolean> {
    const settings = options.settings()
    const job = await options.repo.getJob(jobPk)
    if (!job) return false

    // —— 崩溃恢复：库里残留 sending（§6.3 第二分支） ——
    if (job.status === 'sending') {
      if (await options.repo.hasOutgoingReceipt(jobPk)) {
        await recoverAsSent(jobPk, '崩溃恢复：查到外发回执，补记已发送')
        return true
      }
      await options.repo.suspendJob(jobPk)
      emitStatus(jobPk, 'sending', 'ready', '崩溃恢复：无回执，回落 ready 待重发')
      // 回落 ready 是**为了重发**，所以必须重新排队并留一根重试定时器；
      // 只改状态不排队 = 这条草稿永远不会再被外发（重启后静默丢失）。
      sendQueue.push(jobPk)
      scheduleRetry()
      return false
    }
    // 前置检查恒为 ready（要点3）
    if (job.status !== 'ready') return false

    // manual 模式：不自动外发，停 ready + hold_reason（计入 reviewCount O7）
    if (job.sendModeUsed === 'manual' && !manualOverride.has(jobPk)) {
      await options.repo.holdJob(jobPk, 'manual_mode')
      emitStatus(jobPk, 'ready', 'ready', '人工模式待确认', 'manual_mode')
      options.emit({ type: 'safetyChanged', snapshot: options.gate.snapshot() })
      return false
    }
    manualOverride.delete(jobPk)

    const conv = await options.repo.getConversation(job.targetId)
    /**
     * S5 需要触发消息的发送者工号：`senderId` 传空会让 Gate 的合并判定
     * **永远短路**（它刻意不对未知发送者做合并），规则形同虚设。
     * job 只存了 `trigger_msg_pk`，因此这里补一次主键查询 —— 单行读，
     * 且只在「即将外发」这一条路径上发生（不在 check 的循环里）。
     */
    const triggerMsg = conv ? await options.repo.getMessage(job.triggerMsgPk).catch(() => null) : null
    const senderId = triggerMsg?.senderId ?? ''
    const decision = options.gate.check({ job, senderId, conversation: conv })

    if (decision.action !== 'send') {
      switch (decision.action) {
        case 'skip':
          await options.repo.skipJob(jobPk, decision.reason)
          emitStatus(jobPk, 'ready', 'skipped', decision.detail)
          break
        case 'hold':
          await options.repo.holdJob(jobPk, decision.reason)
          emitStatus(jobPk, 'ready', 'ready', decision.detail, String(decision.reason))
          break
        case 'defer':
          // 挂起：回 ready（无 hold_reason），等下一轮重试。
          //
          // 为什么用**单列的 retryTimer** 而不是 `scheduleFlush(retryDelayMs)`：
          // 0ms 的冲刷请求（新草稿就绪）会顶掉长延时排程，被挂起的任务就再也
          // 等不到重试。`scheduleRetry()` 保证「只要还有任务在等，就恒有一根
          // 重试定时器」，且多任务共用同一根。
          //
          // 短期挂起（静默时段/全局配额）值得重排；长期挂起（会话静音）等下次
          // 入队更省，避免每个 tick 无意义刷库。
          await options.repo.suspendJob(jobPk)
          emitStatus(jobPk, 'ready', 'ready', decision.detail)
          sendQueue.push(jobPk)
          if (!decision.terminal) scheduleRetry()
          break
      }
      options.emit({ type: 'safetyChanged', snapshot: options.gate.snapshot() })
      return false
    }

    // 乐观锁置 sending：并发/重复投递只有一个能拿到（D12 的核心保证）
    const locked = await options.repo.markStatus(jobPk, 'sending', 'ready')
    if (!locked) return false
    emitStatus(jobPk, 'ready', 'sending', 'Gate 放行，开始外发')

    const port = options.port(settings)
    try {
      const receipt = await port.send({ convId: job.targetId, convType: job.targetType }, job.draft)
      const sentAt = nowStamp(now())
      const convPk = conv?.pk ?? 0
      const recorded = await options.repo.markSent(jobPk, {
        msgUid: receipt.msgUid,
        sentAt,
        convPk,
        content: job.draft,
      })
      if (!recorded) {
        // sending 锁已保证唯一，走到这里说明状态被外部改动（如人工删除任务）—— 不重复记账
        logger.warn(`发送成功但记账未生效（job ${jobPk}），已跳过重复记账`)
        return true
      }
      // 配额扣减**只在发送成功后**（否则失败会白吃配额）
      options.gate.onSent(job.targetId, senderId)
      emitStatus(jobPk, 'sending', 'sent', '已发送')
      options.emit({ type: 'safetyChanged', snapshot: options.gate.snapshot() })
      if (conv) {
        // 让消息中心即时看到自己发出的那条（增量补丁，不整表刷新；pk 用负数占位）
        options.emit({
          type: 'messagesAppended',
          convId: job.targetId,
          messages: [
            {
              pk: -Date.now(),
              convPk,
              msgUid: receipt.msgUid,
              convType: job.targetType,
              convId: job.targetId,
              direction: 'out',
              senderId: '',
              senderName: '我',
              content: job.draft,
              msgType: 'text',
              atMe: false,
              readFlag: true,
              sentAt,
            },
          ],
        })
      }
      logger.info(`已回复（job ${jobPk} → ${conv?.title || job.targetId}）`)
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)

      // 重发前必须核对回执：上一次可能「发出去了但没记上」（§6.2 防双发）
      if (await options.repo.hasOutgoingReceipt(jobPk)) {
        await recoverAsSent(jobPk, '发送报错但查到外发回执，补记 sent 以防重复发送')
        // 有回执 = 大概率真的发出去了 → 计入配额并刷新 S1 基线（防止紧接着再回一条）
        options.gate.onSent(job.targetId, senderId)
        logger.warn(`发送报错但存在回执（job ${jobPk}），补记 sent 以防重复发送`)
        return true
      }

      const attempts = job.attempts + 1
      if (attempts < MAX_SEND_ATTEMPTS) {
        await options.repo.recordAttemptFailure(jobPk, 'ready', message)
        emitStatus(jobPk, 'sending', 'ready', `发送失败，第 ${attempts} 次重试：${message}`)
        sendQueue.push(jobPk)
        scheduleRetry(Math.min(60_000, attempts * 5000))
      } else {
        await options.repo.recordAttemptFailure(jobPk, 'failed', message)
        emitStatus(jobPk, 'sending', 'failed', `发送重试 ${attempts} 次耗尽：${message}`)
      }
      return false
    }
  }

  // ---------------------------------------------------------------- 调度

  /** 统一的冲刷：先跑满生成段（并发 N），再串行清空外发段 */
  async function flush(): Promise<number> {
    if (!running) return 0
    let handled = 0
    /**
     * 本轮**被挂起（defer/hold）后又被放回队列**的 job。
     *
     * 为什么需要这个集合：`sendOne` 在挂起时会把 job 推回 `sendQueue`（否则它
     * 永远等不到重试）。但本轮循环还会继续消费队列 —— 同一批里它会被再次取出、
     * 再次判定、再次推回，`for` 循环就这样空转到 guard 上限（500 次库操作），
     * `drain()` 也跟着白等。把「本轮已挂起过」的 job 在一轮冲刷内跳过，
     * 让它**只在定时器到点后的下一轮**重试。
     */
    const deferredThisPass = new Set<number>()

    for (let guard = 0; guard < 500; guard += 1) {
      // —— 生成段：并发 N（无副作用，可并行） ——
      while (inflightGenerate.size < GENERATE_CONCURRENCY && generateQueue.length) {
        const jobPk = generateQueue.shift()!
        handled += 1
        const task = generateOne(jobPk).catch((error) => {
          logger.error(`生成段异常（job ${jobPk}）`, error)
        })
        inflightGenerate.add(task)
        void task.finally(() => {
          inflightGenerate.delete(task)
          // 队列非空就再冲刷一次，把同批的活干完（P2 的链式语义）。
          // 注意**不含** retryGenerate：延迟重试由 `scheduleRetry` 的定时器驱动，
          // 若这里也排一次 0ms 冲刷，等于把刚设的延时又抹掉了。
          if (sendQueue.length || generateQueue.length) scheduleFlush(0)
        })
      }

      // —— 外发段：严格串行 ——
      if (!sendActive && sendQueue.length) {
        // 取队首；队首是「本轮刚挂起」的就先放下，看后面还有没有能立刻处理的
        const jobPk = sendQueue[0]
        if (deferredThisPass.has(jobPk)) {
          // 整队都已挂起过（挂起的都推回队尾了）→ 本轮到此为止
          if (deferredThisPass.size >= sendQueue.length) break
          sendQueue.shift()
          sendQueue.push(jobPk)
          continue
        }
        sendQueue.shift()
        handled += 1
        sendActive = true
        try {
          const sent = await sendOne(jobPk)
          // 没发出去 = 被拦截/挂起 —— 记录下来，避免本轮空转重试
          if (!sent) deferredThisPass.add(jobPk)
        } catch (error) {
          logger.error(`外发段异常（job ${jobPk}）`, error)
          deferredThisPass.add(jobPk)
        } finally {
          sendActive = false
        }
        continue
      }

      // 生成段在飞 / 无活可干 → 让出控制权（新任务由 finally 重排）
      break
    }
    return handled
  }

  /** 常规冲刷排程（0ms = 立刻；新草稿就绪走这条） */
  function scheduleFlush(delayMs: number) {
    if (!running) return
    if (flushTimer !== null) {
      // 已有待执行的冲刷：0ms 请求优先（立刻处理新产生的草稿），长延时请求不插队
      if (delayMs > 0) return
      timers.clear(flushTimer)
    }
    flushTimer = timers.set(
      () => {
        flushTimer = null
        void flush()
      },
      Math.max(0, delayMs),
    )
  }

  /**
   * 重试排程（与 `scheduleFlush` 刻意分开），也是生成段延时重试的**唯一入口**。
   *
   * 背景是两个真实的缺陷：
   *  1. `scheduleFlush` 的规则是「0ms 请求顶掉长延时」—— defer 挂起的任务用
   *     `scheduleFlush(retryDelayMs)` 排的重试，会被期间任何一次新草稿就绪的
   *     `scheduleFlush(0)` **丢掉**，它于是永远卡在 ready。
   *  2. 生成失败的任务若直接推回 `generateQueue`，会被冲刷循环末尾
   *     「任务完成→队列非空→0ms 再冲刷」的重排立刻重跑，1500ms 的延时形同虚设
   *     （真实表现：Agent 一抖，3 次尝试在毫秒内烧完，直接判 failed 交人工）。
   *
   * 到点后先**把延时重试的生成任务放回生成队列**，再冲刷一次。多个挂起任务
   * 共用同一根定时器；已有排程时保留更早的那个，避免被反复推后。
   */
  function scheduleRetry(delayMs = retryDelayMs) {
    if (!running) return
    if (retryTimer !== null) return
    retryTimer = timers.set(
      () => {
        retryTimer = null
        while (retryGenerate.length) generateQueue.push(retryGenerate.shift()!)
        // 多个任务在同一根定时器上汇聚时，按**最先到点**的那个排下一次（各自倍数已算过，
        // 这里取最小值是为保守；实际生产里同一时刻很少有两个生成任务同时进重试）
        if (retryGenerate.length) {
          let soonest = GENERATE_RETRY_MS
          for (const pk of retryGenerate)
            soonest = Math.min(soonest, GENERATE_RETRY_MS * 2 ** (generateRetries.get(pk) ?? 0))
          scheduleRetry(soonest)
        }
        void flush()
      },
      Math.max(0, delayMs),
    )
  }

  return {
    start() {
      if (running) return
      running = true
      logger.info(`WeLink 回复管线已启动（生成并发 ${GENERATE_CONCURRENCY} / 外发串行 1）`)
      scheduleFlush(0)
    },

    stop() {
      running = false
      timers.clear(flushTimer)
      flushTimer = null
      timers.clear(retryTimer)
      retryTimer = null
      logger.info('WeLink 回复管线已停止（未完成任务保留在库中）')
    },

    running() {
      return running
    },

    enqueue(jobPk) {
      const queued = generateQueue.includes(jobPk) || sendQueue.includes(jobPk) || retryGenerate.includes(jobPk)
      if (!queued) generateQueue.push(jobPk)
      scheduleFlush(0)
    },

    enqueueMany(jobPks) {
      for (const jobPk of jobPks) {
        const queued = generateQueue.includes(jobPk) || sendQueue.includes(jobPk) || retryGenerate.includes(jobPk)
        if (!queued) generateQueue.push(jobPk)
      }
      scheduleFlush(0)
    },

    async drain() {
      // 把队列跑到空：反复冲刷直到没有队列积压、生成段也回落
      let handled = 0
      for (let round = 0; round < 100; round += 1) {
        handled += await flush()
        if (inflightGenerate.size) {
          await Promise.allSettled([...inflightGenerate])
          continue
        }
        // 延时重试（生成失败/AI 挂起）就让它们留在队列里等定时器，
        // 不在 drain 里空转 —— 「立刻把队列跑到空」不该包含「等退避」
        if (generateQueue.length || sendQueue.length) continue
        break
      }
      return handled
    },

    pending() {
      return {
        generate: generateQueue.length + retryGenerate.length + inflightGenerate.size,
        send: sendQueue.length + (sendActive ? 1 : 0),
      }
    },

    async sendNow(jobPk) {
      const job = await options.repo.getJob(jobPk)
      if (!job) return false
      if (!job.draft.trim()) {
        // 没有草稿不得外发（要点3：库中无草稿不得外发）
        logger.warn(`人工发送被拒（job ${jobPk}）：草稿为空`)
        return false
      }
      // failed / skipped 的人工重发：先回 ready（Gate 仍会再判一遍）
      if (job.status === 'failed' || job.status === 'skipped') {
        const requeued = await options.repo.requeueJob(jobPk)
        if (!requeued) return false
        emitStatus(jobPk, job.status, 'ready', '人工重发，回到待发送队列')
      } else if (job.status !== 'ready') {
        // 人工通道只接受「有草稿的 ready / failed / skipped」。
        // 其余（pending/discussing/sending/sent）说明还没有可发的内容或已在处理中，
        // 硬塞进外发队列会让 sendOne 的前置检查白跑一遍（并发出误导性的 ready>ready 事件）。
        logger.warn(`人工发送被拒（job ${jobPk}）：状态 ${job.status} 不可直接外发`)
        return false
      }
      manualOverride.add(jobPk)
      if (!sendQueue.includes(jobPk)) sendQueue.push(jobPk)
      scheduleFlush(0)
      return true
    },
  }
}

/**
 * 检索片段拼装（rag-retrieval D-I）：minScore过滤 + maxChars 截断。
 *
 * 结构头（【知识N】+ 来源 + 相关度）由本端生成，防知识正文伪造行结构；
 * 正文经 `sanitizeTrustedContent` **结构消毒**（S-03）——原设计假设
 * 「攻击面 = 用户自己的知识库」，但 `sediment.mode='auto'` 时知识库会被
 * 免审写入群消息提取内容，攻击面是「任意群成员」。消毒只拍平换行/剥控制字符，
 * **不改语义**（知识片段的分步骤结构要保留），长度由 maxChars 管。
 * 片段永不作为回复正文外发。
 */
/**
 * 技能绑定知识文档拼装（knowledge-sedimentation K-F）：按绑定顺序读取清单内文档，
 * 总长受 docsMaxChars 截断（首篇超限硬截断正文，与 formatRetrieved 同策略）。
 * 清单外的绑定文件由 resolveDocs 静默剔除（「仅保留清单内文件名」的消费侧落点）；
 * 清单内但读不到的文件计入 missing 由调用方告警。
 */
async function formatBoundDocs(
  port: KnowledgePort,
  files: string[],
  maxChars: number,
): Promise<{ text: string; hit: number; missing: string[] }> {
  const docs = await port.resolveDocs(files)
  const parts: string[] = []
  const missing: string[] = []
  let total = 0
  for (const doc of docs) {
    const raw = await port.readDoc(doc.file)
    if (raw === null) {
      missing.push(doc.file)
      continue
    }
    // S-03：先结构消毒再算预算 —— 消毒会改变长度（控制字符被剥、换行被拍平），
    // 先消毒才保证 maxChars 是**注入后**的真实上限。
    const content = sanitizeTrustedContent(raw)
    const head = `【文档·${doc.title}】\n`
    const budget = maxChars - total
    if (budget <= head.length) break
    const body = head.length + content.length > budget ? `${content.slice(0, budget - head.length - 1)}…` : content
    parts.push(head + body)
    total += head.length + body.length
  }
  return { text: parts.join('\n\n'), hit: parts.length, missing }
}

function formatRetrieved(chunks: RagChunk[], rag: WelinkRagSettings): string {
  const parts: string[] = []
  let total = 0
  let index = 0
  for (const chunk of chunks) {
    if (chunk.score < rag.minScore) continue
    index += 1
    const head = `【知识${index}】(来源 ${chunk.source || '未知'}, 相关度 ${chunk.score.toFixed(2)})\n`
    const budget = rag.maxChars - total
    if (budget <= head.length) break
    // S-03：结构消毒（剥控制字符 + 拍平换行），只降结构伪造风险、不改语义。
    // 先消毒再算长度，保证 maxChars 是注入后的真实上限。
    const content = sanitizeTrustedContent(chunk.content)
    // 首块超限时硬截断正文（保底注入部分知识而非空串）；后续块按相关性优先装满
    const body = head.length + content.length > budget ? `${content.slice(0, budget - head.length - 1)}…` : content
    parts.push(head + body)
    total += head.length + body.length
  }
  return parts.join('\n\n')
}
