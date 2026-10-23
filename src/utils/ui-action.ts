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
import { ElMessage, ElMessageBox } from 'element-plus'
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

export interface ConfirmOptions {
  /** 确认按钮文案（必填：本项目的确认按钮一向是具体动词，不是「确定」） */
  verb: string
  /** 取消按钮文案（默认「取消」；有一处是「改回去」，语义不同故可覆盖） */
  cancel?: string
  /** 语气：`warning`（默认，破坏性动作）/ `info`（中性批量操作） */
  tone?: 'warning' | 'info'
  /** 确认按钮套 `el-button--danger` 红样式（不可逆删除类动作开） */
  danger?: boolean
}

/**
 * 危险动作确认框的统一出口。
 *
 * @returns `true` = 用户确认；`false` = 取消或关闭弹窗（**已吞掉 reject**）。
 *
 * 为什么收口：全库 16 处 `ElMessageBox.confirm` 是同一段样板抄了 16 遍——
 * `type/confirmButtonText/cancelButtonText` 三件套 + `.catch(() => false)` +
 * `if (confirmed === false) return`，另有 2 处写成 `try/catch { return }`。
 * 抄写型重复的代价不是行数，是**任何一条约束想改都得改 16 处**：
 *
 *  - `dangerouslyUseHTMLString` 默认 false，但只要有一处手抖开成 true，
 *    会话标题（外部数据）进弹窗就是一个 XSS 口子 —— 现在它在这一处显式关死；
 *  - 「取消 = reject」这个反直觉语义需要在**唯一**一处转成布尔，
 *    否则每处都得记得挂 `.catch`，漏一处就是未处理拒绝。
 *
 * 语义边界（与 `runUiAction` 一致）：**取消不算错误**，只返回 false，
 * 由调用方决定是 `return` 还是回滚字段值（如配额放宽被拒时改回默认值）。
 */
export async function confirmDanger(message: string, title: string, options: ConfirmOptions): Promise<boolean> {
  const { verb, cancel = '取消', tone = 'warning', danger = false } = options
  try {
    await ElMessageBox.confirm(message, title, {
      type: tone,
      confirmButtonText: verb,
      cancelButtonText: cancel,
      // 显式关死：会话标题、群名等外部数据会拼进 message，开 HTML 等于开口子。
      // （有反证用例钉住：把它改成 true，`ui-action.spec.ts` 的「恒不启用 HTML」会变红）
      dangerouslyUseHTMLString: false,
      ...(danger ? { confirmButtonClass: 'el-button--danger' } : {}),
    })
    return true
  } catch {
    // ElMessageBox 用 reject 表达「取消/关闭」，这里统一折叠成 false，
    // 避免调用方漏挂 catch 产生未处理拒绝。
    return false
  }
}

export interface UiActionOptions {
  /** 失败提示文案（必填） */
  fail: string
  /** 成功提示文案（可选；多数场景 UI 会因重拉而自行变化，不必提示） */
  ok?: string
  /** 执行期置 true、结束置 false；用于按钮 `:loading` 防重复提交 */
  busy?: Ref<boolean>
  /**
   * 把「任务 resolve 出 `false`」也算失败（默认只看是否抛错）。
   *
   * 为什么需要：本项目的 store 有一批**「返回布尔、永不 reject」**的语义
   * （`init()` / `save()` / `refresh()` 的成功与否靠布尔表达）。直接把它们塞进
   * `runUiAction`，`false` 会被当成「没抛错 = 成功」—— 装载失败、保存失败全部
   * 静默变成功，正是这个出口要消灭的缺陷形态。给这类调用点开这个开关即可。
   *
   * 反之，业务级「没做但也不算错」的动作（如「数据源不支持演示剧本」返回 false）
   * 不该开：它们由调用方自己降级提示，不该被这里当成错误。
   */
  failOnFalse?: boolean
  /**
   * 失败文案写入这个 ref（页面内的行内错误区），而不是弹 toast。
   *
   * 为什么要：表单/清单类页面有固定的错误展示位（如仓库清单下的 `.repos__error`），
   * 再弹一次 toast 就是同一条错误报两遍。给了 `error` 就表示「行内区就是提示出口」，
   * 出口仍然唯一，只是换了个呈现位置。动作开始前会清空它。
   */
  error?: Ref<string>
}

/**
 * 执行一个 UI 动作，统一处理「繁忙态 + 失败提示」。
 *
 * @returns 成功 true；失败 false（已提示，不再抛）
 */
export async function runUiAction(task: () => Promise<unknown> | unknown, options: UiActionOptions): Promise<boolean> {
  const { fail, ok, busy, failOnFalse, error: errorRef } = options
  if (busy) busy.value = true
  if (errorRef) errorRef.value = ''
  /** 失败的唯一出口：给了行内错误区就写区里，否则弹 toast */
  const report = (text: string) => {
    if (errorRef) errorRef.value = text
    else ElMessage.error(text)
  }
  try {
    const result = await task()
    if (failOnFalse && result === false) {
      report(fail)
      return false
    }
    if (ok) ElMessage.success(ok)
    return true
  } catch (thrown) {
    // 关键：失败必须让用户看见。返回值交调用方决定是否回滚 UI。
    report(errorText(thrown, fail))
    return false
  } finally {
    if (busy) busy.value = false
  }
}
