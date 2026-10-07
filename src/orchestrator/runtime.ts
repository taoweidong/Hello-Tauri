/**
 * 编排层组合根（Composition Root）。
 *
 * 职责单一：**把端口、仓储、闸口、轮询器、管线、恢复器装配成一个可启动的整体**，
 * 并把「启动 / 停止 / 急停 / 立即拉取」这些生命周期动作收口成一组干净的方法。
 *
 * 为什么要有这一层（而不是让 store 直接 new 各部件）：
 *  * 依赖方向必须向下（D8）—— store 不知道 repo/端口怎么来的，只调 `runtime.xxx()`；
 *  * 单测可以整块替换依赖（注入 mock 端口/repo/假时钟），跑「mock→库→mock agent→
 *    Gate→mock send」全链路，而不触碰真实计时器与真实 SQLite；
 *  * 打开/关闭助手涉及 5 个部件的启停顺序（管线先起、轮询后起；停则反过来），
 *    散落在 store 里必然写乱。
 */
import { sediment as sedimentRepoFactory, welink, type SedimentRepository, type WelinkRepository } from '@/infra/db'
import { knowledgePort, type KnowledgePort } from '@/infra/knowledge'
import { createKnowledgeHarvester, type KnowledgeHarvester } from './knowledge-harvester'
import { agentClient, type AgentCallRecord, type AgentClient } from '@/infra/agent'
import { ragClient } from '@/infra/rag'
import { welinkClient, type WelinkPort } from '@/infra/welink'
import type { WelinkAgentSettings, WelinkSettings } from '@/types/welink'
import { logger } from '@/utils/logger'
import { createBootstrap, type Bootstrap, type BootstrapReport } from './bootstrap'
import type { EventSink } from './events'
import { createPipeline, type Pipeline } from './pipeline'
import { createPoller, type Poller } from './poller'
import { createRetention, type Retention, type RetentionReport } from './retention'
import { createSafetyGate, type SafetyGate } from './safety-gate'
import { registerWelinkSecrets } from './secrets'
import type { TimerApi } from './timers'

export interface WelinkRuntimeOptions {
  settings: () => WelinkSettings
  emit: EventSink
  repo?: WelinkRepository
  /** 端口/客户端注入（测试用；默认走工厂，浏览器模式自动 mock） */
  port?: (settings: WelinkSettings) => WelinkPort
  agent?: AgentClient
  timers?: TimerApi
  now?: () => Date
  /** 关掉自动启动（测试里手动控制启停） */
  autoStart?: boolean
  /** 轮询会话间错峰（测试传 0） */
  staggerMs?: number
  /** 保留期清理的首轮延迟与间隔（测试传小值；生产用默认的每日一次） */
  retention?: { firstDelayMs?: number; intervalMs?: number }
  /** 沉淀域仓储注入（测试用；默认走工厂） */
  sedimentRepo?: SedimentRepository
  /** 知识库端口注入（测试用；默认走工厂） */
  knowledge?: KnowledgePort
}

export interface WelinkRuntime {
  repo: WelinkRepository
  gate: SafetyGate
  poller: Poller
  pipeline: Pipeline
  bootstrap: Bootstrap
  /** 保留期清理器（每日一次；手动触发与上次结果供监控页用） */
  retention: Retention
  /** 知识沉淀管线（周期提取与「立即提取」；独立于回复链路） */
  harvester: KnowledgeHarvester
  /** 端口实例（演示剧本 / 来源徽标用） */
  port(): WelinkPort
  agent(): AgentClient
  /** 启动助手（恢复 + 起调度），返回恢复报告 */
  start(): Promise<BootstrapReport>
  /** 停止助手（数据与未完成任务保留） */
  stop(): void
  /** 立即拉取（与自动轮询共用 in-flight 锁） */
  pullNow(): Promise<import('./events').PollSummary>
  /** 立即执行一轮保留期清理（与每日自动轮次共用 single-flight） */
  purgeNow(): Promise<RetentionReport>
  /** 窗口可见性（P9）：隐藏时轮询间隔 ×3 */
  setVisible(visible: boolean): void
  /** 配置热更新（改设置后调用） */
  reload(settings: WelinkSettings): void
  /** 是否运行中 */
  running(): boolean
}

