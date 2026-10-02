/**
 * 系统信息探测适配器（design D3：探测走 Bridge 原生命令，非子进程解析）。
 *
 * Bridge 层已实现「永不 reject」契约（tauri.ts/web.ts 折叠）；这里的 backstop
 * 是第二道防线：若任何 Bridge 实现违约抛错，仍折叠为失败结果 —— spec 要求
 * 「探测 MUST 永不 reject」，防御放在适配器入口而不是信任每个实现者。
 */
import { bridge } from '@/api'
import type { SysAdapter, SysDisk, SysOverview } from '@/types'
import type { ProbeResult } from './port'

/** 依赖形状（测试注入桩用；缺省 = 全局 Bridge） */
export interface SysinfoBridgeDeps {
  sysOverview(): Promise<ProbeResult<SysOverview>>
  sysEnvVar(name: string): Promise<ProbeResult<string | null>>
  sysDisks(): Promise<ProbeResult<SysDisk[]>>
  sysAdapters(): Promise<ProbeResult<SysAdapter[]>>
}

/** 兜底折叠：违约抛错也折叠成确定结果（永不 reject 的最后一道闸） */
async function backstop<T>(task: () => Promise<ProbeResult<T>>, label: string): Promise<ProbeResult<T>> {
  try {
    return await task()
  } catch (error) {
    return {
      ok: false,
      reason: `${label}执行异常（宿主契约违约）`,
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

export function createSysinfoProbes(deps: SysinfoBridgeDeps = bridge) {
  return {
    probeOverview: () => backstop(() => deps.sysOverview(), '系统概要探测'),
    probeEnvVar: (name: string) => backstop(() => deps.sysEnvVar(name), '环境变量读取'),
    probeDisks: () => backstop(() => deps.sysDisks(), '磁盘探测'),
    probeAdapters: () => backstop(() => deps.sysAdapters(), '网卡探测'),
  }
}
