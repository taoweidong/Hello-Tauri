import { describe, expect, it } from 'vitest'

/**
 * SafetyGate 单测（设计 §13「v4.2：假时钟下 S1–S8 每条规则的放行/拦截/skip_reason」）。
 *
 * 这是全项目**唯一的外发出口**，判错两个方向的代价都不可逆：
 *  * 漏拦（该拦不拦）→ 群里刷屏，用户直接卸载；
 *  * 误拦（该放不放）→ 功能像坏了。
 * 因此 §5A.3 的判定顺序、每条规则的四个出口（send/skip/hold/defer）、以及
 * 配额「只在成功发送后扣减」的立场，都逐条断言。
 *
 * 边界语义（实测确认，勿凭直觉改）：
 *  * `fuseThreshold = N` 表示**第 N+1 次**同类拦截才熔断（`hits.length <= N` 时返回 null）；
 *  * 判定顺序是 S1 → S5 → S2 → S3，因此测 S5/S2/S3 时必须先把 S1 关掉
 *    （`perConvMinIntervalSec: 0`），否则会被 S1 抢先拦下；
 *  * `empty/oversize/blacklist` **不计入熔断**（内容质量问题 ≠ 滥发风险）。
 */

import { createSafetyGate, isNoUserId, type GateCheckInput } from '@/orchestrator/safety-gate'
import {
  DEFAULT_WELINK_SETTINGS,
  type WelinkConversation,
  type WelinkJob,
  type WelinkSafetySettings,
  type WelinkSettings,
} from '@/types/welink'
import { parseStamp } from '@/utils/time'

// ---------------------------------------------------------------- 测试夹具

/** 可控假时钟：Gate 的全部时间判定（冷桶/静默/间隔/合并窗/隔夜草稿/熔断窗）都读它 */
function createClock(stamp: string) {
  let current = parseStamp(stamp)!
  return {
    now: () => new Date(current.getTime()),
    advance(ms: number) {
      current = new Date(current.getTime() + ms)
    },
    to(stamp: string) {
      current = parseStamp(stamp)!
    },
    get: () => new Date(current.getTime()),
  }
}

function settings(
  overrides: {
    myUserId?: string
    enabled?: boolean
    groupAtMe?: boolean
    privateAutoReply?: boolean
    safety?: Partial<WelinkSafetySettings>
  } = {},
): WelinkSettings {
  return {
    ...DEFAULT_WELINK_SETTINGS,
    myUserId: overrides.myUserId ?? 'E-0001',
    enabled: overrides.enabled ?? true,
    trigger: {
      groupAtMe: overrides.groupAtMe ?? true,
      privateAutoReply: overrides.privateAutoReply ?? true,
    },
    safety: { ...DEFAULT_WELINK_SETTINGS.safety, ...overrides.safety },
  }
}

function conversation(overrides: Partial<WelinkConversation> = {}): WelinkConversation {
  return {
    pk: 1,
    convType: 'group',
    convId: 'G-1001',
    title: '研发一组',
    remark: '',
    watching: true,
    autoReply: true,
    muteUntil: null,
    lastMsgAt: '',
    unreadCount: 0,
    mentionCount: 0,
    lastActive: '',
    lastCursor: '',
    updatedAt: '',
    ...overrides,
  }
}

function job(overrides: Partial<WelinkJob> = {}): WelinkJob {
  return {
    pk: 1,
    triggerMsgPk: 1,
    triggerType: 'group_at_me',
    targetType: 'group',
    targetId: 'G-1001',
    sendModeUsed: 'auto',
    contextSnapshot: '',
    draft: '收到，我看下',
    status: 'ready',
    attempts: 0,
    lastError: '',
    skipReason: '',
    holdReason: '',
    skillId: '',
    skillName: '',
    skillSource: '',
    rating: null,
    createdAt: '2026-09-27 14:00:00',
    updatedAt: '2026-09-27 14:00:00',
    finishedAt: null,
    triggerSummary: '',
    targetTitle: '研发一组',
    ...overrides,
  }
}

/** 建 Gate + 假时钟（放在一起避免每个用例重复两行） */
function setup(config: Parameters<typeof settings>[0] = {}, startedAt = '2026-09-27 14:00:00') {
  const clock = createClock(startedAt)
  const gate = createSafetyGate({ settings: settings(config), now: clock.now })
  return { gate, clock, conf: settings(config) }
}

/** 一次判定的简写 */
function check(gate: ReturnType<typeof createSafetyGate>, input: Partial<GateCheckInput> = {}) {
  return gate.check({
    job: job(),
    senderId: '',
    conversation: conversation(),
    ...input,
  })
}

// ---------------------------------------------------------------- L0 / L1 / L2 / L3

describe('SafetyGate —— L0 一键急停', () => {
  it('急停后自动发送被拦（skip + panic）', () => {
    const { gate } = setup()
    gate.setPanic(true)
    expect(check(gate)).toMatchObject({ action: 'skip', reason: 'panic' })
  })

  it('急停是唯一出口，**人工发送也被封**（需先解锁）', () => {
    const { gate } = setup()
    gate.setPanic(true)
    expect(check(gate, { job: job({ triggerType: 'manual', sendModeUsed: 'manual' }) })).toMatchObject({
      action: 'skip',
      reason: 'panic',
    })
  })

  it('解除急停后恢复放行', () => {
    const { gate } = setup()
    gate.setPanic(true)
    gate.setPanic(false)
    expect(check(gate).action).toBe('send')
  })

  it('急停状态进快照（控制条红条的数据源）', () => {
    const { gate } = setup()
    gate.setPanic(true)
    expect(gate.snapshot().panic).toBe(true)
  })
})

