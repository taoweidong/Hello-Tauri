import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * WeLink 域仓储的**真实 SQLite** 集成测试（migration v2 + v7）。
 *
 * ## 为什么必须有这个文件（以及它防的是什么）
 *
 * 其余仓储测试全部通过 mock bridge + **断言 SQL 文本**。那一层证明的是
 * 「我们写了什么 SQL」，证明不了「这些 SQL 跑在真库上是什么结果」。这两件事
 * 在下面这个缺陷上彻底分叉了：
 *
 * `purgeMessagesBefore` 曾经只写 `DELETE FROM welink_messages WHERE sent_at < ?`，
 * 断言 SQL 文本的用例**一直是绿的** —— 但真库上它 100% 抛
 * `FOREIGN KEY constraint failed`，一行都删不掉。因为
 * `welink_reply_jobs.trigger_msg_pk` 声明了 `REFERENCES welink_messages(id)`
 * 且没有 `ON DELETE` 子句，而宿主开着 `PRAGMA foreign_keys = ON`。
 * 异常又被 retention 调度层的 `.catch` 降级为一条 warn，于是**保留期清理静默
 * 永久失效、消息表无界增长**，而单测全绿。
 *
 * 这类缺陷的共同特征是「**单条 SQL 语法正确，多条组合起来违反约束**」。
 * 文本断言对它们结构性失明 —— 所以这里不用仿真，而是起真库、跑真迁移、
 * 跑真 SQL，让约束替我们说话。
 *
 * ## 覆盖范围
 *
 * 只覆盖「**跨表约束**」相关的语义（外键、级联、索引），不重复
 * `welink.spec.ts` 已覆盖的列表/计数/分页口径，也不做双实现语义对比
 * （那是 `welink-contract.spec.ts` 的职责，且它对 SQL 侧是语句仿真）。
 *
 * 与 `sediment-contract.spec.ts` 同一模式：Node 22 内置 `node:sqlite` 起内存库。
 */
import type { DbParam, DbRow } from '@/types'
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

