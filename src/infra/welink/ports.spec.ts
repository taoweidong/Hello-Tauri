import { describe, expect, it, vi } from 'vitest'

/**
 * WeLink 端口夹具（设计 §13「夹具双实现」）。
 *
 * 本文件覆盖**与实现无关的契约**：真实 `welink-cli` 到位后，同一套断言要能直接
 * 跑在 `createCliWelinkPort` 上（因此这里只碰 `WelinkPort` 三个方法 + mock 的
 * 确定性注入点，不碰 mock 内部字段细节以外的实现）。
 *
 * 四个契约要点：
 *  1. `listConversations` 只给**候选**，不参与轮询；
 *  2. `pull` 的 limit 必须生效（P8 载荷可控）、`hasMore` 只在被截断时为真；
 *  3. `send` 返回的 msgUid 是**防双发幂等键**，同一逻辑发送不得复用不同 uid 的重叠语义；
 *  4. 故障注入必须归到正确的 `kind`（错分类会让退避策略误判可重试）。
 */

import { DEMO_SCRIPT, createMockWelinkPort, MOCK_CONVERSATIONS } from '@/infra/welink/mock'
import { WelinkError } from '@/infra/welink/port'
import {
  isLocalGroupId,
  normalizeMessage,
  parseCreateGroupOutput,
  parseJson,
  parseListOutput,
  parsePullOutput,
  parseSendOutput,
} from '@/infra/welink/adapter'
import { listArgs, pullArgs, sendArgs } from '@/infra/welink/commands'
import { withTransportRetry } from '@/infra/welink/exec'

const CONTEXT = { myUserId: 'E-0001', convId: 'G-1001', convType: 'group' as const }

describe('infra/welink —— WelinkError 分类', () => {
  it('默认 kind 是 unknown，name 固定为 WelinkError', () => {
    const error = new WelinkError('boom')
    expect(error.kind).toBe('unknown')
    expect(error.name).toBe('WelinkError')
    expect(error).toBeInstanceOf(Error)
  })

  it('保留 cause 以便排查底层原因', () => {
    const cause = new Error('inner')
    expect(new WelinkError('outer', 'transport', cause).cause).toBe(cause)
  })
})

describe('infra/welink —— withTransportRetry（只重试 transport）', () => {
  it('transport 错重试 1 次后成功', async () => {
    const task = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new WelinkError('抖动', 'transport'))
      .mockResolvedValueOnce('ok')
    await expect(withTransportRetry(task)).resolves.toBe('ok')
    expect(task).toHaveBeenCalledTimes(2)
  })

  it('transport 错连错 2 次后仍抛（不无限重试）', async () => {
    const task = vi.fn<() => Promise<string>>().mockRejectedValue(new WelinkError('持续故障', 'transport'))
    await expect(withTransportRetry(task)).rejects.toBeInstanceOf(WelinkError)
    // 首次 + 1 次重试 = 2；CLI 冷启动有成本，不能在这一层死磕
    expect(task).toHaveBeenCalledTimes(2)
  })

  it('parse 错不重试（协议不兼容，重试只会刷日志）', async () => {
    const task = vi.fn<() => Promise<string>>().mockRejectedValue(new WelinkError('结构不符', 'parse'))
    await expect(withTransportRetry(task)).rejects.toMatchObject({ kind: 'parse' })
    expect(task).toHaveBeenCalledTimes(1)
  })

  it('auth 错不重试', async () => {
    const task = vi.fn<() => Promise<string>>().mockRejectedValue(new WelinkError('未登录', 'auth'))
    await expect(withTransportRetry(task)).rejects.toMatchObject({ kind: 'auth' })
    expect(task).toHaveBeenCalledTimes(1)
  })

  it('未知错误按 unknown 处理，不重试', async () => {
    const task = vi.fn<() => Promise<string>>().mockRejectedValue(new Error('随便一个错'))
    await expect(withTransportRetry(task)).rejects.toThrow('随便一个错')
    expect(task).toHaveBeenCalledTimes(1)
  })

  it('retries=0 时退化为单次调用', async () => {
    const task = vi.fn<() => Promise<string>>().mockRejectedValue(new WelinkError('x', 'transport'))
    await expect(withTransportRetry(task, 0)).rejects.toBeInstanceOf(WelinkError)
    expect(task).toHaveBeenCalledTimes(1)
  })
})

