import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 知识沉淀域仓储契约测试（migration v6 + 双实现行为一致）。
 *
 * 与 welink-contract.spec 同一动机：SQL 文本断言（后续各 spec）证明「写了什么 SQL」，
 * 这里证明「两套实现语义一致」。区别在于 SQLite 侧**不做语句仿真**——沉淀域的 SQL
 * 都是简单形态，直接用 Node 22 内置 `node:sqlite` 起真内存库、跑真实 MIGRATIONS，
 * 既验证迁移 DDL（表结构断言），又让契约对比建立在真实 SQLite 行为上。
 *
 * 对比方法：同一组操作序列分别喂给 SQL 实现与内存实现（welink 侧种子数据也走
 * 双实现同款 API），断言**可观察结果**一致；时间戳（createdAt/reviewedAt）是
 * 「调用时刻」不属于契约，投影时剔除。
 */
import type { DbParam, DbRow } from '@/types'
import type { NormalizedMessage } from '@/types/welink'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'

type SelectFn = (sql: string, params?: DbParam[]) => Promise<DbRow[]>
type ExecFn = (sql: string, params?: DbParam[]) => Promise<{ changes: number; lastInsertId: number }>
type TxnFn = (statements: { sql: string; params?: DbParam[] }[]) => Promise<number[]>

const db = vi.hoisted(() => ({
  platform: 'tauri',
  dbExecute: vi.fn<ExecFn>(),
  dbSelect: vi.fn<SelectFn>(),
  dbTransaction: vi.fn<TxnFn>(),
}))

vi.mock('@/api', () => ({
  bridge: db,
  get platform() {
    return db.platform
  },
}))

// 同上：只替换 `logger`，保留 `maskSecrets` —— 双实现的 `insertSedimentLog`
// 落库前都会过遮蔽表（`logger.maskSecrets`），全量 mock 会把这条真实路径打没。
vi.mock('@/utils/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/logger')>()
  return {
    ...actual,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }
})

// ---------------- 内存侧：隔离 localStorage ----------------

const storage = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => void storage.set(key, value),
  removeItem: (key: string) => void storage.delete(key),
  clear: () => storage.clear(),
})

import { MIGRATIONS } from '@/infra/db'
import { migrationV6 } from '@/infra/db/migrations/welink-sediment'
import { sqlSedimentRepository } from '@/infra/db/repos/sediment'
import { memorySedimentRepository, resetSedimentMemory } from '@/infra/db/repos/sediment-memory'
import { memoryWelinkRepository, resetWelinkMemory } from '@/infra/db/repos/welink-memory'
import { sqlWelinkRepository } from '@/infra/db/repos/welink'
import {
  SEDIMENT_KEYS,
  type KnowledgeDraft,
  type SentQaRecord,
  type WelinkAnnouncement,
} from '@/infra/db/sediment-ports'
import { registerSecret } from '@/utils/logger'
import type { WelinkRepository } from '@/infra/db/ports'
import type { WelinkMessage } from '@/types/welink'
import type { SedimentRepository } from '@/infra/db/sediment-ports'

let realDb: DatabaseSync

/**
 * 仓库 SQL 统一使用 `?N` 编号占位符（rusqlite 原生支持），而本机 Node 的 node:sqlite
 * 只支持匿名 `?` 位置绑定。桥接层做一次「编号 → 匿名」改写：每个 `?N` 出现处替换为
 * `?`，并按出现顺序展开参数（同号复用如 inbox 的日期条件自然展开为多份）。
 * 仅测试桥使用，生产路径不经过这里。
 */
function toAnonymous(sql: string, params: DbParam[]): { sql: string; args: DbParam[] } {
  const args: DbParam[] = []
  const rewritten = sql.replace(/\?(\d+)/g, (_, n: string) => {
    args.push(params[Number(n) - 1])
    return '?'
  })
  return { sql: rewritten, args }
}

