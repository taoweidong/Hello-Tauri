/**
 * CodeHub 检视域 —— 领域类型（personal-workbench）。
 *
 * 命名约定与项目一致：DB 列 snake_case，TS 字段 camelCase，映射集中在仓储层，
 * 上层永远只见 camelCase。数据源为内网 codehub-cli（机制对标 gh CLI 之于 GitHub），
 * 所有持久化数据只落本机 SQLite 快照（内网离线是硬需求）。
 */

// ---------- 枚举 ----------

/** MR 状态（三态；「待检视」口径本期不做，见 proposal 不做清单） */
export type CodeHubMrState = 'open' | 'merged' | 'closed'

/** 数据来源端口实现 */
export type CodeHubSource = 'mock' | 'cli'

// ---------- 实体 ----------

/** 注册仓库（`codehub_repos`） */
export interface CodeHubRepo {
  pk: number
  /** 仓库标识（[CLI-ASSUME]：宿主内唯一标识的具体形态，对接时核实） */
  repoId: string
  /** 展示名（注册时填写，默认取 repoId 尾段） */
  name: string
  enabled: boolean
  createdAt: string
}

/** 检视摘要（列表列存 + 详情展示共用） */
export interface CodeHubReviewSummary {
  /** 检视人列表 */
  reviewers: string[]
  /** 已批准数 */
  approvals: number
  /** 未解决意见数 */
  unresolved: number
  /** 最近检视动态时间（ISO，可为空串） */
  lastActivityAt: string
}

/** MR 评论（详情 JSON 内嵌，不单独建表——只读快照无关联查询需求） */
export interface CodeHubComment {
  author: string
  body: string
  createdAt: string
}

/** MR 列表字段（`codehub_mrs` 列存部分，筛选/排序全靠这些列） */
export interface CodeHubMergeRequestSummary {
  repoId: string
  /** MR 编号（宿主仓库内唯一） */
  mrIid: string
  title: string
  state: CodeHubMrState
  author: string
  sourceBranch: string
  targetBranch: string
  updatedAt: string
  webUrl: string
  review: CodeHubReviewSummary
}

/** MR 详情（`codehub_mrs.detail_json` 载荷；list 输出缺失/截断时可为空） */
export interface CodeHubMergeRequestDetail {
  description: string
  comments: CodeHubComment[]
}

/** 端口单条记录：列表字段 + 可缺省的详情载荷（缺省时同步侧弃写详情列） */
export interface CodeHubMrRecord {
  summary: CodeHubMergeRequestSummary
  detail: CodeHubMergeRequestDetail | null
}

/**
 * 每仓库同步状态（`codehub_sync_state`，每仓一行；从未同步过的仓库无行）。
 *
 * 失败只写 `lastError`、不动 `lastSyncedAt` —— 旧快照仍然可读，UI 据此标注「非实时」
 * （spec「快照落库与离线只读降级」）。
 */
export interface CodeHubSyncState {
  repoId: string
  /** 最后一次成功同步时间；从未成功为 null */
  lastSyncedAt: string | null
  /** 最近一次失败原因摘要；成功后清空（截断降级不写这里，见 design D5） */
  lastError: string | null
}

// ---------- 连接配置 ----------

/**
 * CodeHub 连接配置（config.json 的 codeHub 节）。
 *
 * token 为用户显式配置的敏感凭据：调用时以命令行参数注入（用户决策，design D6），
 * 全链路脱敏（日志/诊断信息不得出现明文）。
 */
export interface CodeHubSettings {
  source: CodeHubSource
  cliPath: string
  token: string
  /** 自动同步间隔（秒）；0 = 仅手动刷新（默认，手动优先） */
  pollIntervalSec: number
  /** 单批拉取上限（P8 载荷可控） */
  pullBatchLimit: number
}

/**
 * 单批拉取的硬上限（端口实现与配置输入共用同一真值）。
 *
 * 真实 CLI 的 `--limit` 上限未知（[CLI-ASSUME]），这里取「一次子进程输出不至于撞上
 * 宿主 2MB 截断」的经验值；配置页输入与适配器拼装都钳到它，避免用户填了大数却被
 * 适配器静默改小。
 */
export const CODEHUB_MAX_BATCH = 200

export const DEFAULT_CODEHUB_SETTINGS: CodeHubSettings = {
  source: 'mock',
  cliPath: 'codehub-cli',
  token: '',
  pollIntervalSec: 0,
  pullBatchLimit: CODEHUB_MAX_BATCH,
}

const MR_STATES: readonly CodeHubMrState[] = ['open', 'merged', 'closed']

export function isCodeHubMrState(value: unknown): value is CodeHubMrState {
  return typeof value === 'string' && (MR_STATES as readonly string[]).includes(value)
}

/** 状态中文标签（检视页筛选条、列表徽标与详情面板共用，与 JOB_STATUS_LABEL 同处） */
export const CODEHUB_STATE_LABEL: Record<CodeHubMrState, string> = {
  open: '开启',
  merged: '已合并',
  closed: '已关闭',
}

/** 归一化入口：config.json 是用户可手改的 JSON，坏值一律回落默认（与 welink 同策略） */
export function normalizeCodeHubSettings(input?: Partial<CodeHubSettings> | null): CodeHubSettings {
  const raw = input ?? {}
  const interval = Number(raw.pollIntervalSec)
  const batch = Number(raw.pullBatchLimit)
  return {
    source: raw.source === 'cli' ? 'cli' : 'mock',
    cliPath: typeof raw.cliPath === 'string' && raw.cliPath ? raw.cliPath : DEFAULT_CODEHUB_SETTINGS.cliPath,
    token: typeof raw.token === 'string' ? raw.token : '',
    pollIntervalSec: Number.isFinite(interval) && interval > 0 ? Math.floor(interval) : 0,
    pullBatchLimit:
      Number.isFinite(batch) && batch > 0
        ? Math.min(Math.floor(batch), CODEHUB_MAX_BATCH)
        : DEFAULT_CODEHUB_SETTINGS.pullBatchLimit,
  }
}
