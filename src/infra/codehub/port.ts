/**
 * CodeHub 端口 —— 业务层依赖的「外部世界形状」（与 `infra/welink/port.ts` 同构）。
 *
 * 这份接口是整条链路的**变化点边界**：真实 codehub-cli 契约到手后，只替换
 * `codehub-cli.ts` + `exec.ts`，业务层零改动（打桩先行，见 change design D3）。
 *
 * 三个方法的契约要点：
 *  * `listMergeRequests` 返回 `{ records, degraded }`：每条记录是「列表字段 + 可缺省
 *    详情」（`CodeHubMrRecord`），list 一次拉全量字段（[CLI-ASSUME]），避免逐条
 *    `mr view` 的 N+1 子进程开销；详情缺失（字段缺失/输出截断）时 `detail=null`，
 *    同步侧弃写详情列、UI 走单条补拉；`degraded` 表示输出触到截断上限、本轮可能少
 *    了几条（design D5 的降级信号，必须让上层看得见）；
 *  * `getMergeRequestDetail` 恒返回非空详情：单条补拉的语义就是「要详情」，拿不到
 *    属于 parse 故障；
 *  * `verifyConnection` **永不 reject**：它是诊断通道，职责就是把失败原因带回来；
 *    其余两个方法按 `CodeHubError` 分类抛出。
 */
import type { CodeHubMergeRequestDetail, CodeHubMrRecord, CodeHubMrState } from '@/types/codehub'

export interface CodeHubListOptions {
  state?: CodeHubMrState
  /** 本批上限（端口实现内部还会钳到 `CODEHUB_MAX_BATCH`） */
  limit?: number
}

/**
 * 一次列表拉取的结果。
 *
 * `degraded` = 宿主子进程输出触到截断上限（2MB），本轮记录**可能不完整**（残缺的
 * 最后一个元素已被丢弃）。它是 design D5 的降级信号：编排层据此在同步摘要里告警，
 * 而不是让「少了几条」静默变成一次成功快照。
 */
export interface CodeHubListResult {
  records: CodeHubMrRecord[]
  degraded: boolean
}

export interface CodeHubVerifyResult {
  ok: boolean
  /** 可用性说明（含失败原因），供配置页直接展示 */
  detail: string
}

export interface CodeHubPort {
  listMergeRequests(repoId: string, options?: CodeHubListOptions): Promise<CodeHubListResult>
  getMergeRequestDetail(repoId: string, mrIid: string): Promise<CodeHubMergeRequestDetail>
  verifyConnection(): Promise<CodeHubVerifyResult>
}

/**
 * 端口错误分类（语义与 `WelinkError` 一致）——管线对三类的处理完全不同：
 *  * `transport` —— 值得重试（进程起不来/超时/通道故障）；
 *  * `parse` —— 重试无用（输出结构不符、JSON 解析失败、CLI 自身报错）；
 *  * `auth` —— 需要用户介入（token 缺失/失效），退避无意义，UI 应引导到配置页。
 */
export class CodeHubError extends Error {
  constructor(
    message: string,
    readonly kind: 'transport' | 'parse' | 'auth' | 'unknown' = 'unknown',
    override readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'CodeHubError'
  }
}