vi.mock('@/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { MIGRATIONS } from '@/infra/db'
import { sqlWelinkRepository } from '@/infra/db/repos/welink'

let realDb: DatabaseSync

/**
 * 仓库 SQL 统一用 `?N` 编号占位符（rusqlite 原生支持），本机 Node 的 node:sqlite
 * 只支持匿名 `?`。桥接层做一次「编号 → 匿名」改写（与 sediment-contract.spec 同款）。
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
  const { DatabaseSync: Database } = await import('node:sqlite')
  realDb = new Database(':memory:')
  // 与宿主 db.rs 的 open_db 一致：WAL/外键都在宿主统一设置，这里必须同样开启，
  // 否则「外键是否生效」这个前提本身就与生产不一致（等于没测）。
  realDb.exec('PRAGMA foreign_keys = ON')

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
    const affected: number[] = []
    realDb.exec('BEGIN')
    try {
      for (const statement of statements) {
        const rewritten = toAnonymous(statement.sql, statement.params ?? [])
        const result = realDb.prepare(rewritten.sql).run(...(rewritten.args as unknown as SQLInputValue[]))
        affected.push(Number(result.changes))
      }
      realDb.exec('COMMIT')
    } catch (error) {
      realDb.exec('ROLLBACK')
      throw error
    }
    return affected
  })
})

beforeEach(() => {
  realDb.exec('PRAGMA foreign_keys = OFF')
  const tables = realDb
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
    .all() as { name: string }[]
  for (const table of tables) realDb.exec(`DROP TABLE IF EXISTS "${table.name}"`)
  for (const migration of MIGRATIONS) realDb.exec(migration.sql)
  realDb.exec('PRAGMA foreign_keys = ON')
})

// ---------------- 种子数据工具 ----------------

const repo = sqlWelinkRepository

/**
 * 造一个会话并返回主键。
 *
 * 直接写 SQL 而不走 `updateConversation`：本文件专注「跨表约束」，
 * 让种子失败时抛在SQL 上（信息明确），而不是被仓储层的业务校验糊掉。
 */
function seedConversation(convId = 'g-1', convType: 'group' | 'private' = 'group'): number {
  // 本文件**直连** realDb 的 SQL 一律用匿名 `?`：本机 node:sqlite 不支持 `?N`
  // 编号参数的位置绑定（桥接层 toAnonymous 只覆盖经过 mock bridge 的仓储 SQL），
  // 同号复用处按出现顺序重复传参。
  realDb
    .prepare(
      `INSERT INTO welink_conversations (conv_type, conv_id, title, updated_at)
       VALUES (?, ?, ?, '2026-01-01 00:00:00')`,
    )
    .run(convType, convId, convId)
  const rows = realDb.prepare('SELECT id FROM welink_conversations WHERE conv_id = ?').all(convId) as { id: number }[]
  return rows[0].id
}

/** 直接往messages 插一行（绕开 applyPollResult 的批量语义，专注构造外键场景） */
function seedMessage(convPk: number, id: number, sentAt: string): void {
  realDb
    .prepare(
      `INSERT INTO welink_messages (id, msg_uid, conv_pk, direction, sender_id, sender_name, content, msg_type, at_me, read_flag, sent_at, created_at)
       VALUES (?, ?, ?, 'in', 'u1', '张三', '正文' || ?, 'text', 0, 0, ?, ?)`,
    )
    .run(id, `u-${id}`, convPk, id, sentAt, sentAt)
}

/** 往 jobs 插一行并挂到某条消息上 */
function seedJob(triggerMsgPk: number, status = 'sent'): void {
  realDb
    .prepare(
      `INSERT INTO welink_reply_jobs (trigger_msg_pk, trigger_type, target_type, target_id, send_mode_used,
         status, draft, created_at, updated_at)
       VALUES (?, 'group_at_me', 'group', 'g-1', 'auto', ?, '草稿' || ?, '2026-01-01 00:00:00', '2026-01-01 00:00:00')`,
    )
    .run(triggerMsgPk, status, triggerMsgPk)
}

/** 往 agent_logs 插一行并挂到某个 job 上 */
function seedAgentLog(jobPk: number, createdAt: string): void {
  realDb
    .prepare(
      `INSERT INTO welink_agent_logs (job_pk, seq, prompt, response, status, latency_ms, error, created_at)
       VALUES (?, 1, '提示词' || ?, '回复', 'ok', 10, '', ?)`,
    )
    .run(jobPk, jobPk, createdAt)
}

function count(table: 'welink_messages' | 'welink_reply_jobs' | 'welink_agent_logs'): number {
  const rows = realDb.prepare(`SELECT COUNT(*) AS c FROM ${table}`).all() as { c: number }[]
  return rows[0].c
}

function messageIds(): number[] {
  return (realDb.prepare('SELECT id FROM welink_messages ORDER BY id').all() as { id: number }[]).map((r) => r.id)
}

// ---------------- 迁移 DDL ----------------

describe('migration v7 —— 保留期清理的前置索引', () => {
  it('idx_wrj_trigger_msg 必须存在（缺它NOT EXISTS 退化为全表扫描，实测 5 万行 21.8s）', () => {
    const rows = realDb
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_wrj_trigger_msg'`)
      .all()
    expect(rows).toHaveLength(1)
  })

  it('purge 的 NOT EXISTS 子查询走索引而非SCAN（防回归：索引被误删后性能塌陷）', () => {
    const plan = realDb
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT m.id FROM welink_messages m
          WHERE m.sent_at < ?
            AND NOT EXISTS (SELECT 1 FROM welink_reply_jobs j WHERE j.trigger_msg_pk = m.id)
          ORDER BY m.id LIMIT ?`,
      )
      .all('2026-06-01 00:00:00', 500) as { detail: string }[]
    const detail = plan.map((row) => row.detail).join(' | ')
    expect(detail).not.toContain('SCAN j')
    expect(detail).toMatch(/SEARCH j.*INDEX/)
  })
})

// ---------------- 核心回归：purge 不再抛外键错误 ----------------

describe('purgeMessagesBefore —— 真库外键行为（回归防线）', () => {
  it('存在被job 引用的过期消息时**不抛外键错误**，而是跳过它们（这是本文件的核心断言）', async () => {
    const convPk = seedConversation()
    seedMessage(convPk, 1, '2026-01-01 00:00:00')
    seedMessage(convPk, 2, '2026-01-01 00:00:00')
    seedMessage(convPk, 3, '2026-01-01 00:00:00')
    seedJob(1) // 只让消息 1 被引用；2、3 无引用

    // 旧实现在这里抛 FOREIGN KEY constraint failed
    const removed = await repo.purgeMessagesBefore('2026-06-01 00:00:00', 500)

    expect(removed).toBe(2)
    expect(messageIds()).toEqual([1])
  })

  it('被引用的消息保留、job 与语料**完整无损**（语义边界：只删留痕，不动 job）', async () => {
    const convPk = seedConversation()
    seedMessage(convPk, 1, '2026-01-01 00:00:00')
    seedMessage(convPk, 2, '2026-01-01 00:00:00')
    seedJob(1)
    const jobPk = (realDb.prepare('SELECT id FROM welink_reply_jobs').all() as { id: number }[])[0].id
    seedAgentLog(jobPk, '2026-01-01 00:00:00')

    await repo.purgeMessagesBefore('2026-06-01 00:00:00', 500)
    await repo.purgeAgentLogsBefore('2026-06-01 00:00:00', 500)

    expect(count('welink_messages')).toBe(1)
    expect(count('welink_reply_jobs')).toBe(1)
    // 语料保留期 90 天 < 消息 180 天，这里用同一条 cutoff演示「job 不受purge 影响」
    expect(count('welink_agent_logs')).toBe(0)
    const kept = realDb.prepare('SELECT trigger_msg_pk FROM welink_reply_jobs').all() as { trigger_msg_pk: number }[]
    expect(kept[0].trigger_msg_pk).toBe(1)
  })

  it('未过期的消息一律不删（cutoff 边界正确）', async () => {
    const convPk = seedConversation()
    seedMessage(convPk, 1, '2026-01-01 00:00:00') // 过期
    seedMessage(convPk, 2, '2026-09-01 00:00:00') // 未过期

    const removed = await repo.purgeMessagesBefore('2026-06-01 00:00:00', 500)

    expect(removed).toBe(1)
    expect(messageIds()).toEqual([2])
  })

  it('全部消息都被引用时删 0 条且**不报错**（收敛，不空转）', async () => {
    const convPk = seedConversation()
    seedMessage(convPk, 1, '2026-01-01 00:00:00')
    seedMessage(convPk, 2, '2026-01-01 00:00:00')
    seedJob(1)
    seedJob(2)

    const removed = await repo.purgeMessagesBefore('2026-06-01 00:00:00', 500)

    expect(removed).toBe(0)
    expect(count('welink_messages')).toBe(2)
  })

  it('分批语义：batch 限制生效（一次只删batch 条，供调用方循环）', async () => {
    const convPk = seedConversation()
    for (let id = 1; id <= 5; id += 1) seedMessage(convPk, id, '2026-01-01 00:00:00')

    const removed = await repo.purgeMessagesBefore('2026-06-01 00:00:00', 2)

    expect(removed).toBe(2)
    expect(count('welink_messages')).toBe(3)
  })

  it('语料清理在消息被跳过后仍能正常执行（两条 purge 不互相连坐）', async () => {
    const convPk = seedConversation()
    seedMessage(convPk, 1, '2026-01-01 00:00:00')
    seedJob(1)
    const jobPk = (realDb.prepare('SELECT id FROM welink_reply_jobs').all() as { id: number }[])[0].id
    seedAgentLog(jobPk, '2026-01-01 00:00:00')

    // 消息清理删不掉（被引用），语料清理必须照样成功
    await expect(repo.purgeMessagesBefore('2026-06-01 00:00:00', 500)).resolves.toBe(0)
    await expect(repo.purgeAgentLogsBefore('2026-06-01 00:00:00', 500)).resolves.toBe(1)
    expect(count('welink_agent_logs')).toBe(0)
  })
})

// ---------------- 既有级联语义未被破坏 ----------------

describe('显式级联删除在真库上仍成立（回归）', () => {
  it('removeConversation 显式删干净三张表，不留悬挂 job', async () => {
    const convPk = seedConversation()
    seedMessage(convPk, 1, '2026-01-01 00:00:00')
    seedJob(1)

    await repo.removeConversation('g-1')

    expect(count('welink_messages')).toBe(0)
    expect(count('welink_reply_jobs')).toBe(0)
    expect(count('welink_agent_logs')).toBe(0)
  })

  it('removeJob 先删语料再删 job（反序会留下孤儿日志）', async () => {
    const convPk = seedConversation()
    seedMessage(convPk, 1, '2026-01-01 00:00:00')
    seedJob(1)
    const jobPk = (realDb.prepare('SELECT id FROM welink_reply_jobs').all() as { id: number }[])[0].id
    seedAgentLog(jobPk, '2026-01-01 00:00:00')

    await repo.removeJob(jobPk)

    expect(count('welink_reply_jobs')).toBe(0)
    expect(count('welink_agent_logs')).toBe(0)
    expect(count('welink_messages')).toBe(1) // 消息不受影响
  })
})
