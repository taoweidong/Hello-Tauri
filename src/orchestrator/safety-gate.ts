/**
 * SafetyGate —— 唯一外发出口（设计 §5A）。
 *
 * **所有外发动作必经此处**：管线的外发 worker 在 `send` 之前调用 `check()`，
 * 编排层无法绕开。每一条被拦下的发送都以 `skipped` + `skip_reason` 落库留痕
 * ——「宁可不回，不可滥发」。
 *
 * 判定顺序严格照 §5A.3 的流程图，纵向主链全通过才放行：
 *
 * ```
 * L0 急停 → L1 总开关 → L2 场景开关 → L3 会话开关(+O11 静音) → S8 熔断
 *   → S4 静默 → S6 草稿防护 → S7 黑名单 → S1 会话间隔 → S5 同人合并
 *   → S2 会话小时配额 → S3 全局小时配额 → 放行（扣配额）
 * ```
 *
 * 三个实现要点（改代码前必读）：
 *  1. **零 SELECT**（O5）：会话开关、S1–S3 计数全在内存，会话 upsert 时失效；
 *     启动时由组合根用 `primeConversation/primeGlobal` 预热一次。
 *  2. **配额只在 `onSent` 扣减**：`check()` 是纯判定（幂等，可重复调用），
 *     扣减发生在发送成功之后 —— 否则发送失败会白白吃掉配额。
 *  3. **熔断是状态而不是计数**：触发后写进 `fuses` 集合，该场景后续 job 一律
 *     `skip(fused)`，直到人工 `resetFuse()`；期间拉取与存档照常。
 */
import type { HoldReason, SkipReason, WelinkConversation, WelinkJob, WelinkSettings } from '@/types/welink'
import { nowStamp, parseStamp } from '@/utils/time'
import type { SafetySnapshot } from './events'

/** Gate 判定结果（四选一，语义见设计 §5A.3 的三个右侧出口 + 主链） */
export type GateDecision =
  /** 放行：调用方随后必须调用 `onSent()` 扣配额 */
  | { action: 'send'; reason: ''; detail: string }
  /** 终态拦截：`skipped` + `skip_reason` 留痕 */
  | { action: 'skip'; reason: SkipReason | string; detail: string }
  /** 转人工待审：停 `ready` + `hold_reason`（计入 reviewCount O7） */
  | { action: 'hold'; reason: HoldReason | string; detail: string }
  /**
   * 挂起：回 `ready`（不带 hold_reason），等下一轮外发重试。
   *
   * `terminal` 区分两种挂起：静默时段/全局配额是**短期**等待（时段结束或下小时
   * 自动补发），而会话静音/熔断属于**长期**等待 —— 后者若每个 tick 重试，会
   * 无意义地刷库。调用方据此决定「立刻重试」还是「等下一轮」。
   */
  | { action: 'defer'; reason: SkipReason | string; detail: string; terminal: boolean }

export interface GateCheckInput {
  job: WelinkJob
  /** 触发消息发送者工号（S5「同人短窗合并」用；未知传空串则不做合并判定） */
  senderId: string
  /** 会话快照；会话已被删除时传 null（→ target_missing） */
  conversation: WelinkConversation | null
}

export interface SafetyGate {
  /** 判定（纯函数语义：不改状态、不落库，可安全重复调用） */
  check(input: GateCheckInput): GateDecision
  /** 发送成功后调用：扣减配额、记录 S1 时间基线、写 S5 合并基线 */
  onSent(targetId: string, senderId: string): void
  /** L0 一键急停开关 */
  setPanic(on: boolean): void
  /** L1 助手总开关快照（控制条 start/stop 之外的第二道保险） */
  setEnabled(on: boolean): void
  /** 配置热更新（改设置后调用；计数与冷却保留，避免「改个参数配额就清零」） */
  reload(settings: WelinkSettings): void
  /** 配置读取（管线分派时复用同一份） */
  settings(): WelinkSettings
  /** 该场景是否熔断中 */
  fused(scope: string): boolean
  /** 人工解除熔断（scope 省略 = 全部） */
  resetFuse(scope?: string): void
  /** 会话开关变更后失效缓存（O5） */
  invalidateConversation(convId: string): void
  /**
   * 会话开关快照写入缓存（O5）。
   *
   * 缓存**必须有写入方**，否则 `invalidateConversation` 只是删一个永远不存在的键，
   * 「upsert 时失效」的机制名存实亡。调用点在会话增删改（`store.upsertConversation`）
   * 与轮询读到新会话时 —— 写的是**权威值**，`check()` 命中缓存即 0 次 SELECT。
   */
  cacheConversation(convId: string, autoReply: boolean, muteUntil: string | null): void
  /** 启动预热：某会话本小时已发条数与最后发送时间（O5，避免每次 check 查库） */
  primeConversation(convId: string, hourlyCount: number, lastSentAt: string | null): void
  /** 启动预热：全局本小时已发条数 */
  primeGlobal(hourlyCount: number): void
  /** 快照（控制条徽标/横幅的数据源） */
  snapshot(): SafetySnapshot
  /** 熔断触发回调（UI 弹横幅用；只回调一次/每个场景） */
  onFuse(handler: (info: { scope: string; reason: string; blocked: number }) => void): void
}