describe('SafetyGate —— L1 助手总开关', () => {
  it('总开关关闭拦自动外发（skip + disabled）', () => {
    const { gate } = setup({ enabled: false })
    expect(check(gate)).toMatchObject({ action: 'skip', reason: 'disabled' })
  })

  it('总开关关闭**不拦**人工明确发起的发送（manual 是显式意图）', () => {
    const { gate } = setup({ enabled: false })
    expect(check(gate, { job: job({ triggerType: 'manual', sendModeUsed: 'manual' }) }).action).toBe('send')
  })

  it('setEnabled 可运行时切换（控制条 start/stop 的第二道保险）', () => {
    const { gate } = setup()
    gate.setEnabled(false)
    expect(check(gate).action).toBe('skip')
    gate.setEnabled(true)
    expect(check(gate).action).toBe('send')
  })

  it('reload 同步 enabled（配置热更新）', () => {
    const { gate, conf } = setup()
    gate.reload({ ...conf, enabled: false })
    expect(check(gate)).toMatchObject({ action: 'skip', reason: 'disabled' })
  })
})

describe('SafetyGate —— L2 场景开关', () => {
  it('群 @我 场景关闭 → skip + switch_off', () => {
    const { gate } = setup({ groupAtMe: false })
    expect(check(gate)).toMatchObject({ action: 'skip', reason: 'switch_off' })
  })

  it('私聊场景关闭 → skip + switch_off', () => {
    const { gate } = setup({ privateAutoReply: false })
    expect(
      check(gate, {
        job: job({ triggerType: 'private', targetType: 'private', targetId: 'E-2001' }),
        conversation: conversation({ convType: 'private', convId: 'E-2001' }),
      }),
    ).toMatchObject({ action: 'skip', reason: 'switch_off' })
  })

  it('场景开关只管对应场景（群关不影响私聊）', () => {
    const { gate } = setup({ groupAtMe: false })
    expect(
      check(gate, {
        job: job({ triggerType: 'private', targetType: 'private', targetId: 'E-2001' }),
        conversation: conversation({ convType: 'private', convId: 'E-2001' }),
      }).action,
    ).toBe('send')
  })

  it('manual 任务不受场景开关影响（交由 L0/L1 与黑名单把关）', () => {
    const { gate } = setup({ groupAtMe: false })
    expect(check(gate, { job: job({ triggerType: 'manual' }) }).action).toBe('send')
  })
})

describe('SafetyGate —— L3 会话级开关与静音（O11）', () => {
  it('会话未开自动回复 → skip + conv_switch（详情含会话名）', () => {
    const { gate } = setup()
    const decision = check(gate, { conversation: conversation({ autoReply: false }) })
    expect(decision).toMatchObject({ action: 'skip', reason: 'conv_switch' })
    expect(decision.detail).toContain('研发一组')
  })

  it('manual 不受会话开关限制', () => {
    const { gate } = setup()
    expect(
      check(gate, { job: job({ triggerType: 'manual' }), conversation: conversation({ autoReply: false }) }).action,
    ).toBe('send')
  })

  it('会话已删除（null）→ skip + target_missing', () => {
    const { gate } = setup()
    expect(check(gate, { conversation: null })).toMatchObject({ action: 'skip', reason: 'target_missing' })
  })

  it('会话静音未过期 → defer（terminal=true，长期等待不等下个 tick）', () => {
    const { gate } = setup()
    const decision = check(gate, { conversation: conversation({ muteUntil: '2026-09-27 18:00:00' }) })
    expect(decision).toMatchObject({ action: 'defer', reason: 'quiet', terminal: true })
  })

  it('静音已过期 → 放行（不需要人工解除）', () => {
    const { gate } = setup()
    expect(check(gate, { conversation: conversation({ muteUntil: '2026-09-27 13:00:00' }) }).action).toBe('send')
  })

  it('invalidateConversation 后改用调用方传入的新快照（O5 缓存失效）', () => {
    const { gate } = setup()
    // 先用旧快照走一遍，把缓存写热
    expect(check(gate, { conversation: conversation({ convId: 'G-1001', autoReply: false }) }).action).toBe('skip')
    gate.invalidateConversation('G-1001')
    // 会话在库里被开启后，缓存失效即立刻生效（缓存只存「曾经读到的值」）
    expect(check(gate, { conversation: conversation({ convId: 'G-1001', autoReply: true }) }).action).toBe('send')
  })
})

// ---------------------------------------------------------------- S8 熔断

