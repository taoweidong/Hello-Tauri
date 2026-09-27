import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * WeLink 仓储双实现契约测试（设计 §13：端口夹具双实现）。
 *
 * 为什么单有 `welink.spec.ts`（SQL 文本断言）还不够：那一层只证明「SQLite 实现
 * 写了什么 SQL」，证明不了「内存实现与它**语义一致**」。而浏览器调试模式
 * （`npm run dev`，无 Rust 环境）跑的是内存实现 —— 两套实现一旦漂移，
 * 就会出现「桌面能复现、浏览器调试复现不了」这种最难查的 bug。
 *
 * 这里对**同一组操作序列**同时喂给两个实现，断言**可观察结果**一致。
 * 它同时是一道防呆闸：接口新增方法（例如 S5 修复引入的 `getMessage`）却漏改
 * 某一侧时，这里会先红 —— 之前正是靠人肉 typecheck 才发现，代价是一次误判。
 *
 * 仿真边界：只在「本文件用到的语句形态」上仿真 SQLite，未覆盖的语句会抛错
 * （宁可显式失败，也不要静默返回空数组伪造通过）。
 */
import type { NormalizedMessage } from '@/types/welink'

type DbParam = unknown
type DbRow = Record<string, unknown>
type Row = Record<string, unknown>

const tables = { conversations: [] as Row[], messages: [] as Row[], jobs: [] as Row[] }
let seq = { conv: 0, msg: 0, job: 0 }

function resetTables() {
  tables.conversations.length = 0
  tables.messages.length = 0
  tables.jobs.length = 0
  seq = { conv: 0, msg: 0, job: 0 }
}

function stamp(): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  const date = new Date()
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  )
}

/** `?n` 取实参（1-based，与 SQLite 占位符口径一致） */
const arg = (params: DbParam[], index: number): unknown => params[index - 1]

const text = (value: unknown): string => (value === null || value === undefined ? '' : String(value))
const number = (value: unknown): number => Number(value ?? 0)

const db = vi.hoisted(() => ({
  platform: 'tauri',
  dbExecute: vi.fn<(sql: string, params?: DbParam[]) => Promise<{ changes: number; lastInsertId: number }>>(),
  dbSelect: vi.fn<(sql: string, params?: DbParam[]) => Promise<DbRow[]>>(),
  dbTransaction: vi.fn(async (statements: { sql: string; params?: DbParam[] }[]) => statements.map(() => 1)),
}))

vi.mock('@/api', () => ({
  bridge: db,
  get platform() {
    return db.platform
  },
}))

vi.mock('@/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { sqlWelinkRepository } from '@/infra/db/repos/welink'
import { memoryWelinkRepository, resetWelinkMemory } from '@/infra/db/repos/welink-memory'
import type { WelinkRepository } from '@/infra/db/ports'

// ---------------- 内存侧：隔离 localStorage ----------------

const storage = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => void storage.set(key, value),
  removeItem: (key: string) => void storage.delete(key),
  clear: () => storage.clear(),
})

// ---------------- SQLite 侧：语句级仿真 ----------------

