/**
 * UI 动作的统一出口（第三轮 S3 一致性收口）。
 *
 * 背景：全量勘察发现 UI 层有 29 处「有 await 无 try」的裸异步（`components/**`
 * 与 `views/**`）。它们的共同缺陷形态是**静默失效**——写库失败时开关已经在界面上
 * 动过了，但库里的值没变，用户既看不到错误也看不到回滚，下次刷新才发现「白点了」。
 * 这类缺陷功能测试照绿（失败路径没人走），正是本项目最忌讳的一类。
 *
 * 为什么收成一个工具而不是逐处补 try/catch：
 *  1. 「失败必须提示」是**契约**而不是风格，散在 29 处迟早有人漏；
 *  2. `busy`（防重复提交）与失败提示必须成对出现——只加其中一个等于没加；
 *  3. 可测：`runUiAction` 有直连用例（含反证），逐处 try/catch 无法统一断言。
 *
 * 语义边界（改动前务必读）：
 *  - 返回值 `true` = 成功，`false` = 失败且**已提示**。调用方据此决定是否继续后续动作
 *    （如「失败也要重拉列表，把 UI 回滚到库里的真值」），不要把返回值当错误对象用。
 *  - **不吞取消**：`ElMessageBox` 的取消由调用方自己判，不进这个出口。
 *  - 只用于 UI 层的**离散用户动作**；`infra` / `orchestrator` 层的错误照旧向上抛
 *    （分层约定：infra 抛、api 折叠、orchestrator 返回报告）。
 */
import { ElMessage } from 'element-plus'
import type { Ref } from 'vue'

/**
 * 把 `unknown` 收敛成可展示文案。
 *
 * 优先取 `Error.message`（infra 抛出的都是带中文语义的自定义 Error），
 * 退化到 `fallback`——**fallback 是必填的**：没有兜底文案就等于允许静默失败。
 */
export function errorText(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string' && error.trim()) return error
  return fallback
}

export interface UiActionOptions {
  /** 失败提示文案（必填） */
  fail: string
  /** 成功提示文案（可选；多数场景 UI 会因重拉而自行变化，不必提示） */
  ok?: string
  /** 执行期置 true、结束置 false；用于按钮 `:loading` 防重复提交 */
  busy?: Ref<boolean>
}

/**
 * 执行一个 UI 动作，统一处理「繁忙态 + 失败提示」。
 *
 * @returns 成功 true；失败 false（已提示，不再抛）
 */
export async function runUiAction(task: () => Promise<unknown> | unknown, options: UiActionOptions): Promise<boolean> {
  const { fail, ok, busy } = options
  if (busy) busy.value = true
  try {
    await task()
    if (ok) ElMessage.success(ok)
    return true
  } catch (error) {
    // 关键：失败必须让用户看见。返回值交调用方决定是否回滚 UI。
    ElMessage.error(errorText(error, fail))
    return false
  } finally {
    if (busy) busy.value = false
  }
}