export function createWelinkRuntime(options: WelinkRuntimeOptions): WelinkRuntime {
  const repo = options.repo ?? welink()
  const resolvePort = options.port ?? ((settings: WelinkSettings) => welinkClient({ settings }))
  const resolveAgent = options.agent ?? null
  let currentSettings = options.settings()

  /**
   * 事件中转（**组合根的核心接线**）。
   *
   * `poller` 建出新 job 后只发 `jobCreated` 事件，它并不知道管线存在（依赖方向
   * 向下）。把「事件 → 入队」这一步统一收在这里，而不是让 poller 直接持有
   * `pipeline`：poller 多一个依赖就多一处可以写乱的地方，而且生产端不止一处
   * （将来手工补建、批量导入都要走同一条路）。
   *
   * 漏接这一环的后果是**端到端自动回复彻底不通**：总开关打开后新任务永远停在
   * `pending`，直到下次重启才被 bootstrap 捞回 —— 这正是设计 §6.1 时序图里
   * 「P->>PL: 新 job 入队」那根箭头。
   *
   * 先入队再转发事件：`enqueue` 只是推队列 + 排 0ms 冲刷（同步返回），
   * store 拿到事件时任务已在管线里，UI 的「排队中」不会出现一闪而过的假状态。
   */
  let pipelineRef: Pipeline | null = null
  const emit: EventSink = (event) => {
    if (event.type === 'jobCreated') pipelineRef?.enqueue(event.job.pk)
    options.emit(event)
  }

  const gate = createSafetyGate({
    settings: currentSettings,
    now: options.now,
  })
  // Agent 实例经**代理 + 可变 holder** 注入（P-02）：
  //
  // 背景：`agentClient` 工厂按配置键缓存实例，换baseUrl/endpoint/model/apiKey 后
  // 会返回新实例；而这里原先只在装配时取一次固定引用，导致设置页改完模型或密钥，
  // 管线仍在用旧端点（rag 早已用 getter 修好，agent 漏了）。
  //
  // 为什么不用 getter 改三处类型：`agent` 是 pipeline / harvester / skill-router
  // 三个模块的构造参数，全改成 `() => AgentClient` 会连带改它们的类型与测试夹具。
  // 代理对象把「取当前实例」这件事收在 runtime 内部，下游零改动。
  //
  // 为什么不用「reload 时重建并重新装配 pipeline」：pipeline/harvester/router 三者
  // 都持有引用，重装配要重建整条链且丢掉已注册的 onCall 录音钩子。
  //
  // 注意 `resolveAgent` 是测试注入点：给了它就永远固定（单测要可预测），
  // 这也是原设计的意图 —— 生产路径 `options.resolveAgent` 为 undefined。
  const agentHolder: { current: AgentClient } = {
    current: resolveAgent ?? agentClient({ settings: currentSettings.agent }),
  }
  /**
   * 录音钩子表：**代理自己持有**，不交给实例。
   *
   * 踩过的坑：最初写成 `onCall: (h) => agentHolder.current.onCall(h)`，
   * 测试立刻抓到换实例后钩子丢失（第二次调用没有留痕）——
   * `agentClient` 的 `handlers` 与实例同生命周期，新实例是空的。
   *
   * 由此推出两条硬约束（改这段前必读）：
   *  1. **换实例后必须补注册**，否则「改了模型之后 agent_logs 就没留痕了」，
   *     而留痕是 R4 语料分析的基础（见下方 replaceAgent）。
   *  2. 钩子表在**代理**上，故实例被换掉也不影响已注册的 handler。
   */
  const agentCallHandlers: Array<(record: AgentCallRecord) => void> = []
  /** 换实例并把已注册的录音钩子补挂到新实例上 */
  function replaceAgent(next: AgentClient): void {
    agentHolder.current = next
    for (const handler of agentCallHandlers) next.onCall(handler)
  }
  const agentProxy: AgentClient = {
    complete: (prompt) => agentHolder.current.complete(prompt),
    onCall: (handler) => {
      agentCallHandlers.push(handler)
      agentHolder.current.onCall(handler)
    },
  }
  const agentInstance = agentProxy
  // rag 实例经工厂 getter 注入：ragClient 缓存键含连接配置，reload 换配置后下一次
  // 检索自动取到新实例（热更新）；固定实例会让 baseUrl/密钥变更必须重启助手
  const ragInstance = () => ragClient({ settings: currentSettings.rag })

  const pipeline = createPipeline({
    repo,
    gate,
    agent: agentInstance,
    rag: ragInstance,
    knowledge: () => knowledgePort(),
    port: resolvePort,
    settings: () => currentSettings,
    emit,
    timers: options.timers,
    now: options.now,
  })
  pipelineRef = pipeline

  /**
   * 熔断通知（S8 → UI 横幅）。
   *
   * `onFuse` 是 Gate 唯一向外的主动通知口：必须在组合根注册，否则
   * `fuseTripped` 事件永远发不出去，§11.0 的「熔断横幅」只能靠下一次
   * `refreshSafety` 被动补上（用户看不到「刚刚发生了什么」）。
   */
  gate.onFuse((info) => emit({ type: 'fuseTripped', scope: info.scope, reason: info.reason, blocked: info.blocked }))

  const poller = createPoller({
    repo,
    settings: () => currentSettings,
    emit,
    timers: options.timers,
    now: options.now,
    staggerMs: options.staggerMs,
    client: resolvePort,
  })

  const bootstrap = createBootstrap({
    repo,
    poller,
    pipeline,
    gate,
    settings: () => currentSettings,
    emit,
    autoStart: options.autoStart ?? currentSettings.enabled,
  })

  /**
   * 保留期清理（D-1 + S-4）。
   *
   * 挂在这里而不是 bootstrap 里：bootstrap 的语义是「**一次性**启动恢复」，
   * 而清理是**周期性**动作，生命周期跟随 runtime 的 start/stop。混进 bootstrap
   * 会让「重启一次只恢复一次」这条不变量变得含糊。
   *
   * start 时机：只有助手真正在跑（`runsScheduler`）才起清理 —— 总开关关闭时
   * 用户没在采集数据，后台不需要动库（也避免「关了助手还在改数据」的困惑）。
   */
  const retention = createRetention({
    repo,
    timers: options.timers,
    now: options.now,
    firstDelayMs: options.retention?.firstDelayMs,
    intervalMs: options.retention?.intervalMs,
  })

  /**
   * 知识沉淀管线（K-A：与 poller/pipeline 平行的第三条链路）。
   *
   * 生命周期跟随 runtime 的 start/stop；是否真正干活由每轮的
   * `settings.sediment.enabled` 自检（总开关关闭时轮次直接返回 disabled）——
   * 调度常驻、轮次自检，避免「改配置还要重启助手」。
   */
  const harvester = createKnowledgeHarvester({
    sediment: options.sedimentRepo ?? sedimentRepoFactory(),
    welink: repo,
    port: () => resolvePort(currentSettings),
    knowledge: options.knowledge ?? knowledgePort(),
    agent: agentInstance,
    settings: () => currentSettings,
    timers: options.timers,
    now: options.now,
  })

  let started = false

  return {
    repo,
    gate,
    poller,
    pipeline,
    bootstrap,
    retention,
    harvester,

    port() {
      return resolvePort(currentSettings)
    },

    agent() {
      return agentInstance
    },

    async start() {
      currentSettings = options.settings()
      gate.reload(currentSettings)
      const report = await bootstrap.run()
      started = currentSettings.enabled
      if (started) retention.start()
      harvester.start()
      return report
    },

    stop() {
      // 停的顺序与启动相反：先断生产（轮询）再断消费（管线），
      // 清理器与沉淀管线最后停：它们不产生任务，但会改数据，
      // 等采集与处理都安静下来再收尾最安全。
      poller.stop()
      pipeline.stop()
      retention.stop()
      harvester.stop()
      started = false
    },

    pullNow() {
      return poller.pullNow()
    },

    purgeNow() {
      return retention.runOnce()
    },

    setVisible(visible) {
      poller.setVisible(visible)
    },

    reload(next) {
      const prevAgent = currentSettings.agent
      currentSettings = next
      gate.reload(next)
      // P-02：配置里的 Agent 连接参数变了就换实例 —— 否则改模型/密钥不生效
      // （设置页提示「改完即生效」，实际管线仍用旧端点）。
      // 只在**真的变了**时重建：agentClient 的 `onCall` handlers 与实例同生命周期，
      // 每次 reload 都换实例会丢掉已注册的录音钩子，导致 agent_logs 留痕中断。
      if (!resolveAgent && agentConfigChanged(prevAgent, next.agent)) {
        // 必须走 replaceAgent：新实例的 handlers 是空的，
        // 直接赋值会丢掉已注册的录音钩子（agent_logs 留痕中断）。
        replaceAgent(agentClient({ settings: next.agent }))
      }
      // S-04：热更新路径同样要把密钥注册进日志遮蔽表 —— 用户可能刚在设置页
      // 换了一把新 key，而这次换 key 不经过 store 的某些路径。
      registerWelinkSecrets(next)
      logger.info('WeLink 配置已热更新（配额与冷却状态保留）')
    },

    running() {
      return started && poller.running()
    },
  }
}

/**
 * Agent 连接配置是否变化（决定 `reload` 要不要换实例）。
 *
 * **字段必须与 `infra/agent/index.ts` 里 `agentClient` 的缓存键严格一致** ——
 * 少判一个就会「改了却复用旧实例」，多判一个则白白丢掉录音钩子。
 * 那边参与的字段：agentSource / baseUrl / endpoint / model / apiKey / timeoutMs
 * （外加 `options.mock`，仅测试注入，不走本函数）。
 *
 * 刻意**不**纳入 promptTemplate / skills / maxContextMsgs 等内容字段：
 * 它们不参与实例缓存，换了用同一个客户端即可（内容是每次请求现传的）。
 */
function agentConfigChanged(prev: WelinkAgentSettings, next: WelinkAgentSettings): boolean {
  return (
    prev.agentSource !== next.agentSource ||
    prev.baseUrl !== next.baseUrl ||
    prev.endpoint !== next.endpoint ||
    prev.model !== next.model ||
    prev.apiKey !== next.apiKey ||
    prev.timeoutMs !== next.timeoutMs
  )
}
