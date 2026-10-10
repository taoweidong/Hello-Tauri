import { describe, expect, it } from 'vitest'

import { createMockUpdateClient } from './mock'

/**
 * [MOCK-UPDATE] 替身语义锁定（U-L）：浏览器调试的「假清单 + 假进度 + 成功但不重启」。
 * 这些语义是 npm run dev 全流程演示的依据，漂移会让 UI 调试失真。
 */
describe('createMockUpdateClient', () => {
  it('假清单 version 恒为当前 +0.0.1，平台项与进度字段齐备', async () => {
    const client = createMockUpdateClient({ currentVersion: '0.1.0', tickDelayMs: 0 })
    const manifest = await client.fetchRemote('http://mock.internal/latest.json')
    expect(manifest?.version).toBe('0.1.1')
    expect(manifest?.notes).toContain('MOCK-UPDATE')
    expect(manifest?.platforms['windows-x86_64']?.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('版本解析失败回退 9.9.9（保证「有新版本」分支总可达）', async () => {
    const client = createMockUpdateClient({ currentVersion: 'dev', tickDelayMs: 0 })
    const manifest = await client.fetchRemote('http://mock.internal/latest.json')
    expect(manifest?.version).toBe('9.9.9')
  })

  it('端点为空 → null（与「未配置不检查」语义一致）', async () => {
    const client = createMockUpdateClient({ currentVersion: '0.1.0' })
    await expect(client.fetchRemote('   ')).resolves.toBeNull()
  })

  it('download 推进进度至满额并返回与清单一致的 sha256', async () => {
    const seen: Array<{ received: number; total: number | null }> = []
    const client = createMockUpdateClient({ currentVersion: '0.1.0', totalBytes: 1000, tickDelayMs: 0 })
    const manifest = await client.fetchRemote('http://mock.internal/latest.json')
    const outcome = await client.download(manifest!, {
      endpoint: 'http://mock.internal/latest.json',
      onProgress: (p) => seen.push(p),
    })
    expect(seen.at(-1)).toEqual({ received: 1000, total: 1000 })
    expect(outcome).toEqual({ bytes: 1000, sha256: manifest!.platforms['windows-x86_64']!.sha256 })
  })

  it('stagedRelative：inbox 固定名；在线按版本命名', async () => {
    const client = createMockUpdateClient({ currentVersion: '0.1.0' })
    const manifest = (await client.fetchRemote('http://mock.internal/latest.json'))!
    expect(client.stagedRelative(manifest, 'inbox')).toBe('update/inbox/mock.exe')
    expect(client.stagedRelative(manifest, 'remote')).toBe('update/staging/app-0.1.1.exe')
  })

  it('fetchInbox 恒 null；apply 成功但不重启（浏览器演示终点）', async () => {
    const client = createMockUpdateClient({ currentVersion: '0.1.0', tickDelayMs: 0 })
    await expect(client.fetchInbox()).resolves.toBeNull()
    await expect(client.apply('update/inbox/mock.exe', 'a'.repeat(64))).resolves.toMatchObject({
      ok: true,
      step: null,
    })
  })

  it('failOn 注入故障：对应环节抛 UpdateError', async () => {
    const client = createMockUpdateClient({ currentVersion: '0.1.0', tickDelayMs: 0, failOn: 'download' })
    const manifest = (await client.fetchRemote('http://mock.internal/latest.json'))!
    await expect(client.download(manifest, { endpoint: 'x', onProgress: () => {} })).rejects.toMatchObject({
      step: 'download',
    })
  })
})
