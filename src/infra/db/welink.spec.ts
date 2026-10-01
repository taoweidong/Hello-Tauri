import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * WeLink 四表仓储单测（设计 §13）。
 *
 * 为什么这一层要重点测「SQL 文本 + 参数绑定」：Q1 决策把 SQL 全放在 TS
 * （Rust 只是通用执行器），所以**业务正确性就写在 SQL 里**。类型检查看不出
 * `WHERE id=?1 AND status='sending'` 被误写成 `status=?1`，只有断言文本能。
 *
 * 四类必须守住的硬约束：
 *  1. **分页强制**（P7）—— 任何列表 SQL 必含 LIMIT，且 limit/offset 是参数；
 *  2. **要点3 原子性** —— `commitDraft` 的 draft 与 `status='ready'` 必须同一条 UPDATE；
 *  3. **防双发** —— `markSent` 的 `AND status='sending'` + `hasOutgoingReceipt` 回执核对；
 *  4. **列表与计数同口径** —— 分页脚的数字必须与列表用同一套 WHERE。
 */

import type { DbParam, DbRow, ExecResult } from '@/types'
import type { NormalizedMessage } from '@/types/welink'

type SelectFn = (sql: string, params?: DbParam[]) => Promise<DbRow[]>
type TxnFn = (statements: { sql: string; params?: DbParam[] }[]) => Promise<number[]>