beforeAll(async () => {
  const { DatabaseSync } = await import('node:sqlite')
  realDb = new DatabaseSync(':memory:')
  for (const migration of MIGRATIONS) realDb.exec(migration.sql)

  db.dbExecute.mockImplementation(async (sql: string, params: DbParam[] = []) => {
    const rewritten = toAnonymous(sql, params)
    const result = realDb.prepare(rewritten.sql).run(...(rewritten.args as unknown as SQLInputValue[]))
    return { changes: Number(result.changes), lastInsertId: Number(result.lastInsertRowid) }
  })
  db.dbSelect.mockImplementation(async (sql: string, params: DbParam[] = []) => {
    const rewritten = toAnonymous(sql, params)
    return realDb.prepare(rewritten.sql).all(...(rewritten.args as unknown as SQLInputValue[])) as DbRow[]
  })
  db.dbTransaction.mockImplementation(async (statements: { sql: string; params?: DbParam[] }[]) => {
    // 返回值语义必须与宿主一致：`src-tauri/src/db.rs::db_transaction` 返回**各语句
    // 受影响行数**（changes），不是 lastInsertRowid —— 测试替身与真值不一致时，
    // 「幂等插入只算新增」这类依赖 changes 的判断会在真机上静默失效。
    const changes: number[] = []
    realDb.exec('BEGIN')
    try {
      for (const statement of statements) {
        const rewritten = toAnonymous(statement.sql, statement.params ?? [])
        const result = realDb.prepare(rewritten.sql).run(...(rewritten.args as unknown as SQLInputValue[]))
        changes.push(Number(result.changes))
      }
      realDb.exec('COMMIT')
    } catch (error) {
      realDb.exec('ROLLBACK')
      throw error
    }
    return changes
  })
})

/** SQL 侧与内存侧对齐：每个用例前清空全部业务表并重放迁移（内存侧靠 reset* 函数） */
function resetSqlDb() {
  // node:sqlite 默认开启外键约束：清表期间先关闭，避免 DROP 父表被级联约束卡住
  realDb.exec('PRAGMA foreign_keys = OFF')
  const tables = realDb
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
    .all() as {
    name: string
  }[]
  for (const table of tables) realDb.exec(`DROP TABLE IF EXISTS "${table.name}"`)
  for (const migration of MIGRATIONS) realDb.exec(migration.sql)
  realDb.exec('PRAGMA foreign_keys = ON')
}

beforeEach(() => {
  resetSqlDb()
  storage.clear()
  resetWelinkMemory()
  resetSedimentMemory()
})

// ---------------- 迁移 DDL 断言（任务 2.1：表结构与迁移记录） ----------------

