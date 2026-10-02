/**
 * Shell 交互适配器（design D4：默认程序打开 / 剪贴板 / 通知）。
 *
 * 与 sysinfo.ts 同款 backstop 策略：Bridge 层永不 reject，适配器再兜一层
 * 「契约违约折叠」，保证尽力而为语义传导到调用方 —— 通知/剪贴板失败绝不能
 * 中断业务流程。
 */
import { bridge } from '@/api'
import type { BasicOutcome } from '@/types'
import type { ProbeResult } from './port'

/** 依赖形状（测试注入桩用；缺省 = 全局 Bridge） */
export interface ShellBridgeDeps {
  shellOpen(target: string): Promise<BasicOutcome>
  clipboardRead(): Promise<ProbeResult<string | null>>
  clipboardWrite(text: string): Promise<BasicOutcome>
  notifySend(title: string, body: string): Promise<BasicOutcome>
}

async function backstopProbe<T>(task: () => Promise<ProbeResult<T>>, label: string): Promise<ProbeResult<T>> {
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

async function backstopOutcome(task: () => Promise<BasicOutcome>, label: string): Promise<BasicOutcome> {
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

export function createShellInteractions(deps: ShellBridgeDeps = bridge) {
  return {
    openWithDefault: (target: string) => backstopOutcome(() => deps.shellOpen(target), '默认程序打开'),
    readClipboard: () => backstopProbe(() => deps.clipboardRead(), '剪贴板读取'),
    writeClipboard: (text: string) => backstopOutcome(() => deps.clipboardWrite(text), '剪贴板写入'),
    notify: (title: string, body: string) => backstopOutcome(() => deps.notifySend(title, body), '系统通知'),
  }
}
