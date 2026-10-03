/**
 * 真实 codehub-cli 适配器：把 `CodeHubPort` 落到 codehub-cli 子进程上。
 *
 * 本文件与 `exec.ts` 是「真实对接」的唯一改动面。业务层对此一无所知 —— 只看到
 * `CodeHubPort` 三个方法；打桩期（mock）锁定全部上层行为，对接时只换本文件。
 *
 * ┌─ [CLI-ASSUME] 契约假设清单（对接真实 codehub-cli 前逐项核实，核实后更新/删除）─┐
 * │ 1. 子命令面：                                                               │
 * │    · 连通自检 `auth status`（退出码 0 即可用）；                             │
 * │    · 列表 `mr list --repo <id> [--state <s>] --limit <n> --format json`；   │
 * │    · 单条 `mr view <iid> --repo <id> --format json`。                       │
 * │ 2. token 注入：全局参数 `--token <值>` 置于子命令之前（用户已确认参数方式，   │
 * │    参数名与位置待核实）。                                                    │
 * │ 3. 输出：UTF-8 文本；list 为 JSON 数组、view 为 JSON 对象。                  │
 * │ 4. 字段名假设集中在 `normalizeRecord` / `normalizeReview` / `normalizeState` │
 * │    的逐项注释里。                                                           │
 * │ 5. 认证失败特征串见 `exec.ts` 的 AUTH_PATTERN。                             │
 * │ 6. `--limit` 的服务端上限未知：本地 CODEHUB_MAX_BATCH(200) 与之取小。        │
 * └────────────────────────────────────────────────────────────────────────────┘
 */
import type {
  CodeHubComment,
  CodeHubMergeRequestDetail,
  CodeHubMrRecord,
  CodeHubMrState,
  CodeHubReviewSummary,
} from '@/types/codehub'
import { CODEHUB_MAX_BATCH } from '@/types/codehub'
import { runForOutput, TOKEN_FLAG, withTransportRetry } from './exec'
import {
  CodeHubError,
  type CodeHubListOptions,
  type CodeHubListResult,
  type CodeHubPort,
  type CodeHubVerifyResult,
} from './port'

export interface CliCodeHubOptions {
  /** 已解析的可执行文件路径（主干名必须是 codehub-cli，Rust 侧白名单校验） */
  cliPath: string
  /** 访问 token（用户配置；以命令行参数注入，见文件头 [CLI-ASSUME] 2） */
  token: string
  /** 子命令超时预算（毫秒） */
  timeoutMs?: number
}

// ---------- 参数拼装 ----------

function tokenArgs(token: string): string[] {
  return token ? [TOKEN_FLAG, token] : []
}

function listArgs(repoId: string, options: CodeHubListOptions, limit: number): string[] {
  const args = ['mr', 'list', '--repo', repoId, '--format', 'json', '--limit', String(limit)]
  if (options.state) args.push('--state', options.state)
  return args
}

function viewArgs(repoId: string, mrIid: string): string[] {
  return ['mr', 'view', mrIid, '--repo', repoId, '--format', 'json']
}

// ---------- 归一化（字段名假设集中于此，对接时逐项核对） ----------

function asRecord(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CodeHubError('MR 记录不是对象', 'parse')
  }
  return raw as Record<string, unknown>
}

/** 依次尝试多个候选字段名，取第一个非空值（字段名假设的统一着陆点） */
function str(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value) return value
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return ''
}

/** [CLI-ASSUME] 状态取值：opened/open → open，merged → merged，closed/rejected → closed */
function normalizeState(record: Record<string, unknown>): CodeHubMrState {
  const raw = str(record, ['state', 'status']).toLowerCase()
  if (raw === 'opened' || raw === 'open') return 'open'
  if (raw === 'merged') return 'merged'
  if (raw === 'closed' || raw === 'rejected') return 'closed'
  throw new CodeHubError(`未知 MR 状态：${raw || '(空)'}`, 'parse')
}

/** [CLI-ASSUME] 检视摘要字段：reviewers（人名/工号数组）、approvals/approve_count、
 *  unresolved_comments 数值。缺失一律回落安全默认值，不因摘要字段缺失丢整条记录。 */
function normalizeReview(record: Record<string, unknown>): CodeHubReviewSummary {
  const reviewersRaw = record.reviewers
  const reviewers = Array.isArray(reviewersRaw)
    ? reviewersRaw
        .map((item) => (typeof item === 'string' ? item : str(asRecord(item), ['name', 'username', 'id'])))
        .filter(Boolean)
    : []
  const approvals = Number(record.approvals ?? record.approve_count)
  const unresolved = Number(record.unresolved_comments ?? record.unresolved)
  return {
    reviewers,
    approvals: Number.isFinite(approvals) && approvals > 0 ? approvals : 0,
    unresolved: Number.isFinite(unresolved) && unresolved > 0 ? unresolved : 0,
    lastActivityAt: str(record, ['last_activity_at', 'updated_at']),
  }
}

/** [CLI-ASSUME] 评论字段：comments 数组，元素含 author/username、body/content、
 *  created_at。字段**缺失**（截断/精简输出）返回 null → 详情视为不可得；空数组是
 *  合法详情（「确实没有评论」）。 */
