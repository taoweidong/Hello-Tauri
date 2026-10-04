import { describe, expect, it } from 'vitest'

import { createMockCodeHubPort, MOCK_MRS, MOCK_MR_DETAILS, MOCK_REPOS } from './mock'

/**
 * CodeHub mock 端口契约测试（[MOCK-CLI]）。
 *
 * mock 是打桩期的「行为基准」：同步管线、快照仓储、UI 全部对着这份契约开发，
 * 真实 CLI 对接后用同款用例钉住适配器（welink 的端口夹具测试同款思路）。
 * 这里守的不变量：按仓库/状态过滤、limit 生效、未知资源 parse 故障、
 * 诊断通道永不 reject、确定性故障注入按次消费。
 */
describe('codehub mock 端口', () => {
  it('夹具覆盖三态且分布在多个仓库（检视页筛选的素材前提）', () => {
    expect(new Set(MOCK_MRS.map((record) => record.summary.state))).toEqual(new Set(['open', 'merged', 'closed']))
    expect(new Set(MOCK_MRS.map((record) => record.summary.repoId)).size).toBeGreaterThan(1)
    // 详情弃写路径的替身：至少一条记录 detail 为 null
    expect(MOCK_MRS.some((record) => record.detail === null)).toBe(true)
  })

  it('list 按仓库过滤，未知仓库返回空数组而不是报错', async () => {
    const port = createMockCodeHubPort()
    const { records: all } = await port.listMergeRequests(MOCK_REPOS[0])
    expect(all.length).toBeGreaterThan(0)
    expect(all.every((record) => record.summary.repoId === MOCK_REPOS[0])).toBe(true)
    await expect(port.listMergeRequests('no/such-repo')).resolves.toMatchObject({ records: [], degraded: false })
  })

  it('list 支持状态筛选与 limit 截断', async () => {
    const port = createMockCodeHubPort()
    const { records: open } = await port.listMergeRequests(MOCK_REPOS[0], { state: 'open' })
    expect(open.length).toBeGreaterThan(0)
    expect(open.every((record) => record.summary.state === 'open')).toBe(true)
    const { records: limited } = await port.listMergeRequests(MOCK_REPOS[0], { limit: 1 })
    expect(limited).toHaveLength(1)
  })

  it('详情：list 已带载荷的直接回；list 缺详情的走 view 侧夹具；未知 iid 才按 parse 故障抛出', async () => {
    const port = createMockCodeHubPort()
    const known = MOCK_MRS.find((record) => record.detail !== null)
    await expect(port.getMergeRequestDetail(known!.summary.repoId, known!.summary.mrIid)).resolves.toEqual(
      known!.detail,
    )
    // list 只给摘要、view 才回载荷 —— 这是「点开补拉」在浏览器模式下可演示的前提
    const omitted = MOCK_MRS.find((record) => record.detail === null)!
    await expect(port.getMergeRequestDetail(omitted.summary.repoId, omitted.summary.mrIid)).resolves.toEqual(
      MOCK_MR_DETAILS[`${omitted.summary.repoId}!${omitted.summary.mrIid}`],
    )
    await expect(port.getMergeRequestDetail(MOCK_REPOS[0], 'no-such')).rejects.toMatchObject({ kind: 'parse' })
  })

  it('verifyConnection 恒可用且不抛错（诊断语义）', async () => {
    const port = createMockCodeHubPort()
    await expect(port.verifyConnection()).resolves.toMatchObject({ ok: true })
  })

  it('确定性故障注入：transport / parse 按次消费，用尽后恢复正常', async () => {
    const port = createMockCodeHubPort({ transportFailures: 1, parseFailures: 1 })
    await expect(port.listMergeRequests(MOCK_REPOS[0])).rejects.toMatchObject({ kind: 'transport' })
    await expect(port.listMergeRequests(MOCK_REPOS[0])).rejects.toMatchObject({ kind: 'parse' })
    await expect(port.listMergeRequests(MOCK_REPOS[0])).resolves.toMatchObject({ degraded: false })
  })

  it('degraded 注入：接下来 N 次 list 标记「可能不完整」，用尽后恢复 false（降级条演示通道）', async () => {
    const port = createMockCodeHubPort({ degradedCount: 1 })
    await expect(port.listMergeRequests(MOCK_REPOS[0])).resolves.toMatchObject({ degraded: true })
    await expect(port.listMergeRequests(MOCK_REPOS[0])).resolves.toMatchObject({ degraded: false })
    port.injectDegraded(2)
    await expect(port.listMergeRequests(MOCK_REPOS[0])).resolves.toMatchObject({ degraded: true })
    // degraded 只影响 list 的完整性标志，记录本身照常完整返回（D5：完整元素照常入库）
    const { records } = await port.listMergeRequests(MOCK_REPOS[0])
    expect(records.length).toBeGreaterThan(0)
  })

  it('故障注入同样作用于详情与连通验证通道', async () => {
    const port = createMockCodeHubPort()
    port.injectTransportFailure(2)
    await expect(port.getMergeRequestDetail(MOCK_REPOS[0], '101')).rejects.toMatchObject({ kind: 'transport' })
    await expect(port.verifyConnection()).rejects.toMatchObject({ kind: 'transport' })
  })
})
