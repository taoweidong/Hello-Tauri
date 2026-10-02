import { describe, expect, it } from 'vitest'

import { DEFAULT_COMMAND_TIMEOUT_MS, getRegisteredCommand, listRegisteredCommands } from './registry'
import { HARD_TIMEOUT_MS } from './port'

/**
 * Rust 白名单镜像（src-tauri/src/cli.rs ALLOWED_STEMS 中与系统诊断相关的项 +
 * 原有 welink/python 项）。这是双层闸的契约测试：登记表出现镜像之外的程序名
 * 即失败 —— 提醒同步放行 Rust 白名单，避免「TS 登记、Rust 拒绝」的静默不可用。
 */
const RUST_ALLOWED_STEMS = new Set([
  'welink-cli',
  'python',
  'python3',
  'py',
  'systeminfo',
  'ipconfig',
  'tasklist',
  'where',
  'whoami',
  'hostname',
  'nslookup',
  'ping',
])

describe('windows 命令注册表', () => {
  it('登记项稳定 ID 唯一', () => {
    const ids = listRegisteredCommands().map((entry) => entry.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('每个登记项的 program 都在 Rust 白名单镜像内', () => {
    for (const entry of listRegisteredCommands()) {
      expect(RUST_ALLOWED_STEMS.has(entry.program), `程序未放行白名单：${entry.program}`).toBe(true)
    }
  })

  it('每个登记项都有用途说明与合法超时预算（且小于硬超时）', () => {
    for (const entry of listRegisteredCommands()) {
      expect(entry.purpose.length, `用途缺失：${entry.id}`).toBeGreaterThan(0)
      expect(entry.timeoutMs, `超时非法：${entry.id}`).toBeGreaterThanOrEqual(1000)
      expect(entry.timeoutMs, `超时必须小于硬超时：${entry.id}`).toBeLessThan(HARD_TIMEOUT_MS)
      expect(entry.extraArgs, `追加参数限额非法：${entry.id}`).toBeGreaterThanOrEqual(0)
    }
  })

  it('慢命令必须显式放宽默认预算（systeminfo 10s，其余不超过默认两倍语义由清单体现）', () => {
    const systeminfo = getRegisteredCommand('system-info')
    expect(systeminfo?.timeoutMs).toBeGreaterThan(DEFAULT_COMMAND_TIMEOUT_MS)
  })

  it('按 ID 查询：存在返回登记项，未知返回 undefined', () => {
    expect(getRegisteredCommand('ping-host')?.program).toBe('ping')
    expect(getRegisteredCommand('format-c')).toBeUndefined()
  })

  it('登记的都是只读诊断命令（无写盘/改系统语义的 cmd 内建或 shell 载体）', () => {
    const banned = ['cmd', 'powershell', 'pwsh', 'wscript', 'cscript', 'mshta', 'reg', 'regedit', 'del', 'rd']
    for (const entry of listRegisteredCommands()) {
      expect(banned.includes(entry.program.toLowerCase()), `登记了危险程序：${entry.program}`).toBe(false)
    }
  })
})