describe('infra/welink —— commands（假设接口的唯一改动面）', () => {
  it('三个子命令都要求 --json（文本格式解析脆弱）', () => {
    expect(listArgs()).toEqual(['list', '--json'])
    expect(pullArgs('G-1', 'group', '', 20)).toContain('--json')
    expect(sendArgs({ convId: 'G-1', convType: 'group' }, 'hi')).toContain('--json')
  })

  it('pull 首次拉取不传 --after（取最新一批，而非从纪元开始）', () => {
    expect(pullArgs('G-1', 'group', '', 20)).toEqual([
      'pull',
      '--conv',
      'G-1',
      '--type',
      'group',
      '--limit',
      '20',
      '--json',
    ])
  })

  it('pull 有游标时追加 --after', () => {
    expect(pullArgs('G-1', 'private', 'c-9', 5)).toEqual([
      'pull',
      '--conv',
      'G-1',
      '--type',
      'private',
      '--limit',
      '5',
      '--json',
      '--after',
      'c-9',
    ])
  })

  it('send 的文本是独立参数（不经 shell，引号/换行/中文安全）', () => {
    const args = sendArgs({ convId: 'G-1', convType: 'group' }, '他说："收到"\n换行')
    // 文本整体是数组中的一个元素，不会被拆分或转义
    expect(args).toContain('他说："收到"\n换行')
    expect(args[args.indexOf('--text') + 1]).toBe('他说："收到"\n换行')
  })
})

