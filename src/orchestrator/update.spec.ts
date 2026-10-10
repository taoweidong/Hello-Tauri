import { describe, expect, it, vi, beforeEach, type Mock } from 'vitest'

/**
 * 更新编排状态机测试（design-auto-update §12.3）：全状态路径、节流（注入时钟）、
 * sha 不符、apply 失败各 step 分档、auto/notify 分叉、摆渡 inbox、宽限期语义。
 * orchestrator/** 覆盖率基线 95/90/95/88 适用 —— 本文件是防回退主体。
 */
import { createUpdater, emptyStatus, type UpdaterDeps, type UpdatePersistedState } from './update'
import { UpdateError, type UpdateClient, type UpdateManifest } from '@/infra/update'

const SHA = 'a'.repeat(64)
const ENDPOINT = 'http://10.0.0.8/update/hello-tauri/latest.json'

function manifestOf(version: string): UpdateManifest {
  return {
    manifestVersion: 1,
    version,
    notes: `notes-${version}`,
    minVersion: null,
    platforms: { 'windows-x86_64': { url: `${ENDPOINT.replace('latest.json', '')}files/app.exe`, sha256: SHA } },
  }
}

interface Harness {
  updater: ReturnType<typeof createUpdater>
  client: {
    fetchRemote: Mock
    fetchInbox: Mock
    download: Mock
    apply: Mock
    stagedRelative: Mock
  }
  pauseServices: Mock
  notify: Mock
  loadState: Mock
  saveState: Mock
  settings: () => { enabled: boolean; mode: 'notify' | 'auto'; endpoint: string; checkIntervalHours: number }
  setSettings: (patch: Partial<{ enabled: boolean; mode: 'notify' | 'auto'; endpoint: string; checkIntervalHours: number }>) => void
  statuses: Array<Record<string, unknown>>
}

function createHarness(
  options: { currentVersion?: string; now?: () => number; startupDelayMs?: number } = {},
): Harness {
  const settings = { enabled: true, mode: 'notify' as const, endpoint: ENDPOINT, checkIntervalHours: 24 }
  const client = {
    fetchRemote: vi.fn(async () => manifestOf('9.9.9')),
    fetchInbox: vi.fn(async () => null),
    download: vi.fn(async (_m: UpdateManifest, opts: { onProgress: (p: { received: number; total: number | null }) => void }) => {
      opts.onProgress({ received: 50, total: 100 })
      opts.onProgress({ received: 100, total: 100 })
      return { bytes: 100, sha256: SHA }
    }),
    apply: vi.fn(async () => ({ ok: true, step: null, rolledBack: false, reason: null })),
    stagedRelative: vi.fn((m: UpdateManifest, source: string) =>
      source === 'inbox' ? 'update/inbox/app.exe' : `update/staging/app-${m.version}.exe`,
    ),
  }
  const pauseServices = vi.fn(async () => {})
  const notify = vi.fn()
  const loadState = vi.fn(async (): Promise<UpdatePersistedState | null> => null)
  const saveState = vi.fn(async () => {})
  const statuses: Array<Record<string, unknown>> = []
  const deps: UpdaterDeps = {
    client: client as unknown as UpdateClient,
    settings: () => ({ ...settings }),
    currentVersion: options.currentVersion ?? '0.1.0',
    pauseServices,
    loadState,
    saveState,
    notify,
    now: options.now,
    // 真实 setTimeout，但调度延迟全部归零：启动检查在微任务后即触发（测试轮询等待）
    startupDelayMs: options.startupDelayMs ?? 0,
    periodicIntervalMs: 10_000,
    applyGraceMs: 20,
  }
  const updater = createUpdater(deps)
  updater.onStatus((next) => statuses.push({ ...next }))
  return {
    updater,
    client,
    pauseServices,
    notify,
    loadState,
    saveState,
    settings: () => ({ ...settings }),
    setSettings: (patch) => Object.assign(settings, patch),
    statuses,
  }
}