function normalizeComments(record: Record<string, unknown>): CodeHubComment[] | null {
  const raw = record.comments
  if (!Array.isArray(raw)) return null
  return raw.map((item) => {
    const comment = asRecord(item)
    return {
      author: str(comment, ['author', 'username', 'name']),
      body: str(comment, ['body', 'content']),
      createdAt: str(comment, ['created_at', 'createdAt']),
    }
  })
}

/** 单条外部记录 → 端口记录。iid/title/state 缺失属于契约破坏（parse），摘要字段
 *  缺失回落默认。详情是否可得只取决于 comments 字段是否存在。 */
function normalizeRecord(raw: unknown, repoId: string): CodeHubMrRecord {
  const record = asRecord(raw)
  const mrIid = str(record, ['iid', 'mr_iid', 'number', 'id'])
  const title = str(record, ['title'])
  if (!mrIid || !title) throw new CodeHubError('MR 记录缺少 iid/title 字段', 'parse')
  const comments = normalizeComments(record)
  const detail: CodeHubMergeRequestDetail | null =
    comments === null
      ? null
      : { description: typeof record.description === 'string' ? record.description : '', comments }
  return {
    summary: {
      repoId,
      mrIid,
      title,
      state: normalizeState(record),
      author: str(record, ['author', 'author_name', 'username']),
      sourceBranch: str(record, ['source_branch', 'sourceBranch']),
      targetBranch: str(record, ['target_branch', 'targetBranch']),
      updatedAt: str(record, ['updated_at', 'updatedAt']),
      webUrl: str(record, ['web_url', 'webUrl', 'html_url']),
      review: normalizeReview(record),
    },
    detail,
  }
}

// ---------- 截断降级（design D5：完整元素照常入库，残缺元素丢弃） ----------

/**
 * 解析 list 输出的 JSON 数组；输出被 2MB 截断腰斩时按「花括号深度 + 字符串感知」
 * 抢救完整闭合的元素对象（最后一个残缺元素自然丢弃）。这不是宽容 JSON 解析器：
 * 只服务「截断把数组切一半」这一种形态，非截断的非法输出一律 parse 故障。
 */
export function parseMrArray(text: string, stdoutTruncated: boolean): { items: unknown[]; salvaged: boolean } {
  try {
    const parsed: unknown = JSON.parse(text.trim())
    if (!Array.isArray(parsed)) throw new CodeHubError('list 输出不是 JSON 数组', 'parse')
    return { items: parsed, salvaged: false }
  } catch (error) {
    if (error instanceof CodeHubError) throw error
  }
  if (!stdoutTruncated) throw new CodeHubError('list 输出不是合法 JSON', 'parse')

  const items: unknown[] = []
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
    } else if (char === '{') {
      if (depth === 0) start = index
      depth += 1
    } else if (char === '}') {
      depth -= 1
      if (depth === 0 && start >= 0) {
        try {
          items.push(JSON.parse(text.slice(start, index + 1)))
        } catch {
          // 单元素损坏：抢救语义 = 尽力而为，跳过
        }
        start = -1
      }
      if (depth < 0) break
    }
  }
  return { items, salvaged: true }
}

// ---------- 端口实现 ----------

export function createCliCodeHubPort(options: CliCodeHubOptions): CodeHubPort {
  const timeoutMs = options.timeoutMs ?? 12_000
  const program = options.cliPath || 'codehub-cli'
  const prefix = tokenArgs(options.token)

  return {
    async listMergeRequests(repoId: string, listOptions: CodeHubListOptions = {}): Promise<CodeHubListResult> {
      const limit = Math.min(Math.max(1, listOptions.limit ?? CODEHUB_MAX_BATCH), CODEHUB_MAX_BATCH)
      const args = [...prefix, ...listArgs(repoId, listOptions, limit)]
      const { text, stdoutTruncated } = await withTransportRetry(() => runForOutput(program, args, { timeoutMs }))
      const { items } = parseMrArray(text, stdoutTruncated)
      // 截断标志即降级：抢救回来的记录照常入库，但「本轮可能不完整」必须上报，
      // 由编排层写进同步摘要（design D5）—— 静默少几条比同步失败更难发现。
      return { records: items.map((item) => normalizeRecord(item, repoId)), degraded: stdoutTruncated }
    },

    async getMergeRequestDetail(repoId: string, mrIid: string): Promise<CodeHubMergeRequestDetail> {
      const args = [...prefix, ...viewArgs(repoId, mrIid)]
      const { text } = await withTransportRetry(() => runForOutput(program, args, { timeoutMs }))
      // [CLI-ASSUME] view 输出为单对象（非数组）
      let parsed: unknown
      try {
        parsed = JSON.parse(text.trim())
      } catch {
        throw new CodeHubError('mr view 输出不是合法 JSON', 'parse')
      }
      const record = normalizeRecord(parsed, repoId)
      if (!record.detail) throw new CodeHubError('MR 详情字段缺失', 'parse')
      return record.detail
    },

    async verifyConnection(): Promise<CodeHubVerifyResult> {
      // 诊断通道永不 reject：把失败原因（含脱敏后的参数）装进结果带回配置页
      try {
        await withTransportRetry(() => runForOutput(program, [...prefix, 'auth', 'status'], { timeoutMs }))
        return { ok: true, detail: 'codehub-cli 可用' }
      } catch (error) {
        return { ok: false, detail: error instanceof Error ? error.message : String(error) }
      }
    },
  }
}
