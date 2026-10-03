/**
 * CodeHub 检视域的数据层端口契约（与 `group-ports.ts` 同构，独立成文）。
 *
 * 硬约束与既有域一致，改动时勿破坏：
 *  1. **分页强制**（P7）：`listMrs` 必须带 `limit`，SQL 必含 `LIMIT`；
 *  2. **快照覆盖写**：`applySnapshot` 是 MR 快照进入本地库的唯一入口，单事务内
 *     完成「整批 upsert + 同步状态落 success」—— 半批成功/半批失败是不允许的
 *     中间态（spec「同步失败不破坏既有快照」）。
 */
import type {
  CodeHubMergeRequestDetail,
  CodeHubMrRecord,
  CodeHubMrState,
  CodeHubRepo,
  CodeHubSyncState,
} from '@/types/codehub'

/** MR 快照分页查询条件 */
export interface CodeHubMrQuery {
  repoId?: string
  state?: CodeHubMrState
  limit: number
  offset: number
}

export interface CodeHubRepository {
  // —— 仓库注册（用户显式维护的小清单） ——
  listRepos(limit: number): Promise<CodeHubRepo[]>
  /** 幂等注册：repo_id 已存在时更新名称而非报错，返回注册后的仓库行 */
  addRepo(repoId: string, name: string): Promise<CodeHubRepo>
  setRepoEnabled(pk: number, enabled: boolean): Promise<boolean>
  /** 删仓库并在同事务清掉其 MR 快照与同步状态（显式级联） */
  removeRepo(pk: number): Promise<boolean>

  // —— MR 快照 ——
  /**
   * 整批覆盖写快照（单事务）：全部 upsert + 同步状态落 success。
   * `detail` 为 null 的记录照常写列表字段、详情列写 NULL（截断/字段缺失的降级语义）。
   * 返回写入条数（即 records 长度，空批次 = 仅刷新同步状态）。
   */
  applySnapshot(repoId: string, records: CodeHubMrRecord[], syncedAt: string): Promise<number>
  /** 快照分页查询（P7；排序 updated_at DESC） */
  listMrs(query: CodeHubMrQuery): Promise<CodeHubMrRecord[]>
  /** 与 `listMrs` 同口径的计数（分页脚） */
  countMrs(query: Omit<CodeHubMrQuery, 'limit' | 'offset'>): Promise<number>
  getMr(repoId: string, mrIid: string): Promise<CodeHubMrRecord | null>
  /** 单条详情补拉后的覆盖写（只更新详情列与 synced_at，不产生新行） */
  saveMrDetail(repoId: string, mrIid: string, detail: CodeHubMergeRequestDetail, syncedAt: string): Promise<boolean>

  // —— 同步状态（每仓库一行，从未同步的仓库无行） ——
  listSyncStates(): Promise<CodeHubSyncState[]>
  /** 记录一次失败：保留既有 last_synced_at，只更新 last_error */
  markSyncError(repoId: string, message: string): Promise<void>
}
