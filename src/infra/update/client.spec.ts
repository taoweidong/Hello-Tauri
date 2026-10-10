import { describe, expect, it, vi, type Mock } from 'vitest'

/**
 * 更新客户端契约测试（design-auto-update §12.3）：清单解析容错、端点前缀闸、
 * 验签编排、inbox 摆渡读取、下载/替换的 Bridge 透传与错误归档。
 * Bridge 用内存假件（不 mock 模块），断言「协议规则全在 client、Bridge 只搬运」。
 */
import {
  assertSameEndpoint,
  createHttpUpdateClient,
  parseManifest,
  pickPlatform,
  UpdateError,
  type UpdateManifest,
} from './client'
import type { ApplyOutcome, DownloadOutcome, VerifyOutcome } from '@/types'
import type { Bridge } from '@/api'

const VALID_SHA = 'a'.repeat(64)

function makeManifest(overrides: Partial<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    manifestVersion: 1,
    version: '0.2.0',
    notes: '更新说明',
    pubDate: '2026-10-11T00:00:00+08:00',
    minVersion: null,
    platforms: {
      'windows-x86_64': { url: 'http://10.0.0.8/update/hello-tauri/files/app-0.2.0.exe', sha256: VALID_SHA, sizeBytes: 1024 },
    },
    ...overrides,
  })
}

function makeBridge(overrides: Partial<Bridge> = {}): Bridge {
  const base = {
    platform: 'tauri' as const,
    httpGetText: vi.fn(async (url: string) => {
      if (url.endsWith('.minisig')) return { status: 200, body: 'untrusted comment: sig\nRWsig\ntrusted comment: t\nglobalsig==' }
      return { status: 200, body: makeManifest() }
    }),
    verifyMinisign: vi.fn(async (): Promise<VerifyOutcome> => ({ valid: true, reason: '' })),
    updateDownload: vi.fn(async (): Promise<DownloadOutcome> => ({ bytes: 1024, sha256: VALID_SHA })),
    updateApply: vi.fn(async (): Promise<ApplyOutcome> => ({ ok: true, step: null, rolledBack: false, reason: null })),
    onDownloadProgress: vi.fn(async () => () => {}),
    fsRead: vi.fn(async (relative: string) => (relative === 'update/inbox/latest.json' ? makeManifest() : null)),
  } as unknown as Bridge
  return { ...base, ...overrides }
}

describe('parseManifest（失败表 #3：格式/字段缺失拒绝）', () => {
  it('合法清单解析通过，windows-x86_64 平台项就位', () => {
    const manifest = parseManifest(makeManifest())
    expect(manifest.version).toBe('0.2.0')
    expect(manifest.notes).toBe('更新说明')
    const platform = pickPlatform(manifest)
    expect(platform.sha256).toBe(VALID_SHA)
    expect(platform.sizeBytes).toBe(1024)
  })

  it('JSON 非法 → UpdateError(manifest)', () => {
    expect(() => parseManifest('not-json{')).toThrow(UpdateError)
    expect(() => parseManifest('null')).toThrow(UpdateError)
  })

  it.each([
    ['manifestVersion 缺失', { manifestVersion: 2 }],
    ['version 非法', { version: 'v0.2' }],
    ['platforms 缺失', { platforms: undefined }],
    ['平台项缺失', { platforms: {} }],
    ['url 非法', { platforms: { 'windows-x86_64': { url: 'ftp://x', sha256: VALID_SHA } } }],
    ['sha256 非 64 位 hex', { platforms: { 'windows-x86_64': { url: 'http://x/a.exe', sha256: 'abc' } } }],
  ])('%s → 拒绝', (_name, overrides) => {
    expect(() => parseManifest(makeManifest(overrides))).toThrow(UpdateError)
  })

  it('notes 缺失容忍为空串；minVersion 非法容忍为 null（非阻断字段）', () => {
    const manifest = parseManifest(makeManifest({ notes: undefined, minVersion: 'bad' }))
    expect(manifest.notes).toBe('')
    expect(manifest.minVersion).toBeNull()
  })
})

