/**
 * 更新清单协议与端点校验（design-auto-update §9.1/§11.3）—— 更新域的唯一真实适配器。
 *
 * 业务规则落点（Rust 零规则边界的另一半）：清单协议解析、字段校验、验签编排、
 * 下载 URL 与配置端点的同前缀闸（§5.3 基础闸③）全在这里；Bridge/Rust 只做
 * 字节搬运。摆渡 inbox 与在线模式共用验签/解析/换位管线（U-I），仅清单来源不同。
 *
 * [UPD-ASSUME] 清单契约（§9.1，对接服务器时逐项核对）：
 *  * `<endpoint>` → latest.json 原文字节；`<endpoint>.minisig` → armored minisign 文本
 *    （**不是** tauri signer 的 base64 包裹形态——发布脚本负责解码一层）；
 *  * 验签对象 = 清单的完整原文（不做 JSON 重序列化，避免规范化歧义）；
 *  * 404/204 = 暂无更新清单（放行为 up-to-date，失败表 #2）；
 *  * platforms 键 `windows-x86_64`（对齐官方插件命名，为回迁官方生态留口）。
 */
import { isStrictSemVer } from '@/utils/semver'
import type { Bridge } from '@/api'
import type { ApplyOutcome, DownloadOutcome, DownloadProgress } from '@/types'
import { UPDATE_PUBLIC_KEY } from './key'

/** 更新域错误：step 对应状态机失败分档（§4.3/§8） */
export type UpdateErrorStep = 'network' | 'manifest' | 'verify' | 'download' | 'sha' | 'apply'

export class UpdateError extends Error {
  constructor(
    readonly step: UpdateErrorStep,
    message: string,
  ) {
    super(message)
    this.name = 'UpdateError'
  }
}

export interface ManifestPlatform {
  url: string
  sha256: string
  sizeBytes?: number
}

export interface UpdateManifest {
  manifestVersion: number
  version: string
  notes: string
  pubDate?: string
  minVersion?: string | null
  platforms: { 'windows-x86_64'?: ManifestPlatform }
}

/** 清单来源（决定 staged 路径与触发闸） */
export type ManifestSource = 'remote' | 'inbox'

export interface DownloadOptions {
  /** 配置端点（同前缀闸的基准） */
  endpoint: string
  onProgress: (progress: DownloadProgress) => void
}

export interface UpdateClient {
  /** 在线拉取：GET 清单 + GET .minisig + 验签 + 解析。无清单（404/204）返回 null */
  fetchRemote(endpoint: string): Promise<UpdateManifest | null>
  /** 摆渡：fsRead inbox 两文本 + 同一验签管线。无清单（文件不存在）返回 null */
  fetchInbox(): Promise<UpdateManifest | null>
  /** 全量下载到 staging；进度经 onProgress 直推（事件订阅封装在实现内） */
  download(manifest: UpdateManifest, options: DownloadOptions): Promise<DownloadOutcome>
  /** staged 落地相对路径（在线=staging 固定名；摆渡=inbox 内清单声明的文件名） */
  stagedRelative(manifest: UpdateManifest, source: ManifestSource): string
  /** 自替换（Bridge 永不 reject；通道故障折叠为 UpdateError('apply')） */
  apply(stagedRelative: string, sha256: string): Promise<ApplyOutcome>
}

/** 平台项挑选（仅 windows-x86_64；清单协议刻意对齐官方插件形态） */
export function pickPlatform(manifest: UpdateManifest): ManifestPlatform {
  const platform = manifest.platforms['windows-x86_64']
  if (!platform) throw new UpdateError('manifest', '清单缺少 windows-x86_64 平台项')
  return platform
}

/**
 * 下载 URL 与配置端点「同前缀」闸（§5.3 基础闸③；assertAllowedHost 同款先例）。
 * 前缀语义 = 端点 URL 的**目录**（latest.json 所在目录树）——服务器布局中
 * files/ 子目录与清单同根（§9.2），文件必须落在同一目录树下，防清单被换成任意外部地址。
 * （签名已保证清单不可伪造，本闸是纵深一层，属基础防护而非加固。）
 */
export function assertSameEndpoint(endpoint: string, fileUrl: string): void {
  let base: URL
  let file: URL
  try {
    base = new URL(endpoint)
    file = new URL(fileUrl)
  } catch {
    throw new UpdateError('manifest', '更新地址无法解析')
  }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    throw new UpdateError('manifest', '更新端点只允许 http/https')
  }
  if (file.protocol !== base.protocol) {
    throw new UpdateError('manifest', '下载地址协议与更新端点不一致')
  }
  const prefix = `${base.origin}${base.pathname.replace(/[^/]*$/, '')}`
  if (!`${file.origin}${file.pathname}`.startsWith(prefix)) {
    throw new UpdateError('manifest', '下载地址偏离更新服务器目录，已拒绝')
  }
}