/** 一条语句的写执行。未覆盖形态直接抛错，避免「静默成功」伪造通过。 */
function execStatement(rawSql: string, params: DbParam[] = []): number {
  const sql = rawSql.replace(/\s+/g, ' ').trim()

  // —— 会话写入 ——
  if (sql.startsWith('INSERT INTO welink_conversations')) {
    const [, convId, title, remark, watching, autoReply] = params
    const existing = tables.conversations.find((row) => row.conv_id === convId)
    if (existing) {
      if (text(title)) existing.title = title
      existing.updated_at = stamp()
    } else {
      tables.conversations.push({
        id: (seq.conv += 1),
        conv_type: arg(params, 1),
        conv_id: convId,
        title,
        remark,
        watching,
        auto_reply: autoReply,
        mute_until: null,
        last_msg_at: '',
        unread_count: 0,
        mention_count: 0,
        last_active: '',
        last_cursor: '',
        updated_at: stamp(),
      })
    }
    return 1
  }

  if (sql.startsWith('UPDATE welink_conversations SET last_cursor')) {
    const conv = tables.conversations.find((row) => row.id === number(arg(params, 1)))
    if (conv) {
      conv.last_cursor = arg(params, 2)
      const lastMsgAt = text(arg(params, 6))
      if (lastMsgAt && lastMsgAt > text(conv.last_msg_at)) conv.last_msg_at = lastMsgAt
      if (lastMsgAt) conv.last_active = arg(params, 3)
      conv.unread_count = number(conv.unread_count) + number(arg(params, 4))
      conv.mention_count = number(conv.mention_count) + number(arg(params, 5))
    }
    return 1
  }

  if (sql.startsWith('UPDATE welink_conversations SET unread_count = 0')) {
    const conv = tables.conversations.find((row) => row.id === number(arg(params, 1)))
    if (conv) {
      conv.unread_count = 0
      conv.mention_count = 0
    }
    return 1
  }

  // —— 消息写入（INSERT OR IGNORE：msg_uid 唯一） ——
  if (sql.startsWith('INSERT OR IGNORE INTO welink_messages')) {
    const msgUid = text(arg(params, 1))
    if (tables.messages.some((row) => row.msg_uid === msgUid)) return 0
    tables.messages.push({
      id: (seq.msg += 1),
      msg_uid: msgUid,
      conv_pk: arg(params, 2),
      direction: arg(params, 3),
      sender_id: arg(params, 4),
      sender_name: arg(params, 5),
      content: arg(params, 6),
      msg_type: arg(params, 7),
      at_me: arg(params, 8),
      read_flag: arg(params, 9),
      sent_at: arg(params, 10),
      created_at: arg(params, 11),
    })
    return 1
  }

  if (sql.startsWith('UPDATE welink_messages SET read_flag')) {
    for (const row of tables.messages) {
      if (row.conv_pk === arg(params, 1) && number(row.read_flag) === 0) row.read_flag = 1
    }
    return 1
  }

  // —— 任务写入（trigger_msg_pk 走 `(SELECT id ... WHERE msg_uid = ?1)` 子查询） ——
  if (sql.startsWith('INSERT INTO welink_reply_jobs')) {
    const triggerUid = text(arg(params, 1))
    const trigger = tables.messages.find((row) => row.msg_uid === triggerUid)
    const targetId = text(arg(params, 4))
    const createdAt = text(arg(params, 6))
    tables.jobs.push({
      id: (seq.job += 1),
      trigger_msg_pk: trigger?.id ?? null,
      trigger_type: arg(params, 2),
      target_type: arg(params, 3),
      target_id: targetId,
      send_mode_used: arg(params, 5),
      context_snapshot: '',
      draft: '',
      status: 'pending',
      attempts: 0,
      last_error: '',
      skip_reason: '',
      hold_reason: '',
      rating: null,
      created_at: createdAt,
      updated_at: createdAt,
      finished_at: null,
    })
    return 1
  }

  throw new Error(`SQLite 仿真未覆盖的写语句：\n${sql}`)
}