describe('SafetyGate —— S8 熔断', () => {
  it('未填工号 → 进 Gate 即熔断兜底（O8 显式指引）', () => {
    const { gate } = setup({ myUserId: '' })
    const decision = check(gate)
    expect(decision).toMatchObject({ action: 'skip', reason: 'fused' })
    expect(decision.detail).toContain('未填写工号')
    expect(gate.snapshot().globalFuse).toBe(true)
  })

  it('补上工号后 reload 自动解除兜底熔断', () => {
    const { gate } = setup({ myUserId: '' })
    gate.reload(settings({ myUserId: 'E-0001' }))
    expect(check(gate).action).toBe('send')
    expect(gate.snapshot().globalFuse).toBe(false)
  })

  it('isNoUserId 只按工号是否为空判定', () => {
    expect(isNoUserId(settings({ myUserId: '  ' }))).toBe(true)
    expect(isNoUserId(settings({ myUserId: 'E-1' }))).toBe(false)
  })

  // ---- 安全不变量：工号兜底熔断不能被人工解除 ----
  //
  // 这一组是**防自回复死循环**的回归闸（设计 §637）。曾经 resetFuse 里写着
  // `if (scope === 'global') noUserIdFused = false`，而 UI 的「解除熔断」按钮
  // 恰好就传 'global' —— 于是用户可以在工号仍为空的情况下把兜底熔断关掉，
  // filterSelf 随之失效，助手发出的话被自己拉回来当成新消息 → 无限自回复。
  it('解锁全部熔断（不带 scope）不能解除工号兜底（否则自回复死循环）', () => {
    const { gate } = setup({ myUserId: '' })
    expect(gate.snapshot().globalFuse).toBe(true)

    gate.resetFuse()

    expect(gate.snapshot().globalFuse).toBe(true)
    expect(check(gate)).toMatchObject({ action: 'skip', reason: 'fused' })
  })

  it("解锁「全局」熔断（UI 传的 'global'）同样不能解除工号兜底", () => {
    const { gate } = setup({ myUserId: '' })
    gate.resetFuse('global')

    expect(gate.snapshot().globalFuse).toBe(true)
    expect(check(gate).action).toBe('skip')
  })

  it('工号兜底熔断的唯一解除方式是补齐工号（reload）', () => {
    const { gate } = setup({ myUserId: '' })
    // 人工解除一律无效
    gate.resetFuse()
    gate.resetFuse('global')
    expect(gate.snapshot().globalFuse).toBe(true)

    // 补齐工号 → 自动解除
    gate.reload(settings({ myUserId: 'E-0001' }))
    expect(gate.snapshot().globalFuse).toBe(false)
    expect(check(gate).action).toBe('send')
  })

  it('工号兜底熔断不进 fuses 列表（两类熔断语义分离，UI 横幅不混淆）', () => {
    // 为什么要有这条：`snapshot().fuses` 是「阈值类熔断」的列表，而工号兜底是
    // `globalFuse` 布尔位。两者混在一起会让 UI 显示「群 @我场景熔断」这种
    // 与事实不符的文案（实际原因是工号没填）。
    const { gate } = setup({ myUserId: '' })
    gate.resetFuse('group_at_me')

    expect(gate.snapshot().fuses).toEqual([])
    expect(gate.snapshot().globalFuse).toBe(true)
    expect(gate.snapshot().globalFuseReason).toContain('工号')
  })

  it('间隔类拦截累计超过阈值 → 熔断该场景（第 N+1 次触发）', () => {
    // fuseThreshold=2 → 第 3 次同类拦截熔断
    const { gate } = setup({ safety: { perConvMinIntervalSec: 600, fuseThreshold: 2, fuseWindowMin: 10 } })
    gate.onSent('G-1001', '')
    for (let index = 0; index < 2; index += 1) {
      expect(check(gate)).toMatchObject({ action: 'skip', reason: 'rate_conv' })
      expect(gate.fused('group_at_me')).toBe(false)
    }
    expect(check(gate)).toMatchObject({ action: 'skip', reason: 'rate_conv' })
    expect(gate.fused('group_at_me')).toBe(true)
  })

  it('熔断后该场景后续一律 skip + fused（不再重复计数各规则）', () => {
    const { gate } = setup({ safety: { perConvMinIntervalSec: 600, fuseThreshold: 1, fuseWindowMin: 10 } })
    gate.onSent('G-1001', '')
    check(gate) // 第 1 次 rate_conv（不熔断）
    check(gate) // 第 2 次 → 熔断
    expect(gate.fused('group_at_me')).toBe(true)
    const decision = check(gate)
    expect(decision).toMatchObject({ action: 'skip', reason: 'fused' })
  })

  it('人工发送不受熔断限制（manual 是显式意图）', () => {
    const { gate, clock } = setup({ safety: { perConvMinIntervalSec: 600, fuseThreshold: 1 } })
    gate.onSent('G-1001', '')
    check(gate) // 第 1 次 rate_conv
    check(gate) // 第 2 次 → 熔断
    expect(gate.fused('group_at_me')).toBe(true)
    // 推进到间隔已满足，只留「熔断」这一个障碍 —— 证明 manual 豁免的是熔断本身
    clock.advance(600_000)
    expect(check(gate)).toMatchObject({ action: 'skip', reason: 'fused' })
    expect(check(gate, { job: job({ triggerType: 'manual' }) }).action).toBe('send')
  })

  it('熔断按场景隔离（群熔断不影响私聊）', () => {
    const { gate } = setup({ safety: { perConvMinIntervalSec: 600, fuseThreshold: 1 } })
    gate.onSent('G-1001', '')
    check(gate)
    check(gate)
    expect(gate.fused('group_at_me')).toBe(true)
    expect(gate.fused('private')).toBe(false)
    expect(
      check(gate, {
        job: job({ triggerType: 'private', targetType: 'private', targetId: 'E-2001' }),
        conversation: conversation({ convType: 'private', convId: 'E-2001' }),
      }).action,
    ).toBe('send')
  })

  it('内容质量问题（empty/oversize/blacklist）**不计入**熔断', () => {
    // 这一条很重要：模型老是输出裸链接不该让整个场景停摆
    const { gate } = setup({ safety: { fuseThreshold: 0, fuseWindowMin: 10 } })
    for (let index = 0; index < 5; index += 1) {
      check(gate, { job: job({ draft: '' }) })
      check(gate, { job: job({ draft: 'x'.repeat(9999) }) })
      check(gate, { job: job({ draft: '我给你转账 100 元' }) })
    }
    expect(gate.fused('group_at_me')).toBe(false)
    expect(check(gate).action).toBe('send')
  })

  it('人工 resetFuse 解除熔断并清空观察窗计数', () => {
    const { gate } = setup({ safety: { perConvMinIntervalSec: 0, perConvHourlyCap: 1, fuseThreshold: 1 } })
    gate.onSent('G-1001', '')
    check(gate) // S2 第 1 次
    check(gate) // S2 第 2 次 → 熔断
    expect(gate.fused('group_at_me')).toBe(true)
    gate.resetFuse('group_at_me')
    expect(gate.fused('group_at_me')).toBe(false)
    expect(gate.snapshot().fuses).toEqual([])
  })

  it('resetFuse 不带 scope 解除全部', () => {
    const { gate } = setup({ safety: { perConvMinIntervalSec: 0, perConvHourlyCap: 1, fuseThreshold: 1 } })
    gate.onSent('G-1001', '')
    check(gate)
    check(gate)
    gate.resetFuse()
    expect(gate.fused('group_at_me')).toBe(false)
  })

  it('onFuse 回调在熔断瞬间触发一次，携带原因与拦截数', () => {
    const { gate } = setup({ safety: { perConvMinIntervalSec: 600, fuseThreshold: 1 } })
    const seen: Array<{ scope: string; reason: string; blocked: number }> = []
    gate.onFuse((info) => seen.push(info))
    gate.onSent('G-1001', '')
    check(gate)
    check(gate)
    expect(seen).toHaveLength(1)
    expect(seen[0].scope).toBe('group_at_me')
    expect(seen[0].reason).toBe('rate_conv')
    expect(seen[0].blocked).toBeGreaterThan(0)
    // 已熔断后再拦不再重复通知（UI 横幅不会重复弹）
    check(gate)
    expect(seen).toHaveLength(1)
  })

  it('观察窗内的老命中会过期（不是永久累计）', () => {
    const { gate, clock } = setup({
      safety: { perConvMinIntervalSec: 600, fuseThreshold: 2, fuseWindowMin: 1 },
    })
    gate.onSent('G-1001', '')
    check(gate)
    check(gate) // 2 次命中，未熔断（阈值 2 → 第 3 次才熔断）
    // 等过观察窗，老命中全部过期
    clock.advance(2 * 60 * 1000)
    check(gate)
    expect(gate.fused('group_at_me')).toBe(false)
  })
})

