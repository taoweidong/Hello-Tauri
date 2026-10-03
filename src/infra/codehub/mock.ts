/**
 * CodeHub 端口 Mock。
 *
 * [MOCK-CLI] 本文件是 codehub-cli 能力的**模拟替身**（真实 CLI 就绪前后都保留：
 * 单测替身 + 浏览器调试数据源，与 infra/welink/mock.ts 同定位）。与真实行为的
 * 差异清单，对接时逐项核对：
 *  * 仓库/MR 全部为固定夹具（repoId、作者、分支均虚构）；
 *  * verifyConnection 恒可用（真实 CLI 受 token/网络影响）；
 *  * 无游标/增量语义：list 每次返回全量夹具（同步幂等由快照覆盖写保证，行为等价）；
 *  * list 只给摘要、详情由 view 单查（这条分工同时是 [CLI-ASSUME]，核实前 mock 两侧
 *  * 夹具分开维护，见 MOCK_MR_DETAILS）；
 *  * 确定性故障注入（transport/parse 计数）是测试专用通道，真实 CLI 无此概念。
 *
 * 打桩期的核心目的：**在真实 codehub-cli 契约未核实时，把 UI/同步管线/快照行为
 * 全部锁定并可演示**（change design D3「打桩先行」）。
 */
import type { CodeHubComment, CodeHubMergeRequestDetail, CodeHubMrRecord, CodeHubReviewSummary } from '@/types/codehub'
import {
  CodeHubError,
  type CodeHubListOptions,
  type CodeHubListResult,
  type CodeHubPort,
  type CodeHubVerifyResult,
} from './port'

/** mock 仓库夹具（repoId 采用「空间/仓库」路径形态，虚构） */
export const MOCK_REPOS = ['demo/platform-gateway', 'demo/hello-tauri', 'demo/data-tools'] as const

function review(reviewers: string[], approvals: number, unresolved: number, lastActivityAt = ''): CodeHubReviewSummary {
  return { reviewers, approvals, unresolved, lastActivityAt }
}

function comment(author: string, body: string, createdAt: string): CodeHubComment {
  return { author, body, createdAt }
}

/**
 * mock MR 夹具：三仓库 × 三状态全覆盖，其中一条 `detail: null`
 * （详情弃写路径的替身）。iid/title/state 缺失不属于 mock 的职责——那是
 * CLI 适配器 parse 故障测试的领地（见 `codehub-cli.spec.ts`）。
 */
export const MOCK_MRS: CodeHubMrRecord[] = [
  {
    summary: {
      repoId: 'demo/platform-gateway',
      mrIid: '101',
      title: 'feat: 网关限流开关',
      state: 'open',
      author: 'alice',
      sourceBranch: 'feat/rate-limit',
      targetBranch: 'main',
      updatedAt: '2026-10-02T10:00:00+08:00',
      webUrl: 'https://codehub.demo.local/platform-gateway/-/merge_requests/101',
      review: review(['bob', 'carol'], 1, 2, '2026-10-02T11:00:00+08:00'),
    },
    detail: {
      description: '为网关增加每秒限流开关，默认关闭。',
      comments: [
        comment('bob', '限流阈值建议放配置中心。', '2026-10-02T10:30:00+08:00'),
        comment('alice', '已改为读取配置中心。', '2026-10-02T11:00:00+08:00'),
      ],
    },
  },
  {
    summary: {
      repoId: 'demo/platform-gateway',
      mrIid: '99',
      title: 'fix: 健康检查超时',
      state: 'merged',
      author: 'bob',
      sourceBranch: 'fix/health-timeout',
      targetBranch: 'main',
      updatedAt: '2026-09-30T09:00:00+08:00',
      webUrl: 'https://codehub.demo.local/platform-gateway/-/merge_requests/99',
      review: review(['alice'], 2, 0, '2026-09-30T08:40:00+08:00'),
    },
    detail: {
      description: '健康检查探针超时从 1s 调到 3s。',
      comments: [comment('alice', 'LGTM', '2026-09-30T08:40:00+08:00')],
    },
  },
  {
    summary: {
      repoId: 'demo/platform-gateway',
      mrIid: '97',
      title: 'chore: 升级依赖',
      state: 'closed',
      author: 'carol',
      sourceBranch: 'chore/deps',
      targetBranch: 'main',
      updatedAt: '2026-09-28T16:00:00+08:00',
      webUrl: 'https://codehub.demo.local/platform-gateway/-/merge_requests/97',
      review: review([], 0, 3, '2026-09-28T15:00:00+08:00'),
    },
    detail: {
      description: '例行依赖升级，与发布冲突被关闭。',
      comments: [],
    },
  },
  {
    summary: {
      repoId: 'demo/hello-tauri',
      mrIid: '42',
      title: 'feat: 工作台首页卡片',
      state: 'open',
      author: 'taowd',
      sourceBranch: 'feat/workbench-home',
      targetBranch: 'main',
      updatedAt: '2026-10-03T09:30:00+08:00',
      webUrl: 'https://codehub.demo.local/hello-tauri/-/merge_requests/42',
      review: review(['alice'], 0, 1, '2026-10-03T10:00:00+08:00'),
    },
    detail: {
      description: '概览页升级为工作台首页：域卡片聚合。',
      comments: [comment('alice', '卡片布局请对齐设计稿间距。', '2026-10-03T10:00:00+08:00')],
    },
  },
  {
    summary: {
      repoId: 'demo/hello-tauri',
      mrIid: '40',
      title: 'docs: 打包指引更新',
      state: 'merged',
      author: 'alice',
      sourceBranch: 'docs/pack-guide',
      targetBranch: 'main',
      updatedAt: '2026-10-01T14:00:00+08:00',
      webUrl: 'https://codehub.demo.local/hello-tauri/-/merge_requests/40',
      review: review(['taowd'], 1, 0),
    },
    detail: null,
  },
  {
    summary: {
      repoId: 'demo/hello-tauri',
      mrIid: '38',
      title: 'refactor: 轮询器抽离',
      state: 'closed',
      author: 'bob',
      sourceBranch: 'refactor/poller',
      targetBranch: 'main',
      updatedAt: '2026-09-26T11:00:00+08:00',
      webUrl: 'https://codehub.demo.local/hello-tauri/-/merge_requests/38',
      review: review(['carol'], 0, 2, '2026-09-26T10:30:00+08:00'),
    },
    detail: {
      description: '方向调整：轮询器并入 timers，先关闭。',
      comments: [],
    },
  },
  {
    summary: {
      repoId: 'demo/data-tools',
      mrIid: '7',
      title: 'feat: 导出 Excel 模板',
      state: 'open',
      author: 'carol',
      sourceBranch: 'feat/export-xlsx',
      targetBranch: 'main',
      updatedAt: '2026-10-02T18:00:00+08:00',
      webUrl: 'https://codehub.demo.local/data-tools/-/merge_requests/7',
      review: review(['alice', 'bob'], 2, 0, '2026-10-02T17:30:00+08:00'),
    },
    detail: {
      description: '数据导出模板与列校验。',
      comments: [comment('bob', '模板列顺序以表格页为准。', '2026-10-02T17:30:00+08:00')],
    },
  },
]

