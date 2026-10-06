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
import { welink, type WelinkRepository } from '@/infra/db'
import { agentClient, type AgentClient } from '@/infra/agent'
import { ragClient } from '@/infra/rag'
import { welinkClient, type WelinkPort } from '@/infra/welink'
import type { WelinkSettings } from '@/types/welink'
import { logger } from '@/utils/logger'
import { createBootstrap, type Bootstrap, type BootstrapReport } from './bootstrap'
import type { EventSink } from './events'
import { createPipeline, type Pipeline } from './pipeline'
import { createPoller, type Poller } from './poller'
import { createRetention, type Retention, type RetentionReport } from './retention'
import { createSafetyGate, type SafetyGate } from './safety-gate'
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
}

export interface WelinkRuntime {
  repo: WelinkRepository
  gate: SafetyGate
  poller: Poller
  pipeline: Pipeline
  bootstrap: Bootstrap
  /** 保留期清理器（每日一次；手动触发与上次结果供监控页用） */
  retention: Retention
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
  const agentInstance = resolveAgent ?? agentClient({ settings: currentSettings.agent })
  // rag 实例经工厂 getter 注入：ragClient 缓存键含连接配置，reload 换配置后下一次
  // 检索自动取到新实例（热更新）；固定实例会让 baseUrl/密钥变更必须重启助手
  const ragInstance = () => ragClient({ settings: currentSettings.rag })

  const pipeline = createPipeline({
    repo,
    gate,
    agent: agentInstance,
    rag: ragInstance,
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

  let started = false

  return {
    repo,
    gate,
    poller,
    pipeline,
    bootstrap,
    retention,

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
      return report
    },

    stop() {
      // 停的顺序与启动相反：先断生产（轮询）再断消费（管线），
      // 避免停止瞬间还有新任务入队却没人处理。清理器最后停：它不产生任务，
      // 但会改数据，等采集与处理都安静下来再收尾最安全。
      poller.stop()
      pipeline.stop()
      retention.stop()
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
      currentSettings = next
      gate.reload(next)
      logger.info('WeLink 配置已热更新（配额与冷却状态保留）')
    },

    running() {
      return started && poller.running()
    },
  }
}