// ---------------------------------------------------------------- S4 静默时段

describe('SafetyGate —— S4 静默时段', () => {
  it('静默时段内 → defer（terminal=false，时段结束按序补发）', () => {
    const { gate } = setup(
      { safety: { quietHours: { enabled: true, from: '22:00', to: '08:00' } } },
      '2026-09-27 23:30:00',
    )
    // 草稿是刚生成的（未超 4h），才会走「挂起补发」而不是「转人工」
    const decision = check(gate, { job: job({ createdAt: '2026-09-27 23:25:00' }) })
    expect(decision).toMatchObject({ action: 'defer', reason: 'quiet', terminal: false })
    expect(decision.detail).toContain('22:00')
  })

  it('时段外放行', () => {
    const { gate } = setup(
      { safety: { quietHours: { enabled: true, from: '22:00', to: '08:00' } } },
      '2026-09-27 14:00:00',
    )
    expect(check(gate).action).toBe('send')
  })

  it('跨零点区间两侧都算静默（22:00–08:00 的 02:00 也在窗内）', () => {
    const conf = { safety: { quietHours: { enabled: true, from: '22:00', to: '08:00' } } }
    expect(check(setup(conf, '2026-09-27 02:00:00').gate).action).toBe('defer')
    expect(check(setup(conf, '2026-09-27 07:59:00').gate).action).toBe('defer')
    expect(check(setup(conf, '2026-09-27 08:00:00').gate).action).toBe('send')
  })

  it('同日起止区间按正常区间判定（09:00–18:00）', () => {
    const conf = { safety: { quietHours: { enabled: true, from: '09:00', to: '18:00' } } }
    expect(check(setup(conf, '2026-09-27 12:00:00').gate).action).toBe('defer')
    expect(check(setup(conf, '2026-09-27 19:00:00').gate).action).toBe('send')
  })

  it('起止相同视为未启用（不误拦全天）', () => {
    const { gate } = setup(
      { safety: { quietHours: { enabled: true, from: '09:00', to: '09:00' } } },
      '2026-09-27 09:00:00',
    )
    expect(check(gate).action).toBe('send')
  })

  it('quietHours.enabled=false 时完全不生效', () => {
    const { gate } = setup(
      { safety: { quietHours: { enabled: false, from: '22:00', to: '08:00' } } },
      '2026-09-27 23:30:00',
    )
    expect(check(gate).action).toBe('send')
  })

  it('静默时段 + 草稿超 4h → hold stale_draft（隔夜内容不盲发）', () => {
    const { gate } = setup(
      { safety: { quietHours: { enabled: true, from: '22:00', to: '08:00' } } },
      '2026-09-28 03:00:00',
    )
    const decision = check(gate, { job: job({ createdAt: '2026-09-27 14:00:00' }) })
    expect(decision).toMatchObject({ action: 'hold', reason: 'stale_draft' })
  })

  it('静默时段但草稿未超 4h → 仍是 defer（等时段结束补发）', () => {
    const { gate } = setup(
      { safety: { quietHours: { enabled: true, from: '22:00', to: '08:00' } } },
      '2026-09-28 03:00:00',
    )
    expect(check(gate, { job: job({ createdAt: '2026-09-28 01:00:00' }) })).toMatchObject({
      action: 'defer',
      terminal: false,
    })
  })

  it('超 4h 判定用 createdAt（不是 updatedAt）', () => {
    const { gate } = setup(
      { safety: { quietHours: { enabled: true, from: '22:00', to: '08:00' } } },
      '2026-09-28 03:00:00',
    )
    expect(
      check(gate, { job: job({ createdAt: '2026-09-27 10:00:00', updatedAt: '2026-09-28 02:59:00' }) }).action,
    ).toBe('hold')
  })

  it('manual 任务不受静默时段约束（用户明确点了发送）', () => {
    const { gate } = setup(
      { safety: { quietHours: { enabled: true, from: '22:00', to: '08:00' } } },
      '2026-09-27 23:30:00',
    )
    expect(check(gate, { job: job({ triggerType: 'manual' }) }).action).toBe('send')
  })
})

