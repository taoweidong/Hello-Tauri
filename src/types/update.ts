/**
 * 自动更新配置（design-auto-update-2026-10-10 §11.5，U-G/U-M）。
 *
 * 归一化惯例与 `normalizeWelinkSettings` 同款：AppSettings.update 声明为 Partial
 * 允许老配置缺省，调用方永远拿归一化后的完整对象。
 */

export type UpdateMode = 'notify' | 'auto'

export interface UpdateSettings {
  /**
   * 更新开关（U-G）：默认 false —— 「运行时零外部请求」的唯一显式例外，
   * 不启用就一个字节都不外发；摆渡 inbox 模式同样要求显式开启。
   */
  enabled: boolean
  /** notify=只提示（人工点安装）；auto=自动下载+校验+替换重启（无人值守驻留场景） */
  mode: UpdateMode
  /** latest.json 完整 URL（内网 http/https），默认空 —— 无端点则在线检查不发起 */
  endpoint: string
  /** 检查间隔（小时），归一化收窄 [1, 168] */
  checkIntervalHours: number
}

export const DEFAULT_UPDATE_SETTINGS: UpdateSettings = {
  enabled: false,
  mode: 'notify',
  endpoint: '',
  checkIntervalHours: 24,
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

/** 补齐默认值 + 范围收窄（normalizeWelinkSettings 同款纪律） */
export function normalizeUpdateSettings(input?: Partial<UpdateSettings> | null): UpdateSettings {
  const base = DEFAULT_UPDATE_SETTINGS
  const endpoint = typeof input?.endpoint === 'string' ? input.endpoint.trim() : ''
  return {
    enabled: input?.enabled === true,
    mode: input?.mode === 'auto' ? 'auto' : 'notify',
    endpoint,
    checkIntervalHours: clampNumber(input?.checkIntervalHours, 1, 168, base.checkIntervalHours),
  }
}

/** 端点基础校验（在线检查发起前）：必须是合法的 http/https URL，否则给出可行动的错误 */
export function validateEndpoint(endpoint: string): string | null {
  if (!endpoint.trim()) return '请填写更新服务器地址（latest.json 完整 URL）'
  try {
    const url = new URL(endpoint)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return '更新服务器地址只允许 http/https'
    }
    return null
  } catch {
    return '更新服务器地址不是合法的 URL'
  }
}