const db = vi.hoisted(() => ({
  platform: 'tauri',
  dbExecute: vi.fn<(sql: string, params: DbParam[]) => Promise<ExecResult>>(async () => ({
    changes: 1,
    lastInsertId: 42,
  })),
  dbSelect: vi.fn<SelectFn>(async () => []),
  dbTransaction: vi.fn<TxnFn>(async () => []),
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

import { migrationV2 } from '@/infra/db/migrations/welink'
import { sqlWelinkRepository as repo } from '@/infra/db/repos/welink'

/**
 * 重置三个 mock 并装上默认实现。
 *
 * 用 `mockReset()` 而非 `vi.clearAllMocks()`：`clearAllMocks` 只清调用记录，
 * **不清 `mockResolvedValueOnce` 队列** —— 上一个用例未消费完的 once 值会溢出到
 * 下一个用例，造成「单跑绿、连跑红」的诡异失败（本文件踩过一次）。
 */
function resetDb() {
  db.dbExecute.mockReset()
  db.dbSelect.mockReset()
  db.dbTransaction.mockReset()
  db.dbExecute.mockResolvedValue({ changes: 1, lastInsertId: 42 })
  db.dbSelect.mockResolvedValue([])
  db.dbTransaction.mockResolvedValue([])
}

beforeEach(resetDb)

/** 取最近一次 dbExecute 的 [sql, params] */
function lastExec() {
  const call = db.dbExecute.mock.calls.at(-1)!
  return { sql: call[0], params: call[1] ?? [] }
}

/** 取最近一次 dbSelect 的 [sql, params] */
function lastSelect() {
  const call = db.dbSelect.mock.calls.at(-1)!
  return { sql: call[0], params: call[1] ?? [] }
}

/** 取最近一次 dbTransaction 的语句数组 */
function lastTxn() {
  return db.dbTransaction.mock.calls.at(-1)![0]
}

function msg(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    msgUid: 'mu-1',
    convType: 'group',
    convId: 'G-1001',
    direction: 'in',
    senderId: 'E-9001',
    senderName: '赵敏',
    content: '@你 看下接口',
    msgType: 'text',
    atMe: true,
    sentAt: '2026-09-27 10:00:00',
    ...overrides,
  }
}

describe('infra/db/welink —— 迁移 v2', () => {
  it('版本号与描述固定（迁移表按 version 去重，改错会重复执行）', () => {
    expect(migrationV2.version).toBe(2)
    expect(migrationV2.description).toBe('create_welink_assistant')
  })

  it('四张表齐备', () => {
    for (const table of ['welink_conversations', 'welink_messages', 'welink_reply_jobs', 'welink_agent_logs']) {
      expect(migrationV2.sql).toContain(`CREATE TABLE ${table}`)
    }
  })

  it('msg_uid 是 UNIQUE（幂等去重的唯一依据）', () => {
    expect(migrationV2.sql).toMatch(/msg_uid\s+TEXT NOT NULL UNIQUE/)
  })

  it('agent 留痕对 job 级联删除（删任务不留孤儿日志）', () => {
    expect(migrationV2.sql).toMatch(/job_pk\s+INTEGER NOT NULL REFERENCES welink_reply_jobs\(id\) ON DELETE CASCADE/)
  })

  it('status 的 CHECK 枚举与 TS 的 JobStatus 完全一致', () => {
    expect(migrationV2.sql).toContain(
      "CHECK (status IN ('pending','discussing','ready','sending','sent','failed','skipped'))",
    )
  })

  it('汇总列齐备（O3：会话列表查询零聚合的前提）', () => {
    for (const column of ['last_msg_at', 'unread_count', 'mention_count', 'last_active', 'last_cursor']) {
      expect(migrationV2.sql).toContain(column)
    }
  })

  it('索引覆盖 poller 与列表的三种访问路径', () => {
    expect(migrationV2.sql).toContain('idx_wm_conv_time')
    expect(migrationV2.sql).toContain('idx_wrj_status')
    expect(migrationV2.sql).toContain('idx_wrl_target'.replace('wrl', 'wrj'))
    expect(migrationV2.sql).toContain('idx_wal_job')
  })
})

describe('infra/db/welink —— 分页强制（P7）', () => {
  it('listConversations 带 LIMIT/OFFSET 且为参数', async () => {
    await repo.listConversations(20, 40)
    const { sql, params } = lastSelect()
    expect(sql).toContain('FROM welink_conversations')
    expect(sql).toContain('ORDER BY conv_type, last_msg_at DESC, id DESC LIMIT ?1 OFFSET ?2')
    expect(params).toEqual([20, 40])
  })

  it('listWatching 是 poller 数据源，按 watching=1 过滤', async () => {
    await repo.listWatching()
    const { sql } = lastSelect()
    expect(sql).toContain('WHERE watching = 1')
  })

  it('listMessages 的 LIMIT 占位符序号排在 WHERE 参数之后', async () => {
    await repo.listMessages({ convPk: 7, limit: 50 })
    const { sql, params } = lastSelect()
    expect(sql).toContain('LIMIT ?2 OFFSET ?3')
    expect(params).toEqual([7, 50, 0])
  })

  it('listMessages 的 keyword 展开成两个 LIKE 参数，通配符按字面语义转义', async () => {
    // %/_ 经 escapeLike 转义并配套 ESCAPE '\'：搜「50%」是字面匹配，不再全表通配；
    // 值永远是**参数**而非 SQL 片段 —— 这里守的是「不拼接」
    await repo.listMessages({ convPk: 7, keyword: '50%', limit: 50 })
    const { sql, params } = lastSelect()
    expect(sql).toContain("m.content LIKE ?2 ESCAPE '\\' OR m.sender_name LIKE ?3 ESCAPE '\\'")
    expect(params).toEqual([7, '%50\\%%', '%50\\%%', 50, 0])
  })

  it('listJobs 的每个筛选项都进 WHERE 且 limit 在最后一位前', async () => {
    await repo.listJobs({
      status: ['ready', 'sending'],
      triggerType: ['group_at_me'],
      targetId: 'G-1001',
      onlySkipped: true,
      onlyHolding: true,
      onlyDownRated: true,
      from: '2026-09-01',
      to: '2026-09-30',
      limit: 25,
      offset: 5,
    })
    const { sql, params } = lastSelect()
    expect(sql).toContain('j.status IN (?1, ?2)')
    expect(sql).toContain('j.trigger_type IN (?3)')
    expect(sql).toContain('j.target_id = ?4')
    expect(sql).toContain("j.skip_reason <> ''")
    expect(sql).toContain("j.hold_reason <> '' AND j.status = 'ready'")
    expect(sql).toContain("j.rating = 'down'")
    expect(sql).toContain('j.created_at >= ?5')
    expect(sql).toContain('j.created_at <= ?6')
    expect(sql).toContain('LIMIT ?7 OFFSET ?8')
    expect(params).toEqual(['ready', 'sending', 'group_at_me', 'G-1001', '2026-09-01', '2026-09-30', 25, 5])
  })

  it('searchMessages 关键词与时间段都参数化（LIKE 不拼接）', async () => {
    await repo.searchMessages("a' OR 1=1", '2026-01-01', '2026-12-31', 10, 0)
    const { sql, params } = lastSelect()
    expect(sql).toContain("LIKE ?1 ESCAPE '\\' OR m.sender_name LIKE ?2 ESCAPE '\\'")
    expect(params[0]).toBe("%a' OR 1=1%")
    expect(params).toEqual(["%a' OR 1=1%", "%a' OR 1=1%", '2026-01-01', '2026-12-31', 10, 0])
  })

  it('recentContext 用 MAX(1, maxN) 兜底，避免 LIMIT 0 取不到上下文', async () => {
    await repo.recentContext(3, 0)
    const { params } = lastSelect()
    expect(params).toEqual([3, 1])
  })

  it('purgeMessagesBefore 分批删除（子查询 + LIMIT，P1）', async () => {
    db.dbExecute.mockResolvedValue({ changes: 17, lastInsertId: 0 })
    const removed = await repo.purgeMessagesBefore('2026-01-01', 500)
    expect(removed).toBe(17)
    const { sql, params } = lastExec()
    expect(sql).toContain('DELETE FROM welink_messages WHERE id IN')
    expect(sql).toContain('ORDER BY id LIMIT ?2')
    expect(params).toEqual(['2026-01-01', 500])
  })

  it('purgeAgentLogsBefore 与消息清理同构（按 created_at 过期，P1/S-4）', async () => {
    db.dbExecute.mockResolvedValue({ changes: 42, lastInsertId: 0 })
    const removed = await repo.purgeAgentLogsBefore('2026-07-01', 500)
    expect(removed).toBe(42)
    const { sql, params } = lastExec()
    expect(sql).toContain('DELETE FROM welink_agent_logs WHERE id IN')
    expect(sql).toContain('created_at < ?1')
    expect(sql).toContain('ORDER BY id LIMIT ?2')
    expect(params).toEqual(['2026-07-01', 500])
    // 语义边界：只删语料留痕，**不能**顺带动 job（job 是回复历史的主体）
    expect(sql).not.toContain('welink_reply_jobs')
  })
})

describe('infra/db/welink —— 要点3 原子性（draft 与 ready 同条 UPDATE）', () => {
  it('commitDraft 在一次 dbExecute 里同时写 draft、status=ready、清 hold_reason', async () => {
    const ok = await repo.commitDraft(9, '好的，我看下')
    expect(ok).toBe(true)
    expect(db.dbExecute).toHaveBeenCalledTimes(1)
    const { sql } = lastExec()
    expect(sql).toContain('SET draft = ?1')
    expect(sql).toContain("status = 'ready'")
    expect(sql).toContain("hold_reason = ''")
    // 拆成两条 UPDATE 就会出现「草稿已写但状态未就绪」的中间态，这里守住单条
    expect(sql.match(/UPDATE welink_reply_jobs/g)).toHaveLength(1)
  })

  it('commitDraft 用 status=discussing 做乐观并发（后写者不得覆盖先到者）', async () => {
    await repo.commitDraft(9, '草稿')
    const { sql, params } = lastExec()
    // 不带 contextSnapshot 时参数位是 [draft, now, pk] → id 占 ?3
    expect(sql).toContain("WHERE id = ?3 AND status = 'discussing'")
    expect(params[params.length - 1]).toBe(9)
  })

  it('commitDraft 带 contextSnapshot 时追加一个参数位', async () => {
    await repo.commitDraft(9, '草稿', '上下文快照')
    const { sql, params } = lastExec()
    expect(sql).toContain('context_snapshot = ?3')
    expect(sql).toContain('WHERE id = ?4')
    expect(params.slice(0, 3)).toEqual(['草稿', expect.any(String), '上下文快照'])
  })

  it('commitDraft 条件不匹配（changes=0）返回 false', async () => {
    db.dbExecute.mockResolvedValue({ changes: 0, lastInsertId: 0 })
    await expect(repo.commitDraft(9, '草稿')).resolves.toBe(false)
  })

  it('updateDraft（人工编辑后发送）同样清 hold_reason，避免待审徽标残留', async () => {
    await repo.updateDraft(9, '人工改过的草稿')
    const { sql } = lastExec()
    expect(sql).toContain('SET draft = ?1')
    expect(sql).toContain("hold_reason = ''")
  })
})

describe('infra/db/welink —— 防双发（markSent / hasOutgoingReceipt）', () => {
  it('markSent 单事务：sent 记账 + 回写 out 消息 + 刷新会话 last_msg_at', async () => {
    // markSent 的返回值取 changes[0]（job 那条 UPDATE 的影响行数）
    db.dbTransaction.mockResolvedValue([1, 1, 1])
    const ok = await repo.markSent(5, {
      msgUid: 'out-1',
      sentAt: '2026-09-27 10:05:00',
      convPk: 3,
      content: '收到',
    })
    expect(ok).toBe(true)
    const statements = lastTxn()
    expect(statements).toHaveLength(3)
    expect(statements[0].sql).toContain("SET status = 'sent'")
    // 乐观锁：只有把 sending 改成 sent 的那方才记账
    expect(statements[0].sql).toContain("WHERE id = ?2 AND status = 'sending'")
    expect(statements[1].sql).toContain('INSERT OR IGNORE INTO welink_messages')
    expect(statements[1].params?.[0]).toBe('out-1')
    expect(statements[2].sql).toContain('UPDATE welink_conversations')
  })

  it('markSent 在并发下已被写成 sent 时返回 false（不重复记账）', async () => {
    db.dbTransaction.mockResolvedValue([0, 1, 1])
    await expect(repo.markSent(5, { msgUid: 'out-1', sentAt: 't', convPk: 3, content: 'x' })).resolves.toBe(false)
  })

  it('hasOutgoingReceipt 比对的是「同会话同内容的 out 消息」', async () => {
    db.dbSelect.mockResolvedValue([{ count: 1 }])
    await expect(repo.hasOutgoingReceipt(5)).resolves.toBe(true)
    const { sql, params } = lastSelect()
    expect(sql).toContain("m.direction = 'out'")
    expect(sql).toContain('m.content = (SELECT draft FROM welink_reply_jobs WHERE id = ?1)')
    expect(params).toEqual([5])
  })

  it('hasOutgoingReceipt 无回执时返回 false（允许正常发送）', async () => {
    db.dbSelect.mockResolvedValue([{ count: 0 }])
    await expect(repo.hasOutgoingReceipt(5)).resolves.toBe(false)
  })
})

describe('infra/db/welink —— 状态流转与留痕', () => {
  it('markStatus 的 expect 作为 AND 条件追加（乐观并发）', async () => {
    await repo.markStatus(4, 'sending', 'ready')
    const { sql, params } = lastExec()
    expect(sql).toContain('SET status = ?1, updated_at = ?2 WHERE id = ?3 AND status = ?4')
    expect(params[0]).toBe('sending')
    expect(params[3]).toBe('ready')
  })

  it('markStatus 不传 expect 时无条件更新', async () => {
    await repo.markStatus(4, 'ready')
    const { sql } = lastExec()
    expect(sql).not.toContain('AND status =')
  })

  it('recordAttemptFailure 只对 failed/skipped 写 finished_at（终态才有完成时间）', async () => {
    await repo.recordAttemptFailure(4, 'pending', 'x'.repeat(900))
    const { sql, params } = lastExec()
    expect(sql).toContain('attempts = attempts + 1')
    expect(sql).toContain("finished_at = CASE WHEN ?2 IN ('failed','skipped') THEN ?3 ELSE finished_at END")
    // 错误文本截断到 500，避免单条错误撑爆行
    expect((params[0] as string).length).toBe(500)
  })

  it('holdJob 回 ready 并写 hold_reason（O7 待审的计数依据）', async () => {
    await repo.holdJob(4, 'blacklist')
    const { sql, params } = lastExec()
    expect(sql).toContain("status = 'ready'")
    expect(sql).toContain('finished_at = NULL')
    expect(params[0]).toBe('blacklist')
  })

  it('suspendJob 回 ready 但**不**写 hold_reason（静默/配额不是待审）', async () => {
    await repo.suspendJob(4)
    const { sql } = lastExec()
    expect(sql).toContain("status = 'ready'")
    expect(sql).toContain("hold_reason = ''")
  })

  it('countHolding 只数 ready 且 hold_reason 非空', async () => {
    db.dbSelect.mockResolvedValue([{ count: 3 }])
    await expect(repo.countHolding()).resolves.toBe(3)
    const { sql } = lastSelect()
    expect(sql).toContain("status = 'ready' AND hold_reason <> ''")
  })

  it('lastSentAt 返回 MAX(finished_at)（S1 只需最近一次）', async () => {
    db.dbSelect.mockResolvedValue([{ last_at: '2026-09-27 09:00:00' }])
    await expect(repo.lastSentAt('G-1001')).resolves.toBe('2026-09-27 09:00:00')
    const { sql, params } = lastSelect()
    expect(sql).toContain('SELECT MAX(finished_at) AS last_at')
    expect(params).toEqual(['G-1001'])
  })

  it('lastSentAt 无记录时归一为空串 → null（跨重启的会话间隔基线）', async () => {
    db.dbSelect.mockResolvedValue([{ last_at: '' }])
    await expect(repo.lastSentAt('G-1001')).resolves.toBeNull()
  })

  it('removeJob 单事务先删留痕再删 job（反序会留孤儿日志）', async () => {
    db.dbTransaction.mockResolvedValue([2, 1])
    await expect(repo.removeJob(8)).resolves.toBe(true)
    const statements = lastTxn()
    expect(statements[0].sql).toContain('DELETE FROM welink_agent_logs WHERE job_pk = ?1')
    expect(statements[1].sql).toContain('DELETE FROM welink_reply_jobs WHERE id = ?1')
    // 语义刻意窄：不碰触发消息与会话
    expect(statements.some((item) => item.sql.includes('welink_messages'))).toBe(false)
    expect(statements.some((item) => item.sql.includes('welink_conversations'))).toBe(false)
  })

  it('removeJob 在 job 未删掉时返回 false（即使留痕删掉了）', async () => {
    db.dbTransaction.mockResolvedValue([2, 0])
    await expect(repo.removeJob(8)).resolves.toBe(false)
  })
})

describe('infra/db/welink —— 列表与计数同口径', () => {
  it('listJobsWithLogs 与 countJobsWithLogs 的 EXISTS 条件逐字一致', async () => {
    await repo.listJobsWithLogs(10, 0, false)
    const listSql = lastSelect().sql
    await repo.countJobsWithLogs(false)
    const countSql = lastSelect().sql
    const predicate = 'EXISTS (SELECT 1 FROM welink_agent_logs l WHERE l.job_pk = j.id)'
    expect(listSql).toContain(predicate)
    expect(countSql).toContain(predicate)
  })

  it('onlyDownRated 同时作用于列表与计数', async () => {
    await repo.listJobsWithLogs(10, 0, true)
    expect(lastSelect().sql).toContain("j.rating = 'down'")
    await repo.countJobsWithLogs(true)
    expect(lastSelect().sql).toContain("j.rating = 'down'")
  })

  it('countJobs 复用 buildJobWhere（筛选口径不会漂移）', async () => {
    db.dbSelect.mockResolvedValue([{ count: 4 }])
    await expect(repo.countJobs({ status: ['skipped'], onlySkipped: true })).resolves.toBe(4)
    const { sql, params } = lastSelect()
    expect(sql).toContain('j.status IN (?1)')
    expect(sql).toContain("j.skip_reason <> ''")
    expect(params).toEqual(['skipped'])
  })

  it('countInbox 与 listInbox 共用 buildInboxWhere（筛选口径不会漂移）', async () => {
    db.dbSelect.mockResolvedValue([{ count: 2 }])
    await expect(repo.countInbox({})).resolves.toBe(2)
    const { sql } = lastSelect()
    // P-4 重构后不再需要 COUNT(DISTINCT) —— 已去掉 JOIN 造成的行放大，
    // 也就没有 GROUP BY 需要对齐；改为断言「两处共用同一套 WHERE」这一真正的约束。
    expect(sql).toContain('COUNT(*) AS count')
    expect(sql).toContain("c.conv_type = 'private'")
    expect(sql).toContain('EXISTS (SELECT 1 FROM welink_messages x')
    expect(sql).not.toContain('JOIN')
  })

  it('listInbox 用 EXISTS 判存在性，不再 JOIN + GROUP BY（P-4 的退化根源）', async () => {
    await repo.listInbox({ limit: 10, offset: 0 })
    const { sql, params } = lastSelect()
    expect(sql).toContain('EXISTS (SELECT 1 FROM welink_messages x')
    expect(sql).not.toContain('JOIN welink_messages')
    expect(sql).not.toContain('GROUP BY')
    expect(sql).toContain('LIMIT ?1 OFFSET ?2')
    expect(params).toEqual([10, 0])
  })

  it('**日期条件同时作用于「存在 in 消息」与 last_content 子查询**（原双实现分歧点）', async () => {
    await repo.listInbox({ from: '2026-09-01 00:00:00', limit: 10, offset: 0 })
    const { sql, params } = lastSelect()
    // 同一占位符 ?1 复用两遍：EXISTS 与 last_content 各一次 —— 保证两处条件一致
    expect(sql).toContain(`x.sent_at >= ?1`)
    expect(sql.match(/x\.sent_at >= \?1/g)).toHaveLength(2)
    // 参数只收集一次（复用占位符，不重复绑定）
    expect(params).toEqual(['2026-09-01 00:00:00', 10, 0])
  })

  it('listInbox 的关键词按字面转义（与消息搜索/建群历史筛选同语义）', async () => {
    await repo.listInbox({ keyword: 'E_01', limit: 10, offset: 0 })
    const { sql, params } = lastSelect()
    expect(sql).toContain("c.title LIKE ?1 ESCAPE '\\' OR c.conv_id LIKE ?1 ESCAPE '\\'")
    expect(params[0]).toBe('%E\\_01%')
  })

  it('clearAgentLogs 返回删除行数', async () => {
    db.dbExecute.mockResolvedValue({ changes: 5, lastInsertId: 0 })
    await expect(repo.clearAgentLogs(8)).resolves.toBe(5)
  })
})

describe('infra/db/welink —— 会话写入', () => {
  it('upsertConversation 用 ON CONFLICT(conv_id) 且不覆盖已有 watching/auto_reply', async () => {
    db.dbSelect.mockResolvedValue([{ id: 1, conv_type: 'group', conv_id: 'G-1001', title: '项目群' }])
    await repo.upsertConversation({ convType: 'group', convId: 'G-1001', title: '项目群', watching: true })
    const { sql, params } = lastExec()
    expect(sql).toContain('ON CONFLICT(conv_id) DO UPDATE SET')
    expect(sql).toContain("title = CASE WHEN excluded.title <> '' THEN excluded.title")
    // 冲突分支里不得出现 watching/auto_reply 赋值，否则同步导入会关掉用户已开的开关
    expect(sql.split('DO UPDATE SET')[1]).not.toContain('watching =')
    expect(params.slice(0, 6)).toEqual(['group', 'G-1001', '项目群', '', 1, 0])
  })

  it('upsertConversation 写入后仍读不到则抛错（失败要显形，不静默）', async () => {
    db.dbSelect.mockResolvedValue([])
    await expect(repo.upsertConversation({ convType: 'private', convId: 'E-1' })).rejects.toThrow(/写入后仍读取不到/)
  })

  it('setAutoReply 批量 IN 参数化，占位符从 ?3 起（前两位是 bit 与时间）', async () => {
    db.dbExecute.mockResolvedValue({ changes: 2, lastInsertId: 0 })
    await expect(repo.setAutoReply(['G-1', 'G-2'], true)).resolves.toBe(2)
    const { sql, params } = lastExec()
    expect(sql).toContain('conv_id IN (?3, ?4)')
    expect(params).toEqual([1, expect.any(String), 'G-1', 'G-2'])
  })

  it('setAutoReply 空数组直接返回 0 且不打后端', async () => {
    await expect(repo.setAutoReply([], true)).resolves.toBe(0)
    expect(db.dbExecute).not.toHaveBeenCalled()
  })

  it('updateConversation 的 SET 子句与参数位一一对应', async () => {
    await repo.updateConversation('G-1001', { watching: true, muteUntil: '2026-09-28 00:00:00' })
    const { sql, params } = lastExec()
    expect(sql).toContain('updated_at = ?2')
    expect(sql).toContain('watching = ?3')
    expect(sql).toContain('mute_until = ?4')
    expect(sql).toContain('WHERE conv_id = ?1')
    expect(params).toEqual(['G-1001', expect.any(String), 1, '2026-09-28 00:00:00'])
  })

  it('removeConversation 按依赖顺序清四张表（事务内）', async () => {
    db.dbSelect.mockResolvedValue([{ id: 11 }])
    db.dbTransaction.mockResolvedValue([1, 1, 1, 1])
    await repo.removeConversation('G-1001')
    const statements = lastTxn()
    expect(statements).toHaveLength(4)
    expect(statements[0].sql).toContain('DELETE FROM welink_agent_logs')
    expect(statements[1].sql).toContain('DELETE FROM welink_reply_jobs')
    expect(statements[2].sql).toContain('DELETE FROM welink_messages WHERE conv_pk = ?1')
    expect(statements[3].sql).toContain('DELETE FROM welink_conversations WHERE id = ?1')
  })

  it('removeConversation 会话不存在时不发任何写操作', async () => {
    db.dbSelect.mockResolvedValue([])
    await repo.removeConversation('NOPE')
    expect(db.dbTransaction).not.toHaveBeenCalled()
  })
})

describe('infra/db/welink —— applyPollResult（一轮拉取的原子落库）', () => {
  it('会话不在监控清单中直接抛错（防误写孤立消息）', async () => {
    db.dbSelect.mockResolvedValue([])
    await expect(repo.applyPollResult('G-X', [msg()], 'c1', { triggers: {}, sendMode: 'auto' })).rejects.toThrow(
      /会话未在监控清单中/,
    )
  })

  it('已入库的 msg_uid 被幂等过滤，只有新消息进事务', async () => {
    // 第 1 次 SELECT 取会话主键；第 2 次取已存在的 uid
    db.dbSelect.mockResolvedValueOnce([{ id: 7 }]).mockResolvedValueOnce([{ msg_uid: 'mu-old' }])
    const batch = [msg({ msgUid: 'mu-old' }), msg({ msgUid: 'mu-new' })]
    await repo.applyPollResult('G-1001', batch, 'cursor-9', { triggers: { 'mu-new': 'group_at_me' }, sendMode: 'auto' })

    const statements = lastTxn()
    const inserts = statements.filter((item) => item.sql.includes('INSERT OR IGNORE INTO welink_messages'))
    expect(inserts).toHaveLength(1)
    expect(inserts[0].params?.[0]).toBe('mu-new')
  })

  it('命中触发的消息才建 job，未命中的只存档', async () => {
    db.dbSelect.mockResolvedValueOnce([{ id: 7 }]).mockResolvedValueOnce([])
    const batch = [msg({ msgUid: 'mu-a' }), msg({ msgUid: 'mu-b' })]
    await repo.applyPollResult('G-1001', batch, 'c', { triggers: { 'mu-a': 'group_at_me' }, sendMode: 'auto' })

    const statements = lastTxn()
    const jobInserts = statements.filter((item) => item.sql.includes('INSERT INTO welink_reply_jobs'))
    expect(jobInserts).toHaveLength(1)
    // 触发消息主键用 msg_uid 子查询取（同事务内可见，无需回读 lastInsertId）
    expect(jobInserts[0].sql).toContain('(SELECT id FROM welink_messages WHERE msg_uid = ?1)')
    expect(jobInserts[0].params?.[0]).toBe('mu-a')
    expect(jobInserts[0].params?.[1]).toBe('group_at_me')
    expect(jobInserts[0].sql).toContain("'', '', 'pending', 0")
  })

  it('汇总列增量在同事务里更新（O3：列表查询因此零聚合）', async () => {
    db.dbSelect.mockResolvedValueOnce([{ id: 7 }]).mockResolvedValueOnce([])
    const batch = [
      msg({ msgUid: 'mu-a', direction: 'in', atMe: true, sentAt: '2026-09-27 10:00:00' }),
      msg({ msgUid: 'mu-b', direction: 'out', senderId: 'E-0001', atMe: false, sentAt: '2026-09-27 10:01:00' }),
      msg({ msgUid: 'mu-c', direction: 'in', atMe: false, sentAt: '2026-09-27 10:02:00' }),
    ]
    await repo.applyPollResult('G-1001', batch, 'c9', { triggers: {}, sendMode: 'manual' })

    const summary = lastTxn().at(-1)!
    expect(summary.sql).toContain('unread_count = unread_count + ?4')
    expect(summary.sql).toContain('mention_count = mention_count + ?5')
    expect(summary.sql).toContain("last_msg_at = CASE WHEN ?6 <> '' THEN ?6 ELSE last_msg_at END")
    // 未读=2 条 in（out 不计）；mention 只看 in+atMe+text = 1
    expect(summary.params?.[3]).toBe(2)
    expect(summary.params?.[4]).toBe(1)
    expect(summary.params?.[5]).toBe('2026-09-27 10:02:00')
    expect(summary.params?.[1]).toBe('c9')
  })

  it('全部重复的一批不写消息/任务，但仍推进 cursor 与汇总列（更新水位线）', async () => {
    db.dbSelect.mockResolvedValueOnce([{ id: 7 }]).mockResolvedValueOnce([{ msg_uid: 'mu-x' }])
    const result = await repo.applyPollResult('G-1001', [msg({ msgUid: 'mu-x' })], 'c-new', {
      triggers: {},
      sendMode: 'auto',
    })
    // 只有汇总列那一条 UPDATE，没有 INSERT
    const statements = lastTxn()
    expect(statements).toHaveLength(1)
    expect(statements[0].sql).toContain('UPDATE welink_conversations')
    expect(statements.some((item) => item.sql.includes('INSERT'))).toBe(false)
    expect(result.cursor).toBe('c-new')
    expect(result.inserted).toEqual([])
    expect(result.createdJobs).toEqual([])
  })

  it('回读新插入的行并映射成驼峰字段（供 store 增量补丁，P5）', async () => {
    db.dbSelect
      .mockResolvedValueOnce([{ id: 7 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: 12,
          conv_pk: 7,
          msg_uid: 'mu-a',
          direction: 'in',
          sender_id: 'E-9001',
          sender_name: '赵敏',
          content: '@你 看下接口',
          msg_type: 'text',
          at_me: 1,
          read_flag: 0,
          sent_at: '2026-09-27 10:00:00',
          conv_type: 'group',
          conv_id: 'G-1001',
        },
      ])
      .mockResolvedValueOnce([])
    const result = await repo.applyPollResult('G-1001', [msg({ msgUid: 'mu-a' })], 'c', {
      triggers: {},
      sendMode: 'auto',
    })
    expect(result.inserted[0]).toMatchObject({
      pk: 12,
      convPk: 7,
      msgUid: 'mu-a',
      convId: 'G-1001',
      atMe: true,
      readFlag: false,
    })
  })
})

describe('infra/db/welink —— Agent 留痕（R4）', () => {
  it('insertAgentLog 的 seq 按 job 内递增（多次调用可回放顺序）', async () => {
    db.dbSelect.mockResolvedValueOnce([{ last_seq: 2 }]).mockResolvedValueOnce([
      {
        id: 99,
        job_pk: 5,
        seq: 3,
        prompt: 'p',
        response: 'r',
        status: 'ok',
        latency_ms: 120,
        error: '',
        created_at: '2026-09-27 10:00:00',
      },
    ])
    const stored = await repo.insertAgentLog({
      jobPk: 5,
      prompt: 'p',
      response: 'r',
      status: 'ok',
      latencyMs: 120,
      error: '',
    })
    expect(stored.seq).toBe(3)
    expect(db.dbExecute.mock.calls[0][1]?.[1]).toBe(3)
  })

  it('listAgentLogs 按 seq 升序（回溯 Tab 的展示顺序）', async () => {
    await repo.listAgentLogs(5)
    const { sql, params } = lastSelect()
    expect(sql).toContain('WHERE job_pk = ?1 ORDER BY seq')
    expect(params).toEqual([5])
  })
})