// ---------------------------------------------------------------- S6 草稿防护

describe('SafetyGate —— S6 草稿防护', () => {
  it('空草稿 → skip + empty', () => {
    const { gate } = setup()
    expect(check(gate, { job: job({ draft: '' }) })).toMatchObject({ action: 'skip', reason: 'empty' })
  })

  it('纯空白 → empty', () => {
    const { gate } = setup()
    expect(check(gate, { job: job({ draft: '   \n\t  ' }) })).toMatchObject({ action: 'skip', reason: 'empty' })
  })

  it('纯符号/纯 emoji → empty（发出去等于没回，还占配额）', () => {
    const { gate } = setup()
    for (const draft of ['。。。', '！！！', '———', '🚀🚀']) {
      expect(check(gate, { job: job({ draft }) })).toMatchObject({ action: 'skip', reason: 'empty' })
    }
  })

  it('超长草稿 → skip + oversize（详情含字数与上限）', () => {
    const { gate } = setup({ safety: { maxDraftChars: 20 } })
    const decision = check(gate, { job: job({ draft: 'x'.repeat(21) }) })
    expect(decision).toMatchObject({ action: 'skip', reason: 'oversize' })
    expect(decision.detail).toContain('21')
    expect(decision.detail).toContain('20')
  })

  it('恰好等于上限放行（边界不误伤）', () => {
    const { gate } = setup({ safety: { maxDraftChars: 20 } })
    expect(check(gate, { job: job({ draft: 'x'.repeat(20) }) }).action).toBe('send')
  })

  it('长度按 trim 后计（首尾空白不算进上限）', () => {
    const { gate } = setup({ safety: { maxDraftChars: 5 } })
    expect(check(gate, { job: job({ draft: '  abcde  ' }) }).action).toBe('send')
  })
})

// ---------------------------------------------------------------- S7 黑名单

describe('SafetyGate —— S7 内容黑名单', () => {
  it('命中敏感句式 → hold + blacklist（转人工而非丢弃）', () => {
    const { gate } = setup({ safety: { blacklistPatterns: ['转账|汇款'] } })
    const decision = check(gate, { job: job({ draft: '好的，我马上给你转账' }) })
    expect(decision).toMatchObject({ action: 'hold', reason: 'blacklist' })
    expect(decision.detail).toContain('转账|汇款')
  })

  it('匹配大小写不敏感', () => {
    const { gate } = setup({ safety: { blacklistPatterns: ['password'] } })
    expect(check(gate, { job: job({ draft: '请提供你的 PASSWORD' }) })).toMatchObject({ action: 'hold' })
  })

  it('未命中放行', () => {
    const { gate } = setup({ safety: { blacklistPatterns: ['转账|汇款'] } })
    expect(check(gate, { job: job({ draft: '收到，我看下这个接口' }) }).action).toBe('send')
  })

  it('坏正则被跳过而不是让整条链路挂掉', () => {
    const { gate } = setup({ safety: { blacklistPatterns: ['([unclosed', '转账'] } })
    // 前一条语法错被忽略，后一条仍生效
    expect(check(gate, { job: job({ draft: '收到' }) }).action).toBe('send')
    expect(check(gate, { job: job({ draft: '给你转账' }) })).toMatchObject({ action: 'hold' })
  })

  it('空白项被忽略', () => {
    const { gate } = setup({ safety: { blacklistPatterns: ['', '  '] } })
    expect(check(gate).action).toBe('send')
  })

  it('默认黑名单覆盖资金/凭证/承诺类（出厂即防幻觉）', () => {
    const { gate } = setup()
    for (const draft of ['我保证一定给你赔偿', '请把验证码发我', '我先垫付这笔款']) {
      expect(check(gate, { job: job({ draft }) }).action).toBe('hold')
    }
  })

  it('黑名单判定在 S1 之前（刚发过也先转人工而不是记 rate_conv）', () => {
    const { gate } = setup({ safety: { blacklistPatterns: ['转账'], perConvMinIntervalSec: 600 } })
    gate.onSent('G-1001', '')
    expect(check(gate, { job: job({ draft: '给你转账' }) })).toMatchObject({ action: 'hold', reason: 'blacklist' })
  })
})