describe('infra/welink —— adapter：宽进严出', () => {
  it('字段名容错：msgId / msg_id / id 都能取到 msgUid', () => {
    for (const key of ['msgUid', 'msg_uid', 'msgId', 'msg_id', 'id', 'uuid']) {
      const message = normalizeMessage({ [key]: 'mu-1', content: 'hi' }, CONTEXT)
      expect(message.msgUid).toBe('mu-1')
    }
  })

  it('缺少任何 ID 字段 → parse 错（无幂等键会重复回复，是硬错误）', () => {
    expect(() => normalizeMessage({ content: 'hi' }, CONTEXT)).toThrow(WelinkError)
    try {
      normalizeMessage({ content: 'hi' }, CONTEXT)
    } catch (error) {
      expect((error as WelinkError).kind).toBe('parse')
    }
  })

  it('senderId == myUserId → direction=out（防自回复循环的第一道）', () => {
    expect(normalizeMessage({ id: 'm1', senderId: 'E-0001' }, CONTEXT).direction).toBe('out')
    expect(normalizeMessage({ id: 'm2', senderId: 'E-9001' }, CONTEXT).direction).toBe('in')
  })

  it('自发消息不可能被判为 @我（先定 direction 再定 atMe）', () => {
    const message = normalizeMessage({ id: 'm1', senderId: 'E-0001', atMe: true, content: '@我 自己发给自己' }, CONTEXT)
    expect(message.direction).toBe('out')
    expect(message.atMe).toBe(false)
  })

  it('@所有人 标记（atAll）压制 atMe —— Q5', () => {
    const message = normalizeMessage({ id: 'm1', senderId: 'E-9001', atAll: true, atMe: true }, CONTEXT)
    expect(message.atMe).toBe(false)
  })

  it('只给 atList 时用 myUserId 判定（@我 的第二条识别路径）', () => {
    expect(normalizeMessage({ id: 'm1', atList: ['E-0001'] }, CONTEXT).atMe).toBe(true)
    expect(normalizeMessage({ id: 'm2', atList: ['E-9999'] }, CONTEXT).atMe).toBe(false)
    // atList 元素是对象（CLI 常见形状）也要能取到
    expect(normalizeMessage({ id: 'm3', atList: [{ id: 'E-0001' }] }, CONTEXT).atMe).toBe(true)
  })

  it('myUserId 为空时 atList 路径不误判（不做无根据的 @我）', () => {
    expect(normalizeMessage({ id: 'm1', atList: ['E-0001'] }, { ...CONTEXT, myUserId: '' }).atMe).toBe(false)
  })

  it('非 text 消息替换为占位描述而非丢弃（R2 要求可查）', () => {
    expect(normalizeMessage({ id: 'm1', msgType: 'image', content: 'raw' }, CONTEXT).content).toBe('[图片]')
    expect(normalizeMessage({ id: 'm2', msgType: 'file', content: 'raw' }, CONTEXT).content).toBe('[文件]')
    expect(normalizeMessage({ id: 'm3', msgType: 'weird', content: 'raw' }, CONTEXT).content).toBe('[weird消息]')
  })

  it('msgType 大小写不敏感', () => {
    expect(normalizeMessage({ id: 'm1', msgType: 'IMAGE' }, CONTEXT).msgType).toBe('image')
  })

  it('时间是多种格式：ISO 归一、10 位秒、13 位毫秒', () => {
    expect(normalizeMessage({ id: 'm1', sentAt: '2026-09-27T10:00:00.000Z' }, CONTEXT).sentAt).toBe(
      '2026-09-27 10:00:00',
    )
    expect(normalizeMessage({ id: 'm2', sentAt: 1759000000 }, CONTEXT).sentAt).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
    )
    expect(normalizeMessage({ id: 'm3', sentAt: 1759000000000 }, CONTEXT).sentAt).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
    )
  })

  it('parseJson 空输出与非法 JSON 都归 parse 错，且报错含上下文', () => {
    expect(() => parseJson('', 'pull')).toThrow(/pull：输出为空/)
    expect(() => parseJson('{oops', 'pull')).toThrow(/输出不是合法 JSON/)
  })

  it('parsePullOutput 兼容 {messages} 与裸数组两种形状', () => {
    const wrapped = parsePullOutput(JSON.stringify({ messages: [{ id: 'm1' }], cursor: 'c1', hasMore: true }), CONTEXT)
    expect(wrapped.cursor).toBe('c1')
    expect(wrapped.hasMore).toBe(true)
    expect(wrapped.messages).toHaveLength(1)

    const bare = parsePullOutput(JSON.stringify([{ id: 'm1' }]), CONTEXT)
    expect(bare.messages).toHaveLength(1)
    expect(bare.cursor).toBe('')
  })

  it('parsePullOutput 兼容 data / items / list 容器与 has_more / more 命名', () => {
    expect(parsePullOutput(JSON.stringify({ data: [{ id: 'm1' }], has_more: 1 }), CONTEXT).hasMore).toBe(true)
    expect(parsePullOutput(JSON.stringify({ items: [{ id: 'm1' }], more: true }), CONTEXT).hasMore).toBe(true)
    expect(parsePullOutput(JSON.stringify({ list: [{ id: 'm1' }], next: 'n1' }), CONTEXT).cursor).toBe('n1')
  })

  it('parseListOutput 识别 private/group 并回填候选字段', () => {
    const rows = parseListOutput(
      JSON.stringify([
        { convId: 'E-1', type: 'private', name: '李明', unread: 3 },
        { convId: 'G-1', type: 'group', title: '研发一组' },
      ]),
    )
    expect(rows[0]).toMatchObject({ convType: 'private', convId: 'E-1', title: '李明', unreadCount: 3 })
    expect(rows[1]).toMatchObject({ convType: 'group', convId: 'G-1', title: '研发一组' })
    // 导入候选一律不预开开关，避免「同步一下就自动回复」
    expect(rows.every((row) => !row.watching && !row.autoReply)).toBe(true)
  })

  it('parseCreateGroupOutput 缺 groupId 时派生本地占位（防「已建成」被记成失败）', () => {
    expect(parseCreateGroupOutput(JSON.stringify({ groupId: 'G-9' }), 's')).toBe('G-9')
    expect(parseCreateGroupOutput(JSON.stringify({ ok: true }), 'n-3-123')).toBe('local-n-3-123')
  })

  it('isLocalGroupId 识别本地占位群 ID（UI 据此不把占位冒充真实群 ID）', () => {
    expect(isLocalGroupId('local-n-3-123')).toBe(true)
    expect(isLocalGroupId('G-123')).toBe(false)
    expect(isLocalGroupId('')).toBe(false)
  })

  it('parseSendOutput 缺 msgUid 时用种子派生（保证幂等键稳定）', () => {
    expect(parseSendOutput(JSON.stringify({ msgId: 'x-1' }), 'seed')).toBe('x-1')
    expect(parseSendOutput(JSON.stringify({ ok: true }), 'seed')).toBe('local-seed')
  })
})