describe('assertSameEndpoint（§5.3 基础闸③：同前缀）', () => {
  const endpoint = 'http://10.0.0.8/update/hello-tauri/latest.json'

  it('端点目录树内放行（files/ 子目录同根，§9.2 布局）', () => {
    expect(() => assertSameEndpoint(endpoint, 'http://10.0.0.8/update/hello-tauri/files/app.exe')).not.toThrow()
    expect(() => assertSameEndpoint(endpoint, 'http://10.0.0.8/update/hello-tauri/app.exe')).not.toThrow()
  })

  it('偏离端点目录/主机/协议 → 拒绝', () => {
    expect(() => assertSameEndpoint(endpoint, 'http://10.0.0.9/update/hello-tauri/files/app.exe')).toThrow(UpdateError)
    expect(() => assertSameEndpoint(endpoint, 'http://10.0.0.8/other/app.exe')).toThrow(UpdateError)
    expect(() => assertSameEndpoint(endpoint, 'https://10.0.0.8/update/hello-tauri/files/app.exe')).toThrow(UpdateError)
    expect(() => assertSameEndpoint(endpoint, 'file:///etc/passwd')).toThrow(UpdateError)
  })

  it('端点/文件 URL 无法解析 → 拒绝', () => {
    expect(() => assertSameEndpoint('not-a-url', 'http://x/a.exe')).toThrow(UpdateError)
    expect(() => assertSameEndpoint(endpoint, 'not-a-url')).toThrow(UpdateError)
  })
})

describe('createHttpUpdateClient：fetchRemote（§4.2 时序）', () => {
  it('清单 → 签名 → 验签 → 解析全链通过', async () => {
    const bridge = makeBridge()
    const client = createHttpUpdateClient(bridge)
    const manifest = await client.fetchRemote('http://10.0.0.8/update/hello-tauri/latest.json')
    expect(manifest?.version).toBe('0.2.0')
    // 验签消费的是清单**原文**（不重序列化）与钉死公钥
    expect(bridge.verifyMinisign as Mock).toHaveBeenCalledWith(
      makeManifest(),
      expect.stringContaining('untrusted comment'),
      expect.any(String),
    )
  })

  it('清单 404 → null（失败表 #2 放行为 up-to-date）', async () => {
    const bridge = makeBridge({
      httpGetText: vi.fn(async () => ({ status: 404, body: '' })),
    } as Partial<Bridge>)
    const client = createHttpUpdateClient(bridge)
    await expect(client.fetchRemote('http://x/latest.json')).resolves.toBeNull()
  })

  it('清单 500 → UpdateError(manifest)', async () => {
    const bridge = makeBridge({
      httpGetText: vi.fn(async () => ({ status: 500, body: 'oops' })),
    } as Partial<Bridge>)
    const client = createHttpUpdateClient(bridge)
    await expect(client.fetchRemote('http://x/latest.json')).rejects.toMatchObject({ step: 'manifest' })
  })

  it('签名文件 404 → UpdateError(verify)（失败表 #4：签名缺失拒绝）', async () => {
    const bridge = makeBridge({
      httpGetText: vi.fn(async (url: string) =>
        url.endsWith('.minisig') ? { status: 404, body: '' } : { status: 200, body: makeManifest() },
      ),
    } as Partial<Bridge>)
    const client = createHttpUpdateClient(bridge)
    await expect(client.fetchRemote('http://x/latest.json')).rejects.toMatchObject({ step: 'verify' })
  })

  it('验签不通过 → UpdateError(verify)，不进入解析（失败表 #4：唯一安全类文案）', async () => {
    const bridge = makeBridge({
      verifyMinisign: vi.fn(async () => ({ valid: false, reason: 'The signature verification failed' })),
    } as Partial<Bridge>)
    const client = createHttpUpdateClient(bridge)
    await expect(client.fetchRemote('http://x/latest.json')).rejects.toThrow(/清单签名无效/)
  })

  it('传输层故障 → UpdateError(network)', async () => {
    const bridge = makeBridge({
      httpGetText: vi.fn(async () => {
        throw new Error('HTTP 连接失败：connection refused')
      }),
    } as Partial<Bridge>)
    const client = createHttpUpdateClient(bridge)
    await expect(client.fetchRemote('http://x/latest.json')).rejects.toMatchObject({ step: 'network' })
  })
})