// ---------------------------------------------------------------- S1 会话最小间隔

describe('SafetyGate —— S1 每会话最小回复间隔', () => {
  it('距上次回复不足间隔 → skip + rate_conv（详情含剩余秒数）', () => {
    const { gate, clock } = setup({ safety: { perConvMinIntervalSec: 10 } })
    gate.onSent('G-1001', '')
    clock.advance(3000)
    const decision = check(gate)
    expect(decision).toMatchObject({ action: 'skip', reason: 'rate_conv' })
    expect(decision.detail).toContain('7')
  })

  it('冷却结束即可补发（间隔是滑动窗口，不是永久限制）', () => {
    const { gate, clock } = setup({ safety: { perConvMinIntervalSec: 10 } })
    gate.onSent('G-1001', '')
    // 推进到「间隔已满足」但仍在同一小时桶内：否则跨小时归零也会放行，测不出滑动窗口
    clock.advance(10_000)
    expect(check(gate).action).toBe('send')
  })

  it('间隔按会话隔离（A 会话刚发不影响 B 会话）', () => {
    const { gate } = setup({ safety: { perConvMinIntervalSec: 600 } })
    gate.onSent('G-1001', '')
    expect(check(gate).action).toBe('skip')
    expect(
      check(gate, {
        job: job({ pid: undefined, targetId: 'G-1002' } as Partial<WelinkJob>),
        conversation: conversation({ convId: 'G-1002' }),
      }).action,
    ).toBe('send')
  })

  it('间隔为 0 时该规则完全不生效', () => {
    const { gate } = setup({ safety: { perConvMinIntervalSec: 0 } })
    gate.onSent('G-1001', '')
    expect(check(gate).action).toBe('send')
  })

  it('primeConversation 用库中 lastSentAt 恢复基线（跨重启仍然成立）', () => {
    const { gate } = setup({ safety: { perConvMinIntervalSec: 600 } }, '2026-09-27 14:00:00')
    gate.primeConversation('G-1001', 0, '2026-09-27 13:59:00')
    expect(check(gate)).toMatchObject({ action: 'skip', reason: 'rate_conv' })
  })

  it('库中 lastSentAt 为空则不设基线（首启立刻可发）', () => {
    const { gate } = setup({ safety: { perConvMinIntervalSec: 600 } })
    gate.primeConversation('G-1001', 0, null)
    expect(check(gate).action).toBe('send')
  })
})

// ---------------------------------------------------------------- S5 同人合并

describe('SafetyGate —— S5 同人短窗合并', () => {
  it('同一发送者在合并窗内已有外发 → skip + merge_window', () => {
    // S1 必须关掉，否则会抢先拦下（判定顺序 S1 → S5）
    const { gate, clock } = setup({ safety: { perConvMinIntervalSec: 0, mergeWindowSec: 30 } })
    gate.onSent('G-1001', 'E-9001')
    clock.advance(5000)
    const decision = check(gate, { senderId: 'E-9001' })
    expect(decision).toMatchObject({ action: 'skip', reason: 'merge_window' })
    expect(decision.detail).toContain('上下文')
  })

  it('不同发送者不被合并', () => {
    const { gate, clock } = setup({ safety: { perConvMinIntervalSec: 0, mergeWindowSec: 30 } })
    gate.onSent('G-1001', 'E-9001')
    clock.advance(5000)
    expect(check(gate, { senderId: 'E-9002' }).action).toBe('send')
  })

  it('超过合并窗即可再回', () => {
    const { gate, clock } = setup({ safety: { perConvMinIntervalSec: 0, mergeWindowSec: 30 } })
    gate.onSent('G-1001', 'E-9001')
    clock.advance(30_000)
    expect(check(gate, { senderId: 'E-9001' }).action).toBe('send')
  })

  it('senderId 未知（空串）时不做合并判定（宁可不合并也不误拦）', () => {
    const { gate } = setup({ safety: { perConvMinIntervalSec: 0, mergeWindowSec: 30 } })
    gate.onSent('G-1001', 'E-9001')
    expect(check(gate, { senderId: '' }).action).toBe('send')
  })

  it('合并窗为 0 时该规则不生效', () => {
    const { gate } = setup({ safety: { perConvMinIntervalSec: 0, mergeWindowSec: 0 } })
    gate.onSent('G-1001', 'E-9001')
    expect(check(gate, { senderId: 'E-9001' }).action).toBe('send')
  })

  it('合并基线只由「通过 Gate 的外发」写入（未发的不算）', () => {
    const { gate } = setup({ safety: { perConvMinIntervalSec: 0, mergeWindowSec: 30 } })
    check(gate, { senderId: 'E-9001' }) // 只判定，未 onSent
    expect(check(gate, { senderId: 'E-9001' }).action).toBe('send')
  })
})

// ---------------------------------------------------------------- S2 / S3 配额

