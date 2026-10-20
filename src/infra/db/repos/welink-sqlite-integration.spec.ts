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
/** 最近一次经仓储下发的 SQL（已改写为 node:sqlite 的匿名占位符）+ 参数 */
let lastExecute: { sql: string; args: SQLInputValue[] } = { sql: '', args: [] }
/** 最近一次经仓储下发的 **查询** SQL（v10 的谓词走的是 SELECT） */
let lastSelect: { sql: string; args: SQLInputValue[] } = { sql: '', args: [] }

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
    lastExecute = { sql: rewritten.sql, args: rewritten.args as unknown as SQLInputValue[] }
    const result = realDb.prepare(rewritten.sql).run(...(rewritten.args as unknown as SQLInputValue[]))
    return { changes: Number(result.changes), lastInsertId: Number(result.lastInsertRowid) }
  })
  db.dbSelect.mockImplementation(async (sql: string, params: DbParam[] = []) => {
    const rewritten = toAnonymous(sql, params)
    lastSelect = { sql: rewritten.sql, args: rewritten.args as unknown as SQLInputValue[] }
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

// ---------------- 迁移 DDL：清理/轮询热路径的索引 ----------------

describe('migration v8 / v9 —— 高频谓词的索引（缺了就是全表扫描）', () => {
  const hasIndex = (name: string) =>
    (realDb.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`).all(name) as unknown[]).length ===
    1

  it('v8：会话表的 watching 与排序索引都在（poller 每轮的入口查询）', () => {
    expect(hasIndex('idx_wc_watching')).toBe(true)
    expect(hasIndex('idx_wc_type_last')).toBe(true)
  })

  it('v9：消息 sent_at 与调用日志 created_at 都有独立索引（保留期清理的时间谓词）', () => {
    expect(hasIndex('idx_wm_sent_at')).toBe(true)
    expect(hasIndex('idx_wal_created_at')).toBe(true)
  })

  // EXPLAIN 的必须是**仓储真实下发的那条 DELETE**（捕获自 bridge）。
  // 只要子查询带着 `ORDER BY id`，SQLite 就会为了省掉排序选择按 rowid 全表扫描 ——
  // 索引建了也白建；去掉排序后才会走 idx_wm_sent_at / idx_wal_created_at。
  const explainLastExecute = () =>
    (realDb.prepare(`EXPLAIN QUERY PLAN ${lastExecute.sql}`).all(...lastExecute.args) as { detail: string }[])
      .map((row) => row.detail)
      .join(' | ')

  it('purge 的时间谓词走索引而非全表扫描（(conv_pk, sent_at) 帮不上裸 sent_at）', async () => {
    await repo.purgeMessagesBefore('2026-06-01 00:00:00', 500)
    expect(explainLastExecute()).toMatch(/SEARCH m USING (COVERING )?INDEX idx_wm_sent_at/)
  })

  it('语料清理的 created_at 谓词同样走索引', async () => {
    await repo.purgeAgentLogsBefore('2026-06-01 00:00:00', 500)
    expect(explainLastExecute()).toMatch(/SEARCH welink_agent_logs USING (COVERING )?INDEX idx_wal_created_at/)
  })
})

// ---------------- 迁移 DDL：已发送时间的热谓词索引 ----------------

describe('migration v10 —— 已发送时间（finished_at）的热谓词索引', () => {
  const hasIndex = (name: string) =>
    (realDb.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`).all(name) as unknown[]).length ===
    1

  const explainLastSelect = () =>
    (realDb.prepare(`EXPLAIN QUERY PLAN ${lastSelect.sql}`).all(...lastSelect.args) as { detail: string }[])
      .map((row) => row.detail)
      .join(' | ')

  it('两条索引都在（Gate 预热与沉淀水位都靠它们）', () => {
    expect(hasIndex('idx_wrj_target_finished')).toBe(true)
    expect(hasIndex('idx_wrj_status_finished')).toBe(true)
  })

  // EXPLAIN 的同样是**仓储真实下发的那条 SELECT**：安全闸预热对每个监控会话都跑一次
  // countSentSince，N 个会话 = N 次查询。
  //
  // 断言口径：**不钉具体哪条索引**（SQLite 在两条都可用时选谁是代价估算的结果，
  // 不是契约），只钉「走了 v10 的 finished_at 索引、且范围收窄到 finished_at」。
  // 少了 `finished_at>?` 这一段就退回「定位到 status/target 后把后面全扫一遍」。
  it('会话级发送计数：谓词收窄到 finished_at 范围', async () => {
    await repo.countSentSince('g-1', '2026-06-01 00:00:00')
    const detail = explainLastSelect()
    expect(detail).toMatch(/USING (COVERING )?INDEX idx_wrj_(target|status)_finished/)
    expect(detail).toMatch(/finished_at>\?/)
  })

  it('全局发送计数：谓词收窄到 finished_at 范围', async () => {
    await repo.countGlobalSentSince('2026-06-01 00:00:00')
    const detail = explainLastSelect()
    expect(detail).toMatch(/USING (COVERING )?INDEX idx_wrj_status_finished/)
    expect(detail).toMatch(/finished_at>\?/)
  })
})

// ---------------- 重试预算：两段必须分开计 ----------------

describe('commitDraft —— 生成与外发是两段独立重试预算（回归防线）', () => {
  it('草稿就绪时 attempts 归零：生成阶段花掉的计数不得吃掉外发重试', async () => {
    const convPk = seedConversation()
    seedMessage(convPk, 1, '2026-01-01 00:00:00')
    seedJob(1, 'discussing')
    const jobPk = (realDb.prepare('SELECT id FROM welink_reply_jobs').all() as { id: number }[])[0].id

    // 生成阶段连败两次：attempts = 2
    await repo.recordAttemptFailure(jobPk, 'discussing', '生成失败 1')
    await repo.recordAttemptFailure(jobPk, 'discussing', '生成失败 2')
    const attemptsOf = () =>
      (realDb.prepare('SELECT attempts AS a FROM welink_reply_jobs WHERE id = ?').get(jobPk) as { a: number }).a
    expect(attemptsOf()).toBe(2)

    // 生成成功 → 草稿就绪。此时 attempts 必须归零，否则外发第一次失败就是
    // attempts=3（3 < 3 为假）→ 直接判 failed，一次外发重试都没有。
    expect(await repo.commitDraft(jobPk, '最终草稿', '')).toBe(true)
    expect(attemptsOf()).toBe(0)
    expect((realDb.prepare('SELECT status AS s FROM welink_reply_jobs WHERE id = ?').get(jobPk) as { s: string }).s).toBe(
      'ready',
    )
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

// ---------------- 回执核对的时间下界（第二轮：防「重复提问漏回复」） ----------------

/**
 * 场景：对方连着问两个一模一样的问题。
 *
 * 第一次：job 置 sending（updated_at = T1）→ 真发出 → markSent 记下 out 消息（sent_at = T1）。
 * 第二次：新 job 置 sending（updated_at = T2 > T1）。若回执核对**不带时间下界**，
 * 它会拿「同会话 + 同内容」去全表找，命中第一次那条（sent_at = T1）→ 判定"已发送"
 * → 补记 sent 而不真发 → **用户永远收不到第二条回复**。
 */
describe('hasOutgoingReceipt —— 只认本次发送尝试之后的 out 消息', () => {
  /** 造一条 out 消息（direction='out'） */
  function seedOutMessage(convPk: number, id: number, content: string, sentAt: string): void {
    realDb
      .prepare(
        `INSERT INTO welink_messages (id, msg_uid, conv_pk, direction, sender_id, sender_name, content, msg_type, at_me, read_flag, sent_at, created_at)
         VALUES (?, ?, ?, 'out', '', '', ?, 'text', 0, 1, ?, ?)`,
      )
      .run(id, `out-${id}`, convPk, content, sentAt, sentAt)
  }

  it('历史同内容（sent_at 早于本次尝试）→ 不算回执，必须真发', async () => {
    const convPk = seedConversation()
    seedMessage(convPk, 1, '2026-01-01 00:00:00') // 触发消息（in）
    seedJob(1, 'sending')
    const jobPk = (realDb.prepare('SELECT id FROM welink_reply_jobs').all() as { id: number }[])[0].id
    // 本次尝试开始时刻 T2
    realDb.prepare(`UPDATE welink_reply_jobs SET draft = ?, updated_at = ? WHERE id = ?`).run(
      '常见问题答案',
      '2026-06-01 12:00:00',
      jobPk,
    )
    // 上一次问答留下的同内容 out 消息（T1 < T2）
    seedOutMessage(convPk, 2, '常见问题答案', '2026-06-01 10:00:00')

    await expect(repo.hasOutgoingReceipt(jobPk)).resolves.toBe(false)
  })

  it('本次尝试之后的同内容 out（sent_at >= updated_at）→ 判定为回执，补记而不重发', async () => {
    const convPk = seedConversation()
    seedMessage(convPk, 1, '2026-01-01 00:00:00')
    seedJob(1, 'sending')
    const jobPk = (realDb.prepare('SELECT id FROM welink_reply_jobs').all() as { id: number }[])[0].id
    realDb.prepare(`UPDATE welink_reply_jobs SET draft = ?, updated_at = ? WHERE id = ?`).run(
      '常见问题答案',
      '2026-06-01 12:00:00',
      jobPk,
    )
    // 本次真的发出去了（sent_at 晚于尝试开始时刻）
    seedOutMessage(convPk, 2, '常见问题答案', '2026-06-01 12:00:03')

    await expect(repo.hasOutgoingReceipt(jobPk)).resolves.toBe(true)
  })

  it('同会话里**内容不同**的 out 不算回执（防误判放宽）', async () => {
    const convPk = seedConversation()
    seedMessage(convPk, 1, '2026-01-01 00:00:00')
    seedJob(1, 'sending')
    const jobPk = (realDb.prepare('SELECT id FROM welink_reply_jobs').all() as { id: number }[])[0].id
    realDb.prepare(`UPDATE welink_reply_jobs SET draft = ?, updated_at = ? WHERE id = ?`).run(
      '常见问题答案',
      '2026-06-01 12:00:00',
      jobPk,
    )
    seedOutMessage(convPk, 2, '别的回复', '2026-06-01 12:00:03')

    await expect(repo.hasOutgoingReceipt(jobPk)).resolves.toBe(false)
  })
})