describe('migration v6 —— 知识沉淀四表 DDL', () => {
  it('四张表全部建立且关键列齐备（ann_uid 幂等键 / hash 去重 / kv 主键 / 留痕状态枚举）', () => {
    const tables = realDb
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN
                ('welink_announcements','knowledge_drafts','sediment_state','sediment_logs')`,
      )
      .all() as { name: string }[]
    expect(tables.map((row) => row.name).sort()).toEqual([
      'knowledge_drafts',
      'sediment_logs',
      'sediment_state',
      'welink_announcements',
    ])
    const draftColumns = (
      realDb.prepare(`SELECT name FROM pragma_table_info('knowledge_drafts')`).all() as { name: string }[]
    ).map((row) => row.name)
    expect(draftColumns).toEqual(
      expect.arrayContaining([
        'id',
        'title',
        'content',
        'topic',
        'source_type',
        'source_refs',
        'content_hash',
        'status',
        'review_note',
      ]),
    )
    // 幂等键唯一约束（UNIQUE 内联约束生成 sqlite_autoindex，sql 列为 NULL，须经 index_list 查）
    const annIndexes = realDb.prepare(`SELECT "unique" AS u FROM pragma_index_list('welink_announcements')`).all() as {
      u: number
    }[]
    expect(annIndexes.some((row) => Number(row.u) === 1)).toBe(true)
  })

  it('建表类迁移非幂等：重复执行会报错（而非静默成功），幂等由 _migrations 版本表保证', () => {
    // 明确锁定 migrationV6（建表类 DDL），不用 MIGRATIONS.at(-1)——
    // 末尾迁移会随需求增加而变化（v7 是 CREATE INDEX IF NOT EXISTS，幂等不报错），
    // 用位置取最后一条会让这条断言随迁移变动而失去意义。
    expect(() => realDb.exec(migrationV6.sql)).toThrow()
  })
})

// ---------------- 契约对比（双实现同序列） ----------------

/** welink 侧种子：一个白名单群 + 两条入消息 + 两个已答复任务（一个 up 评、一个无评） */
async function seedWelink(repo: WelinkRepository) {
  const conv = await repo.upsertConversation({ convType: 'group', convId: 'g-door', title: '门禁群' })
  const messages: NormalizedMessage[] = [
    {
      msgUid: 'm1',
      convType: 'group',
      convId: 'g-door',
      direction: 'in',
      senderId: 'u1',
      senderName: '张三',
      content: '门禁卡怎么办理？',
      msgType: 'text',
      atMe: true,
      sentAt: '2026-10-06 09:00:00',
    },
    {
      msgUid: 'm2',
      convType: 'group',
      convId: 'g-door',
      direction: 'in',
      senderId: 'u2',
      senderName: '李四',
      content: '访客通道在大厅西侧，需要登记身份证。',
      msgType: 'text',
      atMe: false,
      sentAt: '2026-10-06 09:05:00',
    },
  ]
  const applied = await repo.applyPollResult('g-door', messages, 'c1', { triggers: {}, sendMode: 'auto' })
  const pks = applied.inserted.map((message) => message.pk)

  const jobUp = await repo.createJob({
    triggerMsgPk: pks[0],
    triggerMsgUid: 'm1',
    triggerType: 'group_at_me',
    targetType: 'group',
    targetId: 'g-door',
    sendModeUsed: 'auto',
    contextSnapshot: '',
  })
  // 状态机与 pipeline 同序：pending → discussing（出队）→ ready（commitDraft）→ sending → sent
  await repo.markStatus(jobUp.pk, 'discussing', 'pending')
  await repo.commitDraft(jobUp.pk, '找行政前台办理，工位区的门禁找楼层管理员。', '', {
    id: 'door',
    name: '门禁助手',
    source: 'rule',
  })
  await repo.markStatus(jobUp.pk, 'sending', 'ready')
  await repo.markSent(jobUp.pk, { msgUid: 'out-1', sentAt: '2026-10-06 10:00:00', convPk: conv.pk, content: '发' })
  await repo.rateJob(jobUp.pk, 'up')

  const jobPlain = await repo.createJob({
    triggerMsgPk: pks[1],
    triggerMsgUid: 'm2',
    triggerType: 'group_at_me',
    targetType: 'group',
    targetId: 'g-door',
    sendModeUsed: 'auto',
    contextSnapshot: '',
  })
  await repo.markStatus(jobPlain.pk, 'discussing', 'pending')
  await repo.commitDraft(jobPlain.pk, '访客通道在大厅西侧。', '', { id: 'visit', name: '访客助手', source: 'llm' })
  await repo.markStatus(jobPlain.pk, 'sending', 'ready')
  await repo.markSent(jobPlain.pk, { msgUid: 'out-2', sentAt: '2026-10-06 09:30:00', convPk: conv.pk, content: '发' })

  return { conv, msgPks: pks, jobUpPk: jobUp.pk, jobPlainPk: jobPlain.pk }
}

/** 投影：剔除「调用时刻」字段，仅保留契约字段 */
const normAnn = (row: WelinkAnnouncement) => ({
  pk: row.pk,
  annUid: row.annUid,
  convPk: row.convPk,
  convId: row.convId,
  title: row.title,
  content: row.content,
  publishedAt: row.publishedAt,
})
const normDraft = (row: KnowledgeDraft) => ({
  pk: row.pk,
  title: row.title,
  content: row.content,
  topic: row.topic,
  sourceType: row.sourceType,
  sourceRefs: row.sourceRefs,
  contentHash: row.contentHash,
  status: row.status,
  reviewNote: row.reviewNote,
})
const normMsg = (row: WelinkMessage) => ({
  pk: row.pk,
  msgUid: row.msgUid,
  convId: row.convId,
  direction: row.direction,
  senderName: row.senderName,
  content: row.content,
})
const normQa = (row: SentQaRecord) => ({
  pk: row.pk,
  skillId: row.skillId,
  skillName: row.skillName,
  question: row.question,
  answer: row.answer,
  rating: row.rating,
  finishedAt: row.finishedAt,
})

describe('sediment 仓储双实现契约（SQL vs memory）', () => {
  /** 同一操作序列跑两遍，收集可观察结果 */
  async function runScenario(repo: SedimentRepository, welinkRepo: WelinkRepository) {
    const seed = await seedWelink(welinkRepo)
    const out: Record<string, unknown> = {}

    // —— 公告：幂等批写 + 会话缺失跳过 + 列表 ——
    out.annFirst = (
      await repo.applyAnnouncements([
        {
          annUid: 'a1',
          convId: 'g-door',
          title: '停电公告',
          content: '周六机房停电检修。',
          publishedAt: '2026-10-06 08:00:00',
        },
        {
          annUid: 'a2',
          convId: 'g-none',
          title: '幽灵公告',
          content: '不应入库。',
          publishedAt: '2026-10-06 08:01:00',
        },
      ])
    ).map(normAnn)
    out.annRepeat = (
      await repo.applyAnnouncements([
        {
          annUid: 'a1',
          convId: 'g-door',
          title: '停电公告',
          content: '周六机房停电检修。',
          publishedAt: '2026-10-06 08:00:00',
        },
      ])
    ).map(normAnn)
    out.annList = (await repo.listAnnouncements(10, 0)).map(normAnn)

    // —— 待评审条目：hash 去重 + 列表/计数 + 单向评审流转 ——
    const drafts = [
      {
        title: '门禁卡办理',
        content: '找行政前台办理门禁卡。',
        topic: '门禁',
        sourceType: 'message' as const,
        sourceRefs: ['m1'],
        contentHash: 'h1',
      },
      {
        title: '停电公告要点',
        content: '周六机房停电检修。',
        topic: '机房',
        sourceType: 'announcement' as const,
        sourceRefs: ['a1'],
        contentHash: 'h2',
      },
    ]
    out.draftFirst = (await repo.insertDrafts(drafts)).map(normDraft)
    out.draftRepeat = await repo.insertDrafts(drafts)
    out.draftMixed = (
      await repo.insertDrafts([
        ...drafts,
        { ...drafts[0], title: '新标题同 hash', contentHash: 'h1' },
        { ...drafts[0], title: '新条目', contentHash: 'h3' },
      ])
    ).map(normDraft)
    out.knownHashes = await repo.findKnownHashes(['h1', 'h2', 'hx'])
    out.pendingBefore = (await repo.listDrafts({ status: 'pending', limit: 10, offset: 0 })).map(normDraft)
    out.countAll = await repo.countDrafts()
    out.countPending = await repo.countDrafts('pending')

    const firstPending = out.pendingBefore as KnowledgeDraft[]
    out.approveFirst = await repo.approveDraft(firstPending[0].pk, {
      title: '门禁卡办理（修订）',
      content: '找行政前台办理门禁卡，需要工牌。',
    })
    out.approveAgain = await repo.approveDraft(firstPending[0].pk, { title: '二次改写', content: '不应生效。' })
    out.rejectSecond = await repo.rejectDraft(firstPending[1].pk, '与知识库既有口径重复')
    out.rejectAgain = await repo.rejectDraft(firstPending[1].pk, '二次拒绝不应生效')
    out.draftsAfter = (await repo.listDrafts({ limit: 10, offset: 0 })).map(normDraft)
    out.countAfter = await repo.countDrafts()

    // —— 水位 ——
    out.missingState = await repo.getState(SEDIMENT_KEYS.messagePk)
    await repo.setState(SEDIMENT_KEYS.messagePk, '7')
    await repo.setState(SEDIMENT_KEYS.messagePk, '9')
    out.storedState = await repo.getState(SEDIMENT_KEYS.messagePk)

    // —— 沉淀留痕 ——
    const log = await repo.insertSedimentLog({
      prompt: '提取提示词',
      response: '[]',
      status: 'ok',
      latencyMs: 12,
      error: '',
    })
    await repo.insertSedimentLog({ prompt: '失败调用', response: '', status: 'error', latencyMs: 3, error: 'boom' })
    out.logList = (await repo.listSedimentLogs(10)).map((row) => ({
      pk: row.pk,
      prompt: row.prompt,
      status: row.status,
      error: row.error,
    }))
    // 保留期清理（v11）：三档语义都要双侧一致
    //  ① cutoff 在遥远的过去 → 一条都不该删（别把「没过期」当成「清空」）
    out.logPurgedNone = await repo.purgeSedimentLogsBefore('2000-01-01 00:00:00', 100)
    out.logListAfterNone = (await repo.listSedimentLogs(10)).length
    //  ② cutoff 在未来、batch=1 → 只删一条（分批语义，retention 靠「< batch」判收敛）
    out.logPurgedOne = await repo.purgeSedimentLogsBefore('2999-01-01 00:00:00', 1)
    out.logListAfterOne = (await repo.listSedimentLogs(10)).length
    //  ③ 剩下的清干净
    out.logCleared = await repo.purgeSedimentLogsBefore('2999-01-01 00:00:00', 100)
    out.logListAfterClear = await repo.listSedimentLogs(10)
    expect(log.pk).toBeGreaterThan(0)

    // —— 群公告保留期（v12）：与留痕同构的三档语义，双侧必须一致 ——
    // 先补足条目：seed 只留了 1 条公告，「batch=1 只删一条」的分批语义无从体现
    await repo.applyAnnouncements([
      { annUid: 'p1', convId: 'g-door', title: 'p1', content: 'p1', publishedAt: '2026-10-07 08:00:00' },
      { annUid: 'p2', convId: 'g-door', title: 'p2', content: 'p2', publishedAt: '2026-10-07 08:01:00' },
      { annUid: 'p3', convId: 'g-door', title: 'p3', content: 'p3', publishedAt: '2026-10-07 08:02:00' },
    ])
    out.annCountBeforePurge = (await repo.listAnnouncements(100, 0)).length
    //  ① cutoff 在遥远的过去 → 一条都不该删（别把「没过期」当成「清空」）
    out.annPurgedNone = await repo.purgeAnnouncementsBefore('2000-01-01 00:00:00', 100)
    out.annCountAfterNone = (await repo.listAnnouncements(100, 0)).length
    //  ② cutoff 在未来、batch=1 → 只删一条（分批语义，retention 靠「< batch」判收敛）
    out.annPurgedOne = await repo.purgeAnnouncementsBefore('2999-01-01 00:00:00', 1)
    out.annCountAfterOne = (await repo.listAnnouncements(100, 0)).length
    //  ③ 剩下的清干净
    out.annCleared = await repo.purgeAnnouncementsBefore('2999-01-01 00:00:00', 100)
    out.annCountAfterClear = (await repo.listAnnouncements(100, 0)).length

    // —— 原料扫描 ——
    out.msgScan = (await repo.listInMessagesSince(0, ['g-door'], 100)).map(normMsg)
    out.msgScanOtherConv = await repo.listInMessagesSince(0, ['g-other'], 100)
    out.msgScanEmptyWhitelist = await repo.listInMessagesSince(0, [], 100)
    out.msgScanAfterWatermark = await repo.listInMessagesSince(Math.max(...seed.msgPks), ['g-door'], 100)

    out.qaScan = (await repo.listSentQaSince('', 0, 10)).map(normQa)
    // 复合水位（时间 + id）：只推进时间会把「同秒并列」的那条永久排除（旧实现的丢数据口子）
    out.qaScanAtWatermarkZeroId = (await repo.listSentQaSince('2026-10-06 10:00:00', 0, 10)).map(normQa)
    out.qaScanAfterWatermark = await repo.listSentQaSince('2026-10-06 10:00:00', seed.jobUpPk, 10)
    return out
  }

  it('SQL 实现与内存实现的可观察结果一致', async () => {
    const sqlOut = await runScenario(sqlSedimentRepository, sqlWelinkRepository)
    const memOut = await runScenario(memorySedimentRepository, memoryWelinkRepository)
    expect(memOut).toEqual(sqlOut)
  })

  it('applyAnnouncements 的 IPC 次数与公告条数无关（S9：3N → 3）', async () => {
    // 反证口径：旧实现逐条「查会话 → INSERT → 回查」，12 条公告 = 36 次跨进程 IPC；
    // 这里钉住「2 次查询 + 1 次事务」的批量形态，任何退回逐条循环的改动都会变红。
    await sqlWelinkRepository.upsertConversation({ convType: 'group', convId: 'g-a', title: 'A 群' })
    await sqlWelinkRepository.upsertConversation({ convType: 'group', convId: 'g-b', title: 'B 群' })
    db.dbSelect.mockClear()
    db.dbExecute.mockClear()
    db.dbTransaction.mockClear()

    const items = Array.from({ length: 12 }, (_, index) => ({
      annUid: `batch-${index}`,
      convId: index === 11 ? 'g-missing' : index % 2 === 0 ? 'g-a' : 'g-b',
      title: `公告 ${index}`,
      content: `正文 ${index}`,
      publishedAt: `2026-10-20 09:${String(index).padStart(2, '0')}:00`,
    }))
    const inserted = await sqlSedimentRepository.applyAnnouncements(items)

    expect(inserted).toHaveLength(11) // 会话缺失的那条被跳过，其余照常
    expect(db.dbTransaction).toHaveBeenCalledTimes(1)
    expect(db.dbTransaction.mock.calls[0][0]).toHaveLength(11)
    expect(db.dbSelect).toHaveBeenCalledTimes(2) // 会话 id 批量查询 + 插入行批量回查
    expect(db.dbExecute).not.toHaveBeenCalled()
  })

  it('applyAnnouncements 批内重复 annUid 仍幂等，只返回真正新增的行', async () => {
    await sqlWelinkRepository.upsertConversation({ convType: 'group', convId: 'g-a', title: 'A 群' })
    const made = (annUid: string) => ({
      annUid,
      convId: 'g-a',
      title: annUid,
      content: annUid,
      publishedAt: '2026-10-20 09:00:00',
    })
    expect(
      (await sqlSedimentRepository.applyAnnouncements([made('dup'), made('dup'), made('new')])).map((a) => a.annUid),
    ).toEqual(['dup', 'new'])
    expect(await sqlSedimentRepository.applyAnnouncements([made('dup'), made('new')])).toEqual([])
  })

  it('关键语义抽查：公告幂等、评审单向、复合水位推进（同秒不丢）', async () => {
    const out = await runScenario(sqlSedimentRepository, sqlWelinkRepository)
    // 正例护栏：原料扫描确实扫到了东西（防止双实现同错导致对照假绿）
    expect(out.msgScan).toHaveLength(2)
    expect(out.qaScan).toHaveLength(2)
    // 公告：会话缺失跳过 + 重复批写零新增
    expect(out.annFirst).toHaveLength(1)
    expect(out.annRepeat).toHaveLength(0)
    // hash 去重：重复批与混合批都只让新 hash 入库
    expect(out.draftFirst).toHaveLength(2)
    expect(out.draftRepeat).toHaveLength(0)
    expect(out.draftMixed).toHaveLength(1)
    expect((out.draftsAfter as KnowledgeDraft[]).map((row) => row.status)).toEqual(['approved', 'rejected', 'pending'])
    // 评审单向流：终态再评审返回 false
    expect(out.approveFirst).toBe(true)
    expect(out.approveAgain).toBe(false)
    expect(out.rejectAgain).toBe(false)
    // 排序必须与 (finished_at, id) 复合游标同序：09:30 无评在前，10:00 up 在后。
    // （旧实现按 rating=up 优先排序，与水位不同序 —— 既漏又重，已修）
    expect((out.qaScan as SentQaRecord[]).map((row) => row.rating)).toEqual([null, 'up'])
    // 同秒并列：水位只推到 ('2026-10-06 10:00:00', 0) 时，该秒那条仍要被扫到
    expect(out.qaScanAtWatermarkZeroId).toHaveLength(1)
    // 水位推进到「已消费的那一条」后增量扫描为空
    expect(out.msgScanAfterWatermark).toHaveLength(0)
    expect(out.qaScanAfterWatermark).toHaveLength(0)
    // 公告保留期（v12）：过期才删 + batch 生效（这张表此前从未进过清理链）
    expect(out.annCountBeforePurge).toBe(4) // seed 的 a1 + 补的 p1/p2/p3
    expect(out.annPurgedNone).toBe(0)
    expect(out.annCountAfterNone).toBe(4)
    expect(out.annPurgedOne).toBe(1)
    expect(out.annCountAfterOne).toBe(3)
    expect(out.annCleared).toBe(3)
    expect(out.annCountAfterClear).toBe(0)
  })
})

// ---------------- 落库遮蔽（第七轮） ----------------

describe('落库遮蔽 —— 沉淀留痕的 error 不得成为密钥的第二条出口', () => {
  /**
   * 与 `welink-sqlite-integration.spec.ts` 的 insertAgentLog 用例同款：
   * `knowledge-harvester` 把 `error.message` 原样传给 `insertSedimentLog`，而它可能
   * 来自 Agent 的 HTTP 错误串（网关 4xx 会回显请求信息）。日志出口早被 `logger`
   * 遮蔽了，但这里是**持久化落库**，是独立的一条出口。
   *
   * 反证：去掉双实现里的 `maskSecrets`，下面三条立刻红。
   */
  it('SQL 与内存两个实现都在落库前遮蔽（且遮蔽结果一致）', async () => {
    registerSecret('sk-sediment-secret-0002')
    const message = 'Agent 返回 HTTP 401：{"apiKey":"sk-sediment-secret-0002"}'

    const sql = await sqlSedimentRepository.insertSedimentLog({
      prompt: 'p',
      response: '',
      status: 'error',
      latencyMs: 1,
      error: message,
    })
    const memory = await memorySedimentRepository.insertSedimentLog({
      prompt: 'p',
      response: '',
      status: 'error',
      latencyMs: 1,
      error: message,
    })

    for (const stored of [sql.error, memory.error]) {
      expect(stored).not.toContain('sk-sediment-secret-0002')
      expect(stored).toContain('***')
    }
    // 双实现同口径（否则「浏览器调试模式安全、桌面模式泄漏」这种分叉无从发现）
    expect(sql.error).toBe(memory.error)
  })
})
