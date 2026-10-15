import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'

/**
 * UI 动作统一出口的直连用例。
 *
 * 三条契约必须钉住（少一条就退回「静默失效」）：
 *  ① 失败**一定**提示且返回 false（不抛给调用方）；
 *  ② 失败文案优先 Error.message，退化到必填 fallback；
 *  ③ busy 在「执行中」为 true、结束必复位（成功与失败两条都要，否则按钮永久转圈）。
 *
 * 反证（写用例时实跑过，改实现后请重做）：
 *  - 去掉 `ElMessage.error(...)` → 用例「失败时提示」与「非 Error 退化」双双变红；
 *  - 把 `finally` 改成 `try` 内复位 → 用例「失败后 busy 复位」变红；
 *  - 把返回值改成恒 true → 用例「失败返回 false」变红。
 */
vi.mock('element-plus', () => ({
  ElMessage: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}))

import { ElMessage } from 'element-plus'
import { errorText, runUiAction } from './ui-action'

const errorSpy = () => vi.mocked(ElMessage.error)
const successSpy = () => vi.mocked(ElMessage.success)

beforeEach(() => {
  vi.clearAllMocks()
})

describe('errorText', () => {
  it('优先取 Error.message', () => {
    expect(errorText(new Error('连接被拒绝'), '兜底')).toBe('连接被拒绝')
  })

  it('Error 无 message 时退化到兜底文案', () => {
    expect(errorText(new Error(''), '兜底')).toBe('兜底')
  })

  it('字符串错误原样使用，空白字符串不算', () => {
    expect(errorText('超时', '兜底')).toBe('超时')
    expect(errorText('   ', '兜底')).toBe('兜底')
  })

  it('undefined / 对象一律退化到兜底文案', () => {
    expect(errorText(undefined, '兜底')).toBe('兜底')
    expect(errorText({ code: 500 }, '兜底')).toBe('兜底')
  })
})

describe('runUiAction', () => {
  it('成功时返回 true，不弹错误', async () => {
    const ok = await runUiAction(async () => 'done', { fail: '失败文案' })
    expect(ok).toBe(true)
    expect(errorSpy()).not.toHaveBeenCalled()
  })

  it('给了 ok 文案才弹成功提示', async () => {
    await runUiAction(async () => 1, { fail: '失败文案' })
    expect(successSpy()).not.toHaveBeenCalled()

    await runUiAction(async () => 1, { fail: '失败文案', ok: '已保存' })
    expect(successSpy()).toHaveBeenCalledWith('已保存')
  })

  it('失败时提示 Error.message 并返回 false（不抛给调用方）', async () => {
    const ok = await runUiAction(
      async () => {
        throw new Error('写入被拒')
      },
      { fail: '操作失败' },
    )
    expect(ok).toBe(false)
    expect(errorSpy()).toHaveBeenCalledWith('写入被拒')
  })

  it('非 Error 抛出错时退化到必填兜底文案', async () => {
    const ok = await runUiAction(
      async () => {
        throw undefined
      },
      { fail: '保存会话失败' },
    )
    expect(ok).toBe(false)
    expect(errorSpy()).toHaveBeenCalledWith('保存会话失败')
  })

  it('同步任务同样纳管（抛错走同一出口）', async () => {
    expect(await runUiAction(() => 1, { fail: '兜底' })).toBe(true)
    expect(
      await runUiAction(
        () => {
          throw new Error('同步抛错')
        },
        { fail: '兜底' },
      ),
    ).toBe(false)
    expect(errorSpy()).toHaveBeenCalledWith('同步抛错')
  })

  it('busy 在执行中为 true、成功后复位', async () => {
    const busy = ref(false)
    let seenDuringTask: boolean | null = null
    await runUiAction(
      async () => {
        seenDuringTask = busy.value
      },
      { fail: '兜底', busy },
    )
    expect(seenDuringTask).toBe(true)
    expect(busy.value).toBe(false)
  })

  it('busy 在失败后也必须复位（否则按钮永久转圈）', async () => {
    const busy = ref(false)
    await runUiAction(
      async () => {
        throw new Error('boom')
      },
      { fail: '兜底', busy },
    )
    expect(busy.value).toBe(false)
  })
})