/**
 * `mr view` 侧的详情夹具：list 里 `detail: null` 的那条在这里有完整载荷。
 *
 * 真实 CLI 同款分工（list 只给摘要列，view 才回 description/comments），所以
 * 「点开补拉」必须能拿到东西 —— 否则浏览器模式下这条路径永远演示不了。
 */
export const MOCK_MR_DETAILS: Record<string, CodeHubMergeRequestDetail> = {
  'demo/hello-tauri!40': {
    description: '打包指引补充离线依赖清单与迁移步骤。',
    comments: [comment('taowd', '离线清单一节已与 pack 脚本的校验项对齐。', '2026-10-01T15:20:00+08:00')],
  },
}

export interface MockCodeHubOptions {
  /** 每次调用的模拟延迟（毫秒），默认 0 */
  latencyMs?: number
  /** 确定性故障注入基数：接下来 N 次调用抛 transport */
  transportFailures?: number
  /** 确定性故障注入基数：接下来 N 次调用抛 parse */
  parseFailures?: number
}

export interface MockCodeHubPort extends CodeHubPort {
  /** 测试注入：模拟 CLI 不可用/超时 */
  injectTransportFailure(count?: number): void
  /** 测试注入：模拟输出不可解析 */
  injectParseFailure(count?: number): void
}

export function createMockCodeHubPort(options: MockCodeHubOptions = {}): MockCodeHubPort {
  let transportFailures = options.transportFailures ?? 0
  let parseFailures = options.parseFailures ?? 0
  const latencyMs = options.latencyMs ?? 0

  const maybeFail = (): void => {
    if (transportFailures > 0) {
      transportFailures -= 1
      throw new CodeHubError('[MOCK-CLI] 注入的传输故障', 'transport')
    }
    if (parseFailures > 0) {
      parseFailures -= 1
      throw new CodeHubError('[MOCK-CLI] 注入的解析故障', 'parse')
    }
  }
  const delay = (): Promise<void> =>
    latencyMs ? new Promise((resolve) => setTimeout(resolve, latencyMs)) : Promise.resolve()

  return {
    async listMergeRequests(repoId: string, listOptions: CodeHubListOptions = {}): Promise<CodeHubListResult> {
      maybeFail()
      await delay()
      const limit = Math.max(1, listOptions.limit ?? MOCK_MRS.length)
      // 模拟数据源不存在宿主输出截断，degraded 恒 false（降级语义由真实适配器与编排层测）
      return {
        records: MOCK_MRS.filter(
          (record) =>
            record.summary.repoId === repoId && (!listOptions.state || record.summary.state === listOptions.state),
        ).slice(0, limit),
        degraded: false,
      }
    },

    async getMergeRequestDetail(repoId: string, mrIid: string): Promise<CodeHubMergeRequestDetail> {
      maybeFail()
      await delay()
      const record = MOCK_MRS.find((item) => item.summary.repoId === repoId && item.summary.mrIid === mrIid)
      // list 侧缺详情的夹具回落 view 侧夹具：真实 CLI 的 `mr view` 载荷比 list 更全
      const detail = record?.detail ?? MOCK_MR_DETAILS[`${repoId}!${mrIid}`]
      if (!detail) throw new CodeHubError(`MR 不存在或无详情：${repoId}!${mrIid}`, 'parse')
      return detail
    },

    async verifyConnection(): Promise<CodeHubVerifyResult> {
      maybeFail()
      await delay()
      return { ok: true, detail: '[MOCK-CLI] 连接正常（模拟数据源）' }
    },

    injectTransportFailure(count = 1) {
      transportFailures += count
    },
    injectParseFailure(count = 1) {
      parseFailures += count
    },
  }
}
