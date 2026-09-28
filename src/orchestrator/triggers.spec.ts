import { describe, expect, it } from 'vitest'

import { buildTriggerMap, isAtAll, matchSkipReason, matchTrigger, sceneEnabled } from '@/orchestrator/triggers'
import type { NormalizedMessage } from '@/types/welink'

/**
 * 触发规则单测（设计 §7.1 规则表）。
 *
 * 为什么规则要单独成文件并被重点测试：它决定「哪些消息值得回」，
 * 判错两个方向的代价都不对称 ——
 *  * 漏判（该回不回）用户会发现功能没生效；
 *  * 误判（不该回却回）代价高得多：@所有人 被当成 @我 → 群里刷屏；自发消息成触发
 *    → 自回复死循环。因此每条「不建任务」的分支都要有断言。
 */

const settings = {
  watching: true,
  myUserId: 'E-0001',
  groupAtMe: true,
  privateAutoReply: true,
  // S5：测试默认关闭合并（各条规则断言的是「这条消息建不建任务」，
  // 合并行为由下面的专门用例覆盖，避免它干扰其他断言）
  mergeWindowSec: 0,
}

function msg(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    msgUid: 'm-1',
    convType: 'group',
    convId: 'G-1001',
    direction: 'in',
    senderId: 'E-9001',
    senderName: '赵敏',
    content: '@你 看一下这个接口',
    msgType: 'text',
    atMe: true,
    sentAt: '2026-09-27 10:00:00',
    ...overrides,
  }
}