/**
 * 计入熔断的拦截原因（S8）。
 *
 * 刻意**不含** `empty/oversize/blacklist`：这三类是内容质量问题（草稿为空、
 * 模型写了承诺性语句），把它们算进「滥发风险」会导致熔断误伤 —— 一个模型
 * 老是输出裸链接，不该让整个场景停摆。
 */
const FUSE_REASONS = new Set<string>(['rate_conv', 'rate_conv_hourly', 'rate_global_hourly', 'merge_window'])

/** 间隔/配额类拦截才计入熔断 */
export interface GateOptions {
  settings: WelinkSettings
  /** 时间源（测试注入假时钟） */
  now?: () => Date
}

interface ConvState {
  /** 本小时已发送条数（S2） */
  hourly: number
  /** 计数所属的小时桶 `YYYY-MM-DD HH` */
  bucket: string
  /** 该会话最后一次成功外发时间（S1 基线，可来自库预热） */
  lastSentAt: string | null
  /** 该会话最近一次通过 Gate 的发送者 + 时间（S5 合并基线） */
  recentSender: string
  recentAt: number
}

interface FuseRecord {
  scope: string
  reason: string
  since: string
  blocked: number
}

export function createSafetyGate(options: GateOptions): SafetyGate {
  let settings = options.settings
  const now = options.now ?? (() => new Date())

  let panic = false
  let enabled = settings.enabled
  /** 会话开关缓存（O5）：upsert 时失效，避免每次 check 查库 */
  const convCache = new Map<string, { autoReply: boolean; muteUntil: string | null }>()
  const convStates = new Map<string, ConvState>()
  /** 全局计数 + 小时桶（S3） */
  let globalHourly = 0
  let globalBucket = bucketOf(now())
  let globalClosedUntil: string | null = null
  /** 熔断状态（S8）：scope → 记录 */
  const fuses = new Map<string, FuseRecord>()
  /** 熔断观察窗内的拦截计数：scope|reason → 时间戳数组 */
  const fuseHits = new Map<string, number[]>()
  const fuseHandlers: Array<(info: { scope: string; reason: string; blocked: number }) => void> = []
  /** S8 兜底：未填工号（进 Gate 即熔断，避免每条消息都走一遍） */
  let noUserIdFused = !settings.myUserId.trim()

  function bucketOf(date: Date): string {
    return nowStamp(date).slice(0, 13)
  }

  /** 跨小时则归零（懒重置：读的时候顺手判断，不需要定时器） */
  function rollHour() {
    const bucket = bucketOf(now())
    if (bucket !== globalBucket) {
      globalBucket = bucket
      globalHourly = 0
      globalClosedUntil = null
      for (const state of convStates.values()) {
        if (state.bucket !== bucket) {
          state.bucket = bucket
          state.hourly = 0
        }
      }
    }
  }

  function stateOf(convId: string): ConvState {
    let state = convStates.get(convId)
    if (!state) {
      state = { hourly: 0, bucket: globalBucket, lastSentAt: null, recentSender: '', recentAt: 0 }
      convStates.set(convId, state)
    }
    if (state.bucket !== globalBucket) {
      state.bucket = globalBucket
      state.hourly = 0
    }
    return state
  }

  /** S4：是否处于静默时段（支持跨零点区间，如 22:00–08:00） */
  function inQuietHours(): boolean {
    const quiet = settings.safety.quietHours
    if (!quiet.enabled) return false
    const minutes = now().getHours() * 60 + now().getMinutes()
    const from = toMinutes(quiet.from)
    const to = toMinutes(quiet.to)
    if (from === to) return false
    return from < to ? minutes >= from && minutes < to : minutes >= from || minutes < to
  }

  /** 草稿内容防护（S6） */
  function draftProblem(draft: string): { reason: SkipReason; detail: string } | null {
    const text = draft.trim()
    if (!text) return { reason: 'empty', detail: '草稿为空' }
    // 纯符号/纯空白不算有效回复：「。。。」发出去等于没回，还占了配额
    if (!/[\p{L}\p{N}]/u.test(text)) return { reason: 'empty', detail: '草稿无有效文字内容' }
    if (text.length > settings.safety.maxDraftChars) {
      return { reason: 'oversize', detail: `草稿 ${text.length} 字，超过上限 ${settings.safety.maxDraftChars}` }
    }
    return null
  }

  /** 黑名单正则命中（S7）：配置里写坏的正则**不能**让整条链路挂掉，逐条 try */
  function blacklistHit(draft: string): string | null {
    for (const pattern of settings.safety.blacklistPatterns) {
      if (!pattern.trim()) continue
      try {
        if (new RegExp(pattern, 'i').test(draft)) return pattern
      } catch {
        // 用户手写的正则可能有语法错，跳过该项而不是抛错
      }
    }
    return null
  }

  /** 静默时段内草稿已超 4h → 隔夜内容不盲发，转人工（§5A.2-S4） */
  function staleDraft(job: WelinkJob): boolean {
    const created = parseStamp(job.createdAt)
    if (!created) return false
    return now().getTime() - created.getTime() > 4 * 60 * 60 * 1000
  }

  /** 记录一次「间隔/配额类」拦截，判断是否触发熔断（S8） */
  function registerSkip(scope: string, reason: string): FuseRecord | null {
    if (!FUSE_REASONS.has(reason)) return null
    const key = `${scope}|${reason}`
    const windowMs = settings.safety.fuseWindowMin * 60 * 1000
    const nowMs = now().getTime()
    const hits = (fuseHits.get(key) ?? []).filter((at) => nowMs - at < windowMs)
    hits.push(nowMs)
    fuseHits.set(key, hits)
    if (hits.length <= settings.safety.fuseThreshold) return null

    const existing = fuses.get(scope)
    if (existing) {
      existing.blocked += 1
      return null
    }
    const record: FuseRecord = { scope, reason, since: nowStamp(now()), blocked: hits.length }
    fuses.set(scope, record)
    for (const handler of fuseHandlers) {
      try {
        handler({ scope, reason, blocked: record.blocked })
      } catch {
        // 通知失败不影响判定
      }
    }
    return record
  }

  /** L2 场景开关：按触发类型取对应开关（manual 任务不参与场景开关判定） */
  function sceneOff(job: WelinkJob): boolean {
    if (job.triggerType === 'group_at_me') return !settings.trigger.groupAtMe
    if (job.triggerType === 'private') return !settings.trigger.privateAutoReply
    // manual（人工发起）：场景开关不管，交由 L0/L1 与黑名单把关
    return false
  }

  return {
    check(input) {
      rollHour()
      const { job, conversation } = input
      const isManual = job.triggerType === 'manual'
      const scope =
        job.triggerType === 'group_at_me' ? 'group_at_me' : job.triggerType === 'private' ? 'private' : 'manual'

      // —— L0 一键急停：封死唯一出口（manual 人工发送也需人工解锁后重走） ——
      if (panic) {
        registerSkip(scope, 'panic')
        return { action: 'skip', reason: 'panic', detail: '全局急停中，所有外发已被阻断' }
      }

      // —— L1 助手总开关：拦住自动外发；人工明确发起的（manual）放行 ——
      if (!enabled && !isManual) {
        return { action: 'skip', reason: 'disabled', detail: '助手总开关已关闭' }
      }

      // —— L2 场景开关（群@我 / 私聊） ——
      if (sceneOff(job)) {
        return { action: 'skip', reason: 'switch_off', detail: `${sceneLabel(scope)}自动回复已关闭` }
      }

      // —— L3 会话级开关 + O11 静音合并判定 ——
      if (!conversation) {
        return { action: 'skip', reason: 'target_missing', detail: '目标会话已被删除，无法外发' }
      }
      const cached = convCache.get(conversation.convId)
      const autoReply = cached ? cached.autoReply : conversation.autoReply
      const muteUntil = cached ? cached.muteUntil : conversation.muteUntil
      if (!autoReply && !isManual) {
        return {
          action: 'skip',
          reason: 'conv_switch',
          detail: `「${conversation.title || conversation.convId}」未开启自动回复`,
        }
      }
      if (muteUntil && !isManual) {
        const until = parseStamp(muteUntil)
        if (until && until.getTime() > now().getTime()) {
          return { action: 'defer', reason: 'quiet', detail: `会话静音至 ${muteUntil.slice(11, 16)}`, terminal: true }
        }
      }

      // —— S8 熔断（含 myUserId 为空的一次性兜底） ——
      if (noUserIdFused && !isManual) {
        return { action: 'skip', reason: 'fused', detail: '未填写工号，已熔断兜底（设置中补齐工号后可解除）' }
      }
      const fuse = fuses.get(scope)
      if (fuse && !isManual) {
        fuse.blocked += 1
        return {
          action: 'skip',
          reason: 'fused',
          detail: `${sceneLabel(scope)}因「${fuse.reason}」熔断中（本窗已拦 ${fuse.blocked} 条）`,
        }
      }

      // —— S4 静默时段：挂起不丢弃；补发时草稿已超 4h → 转人工 ——
      if (inQuietHours() && !isManual) {
        if (staleDraft(job)) {
          return { action: 'hold', reason: 'stale_draft', detail: '处于静默时段且草稿已超 4 小时，转人工确认' }
        }
        return {
          action: 'defer',
          reason: 'quiet',
          detail: `静默时段（${settings.safety.quietHours.from}–${settings.safety.quietHours.to}），时段结束后按序补发`,
          terminal: false,
        }
      }

      // —— S6 草稿防护（空/无有效文字/超长） ——
      const problem = draftProblem(job.draft)
      if (problem) {
        return { action: 'skip', reason: problem.reason, detail: problem.detail }
      }

      // —— S7 内容黑名单：防模型幻觉生成承诺性/资金类回复 → 转人工 ——
      const hit = blacklistHit(job.draft)
      if (hit) {
        return { action: 'hold', reason: 'blacklist', detail: `命中敏感句式 /${hit}/，已转人工待审` }
      }

      // —— S1 每会话最小回复间隔 ——
      const state = stateOf(job.targetId)
      const minIntervalMs = settings.safety.perConvMinIntervalSec * 1000
      const lastSent = parseStamp(state.lastSentAt)
      if (lastSent && minIntervalMs > 0 && now().getTime() - lastSent.getTime() < minIntervalMs) {
        const waitSec = Math.ceil((minIntervalMs - (now().getTime() - lastSent.getTime())) / 1000)
        registerSkip(scope, 'rate_conv')
        return {
          action: 'skip',
          reason: 'rate_conv',
          detail: `距上次回复不足 ${settings.safety.perConvMinIntervalSec}s，需再等 ${waitSec}s`,
        }
      }

      // —— S5 同人短窗合并：同一发送者在本会话合并窗内已有一次外发 → 合并掉 ——
      const mergeWindowMs = settings.safety.mergeWindowSec * 1000
      if (
        mergeWindowMs > 0 &&
        input.senderId &&
        state.recentSender === input.senderId &&
        state.recentAt > 0 &&
        now().getTime() - state.recentAt < mergeWindowMs
      ) {
        registerSkip(scope, 'merge_window')
        return {
          action: 'skip',
          reason: 'merge_window',
          detail: `同一发送者 ${settings.safety.mergeWindowSec}s 内已回复过（内容已存于上下文）`,
        }
      }

      // —— S2 每会话每小时上限 ——
      if (state.hourly >= settings.safety.perConvHourlyCap) {
        registerSkip(scope, 'rate_conv_hourly')
        return {
          action: 'skip',
          reason: 'rate_conv_hourly',
          detail: `该会话本小时已回复 ${state.hourly} 条，达到上限 ${settings.safety.perConvHourlyCap}`,
        }
      }

      // —— S3 全局每小时上限：不是丢弃，而是挂起排队（顶栏黄条提示） ——
      if (globalClosedUntil) {
        const until = parseStamp(globalClosedUntil)
        if (until && until.getTime() > now().getTime()) {
          return {
            action: 'defer',
            reason: 'rate_global_hourly',
            detail: `全局配额已满，冷却至 ${globalClosedUntil.slice(11, 16)}`,
            terminal: false,
          }
        }
        globalClosedUntil = null
      }
      if (globalHourly >= settings.safety.globalHourlyCap) {
        registerSkip(scope, 'rate_global_hourly')
        globalClosedUntil = `${globalBucket}:59:59`
        return {
          action: 'defer',
          reason: 'rate_global_hourly',
          detail: `全局本小时已回复 ${globalHourly} 条，达到上限 ${settings.safety.globalHourlyCap}，本小时剩余任务改为排队`,
          terminal: false,
        }
      }

      return { action: 'send', reason: '', detail: '' }
    },

    onSent(targetId, senderId) {
      rollHour()
      const state = stateOf(targetId)
      const stamp = nowStamp(now())
      state.hourly += 1
      state.lastSentAt = stamp
      state.recentSender = senderId
      state.recentAt = now().getTime()
      globalHourly += 1
    },

    setPanic(on) {
      panic = on
    },

    setEnabled(on) {
      enabled = on
    },

    reload(next) {
      settings = next
      enabled = next.enabled
      // 工号补齐 → 解除兜底熔断；清空 → 重新进入熔断（O8：把静默拒绝变成显式指引）
      noUserIdFused = isNoUserId(next)
    },

    settings() {
      return settings
    },

    fused(scope) {
      return fuses.has(scope)
    },

    resetFuse(scope) {
      if (scope) {
        fuses.delete(scope)
        for (const key of [...fuseHits.keys()]) {
          if (key.startsWith(`${scope}|`)) fuseHits.delete(key)
        }
      } else {
        fuses.clear()
        fuseHits.clear()
      }
      // 无论哪种范围，**都不清 noUserIdFused**（刻意保留）。
      //
      // 这不是死分支 —— UI 的「解除熔断」按钮会把「全局」译成字面量 'global'
      // 传进来（ControlBar.vue 的 liftFuse），因此 `scope === 'global'` 可达。
      // 曾经这里写的是 `if (scope === 'global') noUserIdFused = false`，后果很严重：
      // 工号仍然为空、`filterSelf` 仍然失效（自发消息不会被打上 direction='out'），
      // 但防自回复的兜底熔断被人工关掉了 —— 助手发出的回复会被自己拉回来当成
      // 新消息，形成**自回复死循环**（设计 §637 明确把「myUserId 为空 → S8 熔断」
      // 列为死循环防护的一环）。
      //
      // 正确语义：这个熔断的**根因**是「工号没填」，唯一解除方式是补齐工号
      // （见 `reload()`）。人工点「解除」只能解除「拦截次数超阈值」那类熔断。
    },

    invalidateConversation(convId) {
      // 会话开关缓存失效（O5）：下次 check 必须重新读会话行（缓存未命中时用调用方
      // 传入的会话快照，因此这里只需丢缓存 —— 调用方负责传新快照）。
      convCache.delete(convId)
    },

    cacheConversation(convId, autoReply, muteUntil) {
      convCache.set(convId, { autoReply, muteUntil })
    },

    primeConversation(convId, hourlyCount, lastSentAt) {
      rollHour()
      const state = stateOf(convId)
      state.hourly = Math.max(0, hourlyCount)
      state.lastSentAt = lastSentAt
    },

    primeGlobal(hourlyCount) {
      rollHour()
      globalHourly = Math.max(0, hourlyCount)
    },

    snapshot() {
      rollHour()
      const convCounts: Record<string, number> = {}
      for (const [convId, state] of convStates) convCounts[convId] = state.hourly
      return {
        panic,
        globalCount: globalHourly,
        globalCap: settings.safety.globalHourlyCap,
        globalClosedUntil,
        convCounts,
        fuses: [...fuses.values()].map((item) => ({
          key: item.scope,
          scope: sceneLabel(item.scope),
          reason: item.reason,
          since: item.since,
        })),
        globalFuse: noUserIdFused,
        globalFuseReason: noUserIdFused ? '未填写工号（设置页补齐后自动解除）' : '',
      }
    },

    onFuse(handler) {
      fuseHandlers.push(handler)
    },
  }
}

/** 'HH:mm' → 当日分钟数 */
function toMinutes(value: string): number {
  const [hour, minute] = value.split(':')
  return Number(hour) * 60 + Number(minute)
}

function sceneLabel(scope: string): string {
  if (scope === 'group_at_me') return '群 @我'
  if (scope === 'private') return '私聊'
  return '人工发送'
}

/** 初始化：设置里缺工号时立刻进入兜底熔断（O8 的显式指引依赖这个初值） */
export function isNoUserId(settings: WelinkSettings): boolean {
  return !settings.myUserId.trim()
}
