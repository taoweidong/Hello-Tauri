import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
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
  ElMessageBox: { confirm: vi.fn() },
}))

import { ElMessage, ElMessageBox } from 'element-plus'
import { confirmDanger, errorText, runUiAction } from './ui-action'

const errorSpy = () => vi.mocked(ElMessage.error)
const successSpy = () => vi.mocked(ElMessage.success)
// `ElMessageBox.confirm` 的 `MessageBoxData` 是联合类型且带内部字段，
// 这里只关心「resolve / reject」两种结局，故弱化成裸 Mock 使用。
const confirmSpy = () => ElMessageBox.confirm as unknown as Mock

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

  it('failOnFalse：store「返回布尔不抛」的语义下，false 必须算失败', async () => {
    const ok = await runUiAction(async () => false, { fail: '本地快照装载失败，请重试', failOnFalse: true })
    expect(ok).toBe(false)
    expect(errorSpy()).toHaveBeenCalledWith('本地快照装载失败，请重试')
  })

  it('不开 failOnFalse 时 false 仍是成功（业务降级由调用方自己提示）', async () => {
    expect(await runUiAction(async () => false, { fail: '兜底' })).toBe(true)
    expect(errorSpy()).not.toHaveBeenCalled()
  })

  it('error ref：失败文案写进行内错误区，且不再重复弹 toast', async () => {
    const inline = ref('旧的')
    const ok = await runUiAction(
      async () => {
        throw new Error('数据库被占用')
      },
      { fail: '开启参与同步失败', error: inline },
    )
    expect(ok).toBe(false)
    expect(inline.value).toBe('数据库被占用')
    expect(errorSpy()).not.toHaveBeenCalled()
  })

  it('error ref：动作开始前先清空上一次的错误（不留下失效的红字）', async () => {
    const inline = ref('上一次失败')
    expect(await runUiAction(async () => 1, { fail: '兜底', error: inline })).toBe(true)
    expect(inline.value).toBe('')

    await runUiAction(async () => false, { fail: '装载失败', error: inline, failOnFalse: true })
    expect(inline.value).toBe('装载失败')
  })
})

describe('confirmDanger', () => {
  /**
   * 四条契约：
   *  ① 用户确认 → true；
   *  ② 取消/关闭（`ElMessageBox` 以 **reject** 表达）→ false，且不冒泡成未处理拒绝；
   *  ③ `dangerouslyUseHTMLString` **恒为 false** —— 会话标题、群名等外部数据会拼进
   *     文案，开 HTML 就是一个 XSS 口子，这条是本工具存在的首要理由；
   *  ④ 只有 `danger: true` 才挂红色按钮样式。
   *
   * 反证（改实现后请重做）：把 `dangerouslyUseHTMLString` 改成 `true` →
   * 「恒不启用 HTML」变红；去掉 `catch` → 「取消返回 false」直接抛错变红。
   */
  it('用户确认返回 true', async () => {
    confirmSpy().mockResolvedValueOnce('confirm')
    expect(await confirmDanger('确认删除？', '删除记录', { verb: '删除' })).toBe(true)
  })

  it('取消（ElMessageBox reject）折叠为 false，不冒泡成未处理拒绝', async () => {
    confirmSpy().mockRejectedValueOnce(new Error('cancel'))
    await expect(confirmDanger('确认？', '标题', { verb: '删除' })).resolves.toBe(false)
  })

  it('恒不启用 HTML 字符串（外部数据拼进文案，开 HTML 即 XSS 口子）', async () => {
    confirmSpy().mockResolvedValueOnce('confirm')
    await confirmDanger('删除「<img onerror=alert(1)>」？', '删除', { verb: '删除' })
    const options = confirmSpy().mock.calls.at(-1)?.[2] as Record<string, unknown>
    expect(options.dangerouslyUseHTMLString).toBe(false)
  })

  it('verb / cancel / tone 原样透传，仅 danger 挂红色按钮', async () => {
    confirmSpy().mockResolvedValueOnce('confirm')
    await confirmDanger('放宽？', '确认放宽配额', { verb: '确认放宽', cancel: '改回去', tone: 'info' })
    const first = confirmSpy().mock.calls.at(-1)?.[2] as Record<string, unknown>
    expect(first.confirmButtonText).toBe('确认放宽')
    expect(first.cancelButtonText).toBe('改回去')
    expect(first.type).toBe('info')
    expect(first.confirmButtonClass).toBeUndefined()

    confirmSpy().mockResolvedValueOnce('confirm')
    await confirmDanger('删除？', '删除记录', { verb: '删除', danger: true })
    const second = confirmSpy().mock.calls.at(-1)?.[2] as Record<string, unknown>
    expect(second.confirmButtonClass).toBe('el-button--danger')
  })

  it('默认语气 warning、取消文案「取消」', async () => {
    confirmSpy().mockResolvedValueOnce('confirm')
    await confirmDanger('确认？', '标题', { verb: '确定' })
    const options = confirmSpy().mock.calls.at(-1)?.[2] as Record<string, unknown>
    expect(options.type).toBe('warning')
    expect(options.cancelButtonText).toBe('取消')
  })
})