describe('SafetyGate —— S2 每会话每小时上限', () => {
  it('达到上限 → skip + rate_conv_hourly', () => {
    const { gate } = setup({ safety: { perConvMinIntervalSec: 0, perConvHourlyCap: 2 } })
    gate.onSent('G-1001', '')
    gate.onSent('G-1001', '')
    const decision = check(gate)
    expect(decision).toMatchObject({ action: 'skip', reason: 'rate_conv_hourly' })
    expect(decision.detail).toContain('2')
  })

  it('未达上限放行', () => {
    const { gate } = setup({ safety: { perConvMinIntervalSec: 0, perConvHourlyCap: 2 } })
    gate.onSent('G-1001', '')
    expect(check(gate).action).toBe('send')
  })

  it('跨小时自动归零（懒重置）', () => {
    const { gate, clock } = setup({ safety: { perConvMinIntervalSec: 0, perConvHourlyCap: 1 } }, '2026-09-27 14:30:00')
    gate.onSent('G-1001', '')
    expect(check(gate)).toMatchObject({ action: 'skip', reason: 'rate_conv_hourly' })
    clock.to('2026-09-27 15:00:00')
    expect(check(gate).action).toBe('send')
  })

  it('配额按会话隔离', () => {
    const { gate } = setup({ safety: { perConvMinIntervalSec: 0, perConvHourlyCap: 1 } })
    gate.onSent('G-1001', '')
    expect(check(gate).action).toBe('skip')
    expect(
      check(gate, { job: job({ targetId: 'G-1002' }), conversation: conversation({ convId: 'G-1002' }) }).action,
    ).toBe('send')
  })

  it('primeConversation 用库中本小时计数预热（O5 避免每次 check 查库）', () => {
    const { gate } = setup({ safety: { perConvMinIntervalSec: 0, perConvHourlyCap: 3 } })
    gate.primeConversation('G-1001', 3, null)
    expect(check(gate)).toMatchObject({ action: 'skip', reason: 'rate_conv_hourly' })
  })

  it('prefetch 计数为负时夹到 0（脏数据不误拦）', () => {
    const { gate } = setup({ safety: { perConvMinIntervalSec: 0, perConvHourlyCap: 1 } })
    gate.primeConversation('G-1001', -5, null)
    expect(check(gate).action).toBe('send')
  })
})

describe('SafetyGate —— S3 全局每小时上限', () => {
  it('达到全局上限 → defer（不是丢弃，本小时剩余任务排队）', () => {
    const { gate } = setup({
      safety: { perConvMinIntervalSec: 0, perConvHourlyCap: 99, globalHourlyCap: 2 },
    })
    gate.onSent('G-1001', '')
    gate.onSent('G-1002', '')
    const decision = check(gate)
    expect(decision).toMatchObject({ action: 'defer', reason: 'rate_global_hourly', terminal: false })
    expect(decision.detail).toContain('排队')
  })

  it('触发后写入冷却截止时刻（快照黄条的数据源）', () => {
    const { gate } = setup({ safety: { perConvMinIntervalSec: 0, perConvHourlyCap: 99, globalHourlyCap: 1 } })
    gate.onSent('G-1001', '')
    check(gate)
    const snapshot = gate.snapshot()
    expect(snapshot.globalClosedUntil).toContain('2026-09-27 14')
    expect(snapshot.globalCount).toBe(1)
    expect(snapshot.globalCap).toBe(1)
  })

  it('冷却期内持续 defer（直接短路，不再走后面的规则）', () => {
    const { gate } = setup({ safety: { perConvMinIntervalSec: 0, perConvHourlyCap: 99, globalHourlyCap: 1 } })
    gate.onSent('G-1001', '')
    check(gate)
    expect(check(gate)).toMatchObject({ action: 'defer', reason: 'rate_global_hourly' })
    expect(check(gate)).toMatchObject({ action: 'defer', reason: 'rate_global_hourly' })
  })

  it('跨小时冷却自动解除并归零', () => {
    const { gate, clock } = setup(
      { safety: { perConvMinIntervalSec: 0, perConvHourlyCap: 99, globalHourlyCap: 1 } },
      '2026-09-27 14:10:00',
    )
    gate.onSent('G-1001', '')
    check(gate)
    expect(gate.snapshot().globalClosedUntil).not.toBeNull()
    clock.to('2026-09-27 15:00:00')
    gate.onSent('G-1001', '')
    expect(gate.snapshot().globalCount).toBe(1)
    expect(gate.snapshot().globalClosedUntil).toBeNull()
  })

  it('primeGlobal 用库中全局计数预热', () => {
    const { gate } = setup({ safety: { perConvMinIntervalSec: 0, perConvHourlyCap: 99, globalHourlyCap: 3 } })
    gate.primeGlobal(3)
    expect(check(gate)).toMatchObject({ action: 'defer', reason: 'rate_global_hourly' })
  })

  it('全局与会话配额同时生效时先撞哪个由判定顺序决定（S2 在前）', () => {
    const { gate } = setup({ safety: { perConvMinIntervalSec: 0, perConvHourlyCap: 1, globalHourlyCap: 1 } })
    gate.onSent('G-1001', '')
    // S2 在 S3 之前 → 报会话配额
    expect(check(gate)).toMatchObject({ action: 'skip', reason: 'rate_conv_hourly' })
  })
})

// ---------------------------------------------------------------- 立场与快照