describe('orchestrator/triggers —— §7.1 触发规则', () => {
  describe('matchTrigger 命中', () => {
    it('群消息 @我 → group_at_me', () => {
      expect(matchTrigger(msg(), settings)).toBe('group_at_me')
    })

    it('私聊消息（有 watching）→ private', () => {
      expect(matchTrigger(msg({ convType: 'private', convId: 'E-2001', atMe: false, content: '在吗' }), settings)).toBe(
        'private',
      )
    })

    it('私聊即使未 @我 也触发（私聊天然指向本人）', () => {
      expect(matchTrigger(msg({ convType: 'private', convId: 'E-2001', atMe: false }), settings)).toBe('private')
    })
  })

  describe('matchTrigger 不命中（防误回的每一道闸）', () => {
    it('会话未监控 → null（watching 双保险）', () => {
      expect(matchTrigger(msg(), { ...settings, watching: false })).toBeNull()
    })

    it('direction=out 的自发消息 → null（防自回复循环）', () => {
      expect(matchTrigger(msg({ direction: 'out' }), settings)).toBeNull()
    })

    it('senderId 等于 myUserId → null（CLI 未标 direction 时的兜底）', () => {
      expect(matchTrigger(msg({ senderId: 'E-0001' }), settings)).toBeNull()
    })

    it('myUserId 为空时不做自发过滤（不误杀全部消息）', () => {
      expect(matchTrigger(msg({ senderId: '' }), { ...settings, myUserId: '' })).toBe('group_at_me')
    })

    it('非 text 消息 → null（图片/文件只占位存档）', () => {
      expect(matchTrigger(msg({ msgType: 'image', content: '[图片]' }), settings)).toBeNull()
    })

    it('群消息未 @我 → null', () => {
      expect(matchTrigger(msg({ atMe: false }), settings)).toBeNull()
    })

    it('@所有人 不算 @我（Q5：不回复全员广播）', () => {
      expect(matchTrigger(msg({ content: '@所有人 下午三点例会照常', atMe: true }), settings)).toBeNull()
    })

    it('L2 场景开关关闭不阻止建任务（留档可审计）', () => {
      // 这是 v4.2 的关键立场：开关只拦外发，不拦留档
      expect(matchTrigger(msg(), { ...settings, groupAtMe: false })).toBe('group_at_me')
      expect(
        matchTrigger(msg({ convType: 'private', convId: 'E-2001' }), { ...settings, privateAutoReply: false }),
      ).toBe('private')
    })
  })

  describe('isAtAll —— @所有人 文本兜底检测', () => {
    it.each(['@所有人 下午三点例会', '@全体成员 注意', '@All please review', '@  所有人（中间有空格）'])(
      '识别「%s」',
      (content) => {
        expect(isAtAll(content)).toBe(true)
      },
    )

    it.each(['@你 看一下', '@赵敏 收到', '所有人事已毕'])('普通文本「%s」不算 @所有人', (content) => {
      expect(isAtAll(content)).toBe(false)
    })

    it('大小写不敏感（@ALL）', () => {
      expect(isAtAll('@ALL hands meeting')).toBe(true)
    })
  })

  describe('matchSkipReason —— 未命中原因的 UI 文案', () => {
    it('未监控优先于其他原因', () => {
      expect(matchSkipReason(msg({ direction: 'out' }), { ...settings, watching: false })).toBe('会话未开启监控')
    })

    it.each([
      [{ direction: 'out' as const }, '自己发出的消息'],
      [{ msgType: 'file' }, '非文本消息（file）仅占位存档'],
      [{ atMe: false, content: '普通消息' }, '群消息未 @我'],
      [{ content: '@所有人 公告', atMe: true }, '@所有人 不算 @我'],
    ])('原因 %#：%o', (patch, expected) => {
      expect(matchSkipReason(msg(patch), settings)).toBe(expected)
    })

    it('命中的消息返回 null（与 matchTrigger 口径一致）', () => {
      expect(matchSkipReason(msg(), settings)).toBeNull()
      expect(matchSkipReason(msg({ convType: 'private', convId: 'E-2001', atMe: false }), settings)).toBeNull()
    })
  })

  describe('buildTriggerMap —— 一轮批量的触发表与原因统计', () => {
    const batch: NormalizedMessage[] = [
      msg({ msgUid: 'a', content: '@你 接口文档更新了' }),
      msg({ msgUid: 'b', atMe: false, content: '收到' }),
      msg({ msgUid: 'c', content: '@所有人 例会照常' }),
      msg({ msgUid: 'd', msgType: 'image', content: '[图片]' }),
      msg({ msgUid: 'e', direction: 'out', senderId: 'E-0001', content: '好的' }),
      msg({ msgUid: 'f', convType: 'private', convId: 'E-2001', atMe: false, content: '在吗' }),
    ]

    it('只有 a 与 f 进触发表，其余进 skipped 且各有原因', () => {
      const { triggers, skipped } = buildTriggerMap(batch, settings)
      expect(Object.keys(triggers).sort()).toEqual(['a', 'f'])
      expect(triggers.a).toBe('group_at_me')
      expect(triggers.f).toBe('private')
      expect(Object.keys(skipped).sort()).toEqual(['b', 'c', 'd', 'e'])
      expect(skipped.b).toBe('群消息未 @我')
      expect(skipped.c).toBe('@所有人 不算 @我')
      expect(skipped.d).toContain('仅占位存档')
      expect(skipped.e).toBe('自己发出的消息')
    })

    it('触发表与原因表互补（同一条消息只出现在一侧）', () => {
      const { triggers, skipped } = buildTriggerMap(batch, settings)
      const overlap = Object.keys(triggers).filter((uid) => uid in skipped)
      expect(overlap).toEqual([])
      expect(Object.keys(triggers).length + Object.keys(skipped).length).toBe(batch.length)
    })

    it('空批返回两个空表（不抛）', () => {
      expect(buildTriggerMap([], settings)).toEqual({ triggers: {}, skipped: {}, merged: [] })
    })

    it('未监控时全部进 skipped，触发表为空', () => {
      const { triggers, skipped } = buildTriggerMap(batch, { ...settings, watching: false })
      expect(triggers).toEqual({})
      expect(Object.keys(skipped)).toHaveLength(batch.length)
    })
  })

  /**
   * S5 同人短窗合并（设计 §5A.2-S5）。
   *
   * 这条规则的真实缺陷是「管道传了空 senderId，规则永不触发」——
   * 除了 Gate 侧，这里也补一层**建任务阶段**的合并，保证「一次回复、
   * 上下文含全部触发」在提示词生成前就成立。
   */
  describe('buildTriggerMap —— S5 同人短窗合并', () => {
    const mergedSettings = { ...settings, mergeWindowSec: 30 }

    it('同一发送者 30s 内连发三条 → 只保留最早一条建任务', () => {
      const batch = [
        msg({ msgUid: 'm1', sentAt: '2026-09-27 10:00:00', content: '@你 第一条' }),
        msg({ msgUid: 'm2', sentAt: '2026-09-27 10:00:05', content: '@你 补充一下' }),
        msg({ msgUid: 'm3', sentAt: '2026-09-27 10:00:20', content: '@你 还有一点' }),
      ]
      const { triggers, merged, skipped } = buildTriggerMap(batch, mergedSettings)
      expect(Object.keys(triggers)).toEqual(['m1'])
      expect(merged).toEqual(['m2', 'm3'])
      expect(skipped.m2).toContain('合并为一次回复')
      expect(skipped.m3).toContain('合并为一次回复')
    })

    it('超出合并窗口 → 各自建任务', () => {
      const batch = [
        msg({ msgUid: 'm1', sentAt: '2026-09-27 10:00:00' }),
        msg({ msgUid: 'm2', sentAt: '2026-09-27 10:00:31' }),
      ]
      expect(Object.keys(buildTriggerMap(batch, mergedSettings).triggers)).toEqual(['m1', 'm2'])
    })

    it('不同发送者同刻 @我 → 不合并（各自都需要被回复）', () => {
      const batch = [
        msg({ msgUid: 'm1', senderId: 'E-9001', sentAt: '2026-09-27 10:00:00' }),
        msg({ msgUid: 'm2', senderId: 'E-9002', sentAt: '2026-09-27 10:00:02' }),
      ]
      expect(Object.keys(buildTriggerMap(batch, mergedSettings).triggers)).toEqual(['m1', 'm2'])
    })

    it('不同会话的同一发送者 → 不合并（会话是合并的作用域）', () => {
      const batch = [
        msg({ msgUid: 'm1', convId: 'G-1', sentAt: '2026-09-27 10:00:00' }),
        msg({ msgUid: 'm2', convId: 'G-2', sentAt: '2026-09-27 10:00:02' }),
      ]
      expect(Object.keys(buildTriggerMap(batch, mergedSettings).triggers)).toEqual(['m1', 'm2'])
    })

    it('窗口为 0（关闭合并）→ 全部建任务', () => {
      const batch = [
        msg({ msgUid: 'm1', sentAt: '2026-09-27 10:00:00' }),
        msg({ msgUid: 'm2', sentAt: '2026-09-27 10:00:01' }),
      ]
      expect(Object.keys(buildTriggerMap(batch, settings).triggers)).toEqual(['m1', 'm2'])
    })

    it('保留的是**最早**一条，与输入数组顺序无关', () => {
      const batch = [
        msg({ msgUid: 'late', sentAt: '2026-09-27 10:00:20' }),
        msg({ msgUid: 'early', sentAt: '2026-09-27 10:00:00' }),
      ]
      const { triggers, merged } = buildTriggerMap(batch, mergedSettings)
      expect(Object.keys(triggers)).toEqual(['early'])
      expect(merged).toEqual(['late'])
    })

    it('被合并的消息仍计入 skipped（留痕，不静默丢弃）', () => {
      const batch = [
        msg({ msgUid: 'm1', sentAt: '2026-09-27 10:00:00' }),
        msg({ msgUid: 'm2', sentAt: '2026-09-27 10:00:01' }),
      ]
      const { triggers, skipped } = buildTriggerMap(batch, mergedSettings)
      expect(Object.keys(triggers).length + Object.keys(skipped).length).toBe(batch.length)
    })
  })

  describe('sceneEnabled —— L2 场景开关（UI 提示用）', () => {
    it('私聊看 privateAutoReply', () => {
      const privateMsg = msg({ convType: 'private', convId: 'E-2001' })
      expect(sceneEnabled(privateMsg, { ...settings, privateAutoReply: false })).toBe(false)
      expect(sceneEnabled(privateMsg, settings)).toBe(true)
    })

    it('群看 groupAtMe', () => {
      expect(sceneEnabled(msg(), { ...settings, groupAtMe: false })).toBe(false)
      expect(sceneEnabled(msg(), settings)).toBe(true)
    })
  })
})