/** 清单解析与字段校验（失败表 #3：JSON 非法/字段缺失 → 拒绝） */
export function parseManifest(raw: string): UpdateManifest {
  let payload: unknown
  try {
    payload = JSON.parse(raw)
  } catch {
    throw new UpdateError('manifest', '更新源格式错误（不是合法 JSON）')
  }
  if (!payload || typeof payload !== 'object') {
    throw new UpdateError('manifest', '更新源格式错误')
  }
  const obj = payload as Record<string, unknown>
  if (obj.manifestVersion !== 1) {
    throw new UpdateError('manifest', '不支持的清单版本（manifestVersion）')
  }
  const version = typeof obj.version === 'string' ? obj.version.trim() : ''
  if (!isStrictSemVer(version)) {
    throw new UpdateError('manifest', '清单版本号不是合法的 x.y.z')
  }
  const platformsRaw = obj.platforms
  if (!platformsRaw || typeof platformsRaw !== 'object') {
    throw new UpdateError('manifest', '清单缺少 platforms 字段')
  }
  const entry = (platformsRaw as Record<string, unknown>)['windows-x86_64']
  if (!entry || typeof entry !== 'object') {
    throw new UpdateError('manifest', '清单缺少 windows-x86_64 平台项')
  }
  const item = entry as Record<string, unknown>
  const url = typeof item.url === 'string' ? item.url.trim() : ''
  const sha256 = typeof item.sha256 === 'string' ? item.sha256.trim().toLowerCase() : ''
  if (!/^https?:\/\//i.test(url)) {
    throw new UpdateError('manifest', '清单下载地址不是 http/https URL')
  }
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    throw new UpdateError('manifest', '清单 sha256 不是 64 位十六进制')
  }
  const sizeBytes =
    typeof item.sizeBytes === 'number' && Number.isFinite(item.sizeBytes) && item.sizeBytes > 0
      ? item.sizeBytes
      : undefined
  const minVersion = typeof obj.minVersion === 'string' && isStrictSemVer(obj.minVersion) ? obj.minVersion : null
  return {
    manifestVersion: 1,
    version,
    notes: typeof obj.notes === 'string' ? obj.notes : '',
    pubDate: typeof obj.pubDate === 'string' ? obj.pubDate : undefined,
    minVersion,
    platforms: { 'windows-x86_64': { url, sha256, sizeBytes } },
  }
}

/** 清单 GET 的统一包装：状态码判定（404/204=无清单）+ 传输故障归 network */
async function fetchText(bridge: Bridge, url: string, timeoutMs: number): Promise<string | null> {
  let outcome: { status: number; body: string }
  try {
    outcome = await bridge.httpGetText(url, {}, timeoutMs)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new UpdateError('network', `无法连接更新服务器（${detail}）`)
  }
  if (outcome.status === 404 || outcome.status === 204) return null
  if (outcome.status < 200 || outcome.status >= 300) {
    throw new UpdateError('manifest', `更新源返回 HTTP ${outcome.status}`)
  }
  return outcome.body
}

/** 桌面真实现：清单/签名经宿主 GET 通道，下载经宿主流式通道 */
export function createHttpUpdateClient(bridge: Bridge): UpdateClient {
  /** 清单为小文本，超时取连接失败可感知的下限（10s，够内网最慢的静态服务器） */
  const MANIFEST_TIMEOUT_MS = 10_000

  async function verifyManifest(raw: string, signature: string): Promise<void> {
    const outcome = await bridge.verifyMinisign(raw, signature, UPDATE_PUBLIC_KEY)
    if (!outcome.valid) {
      throw new UpdateError('verify', `清单签名无效（${outcome.reason}）`)
    }
  }

  return {
    async fetchRemote(endpoint: string): Promise<UpdateManifest | null> {
      const trimmed = endpoint.trim()
      const raw = await fetchText(bridge, trimmed, MANIFEST_TIMEOUT_MS)
      if (raw === null) return null
      const sigRaw = await fetchText(bridge, `${trimmed}.minisig`, MANIFEST_TIMEOUT_MS)
      if (sigRaw === null) {
        // 签名文件缺失按「清单签名无效」拒绝（失败表 #4）
        throw new UpdateError('verify', '清单签名无效（签名文件缺失）')
      }
      await verifyManifest(raw, sigRaw)
      return parseManifest(raw)
    },

    async fetchInbox(): Promise<UpdateManifest | null> {
      let raw: string | null
      try {
        raw = await bridge.fsRead('update/inbox/latest.json')
      } catch {
        return null // 浏览器无 fs 语义：视为无摆渡清单
      }
      if (raw === null) return null
      let sig: string | null
      try {
        sig = await bridge.fsRead('update/inbox/latest.json.minisig')
      } catch {
        sig = null
      }
      if (sig === null) {
        throw new UpdateError('verify', '清单签名无效（缺少 latest.json.minisig）')
      }
      await verifyManifest(raw, sig)
      return parseManifest(raw)
    },

    async download(manifest: UpdateManifest, options: DownloadOptions): Promise<DownloadOutcome> {
      const platform = pickPlatform(manifest)
      assertSameEndpoint(options.endpoint, platform.url)
      const destRelative = `update/staging/app-${manifest.version}.exe`
      const unlisten = await bridge.onDownloadProgress(options.onProgress)
      try {
        return await bridge.updateDownload(platform.url, destRelative, undefined, platform.sha256)
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        // Rust 已做 expected sha256 收尾校验（不符删除文件并 reject）；这里按文案归档为 sha
        if (detail.includes('校验失败')) throw new UpdateError('sha', detail)
        throw new UpdateError('download', detail)
      } finally {
        unlisten()
      }
    },

    stagedRelative(manifest: UpdateManifest, source: ManifestSource): string {
      if (source === 'inbox') {
        // 摆渡：exe 与 latest.json 同目录、文件名同清单 url 的 basename
        let name: string
        try {
          name = new URL(pickPlatform(manifest).url).pathname.split('/').pop() ?? ''
        } catch {
          name = ''
        }
        if (!/^[\w.-]+\.exe$/i.test(name)) {
          throw new UpdateError('manifest', '清单下载地址不含合法的 exe 文件名，摆渡目录不完整')
        }
        return `update/inbox/${name}`
      }
      // 在线：固定 staging 名（version 已过 isStrictSemVer，无路径注入面）
      return `update/staging/app-${manifest.version}.exe`
    },

    async apply(stagedRelative: string, sha256: string): Promise<ApplyOutcome> {
      try {
        return await bridge.updateApply(stagedRelative, sha256)
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        throw new UpdateError('apply', detail)
      }
    },
  }
}
