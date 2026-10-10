import { describe, expect, it } from 'vitest'

import { DEFAULT_UPDATE_SETTINGS, normalizeUpdateSettings, validateEndpoint } from './update'

describe('normalizeUpdateSettings（AppSettings.update 归一化）', () => {
  it('缺省输入 → 默认关闭 + notify + 空端点 + 24h', () => {
    expect(normalizeUpdateSettings(undefined)).toEqual(DEFAULT_UPDATE_SETTINGS)
    expect(normalizeUpdateSettings(null)).toEqual(DEFAULT_UPDATE_SETTINGS)
    expect(normalizeUpdateSettings({})).toEqual(DEFAULT_UPDATE_SETTINGS)
    expect(DEFAULT_UPDATE_SETTINGS.enabled).toBe(false)
  })

  it('越界值收窄：间隔 [1, 168]', () => {
    expect(normalizeUpdateSettings({ checkIntervalHours: 0 }).checkIntervalHours).toBe(1)
    expect(normalizeUpdateSettings({ checkIntervalHours: 999 }).checkIntervalHours).toBe(168)
    expect(normalizeUpdateSettings({ checkIntervalHours: 12.6 }).checkIntervalHours).toBe(13)
    expect(normalizeUpdateSettings({ checkIntervalHours: Number.NaN }).checkIntervalHours).toBe(24)
  })

  it('非法枚举值回退默认（mode 仅 notify/auto）', () => {
    expect(normalizeUpdateSettings({ mode: 'auto' }).mode).toBe('auto')
    expect(normalizeUpdateSettings({ mode: 'aggressive' as never }).mode).toBe('notify')
  })

  it('端点去首尾空白；enabled 严格布尔', () => {
    const normalized = normalizeUpdateSettings({ endpoint: '  http://x/latest.json  ', enabled: 1 as never })
    expect(normalized.endpoint).toBe('http://x/latest.json')
    expect(normalized.enabled).toBe(false)
    expect(normalizeUpdateSettings({ enabled: true }).enabled).toBe(true)
  })
})

describe('validateEndpoint（在线检查发起前的可行动校验）', () => {
  it('空值/非法 URL/非 http 协议给出明确错误', () => {
    expect(validateEndpoint('')).toContain('请填写')
    expect(validateEndpoint('not a url')).toContain('URL')
    expect(validateEndpoint('ftp://10.0.0.8/latest.json')).toContain('http/https')
  })

  it('合法 http/https 返回 null', () => {
    expect(validateEndpoint('http://10.0.0.8/update/hello-tauri/latest.json')).toBeNull()
    expect(validateEndpoint('https://update.internal/latest.json')).toBeNull()
  })
})
