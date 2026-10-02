import { describe, expect, it, vi } from 'vitest'

import { createSysinfoProbes, type SysinfoBridgeDeps } from './sysinfo'

function throwingDeps(): SysinfoBridgeDeps {
  return {
    sysOverview: vi.fn(() => Promise.reject(new Error('违约异常'))),
    sysEnvVar: vi.fn(() => Promise.reject(new Error('违约异常'))),
    sysDisks: vi.fn(() => Promise.reject(new Error('违约异常'))),
    sysAdapters: vi.fn(() => Promise.reject(new Error('违约异常'))),
  }
}

describe('系统信息探测适配器', () => {
  it('正常路径：透传 Bridge 结果', async () => {
    const probes = createSysinfoProbes({
      sysOverview: () => Promise.resolve({ ok: true, data: { osName: 'Windows 11', osVersion: '23H2', arch: 'x86_64', hostname: 'h', username: 'u', dataRoot: 'D:\\x' } }),
      sysEnvVar: (name) => Promise.resolve(name === 'PATH' ? { ok: true, data: 'C:\\bin' } : { ok: true, data: null }),
      sysDisks: () => Promise.resolve({ ok: true, data: [{ letter: 'C', totalBytes: 1, freeBytes: 1 }] }),
      sysAdapters: () => Promise.resolve({ ok: true, data: [{ name: '以太网', enabled: true, ipv4: '10.0.0.2' }] }),
    })
    await expect(probes.probeOverview()).resolves.toMatchObject({ ok: true })
    await expect(probes.probeEnvVar('PATH')).resolves.toEqual({ ok: true, data: 'C:\\bin' })
    await expect(probes.probeEnvVar('MISSING')).resolves.toEqual({ ok: true, data: null })
    await expect(probes.probeDisks()).resolves.toMatchObject({ ok: true, data: [{ letter: 'C' }] })
    await expect(probes.probeAdapters()).resolves.toMatchObject({ ok: true, data: [{ ipv4: '10.0.0.2' }] })
  })

  it('Bridge 失败结果：原样透传（不吞 reason）', async () => {
    const probes = createSysinfoProbes({
      sysOverview: () => Promise.resolve({ ok: false, reason: '宿主调用失败' }),
      sysEnvVar: () => Promise.resolve({ ok: true, data: null }),
      sysDisks: () => Promise.resolve({ ok: false, reason: '磁盘探测失败', detail: 'E_IO' }),
      sysAdapters: () => Promise.resolve({ ok: true, data: [] }),
    })
    await expect(probes.probeOverview()).resolves.toEqual({ ok: false, reason: '宿主调用失败' })
    await expect(probes.probeDisks()).resolves.toEqual({ ok: false, reason: '磁盘探测失败', detail: 'E_IO' })
  })

  it('永不 reject：Bridge 实现违约抛错时折叠为失败结果（backstop）', async () => {
    const probes = createSysinfoProbes(throwingDeps())
    const overview = await probes.probeOverview()
    expect(overview.ok).toBe(false)
    if (!overview.ok) {
      expect(overview.reason).toContain('系统概要探测')
      expect(overview.detail).toBe('违约异常')
    }
    await expect(probes.probeEnvVar('X')).resolves.toMatchObject({ ok: false })
    await expect(probes.probeDisks()).resolves.toMatchObject({ ok: false })
    await expect(probes.probeAdapters()).resolves.toMatchObject({ ok: false })
  })
})
