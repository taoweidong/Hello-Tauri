/**
 * 建群端口 Mock（设计 §3.3 的 mock 优先策略，migration v3）。
 *
 * 浏览器调试模式（`npm run dev`）下整条建群链路要能跑通：选模板 → 改信息 →
 * 确认 → CLI 外呼 → 留痕 → 历史可见。mock 与真实实现共享同一套端口夹具测试，
 * 确定性故障注入（`failNextCreate`）供编排层失败路径的单测使用 —— 随机故障
 * 会让 CI 随机变红，这里延续「固定种子」的立场。
 */
import type { GroupPort } from './port'
import { WelinkError } from './port'

export interface MockGroupOptions {
  /** 模拟 CLI 延迟（毫秒），用于演示「确认弹层期间 UI 可感知进度」 */
  latencyMs?: number
  /** 确定性故障注入：前 N 次 createGroup 抛 transport 错 */
  createFailures?: number
}

export interface MockGroupState {
  createCount: number
  /** 已创建的群（审计用：编排层测试断言「外呼参数与留痕一致」） */
  created: Array<{ name: string; memberIds: string[]; groupId: string; at: string }>
}

export interface MockGroupPort extends GroupPort {
  readonly state: MockGroupState
  /** 让接下来的 N 次创建抛 transport 错（测试失败留痕路径） */
  failNextCreate(times?: number): void
  /** 重置全部 mock 状态（测试隔离） */
  reset(): void
}

export function createMockGroupPort(options: MockGroupOptions = {}): MockGroupPort {
  const latencyMs = options.latencyMs ?? 150
  let failures = Math.max(0, options.createFailures ?? 0)
  const state: MockGroupState = { createCount: 0, created: [] }

  const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

  return {
    state,

    failNextCreate(times = 1) {
      failures = Math.max(0, times)
    },

    reset() {
      state.createCount = 0
      state.created = []
      failures = 0
    },

    async createGroup({ name, memberIds }) {
      state.createCount += 1
      if (failures > 0) {
        failures -= 1
        throw new WelinkError('建群失败（mock 注入）', 'transport')
      }
      await wait(latencyMs)
      // 群 ID 带序号保证唯一：同一批成员重复建群也各得一个新 ID（与真实行为一致）
      const groupId = `mock-g-${state.createCount}`
      state.created.push({ name, memberIds: [...memberIds], groupId, at: new Date().toISOString() })
      return { groupId }
    },
  }
}