/** 等待状态机到达目标状态（微任务轮询，不依赖 fake timers） */
async function waitFor(harness: Harness, predicate: (state: string) => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate(harness.updater.getStatus().state)) {
    if (Date.now() > deadline) throw new Error(`状态未到达：当前 ${harness.updater.getStatus().state}`)
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('checkNow：enabled/端点闸与节流', () => {
  it('未启用：不发起任何拉取，状态保持 idle', async () => {
    const h = createHarness()
    h.setSettings({ enabled: false })
    const status = await h.updater.checkNow('manual')
    expect(status.state).toBe('idle')
    expect(h.client.fetchRemote).not.toHaveBeenCalled()
  })

  it('启用但端点为空：在线检查跳过（摆渡扫描不受影响）', async () => {
    const h = createHarness()
    h.setSettings({ endpoint: '' })
    await h.updater.checkNow('manual')
    expect(h.client.fetchRemote).not.toHaveBeenCalled()
    // inbox 源只要求 enabled（§11.4）
    await h.updater.checkNow('inbox')
    expect(h.client.fetchInbox).toHaveBeenCalledTimes(1)
  })

  it('schedule 源受 checkIntervalHours 节流；manual 绕过节流', async () => {
    let clock = 1_000_000
    const h = createHarness({ now: () => clock })
    h.client.fetchRemote.mockResolvedValue(manifestOf('0.1.0')) // ≤ 当前 → up-to-date
    await h.updater.checkNow('startup')
    expect(h.client.fetchRemote).toHaveBeenCalledTimes(1)

    clock += 3600_000 // 1h < 24h：schedule 跳过
    await h.updater.checkNow('schedule')
    expect(h.client.fetchRemote).toHaveBeenCalledTimes(1)

    clock += 24 * 3600_000 // 到点：放行
    await h.updater.checkNow('schedule')
    expect(h.client.fetchRemote).toHaveBeenCalledTimes(2)

    await h.updater.checkNow('manual') // 手动始终绕过节流
    expect(h.client.fetchRemote).toHaveBeenCalledTimes(3)
  })

  it('startup 源同样节流（lastCheckAt 持久化恢复后）', async () => {
    const clock = 0
    const h = createHarness({ now: () => clock, startupDelayMs: 5 })
    h.loadState.mockResolvedValue({ lastCheckAt: new Date(0).toISOString(), lastVersionSeen: null })
    h.updater.init()
    await new Promise((resolve) => setTimeout(resolve, 30))
    // 恢复的 lastCheckAt 距今 0ms < 24h → 启动检查被节流跳过
    expect(h.client.fetchRemote).not.toHaveBeenCalled()
    h.updater.dispose()
  })

  it('无论成败都记 lastCheckAt（防故障服务器被高频重试打穿），失败保留 hint 记忆', async () => {
    const h = createHarness()
    h.client.fetchRemote.mockRejectedValueOnce(new UpdateError('network', '无法连接更新服务器'))
    await h.updater.checkNow('startup')
    expect(h.saveState).toHaveBeenCalledWith({ lastCheckAt: expect.any(String), lastVersionSeen: null })

    // 先见过新版本（hint 记忆建立），随后检查失败：lastVersionSeen 保留不清除
    h.client.fetchRemote.mockResolvedValueOnce(manifestOf('0.2.0'))
    await h.updater.checkNow('manual')
    expect(h.saveState).toHaveBeenLastCalledWith({ lastCheckAt: expect.any(String), lastVersionSeen: '0.2.0' })
    h.client.fetchRemote.mockRejectedValueOnce(new UpdateError('network', '又挂了'))
    await h.updater.checkNow('manual')
    expect(h.saveState).toHaveBeenLastCalledWith({ lastCheckAt: expect.any(String), lastVersionSeen: '0.2.0' })
  })
})

describe('checkNow：版本判定与状态迁移', () => {
  it('远端 > 当前 → available + latest 信息；保存 lastVersionSeen', async () => {
    const h = createHarness()
    h.client.fetchRemote.mockResolvedValue(manifestOf('0.2.0'))
    const status = await h.updater.checkNow('manual')
    expect(status.state).toBe('available')
    expect(status.latest).toMatchObject({ version: '0.2.0', notes: 'notes-0.2.0' })
    expect(h.saveState).toHaveBeenCalledWith({ lastCheckAt: expect.any(String), lastVersionSeen: '0.2.0' })
  })

  it('远端 = 当前 → up-to-date（不安装）', async () => {
    const h = createHarness()
    h.client.fetchRemote.mockResolvedValue(manifestOf('0.1.0'))
    expect((await h.updater.checkNow('manual')).state).toBe('up-to-date')
  })

  it('降级清单（远端 < 当前）→ up-to-date 静默跳过（U-H）且清除 hint', async () => {
    const h = createHarness()
    h.client.fetchRemote.mockResolvedValueOnce(manifestOf('0.2.0'))
    await h.updater.checkNow('manual')
    expect(h.updater.getStatus().state).toBe('available')
    h.client.fetchRemote.mockResolvedValueOnce(manifestOf('0.0.9'))
    expect((await h.updater.checkNow('manual')).state).toBe('up-to-date')
    expect(h.updater.getStatus().hintVersion).toBeNull()
  })

  it('404（null 清单）→ up-to-date（失败表 #2 放行）', async () => {
    const h = createHarness()
    h.client.fetchRemote.mockResolvedValue(null)
    expect((await h.updater.checkNow('manual')).state).toBe('up-to-date')
  })

  it('清单非法 → failed{step:manifest}；手动与后台同态（卡片可见，不弹窗）', async () => {
    const h = createHarness()
    h.client.fetchRemote.mockRejectedValue(new UpdateError('manifest', '更新源格式错误'))
    const status = await h.updater.checkNow('manual')
    expect(status.state).toBe('failed')
    expect(status.error).toEqual({ step: 'manifest', reason: '更新源格式错误' })
  })

  it('忙状态下忽略新触发（防双击/防调度与手动竞态）', async () => {
    const h = createHarness()
    let release!: (value: UpdateManifest | null) => void
    h.client.fetchRemote.mockImplementation(
      () => new Promise<UpdateManifest | null>((resolve) => (release = resolve)),
    )
    const first = h.updater.checkNow('manual')
    const second = await h.updater.checkNow('manual')
    expect(second.state).toBe('checking')
    release(manifestOf('0.2.0'))
    await first
    expect(h.updater.getStatus().state).toBe('available')
  })
})

describe('install / auto 模式（notify 默认）', () => {
  it('notify 模式：available 后停在原地，等人工 install', async () => {
    const h = createHarness()
    await h.updater.checkNow('manual')
    expect(h.updater.getStatus().state).toBe('available')
    expect(h.client.download).not.toHaveBeenCalled()
  })

  it('auto 模式：检查 → 下载 → ready → apply 全自动', async () => {
    const h = createHarness()
    h.setSettings({ mode: 'auto' })
    await h.updater.checkNow('manual')
    await waitFor(h, (state) => state === 'applying' || state === 'failed')
    expect(h.client.download).toHaveBeenCalledTimes(1)
    expect(h.client.apply).toHaveBeenCalledWith('update/staging/app-9.9.9.exe', SHA)
    expect(h.pauseServices).toHaveBeenCalledTimes(1)
  })

  it('手动 install：进度事件推进 → verifying → ready（下载路径）', async () => {
    const h = createHarness()
    await h.updater.checkNow('manual')
    const installPromise = h.updater.install()
    await vi.waitFor(() => expect(h.updater.getStatus().state).toBe('ready'))
    expect(h.updater.getStatus().progress).toBeNull()
    expect(h.client.download).toHaveBeenCalledTimes(1)
    await installPromise
    // notify 模式不自动 apply
    expect(h.client.apply).not.toHaveBeenCalled()
  })

  it('下载 sha 与清单不符 → failed{step:sha}（防御性双保险路径）', async () => {
    const h = createHarness()
    h.client.download.mockResolvedValue({ bytes: 100, sha256: 'b'.repeat(64) })
    await h.updater.checkNow('manual')
    await h.updater.install()
    expect(h.updater.getStatus().state).toBe('failed')
    expect(h.updater.getStatus().error?.step).toBe('sha')
    expect(h.client.apply).not.toHaveBeenCalled()
  })

  it('下载通道故障 → failed{step:download}，用户重试（failed 态允许再次 install）', async () => {
    const h = createHarness()
    h.client.download.mockRejectedValueOnce(new UpdateError('download', '下载失败：HTTP 500'))
    await h.updater.checkNow('manual')
    await h.updater.install()
    expect(h.updater.getStatus().state).toBe('failed')
    h.client.download.mockResolvedValue({ bytes: 100, sha256: SHA })
    await h.updater.install()
    expect(h.updater.getStatus().state).toBe('ready')
  })
})

describe('apply：pauseServices、宽限期与失败分档（§8）', () => {
  it('ready 态 install = 直接安装：apply 前调用 pauseServices（U-J）', async () => {
    const h = createHarness()
    await h.updater.checkNow('manual')
    await h.updater.install() // available → ready（notify 模式停住）
    expect(h.updater.getStatus().state).toBe('ready')
    await h.updater.install() // ready → 安装
    expect(h.pauseServices).toHaveBeenCalledTimes(1)
    expect(h.client.apply).toHaveBeenCalledWith('update/staging/app-9.9.9.exe', SHA)
    // mock 客户端 ok:true 但进程不退出 → 宽限后如实呈现（浏览器语义）
    expect(h.updater.getStatus().state).toBe('failed')
    expect(h.updater.getStatus().error?.reason).toContain('未自动重启')
  })

  it('宽限期内响应未达 → failed{step:apply}（进程存活且通道异常的病态场景）', async () => {
    const h = createHarness()
    h.setSettings({ mode: 'auto' })
    h.client.apply.mockImplementation(() => new Promise(() => {})) // 永不 settle
    await h.updater.checkNow('manual')
    await waitFor(h, (state) => state === 'failed')
    expect(h.updater.getStatus().error?.reason).toContain('自替换无响应')
  })

  it.each([
    ['rename_current', '被占用'],
    ['rename_staged', '已回滚'],
    ['probe', '请手动更新'],
    ['verify', '哈希与清单不符'],
  ])('apply 失败 step=%s → failed 透传 Rust 文案', async (step, reasonPart) => {
    const h = createHarness()
    h.client.apply.mockResolvedValue({ ok: false, step, rolledBack: step === 'rename_staged', reason: reasonPart })
    h.setSettings({ mode: 'auto' })
    await h.updater.checkNow('manual')
    await waitFor(h, (state) => state === 'failed')
    expect(h.updater.getStatus().error).toEqual({ step, reason: reasonPart })
    expect(h.notify).not.toHaveBeenCalled()
  })

  it('替换阶段失败（rename_current）后重试：staged 仍有效 → 直接 apply 不重下（失败表 #8）', async () => {
    const h = createHarness()
    h.setSettings({ mode: 'auto' })
    h.client.apply.mockResolvedValueOnce({
      ok: false,
      step: 'rename_current',
      rolledBack: false,
      reason: '当前程序文件被占用',
    })
    await h.updater.checkNow('manual')
    await waitFor(h, (state) => state === 'failed')

    h.client.apply.mockResolvedValueOnce({ ok: true, step: null, rolledBack: false, reason: null })
    const downloadCalls = h.client.download.mock.calls.length
    await h.updater.install()
    expect(h.client.download.mock.calls.length).toBe(downloadCalls)
    expect(h.client.apply).toHaveBeenCalledTimes(2)
  })

  it('下载/校验阶段失败（sha）后重试：重新下载（staged 已被删除）', async () => {
    const h = createHarness()
    h.setSettings({ mode: 'auto' })
    h.client.download.mockRejectedValueOnce(new UpdateError('sha', '下载内容校验失败，请重试'))
    await h.updater.checkNow('manual')
    await waitFor(h, (state) => state === 'failed')

    await h.updater.install()
    expect(h.client.download).toHaveBeenCalledTimes(2)
    expect(h.client.apply).toHaveBeenCalledTimes(1)
  })

  it('spawn 失败档（文件已是新版，不回滚）→ 发系统通知 + failed', async () => {
    const h = createHarness()
    h.setSettings({ mode: 'auto' })
    h.client.apply.mockResolvedValue({
      ok: false,
      step: 'spawn',
      rolledBack: false,
      reason: '已更新但自动重启失败: err，请手动双击启动',
    })
    await h.updater.checkNow('manual')
    await waitFor(h, (state) => state === 'failed')
    expect(h.notify).toHaveBeenCalledWith('更新完成', expect.stringContaining('手动双击启动'))
    expect(h.updater.getStatus().error?.step).toBe('spawn')
  })

  it('pauseServices 抛错不阻断替换（尽力而为，bootstrap 兜底）', async () => {
    const h = createHarness()
    h.pauseServices.mockRejectedValue(new Error('停服务失败'))
    h.setSettings({ mode: 'auto' })
    await h.updater.checkNow('manual')
    await waitFor(h, (state) => state === 'applying' || state === 'failed')
    expect(h.client.apply).toHaveBeenCalled()
  })
})

describe('摆渡 inbox（U-I：与在线同一管线）', () => {
  it('scanInbox 命中 → verifying → ready（跳过下载），notify 模式等人工安装', async () => {
    const h = createHarness()
    h.client.fetchInbox.mockResolvedValue(manifestOf('0.2.0'))
    await h.updater.scanInbox()
    expect(h.updater.getStatus().state).toBe('available')
    expect(h.client.download).not.toHaveBeenCalled() // 摆渡不下载
    await h.updater.install() // inbox：跳过下载 → ready
    expect(h.updater.getStatus().state).toBe('ready')
    expect(h.client.apply).not.toHaveBeenCalled()
    await h.updater.install() // ready → 安装
    expect(h.client.apply).toHaveBeenCalledWith('update/inbox/app.exe', SHA)
  })

  it('inbox 无清单 → up-to-date，不报错', async () => {
    const h = createHarness()
    await h.updater.scanInbox()
    expect(h.updater.getStatus().state).toBe('up-to-date')
  })

  it('auto 模式下摆渡命中直接安装（无人值守兜底通道）', async () => {
    const h = createHarness()
    h.setSettings({ mode: 'auto' })
    h.client.fetchRemote.mockResolvedValue(null) // 服务器暂无清单：不挡摆渡通道
    h.client.fetchInbox.mockResolvedValue(manifestOf('0.2.0'))
    h.updater.init()
    await waitFor(h, (state) => state === 'applying' || state === 'failed')
    expect(h.client.apply).toHaveBeenCalledWith('update/inbox/app.exe', SHA)
  })
})

describe('init：调度装配与跨重启提示', () => {
  it('启动延迟检查 + inbox 串行扫描（enabled 时）', async () => {
    const h = createHarness()
    h.updater.init()
    await waitFor(h, (state) => state !== 'idle' && state !== 'checking')
    expect(h.client.fetchRemote).toHaveBeenCalledTimes(1)
    // 在线检查完成后扫一次摆渡目录
    await vi.waitFor(() => expect(h.client.fetchInbox).toHaveBeenCalledTimes(1))
  })

  it('跨重启恢复 lastCheckAt 与 hintVersion（enabled 且远端版本 > 当前）', async () => {
    const h = createHarness({ startupDelayMs: 60_000 }) // 启动检查不在此测试窗口内触发
    h.loadState.mockResolvedValue({ lastCheckAt: '2026-10-10T00:00:00.000Z', lastVersionSeen: '0.9.0' })
    h.updater.init()
    await vi.waitFor(() => expect(h.updater.getStatus().hintVersion).toBe('0.9.0'))
    expect(h.updater.getStatus().lastCheckAt).toBe('2026-10-10T00:00:00.000Z')
    h.updater.dispose()
  })

  it('未启用时不恢复 hint（关闭更新的实例不出现小红点）', async () => {
    const h = createHarness({ startupDelayMs: 60_000 })
    h.setSettings({ enabled: false })
    h.loadState.mockResolvedValue({ lastCheckAt: '2026-10-10T00:00:00.000Z', lastVersionSeen: '0.9.0' })
    h.updater.init()
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(h.updater.getStatus().hintVersion).toBeNull()
    h.updater.dispose()
  })

  it('loadState 失败静默（状态文件损坏不影响主功能，检查链走完）', async () => {
    const h = createHarness()
    h.loadState.mockRejectedValue(new Error('fs broken'))
    h.updater.init()
    await vi.waitFor(() => expect(h.client.fetchInbox).toHaveBeenCalledTimes(1))
    // 启动检查（9.9.9 → available）→ inbox 扫描（null → up-to-date）：链路未被 restore 异常打断
    expect(h.updater.getStatus().state).toBe('up-to-date')
  })

  it('dispose 后调度停止', async () => {
    const h = createHarness()
    h.updater.dispose()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(h.client.fetchRemote).not.toHaveBeenCalled()
  })
})

describe('onStatus 监听', () => {
  it('状态每次迁移都推送快照；退订后不再推送', async () => {
    const h = createHarness()
    const seen: string[] = []
    const un = h.updater.onStatus((s) => seen.push(s.state))
    await h.updater.checkNow('manual')
    await h.updater.install()
    expect(seen).toContain('checking')
    expect(seen).toContain('downloading')
    expect(seen).toContain('verifying')
    expect(seen).toContain('ready')
    un()
    h.client.apply.mockResolvedValue({ ok: false, step: 'probe', rolledBack: false, reason: 'x' })
    await h.updater.install()
    expect(seen).not.toContain('applying')
  })
})

describe('emptyStatus', () => {
  it('初始状态为 idle 全空', () => {
    expect(emptyStatus()).toEqual({
      state: 'idle',
      latest: null,
      progress: null,
      error: null,
      lastCheckAt: null,
      hintVersion: null,
    })
  })
})
