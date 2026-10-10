/**
 * [MOCK-UPDATE] 浏览器/dev 更新替身（U-L：`npm run dev` 下 UI 全流程可调）。
 *
 * 语义与桌面端一致（验签恒通过、sha 恒匹配、进度真实推进），仅三处刻意为演示服务：
 *  * 清单 version 恒为「当前 +0.0.1」，让「发现新版本」分支总是可达；
 *  * apply 返回成功但**进程不会真的退出** —— 编排层在宽限期后会给出
 *    「替换已发起但进程未退出」的诚实失败态（浏览器无进程可换，这是预期演示终点）；
 *  * fetchInbox 恒 null（浏览器无摆渡目录语义）。
 *
 * [MOCK-UPDATE] 对接真实环境后本文件保留为测试替身与浏览器调试数据源。
 */
import type { ApplyOutcome, DownloadOutcome } from '@/types'
import {
  pickPlatform,
  parseManifest,
  UpdateError,
  type DownloadOptions,
  type ManifestSource,
  type UpdateClient,
  type UpdateErrorStep,
  type UpdateManifest,
} from './client'

export interface MockUpdateOptions {
  /** 当前版本（假清单 = 此版本 +0.0.1） */
  currentVersion: string
  /** 模拟下载总量（进度条演示用），默认 4.5 MB 量级 */
  totalBytes?: number
  /** 进度刻度间隔（ms），默认 60 —— 全流程约 1.5s，肉眼可见又不拖沓 */
  tickDelayMs?: number
  /** 注入故障（演示/测试失败态用） */
  failOn?: UpdateErrorStep | null
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 当前版本 +0.0.1（patch 位进一；解析失败回退 9.9.9 保证「有新版本」） */
function nextVersion(current: string): string {
  const parts = current.split('.').map(Number)
  if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n) || n < 0)) return '9.9.9'
  return `${parts[0]}.${parts[1]}.${parts[2] + 1}`
}

export function createMockUpdateClient(options: MockUpdateOptions): UpdateClient {
  const totalBytes = options.totalBytes ?? 4_500_000
  const tickDelayMs = options.tickDelayMs ?? 60

  function failIf(step: UpdateErrorStep): void {
    if (options.failOn === step) {
      throw new UpdateError(step, `[MOCK-UPDATE] 注入的 ${step} 故障`)
    }
  }

  function fakeManifest(): UpdateManifest {
    const version = nextVersion(options.currentVersion)
    return parseManifest(
      JSON.stringify({
        manifestVersion: 1,
        version,
        notes: `[MOCK-UPDATE] 模拟新版本 ${version}：用于浏览器调试更新全流程`,
        pubDate: new Date().toISOString(),
        minVersion: null,
        platforms: {
          'windows-x86_64': {
            url: `http://mock.internal/update/hello-tauri/files/Hello-Tauri-${version}-x64-mock.exe`,
            sha256: 'f'.repeat(64),
            sizeBytes: totalBytes,
          },
        },
      }),
    )
  }

  return {
    async fetchRemote(endpoint: string): Promise<UpdateManifest | null> {
      if (!endpoint.trim()) return null
      failIf('network')
      await sleep(tickDelayMs)
      failIf('manifest')
      return fakeManifest()
    },

    async fetchInbox(): Promise<UpdateManifest | null> {
      return null // 浏览器无摆渡目录语义
    },

    async download(manifest: UpdateManifest, { onProgress }: DownloadOptions): Promise<DownloadOutcome> {
      failIf('verify')
      await sleep(tickDelayMs)
      failIf('download')
      const platform = pickPlatform(manifest)
      const steps = 20
      for (let i = 1; i <= steps; i += 1) {
        await sleep(tickDelayMs)
        onProgress({ received: Math.round((totalBytes * i) / steps), total: platform.sizeBytes ?? totalBytes })
      }
      failIf('sha')
      return { bytes: totalBytes, sha256: platform.sha256 }
    },

    stagedRelative(manifest: UpdateManifest, source: ManifestSource): string {
      if (source === 'inbox') return 'update/inbox/mock.exe'
      return `update/staging/app-${manifest.version}.exe`
    },

    async apply(_stagedRelative: string, _sha256: string): Promise<ApplyOutcome> {
      failIf('apply')
      await sleep(tickDelayMs)
      // 成功但不重启：进程退出由真实宿主完成，浏览器演示在此打住（见文件头注释）
      return { ok: true, step: null, rolledBack: false, reason: null }
    },
  }
}