describe('infra/welink —— mock 端口契约', () => {
  it('listConversations 返回候选副本（改动不污染模块常量）', async () => {
    const port = createMockWelinkPort()
    const list = await port.listConversations()
    expect(list).toHaveLength(MOCK_CONVERSATIONS.length)
    list[0].title = '被改了'
    expect(MOCK_CONVERSATIONS[0].title).toBe('研发一组')
  })

  it('pull 的 limit 生效（P8 载荷可控）', async () => {
    const port = createMockWelinkPort({ batchSize: 3 })
    const conv = (await port.listConversations())[0]
    const result = await port.pull(conv, '', 1)
    expect(result.messages).toHaveLength(1)
    // 被 limit 截断时 hasMore 为真 —— 编排层续批逻辑的真实触发条件
    expect(result.hasMore).toBe(true)
  })

  it('prompt 不传 limit 截断时返回完整批次', async () => {
    const port = createMockWelinkPort({ batchSize: 2 })
    const conv = (await port.listConversations())[0]
    const result = await port.pull(conv, '', 10)
    expect(result.messages).toHaveLength(2)
    expect(result.hasMore).toBe(false)
  })

  it('cursor 随批次推进（拉两次的游标不同）', async () => {
    const port = createMockWelinkPort()
    const conv = (await port.listConversations())[0]
    const first = await port.pull(conv, '', 5)
    const second = await port.pull(conv, first.cursor, 5)
    expect(second.cursor).not.toBe(first.cursor)
  })

  it('常规批次同时含 in/out 与 @我/非@我样本（覆盖触发规则各分支）', async () => {
    const port = createMockWelinkPort()
    const conv = (await port.listConversations()).find((item) => item.convType === 'group')!
    const { messages } = await port.pull(conv, '', 10)
    expect(messages.some((item) => item.direction === 'out')).toBe(true)
    expect(messages.some((item) => item.direction === 'in' && item.atMe)).toBe(true)
    expect(messages.some((item) => item.direction === 'in' && !item.atMe)).toBe(true)
  })

  it('批次内时间严格递增', async () => {
    const port = createMockWelinkPort()
    const conv = (await port.listConversations())[0]
    const { messages } = await port.pull(conv, '', 10)
    for (let index = 1; index < messages.length; index += 1) {
      expect(messages[index].sentAt >= messages[index - 1].sentAt).toBe(true)
    }
  })

  it('确定性故障注入：failNextPull 只影响接下来的 N 次', async () => {
    const port = createMockWelinkPort()
    const conv = (await port.listConversations())[0]
    port.failNextPull(2)
    await expect(port.pull(conv, '', 5)).rejects.toMatchObject({ kind: 'transport' })
    await expect(port.pull(conv, '', 5)).rejects.toMatchObject({ kind: 'transport' })
    await expect(port.pull(conv, '', 5)).resolves.toBeTruthy()
  })

  it('send 返回唯一 msgUid 并记账（防双发幂等键的来源）', async () => {
    const port = createMockWelinkPort()
    const first = await port.send({ convId: 'G-1001', convType: 'group' }, '收到')
    const second = await port.send({ convId: 'G-1001', convType: 'group' }, '收到')
    expect(first.msgUid).not.toBe(second.msgUid)
    expect(port.sentMessages).toHaveLength(2)
    expect(port.sentMessages[0]).toMatchObject({ convId: 'G-1001', text: '收到' })
  })

  it('send 失败注入归为 transport（外发 worker 靠它决定退避）', async () => {
    const port = createMockWelinkPort({ sendFailures: 1 })
    await expect(port.send({ convId: 'G-1', convType: 'group' }, 'x')).rejects.toMatchObject({
      kind: 'transport',
    })
    await expect(port.send({ convId: 'G-1', convType: 'group' }, 'x')).resolves.toBeTruthy()
  })

  it('reset 清空状态（用例间隔离）', async () => {
    const port = createMockWelinkPort()
    const conv = (await port.listConversations())[0]
    await port.pull(conv, '', 5)
    await port.send({ convId: 'G-1', convType: 'group' }, 'x')
    expect(port.state.pullCount).toBe(1)
    expect(port.sentMessages).toHaveLength(1)
    port.reset()
    expect(port.state.pullCount).toBe(0)
    expect(port.sentMessages).toHaveLength(0)
  })

  it('演示剧本（O13）：三段放完后静默（不再产出）', async () => {
    const port = createMockWelinkPort()
    const conv = (await port.listConversations()).find((item) => item.convType === 'group')!
    port.playScript()
    const batches: number[] = []
    for (let index = 0; index < DEMO_SCRIPT.demo.length; index += 1) {
      batches.push((await port.pull(conv, '', 10)).messages.length)
    }
    // 剧本放完 → 空批次（而不是回落到常规池，避免演示后继续刷消息）
    expect((await port.pull(conv, '', 10)).messages).toHaveLength(0)
    expect(batches.every((count) => count > 0)).toBe(true)
  })

  it('剧本首段包含「@所有人」与「@我」两类样本（可演示 Q5 的分流）', () => {
    const first = DEMO_SCRIPT.demo[0].messages
    expect(first.some((item) => item.content.includes('@所有人'))).toBe(true)
    expect(first.some((item) => item.atMe === true)).toBe(true)
  })
})