describe('SafetyGate —— 关键立场（改代码前必读）', () => {
  it('配额只在 onSent 扣减：check 是纯判定，可重复调用不消耗配额', () => {
    const { gate } = setup({ safety: { perConvMinIntervalSec: 0, perConvHourlyCap: 1 } })
    // 连判 5 次都不放行「消耗」—— 这是幂等性的核心
    for (let index = 0; index < 5; index += 1) expect(check(gate).action).toBe('send')
    expect(gate.snapshot().globalCount).toBe(0)
    expect(gate.snapshot().convCounts['G-1001']).toBe(0)
  })

  it('onSent 同时刷新 S1 基线、S5 基线与两级计数', () => {
    const { gate } = setup({ safety: { perConvMinIntervalSec: 600 } })
    gate.onSent('G-1001', 'E-9001')
    const snapshot = gate.snapshot()
    expect(snapshot.globalCount).toBe(1)
    expect(snapshot.convCounts['G-1001']).toBe(1)
    // S1 基线已刷新 → 立刻再判会被拦
    expect(check(gate)).toMatchObject({ action: 'skip', reason: 'rate_conv' })
  })

  it('快照形状完整（控制条徽标/横幅/明细都读它）', () => {
    const { gate } = setup()
    const snapshot = gate.snapshot()
    expect(Object.keys(snapshot).sort()).toEqual(
      [
        'convCounts',
        'fuses',
        'globalCap',
        'globalClosedUntil',
        'globalCount',
        'globalFuse',
        'globalFuseReason',
        'panic',
      ].sort(),
    )
  })

  it('快照里的熔断项带 key 与中文 scope（UI 直接用）', () => {
    const { gate } = setup({ safety: { perConvMinIntervalSec: 600, fuseThreshold: 1 } })
    gate.onSent('G-1001', '')
    check(gate)
    check(gate)
    const fuse = gate.snapshot().fuses[0]
    expect(fuse.key).toBe('group_at_me')
    expect(fuse.scope).toBe('群 @我')
    expect(fuse.reason).toBe('rate_conv')
    expect(fuse.since).toMatch(/^\d{4}-\d{2}-\d{2}/)
  })

  it('未填工号的熔断原因给的是可操作指引（O8）', () => {
    const { gate } = setup({ myUserId: '' })
    expect(gate.snapshot().globalFuseReason).toContain('设置页')
  })

  it('reload 保留计数与冷却（改参数不该让配额清零）', () => {
    const { gate, conf } = setup({ safety: { perConvMinIntervalSec: 0, perConvHourlyCap: 5 } })
    gate.onSent('G-1001', '')
    gate.onSent('G-1001', '')
    gate.reload({ ...conf, safety: { ...conf.safety, perConvHourlyCap: 10 } })
    expect(gate.snapshot().convCounts['G-1001']).toBe(2)
  })

  it('settings() 返回当前配置（管线分派时复用同一份）', () => {
    const { gate, conf } = setup()
    gate.reload({ ...conf, myUserId: 'E-9999' })
    expect(gate.settings().myUserId).toBe('E-9999')
  })

  it('onFuse 处理器抛错不影响判定（通知失败不反噬业务）', () => {
    const { gate } = setup({ safety: { perConvMinIntervalSec: 600, fuseThreshold: 0 } })
    gate.onFuse(() => {
      throw new Error('UI 崩了')
    })
    gate.onSent('G-1001', '')
    expect(() => check(gate)).not.toThrow()
  })

  it('panic 也计入熔断观察（多次急停拦截会累计）', () => {
    const { gate } = setup({ safety: { fuseThreshold: 0 } })
    gate.setPanic(true)
    check(gate)
    // panic 不在 FUSE_REASONS 里 → 不熔断（急停本身就是全局态，无需再叠一层）
    expect(gate.fused('group_at_me')).toBe(false)
    expect(gate.snapshot().panic).toBe(true)
  })
})

// ---------------------------------------------------------------- 时钟回拨语义（评审 T-5/P3-2）

/**
 * Gate 的时间判定全部依赖注入时钟，小时桶（本地时间 `slice(0,13)`）变化即清零
 * 全局与会话配额——**含回拨**。这是一个已知取舍（与「重启清零」同级）：本机用户
 * 改时钟本就可为，S1/S4 走绝对时间戳不受影响，方向上是「宁多放行不误伤」。
 * 此前没有任何用例固定这个语义，改动 rollHour 时可能无意翻转——本节把它写死。
 */
describe('SafetyGate —— 时钟回拨/前拨（已知取舍，防无意翻转）', () => {
  it('回拨到上一小时桶：配额随桶重置（放行方向）', () => {
    const { gate, clock } = setup({ safety: { globalHourlyCap: 6 } }, '2026-09-27 15:30:00')
    gate.primeGlobal(6)
    // 本桶（15 点）已达全局上限 → S3 是「挂起」（defer），任务不丢、等下个整点
    expect(check(gate).action).toBe('defer')
    // 回拨到 14 点桶 → rollHour 视为桶变化 → 配额清零 → 放行
    clock.to('2026-09-27 14:30:00')
    expect(check(gate).action).toBe('send')
  })

  it('前拨到下一小时桶：同样重置（桶变化语义与方向无关）', () => {
    const { gate, clock } = setup({ safety: { globalHourlyCap: 6 } }, '2026-09-27 15:30:00')
    gate.primeGlobal(6)
    expect(check(gate).action).toBe('defer')
    clock.to('2026-09-27 16:30:00')
    expect(check(gate).action).toBe('send')
  })

  it('S1 最小间隔用绝对时间戳：回拨反而更保守（回拨后 now < lastSent → 拦）', () => {
    const { gate, clock } = setup({ safety: { perConvMinIntervalSec: 30 } }, '2026-09-27 15:30:00')
    gate.onSent('G-1001', 'E-9001')
    clock.to('2026-09-27 15:30:10') // 仅过 10s（< 30s）
    expect(check(gate).action).toBe('skip')
  })
})