describe('createHttpUpdateClient：fetchInbox（U-I 摆渡共用管线）', () => {
  it('inbox 有清单 + 签名 → 同一验签/解析管线', async () => {
    const bridge = makeBridge({
      fsRead: vi.fn(async (relative: string) =>
        relative === 'update/inbox/latest.json'
          ? makeManifest()
          : relative === 'update/inbox/latest.json.minisig'
            ? 'untrusted comment: sig'
            : null,
      ),
    } as Partial<Bridge>)
    const client = createHttpUpdateClient(bridge)
    const manifest = await client.fetchInbox()
    expect(manifest?.version).toBe('0.2.0')
    expect(bridge.verifyMinisign as Mock).toHaveBeenCalled()
  })

  it('无清单 → null；有清单无签名 → UpdateError(verify)', async () => {
    const none = createHttpUpdateClient(makeBridge({ fsRead: vi.fn(async () => null) } as Partial<Bridge>))
    await expect(none.fetchInbox()).resolves.toBeNull()

    const noSig = createHttpUpdateClient(
      makeBridge({ fsRead: vi.fn(async (relative: string) => (relative.endsWith('.minisig') ? null : makeManifest())) } as Partial<Bridge>),
    )
    await expect(noSig.fetchInbox()).rejects.toMatchObject({ step: 'verify' })
  })

  it('fsRead 抛错（浏览器语义）→ 视为无摆渡清单', async () => {
    const client = createHttpUpdateClient(
      makeBridge({ fsRead: vi.fn(async () => { throw new Error('浏览器调试模式不支持读取本地文件') }) } as Partial<Bridge>),
    )
    await expect(client.fetchInbox()).resolves.toBeNull()
  })
})

describe('createHttpUpdateClient：download / stagedRelative / apply', () => {
  const manifest: UpdateManifest = parseManifest(makeManifest())
  const endpoint = 'http://10.0.0.8/update/hello-tauri/latest.json'

  it('下载透传 expected sha256 与 staging 目标；进度事件转发后退订', async () => {
    const onProgress = vi.fn()
    const unlisten = vi.fn()
    const bridge = makeBridge({
      onDownloadProgress: vi.fn(async () => unlisten),
      updateDownload: vi.fn(async () => ({ bytes: 1024, sha256: VALID_SHA })),
    } as Partial<Bridge>)
    const client = createHttpUpdateClient(bridge)
    const outcome = await client.download(manifest, { endpoint, onProgress })
    expect(outcome.sha256).toBe(VALID_SHA)
    expect(bridge.updateDownload as Mock).toHaveBeenCalledWith(
      'http://10.0.0.8/update/hello-tauri/files/app-0.2.0.exe',
      'update/staging/app-0.2.0.exe',
      undefined,
      VALID_SHA,
    )
    expect(unlisten).toHaveBeenCalled()
  })

  it('下载 URL 偏离端点目录 → 前缀闸拒绝，不发起下载', async () => {
    const evil: UpdateManifest = parseManifest(
      makeManifest({ platforms: { 'windows-x86_64': { url: 'http://evil.internal/app.exe', sha256: VALID_SHA } } }),
    )
    const bridge = makeBridge()
    const client = createHttpUpdateClient(bridge)
    await expect(client.download(evil, { endpoint, onProgress: () => {} })).rejects.toMatchObject({
      step: 'manifest',
    })
    expect(bridge.updateDownload).not.toHaveBeenCalled()
  })

  it('sha 校验失败文案归档为 UpdateError(sha)（失败表 #6）', async () => {
    const bridge = makeBridge({
      updateDownload: vi.fn(async () => {
        throw new Error('下载内容校验失败，请重试')
      }),
    } as Partial<Bridge>)
    const client = createHttpUpdateClient(bridge)
    await expect(client.download(manifest, { endpoint, onProgress: () => {} })).rejects.toMatchObject({ step: 'sha' })
  })

  it('stagedRelative：在线=staging 固定名；摆渡=inbox 内清单文件名；非法文件名拒绝', () => {
    const client = createHttpUpdateClient(makeBridge())
    expect(client.stagedRelative(manifest, 'remote')).toBe('update/staging/app-0.2.0.exe')
    expect(client.stagedRelative(manifest, 'inbox')).toBe('update/inbox/app-0.2.0.exe')
    // URL 规范化会折叠字面 ../，路径注入以编码形态出现 —— basename 校验必须拦下
    const evil = parseManifest(
      makeManifest({ platforms: { 'windows-x86_64': { url: 'http://x/..%2F..%2Fevil.exe', sha256: VALID_SHA } } }),
    )
    expect(() => client.stagedRelative(evil, 'inbox')).toThrow(UpdateError)
  })

  it('apply 透传 staged 路径与 sha（Rust 侧复核哈希）；通道故障折叠为 UpdateError(apply)', async () => {
    const bridge = makeBridge()
    const client = createHttpUpdateClient(bridge)
    await client.apply('update/staging/app-0.2.0.exe', VALID_SHA)
    expect(bridge.updateApply as Mock).toHaveBeenCalledWith('update/staging/app-0.2.0.exe', VALID_SHA)

    const broken = createHttpUpdateClient(
      makeBridge({
        updateApply: vi.fn(async () => {
          throw new Error('通道坏了')
        }),
      } as Partial<Bridge>),
    )
    await expect(broken.apply('x', VALID_SHA)).rejects.toMatchObject({ step: 'apply' })
  })
})