/** 一条语句的读执行 */
function selectSql(rawSql: string, params: DbParam[] = []): DbRow[] {
  const sql = rawSql.replace(/\s+/g, ' ').trim()

  const messageRow = (message: Row): DbRow => {
    const conv = tables.conversations.find((row) => row.id === message.conv_pk)
    return {
      id: message.id,
      conv_pk: message.conv_pk,
      msg_uid: message.msg_uid,
      direction: message.direction,
      sender_id: message.sender_id,
      sender_name: message.sender_name,
      content: message.content,
      msg_type: message.msg_type,
      at_me: message.at_me,
      read_flag: message.read_flag,
      sent_at: message.sent_at,
      conv_type: conv?.conv_type,
      conv_id: conv?.conv_id,
    }
  }

  const jobRow = (job: Row): DbRow => {
    const trigger = tables.messages.find((row) => row.id === job.trigger_msg_pk)
    const conv = tables.conversations.find((row) => row.conv_id === job.target_id)
    return {
      ...job,
      trigger_summary: text(trigger?.content).slice(0, 120),
      target_title: text(conv?.title),
    }
  }

  const byIdAsc = (left: Row, right: Row) => number(left.id) - number(right.id)
  const bySentAt = (left: Row, right: Row) =>
    text(left.sent_at) === text(right.sent_at) ? byIdAsc(left, right) : text(left.sent_at) < text(right.sent_at) ? -1 : 1

  if (sql.includes('SELECT id FROM welink_conversations WHERE conv_id =')) {
    const convId = text(arg(params, 1))
    return tables.conversations.filter((row) => row.conv_id === convId).map((row) => ({ id: row.id }))
  }

  if (sql.startsWith('SELECT COUNT(*) AS count FROM welink_conversations')) {
    return [{ count: tables.conversations.length }]
  }

  // 会话列（CONV_COLUMNS）的三种读法
  if (sql.includes('FROM welink_conversations') && !sql.includes('JOIN')) {
    let rows = tables.conversations.slice()
    if (sql.includes('WHERE watching = 1')) rows = rows.filter((row) => number(row.watching) === 1)
    else if (sql.includes('WHERE conv_id =')) rows = rows.filter((row) => row.conv_id === text(arg(params, 1)))
    if (sql.includes('ORDER BY id')) rows.sort(byIdAsc)
    if (sql.includes('ORDER BY conv_type, last_msg_at DESC')) {
      rows.sort((left, right) =>
        text(left.conv_type) === text(right.conv_type)
          ? text(left.last_msg_at) === text(right.last_msg_at)
            ? number(right.id) - number(left.id)
            : text(left.last_msg_at) < text(right.last_msg_at)
              ? 1
              : -1
          : text(left.conv_type).localeCompare(text(right.conv_type)),
      )
    }
    return rows.map((row) => ({ ...row }))
  }

  if (sql.includes('SELECT msg_uid FROM welink_messages WHERE msg_uid IN')) {
    const uids = new Set(params.map(text))
    return tables.messages.filter((row) => uids.has(text(row.msg_uid))).map((row) => ({ msg_uid: row.msg_uid }))
  }

  if (sql.includes('FROM welink_messages m JOIN welink_conversations c')) {
    if (sql.includes('WHERE m.id =')) {
      const id = number(arg(params, 1))
      return tables.messages.filter((row) => row.id === id).map(messageRow)
    }
    if (sql.includes('WHERE m.msg_uid IN')) {
      const uids = new Set(params.map(text))
      return tables.messages
        .filter((row) => uids.has(text(row.msg_uid)))
        .sort(bySentAt)
        .map(messageRow)
    }
    if (sql.includes('WHERE m.conv_pk =')) {
      const convPk = number(arg(params, 1))
      const limit = number(arg(params, 2))
      return tables.messages
        .filter((row) => row.conv_pk === convPk)
        .sort((left, right) => (bySentAt(left, right) === 0 ? 0 : -bySentAt(left, right)))
        .slice(0, limit)
        .map(messageRow)
    }
  }

  if (sql.includes('FROM welink_reply_jobs j')) {
    const targetId = text(arg(params, 1))
    const createdAt = text(arg(params, 2))
    return tables.jobs
      .filter((row) => row.target_id === targetId && text(row.created_at) === createdAt)
      .sort(byIdAsc)
      .map(jobRow)
  }

  throw new Error(`SQLite 仿真未覆盖的读语句：\n${sql}`)
}

function installSqliteSim() {
  db.dbExecute.mockImplementation(async (sql, params = []) => ({
    changes: execStatement(sql, params),
    lastInsertId: seq.conv || seq.msg || seq.job,
  }))
  db.dbSelect.mockImplementation(async (sql, params = []) => selectSql(sql, params))
  db.dbTransaction.mockImplementation(async (statements) => statements.map((item) => execStatement(item.sql, item.params ?? [])))
}

// ---------------- 契约用例 ----------------

/**
 * 端口不变量（见 `infra/welink/adapter.ts` 的 `convId: pickString(..., context.convId)`）：
 * **拉取结果里每条消息的 convId 必然等于 `pull()` 入参会话的 convId** —— 适配器在
 * 原始报文缺字段时用上下文兜底，故这是一条有保障的前提，而非约定俗成的巧合。
 *
 * 契约测试必须尊重它：如果夹具造出「消息 convId ≠ 拉取会话 convId」的数据，
 * 那是在测一个端口不可能产出的世界，测出来的失败也没有修复价值。
 */
function messagesFor(convId: string, items: Array<Partial<NormalizedMessage>>): NormalizedMessage[] {
  return items.map((item, index) =>
    message({ msgUid: `uid-${index + 1}`, convId, sentAt: `2026-09-27 10:0${index}:00`, ...item }),
  )
}

function message(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    msgUid: 'uid-1',
    convType: 'group',
    convId: 'G-1001',
    direction: 'in',
    senderId: 'E-9001',
    senderName: '赵敏',
    content: '@我 看下接口报 500',
    msgType: 'text',
    atMe: true,
    sentAt: '2026-09-27 13:59:00',
    ...overrides,
  }
}

/** 同一段操作喂给两个实现，返回可对比的结果 */
async function runBoth<T>(scenario: (repo: WelinkRepository) => Promise<T>): Promise<{ sqlite: T; memory: T }> {
  resetTables()
  installSqliteSim()
  const sqlite = await scenario(sqlWelinkRepository)

  resetWelinkMemory()
  storage.clear()
  const memory = await scenario(memoryWelinkRepository)

  return { sqlite, memory }
}

describe('WelinkRepository 双实现契约（SQLite ⇄ 内存）', () => {
  beforeEach(() => {
    resetTables()
    db.dbExecute.mockReset()
    db.dbSelect.mockReset()
    db.dbTransaction.mockReset()
  })

  it('接口方法集完全一致（漏实现会被 TS 拦住，运行时也要有兜底断言）', () => {
    expect(Object.keys(memoryWelinkRepository).sort()).toEqual(Object.keys(sqlWelinkRepository).sort())
  })

  it('getMessage 是 S5 的读路径：按主键取回，且返回浅拷贝（外部改写不污染内存态）', async () => {
    const { sqlite, memory } = await runBoth(async (repo) => {
      await repo.upsertConversation({ convType: 'group', convId: 'G-1', title: '核心业务群', watching: true })
      const applied = await repo.applyPollResult('G-1', messagesFor('G-1', [{}]), 'cursor-1', {
        triggers: {},
        sendMode: 'auto',
      })
      const pk = applied.inserted[0].pk
      return { pk, found: await repo.getMessage(pk) }
    })

    expect(sqlite.found).not.toBeNull()
    expect(memory.found).not.toBeNull()
    // 主键由各自分配，只对比业务字段口径
    expect(memory.found).toMatchObject({
      msgUid: sqlite.found!.msgUid,
      senderId: sqlite.found!.senderId,
      senderName: sqlite.found!.senderName,
      content: sqlite.found!.content,
      direction: sqlite.found!.direction,
      convId: sqlite.found!.convId,
      convType: sqlite.found!.convType,
      readFlag: sqlite.found!.readFlag,
      sentAt: sqlite.found!.sentAt,
    })

    memory.found!.content = '被外部改写了'
    expect((await memoryWelinkRepository.getMessage(memory.pk))!.content).toBe('@我 看下接口报 500')
  })

  it('getMessage 找不到时一致返回 null（不抛）', async () => {
    const { sqlite, memory } = await runBoth(async (repo) => repo.getMessage(9999))
    expect(sqlite).toBeNull()
    expect(memory).toBeNull()
  })

  it('upsertConversation 幂等：同 convId 只更新 title，不覆盖 watching / remark', async () => {
    const { sqlite, memory } = await runBoth(async (repo) => {
      await repo.upsertConversation({ convType: 'group', convId: 'G-1', title: '旧名', remark: '备注', watching: true })
      await repo.upsertConversation({ convType: 'group', convId: 'G-1', title: '新名' })
      return { conv: await repo.getConversation('G-1'), count: (await repo.listConversations(10, 0)).length }
    })

    for (const side of [sqlite, memory]) {
      expect(side.count).toBe(1)
      expect(side.conv).toMatchObject({ title: '新名', watching: true, remark: '备注' })
    }
  })

  it('applyPollResult 幂等：同 msgUid 重复入库只建一次 job、只加一次未读', async () => {
    const { sqlite, memory } = await runBoth(async (repo) => {
      await repo.upsertConversation({ convType: 'group', convId: 'G-1', title: '群', watching: true })
      const batch = messagesFor('G-1', [{}])
      const first = await repo.applyPollResult('G-1', batch, 'c1', { triggers: { 'uid-1': 'group_at_me' }, sendMode: 'auto' })
      const second = await repo.applyPollResult('G-1', batch, 'c2', { triggers: { 'uid-1': 'group_at_me' }, sendMode: 'auto' })
      const conv = await repo.getConversation('G-1')
      return {
        first: first.inserted.length,
        firstJobs: first.createdJobs.length,
        second: second.inserted.length,
        secondJobs: second.createdJobs.length,
        unread: conv!.unreadCount,
      }
    })

    for (const side of [sqlite, memory]) {
      expect(side).toMatchObject({ first: 1, firstJobs: 1, second: 0, secondJobs: 0, unread: 1 })
    }
  })

  it('applyPollResult 未命中触发时不建 job（规则由编排层决定，数据层不越权）', async () => {
    const { sqlite, memory } = await runBoth(async (repo) => {
      await repo.upsertConversation({ convType: 'group', convId: 'G-1', title: '群', watching: true })
      return repo.applyPollResult('G-1', messagesFor('G-1', [{}]), 'c1', { triggers: {}, sendMode: 'auto' })
    })
    expect(sqlite.createdJobs).toHaveLength(0)
    expect(memory.createdJobs).toHaveLength(0)
  })

  it('新 job 的触发消息主键指向真实消息行（S5 靠它反查 senderId）', async () => {
    const { sqlite, memory } = await runBoth(async (repo) => {
      await repo.upsertConversation({ convType: 'group', convId: 'G-1', title: '群', watching: true })
      const applied = await repo.applyPollResult('G-1', messagesFor('G-1', [{}]), 'c1', {
        triggers: { 'uid-1': 'group_at_me' },
        sendMode: 'auto',
      })
      const job = applied.createdJobs[0]
      return { targetId: job.targetId, triggerSrc: await repo.getMessage(job.triggerMsgPk) }
    })

    for (const side of [sqlite, memory]) {
      expect(side.triggerSrc).not.toBeNull()
      expect(side.triggerSrc!.senderId).toBe('E-9001')
      expect(side.triggerSrc!.msgUid).toBe('uid-1')
      // job.target_id 口径必须与拉取会话一致，否则 UI 的「该会话待办」会查不到任务
      expect(side.targetId).toBe('G-1')
    }
  })

  it('markRead 清未读：读标记与汇总列一起归零（O6 唯一真值口径）', async () => {
    const { sqlite, memory } = await runBoth(async (repo) => {
      const conv = await repo.upsertConversation({ convType: 'group', convId: 'G-1', title: '群', watching: true })
      await repo.applyPollResult('G-1', messagesFor('G-1', [{}]), 'c1', { triggers: {}, sendMode: 'auto' })
      await repo.markRead(conv.pk)
      const after = await repo.getConversation('G-1')
      const ctx = await repo.recentContext(conv.pk, 10)
      return { unread: after!.unreadCount, mention: after!.mentionCount, readFlag: ctx[0]?.readFlag }
    })
    expect(sqlite).toMatchObject({ unread: 0, mention: 0, readFlag: true })
    expect(memory).toMatchObject({ unread: 0, mention: 0, readFlag: true })
  })

  it('listWatching 只返回 watching=1（poller 的数据源口径）', async () => {
    const { sqlite, memory } = await runBoth(async (repo) => {
      await repo.upsertConversation({ convType: 'group', convId: 'G-1', title: '看', watching: true })
      await repo.upsertConversation({ convType: 'group', convId: 'G-2', title: '不看', watching: false })
      return (await repo.listWatching()).map((row) => row.convId).sort()
    })
    expect(sqlite).toEqual(['G-1'])
    expect(memory).toEqual(['G-1'])
  })

  it('recentContext 返回正序（提示词里时间必须正序，倒序查后要翻回来）', async () => {
    const { sqlite, memory } = await runBoth(async (repo) => {
      const conv = await repo.upsertConversation({ convType: 'group', convId: 'G-1', title: '群', watching: true })
      await repo.applyPollResult(
        'G-1',
        messagesFor('G-1', [{ content: '第一句' }, { content: '第二句' }, { content: '第三句' }]),
        'c1',
        { triggers: {}, sendMode: 'auto' },
      )
      return (await repo.recentContext(conv.pk, 2)).map((row) => row.content)
    })
    expect(sqlite).toEqual(['第二句', '第三句'])
    expect(memory).toEqual(['第二句', '第三句'])
  })
})