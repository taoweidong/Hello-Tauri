import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Python 环境探测器单测：候选链、版本边界与降级路径。
 *
 * 通过打桩 Bridge 的 `cliRun` 覆盖（不测真 Python）：
 *  * 版本判定边界（3.10.0 恰好满足 / 3.9.7 不满足 / 4.x 满足）；
 *  * 候选链（python 是商店 stub / 起不来时回落 py，胜者短路，结论带命令名）;
 *  * 「结论链与排障细节分离」—— 已恢复的失败尝试不污染整体状态，但保留在 details；
 *  * 全部候选不可用 → fail；超时未被恢复 → timeout（不伪装成「未安装」）。
 */
const cliRun = vi.hoisted(() => vi.fn())

vi.mock('@/api', () => ({
  bridge: { cliRun },
  platform: 'tauri',
}))

import { createPythonEnvCheck } from '@/infra/envcheck/python'
import type { CliResult } from '@/types'

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64')

function okResult(stdout: string): CliResult {
  return {
    exitCode: 0,
    stdout: b64(stdout),
    stderr: b64(''),
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    durationMs: 5,
  }
}

/** 按调用顺序回放多路结果；`reject` / `timedOut` 表达通道故障与超时 */
function script(steps: Array<Partial<CliResult> & { reject?: Error }>) {
  let index = 0
  cliRun.mockImplementation(() => {
    const step = steps[index]
    index += 1
    if (!step) throw new Error('cliRun 调用次数超出脚本')
    if (step.reject) return Promise.reject(step.reject)
    return Promise.resolve({ ...okResult(''), ...step } as CliResult)
  })
}

const check = createPythonEnvCheck()

beforeEach(() => {
  cliRun.mockReset()
})

describe('infra/envcheck/python —— 版本判定（≥ 3.10）', () => {
  it('python 3.12.4 → ok，结论带命令名与版本，两步齐全', async () => {
    script([okResult('Python 3.12.4')])
    const outcome = await check.run()
    expect(outcome.status).toBe('ok')
    expect(outcome.summary).toContain('3.12.4')
    expect(outcome.summary).toContain('python')
    expect(outcome.steps.map((step) => step.status)).toEqual(['ok', 'ok'])
    expect(outcome.steps[1]?.name).toContain('≥ 3.10')
    // 首个候选命中即短路：不再探测 py
    expect(cliRun).toHaveBeenCalledTimes(1)
    expect(cliRun).toHaveBeenCalledWith('python', ['--version'], 5000)
  })

  it('3.10.0 恰好在边界上 → 满足', async () => {
    script([okResult('Python 3.10.0')])
    const outcome = await check.run()
    expect(outcome.status).toBe('ok')
    expect(outcome.summary).toContain('满足')
  })

  it('4.x（major > 3）→ 满足', async () => {
    script([okResult('Python 4.0.1')])
    const outcome = await check.run()
    expect(outcome.status).toBe('ok')
  })

  it('3.9.7 → fail，结论明确「不满足」', async () => {
    script([okResult('Python 3.9.7')])
    const outcome = await check.run()
    expect(outcome.status).toBe('fail')
    expect(outcome.summary).toContain('低于 3.10')
    expect(outcome.summary).toContain('不满足')
  })

  it('Python 2 把版本打到 stderr → 照常解析，2.7.18 不满足', async () => {
    script([{ exitCode: 0, stdout: b64(''), stderr: b64('Python 2.7.18') }])
    const outcome = await check.run()
    expect(outcome.status).toBe('fail')
    expect(outcome.summary).toContain('2.7.18')
  })
})

describe('infra/envcheck/python —— 候选链降级', () => {
  it('python 是商店 stub（退出码 9009 无输出）→ 回落 py，胜者短路且结论带 py', async () => {
    script([{ exitCode: 9009, stdout: b64(''), stderr: b64('') }, okResult('Python 3.11.0')])
    const outcome = await check.run()
    expect(outcome.status).toBe('ok')
    expect(outcome.summary).toContain('py')
    expect(outcome.steps).toHaveLength(2) // 结论链只剩胜者 + 版本判定
    expect(cliRun).toHaveBeenCalledTimes(2)
    expect(cliRun).toHaveBeenLastCalledWith('py', ['--version'], 5000)
    // 被恢复的 python 失败不进结论链，但保留在 details 排障
    expect(outcome.details).toContain('9009')
  })

  it('python 超时但 py 成功 → 整体 ok（已恢复的超时不污染结论），超时细节在 details', async () => {
    script([{ timedOut: true, durationMs: 5000 }, okResult('Python 3.11.0')])
    const outcome = await check.run()
    expect(outcome.status).toBe('ok')
    expect(outcome.steps.every((step) => step.status === 'ok')).toBe(true)
    expect(outcome.details).toContain('超时')
  })

  it('全部候选起不来 → fail，结论列出已尝试命令，details 逐条错误', async () => {
    script([{ reject: new Error('启动子进程失败：not found') }, { reject: new Error('启动子进程失败：not found') }])
    const outcome = await check.run()
    expect(outcome.status).toBe('fail')
    expect(outcome.summary).toContain('未找到可用的 Python')
    expect(outcome.summary).toContain('python、py')
    expect(outcome.details).toContain('命令探测（python）')
    expect(outcome.details).toContain('命令探测（py）')
    expect(cliRun).toHaveBeenCalledTimes(2)
  })

  it('首个候选超时且未被恢复（py 也超时）→ 整体 timeout，不伪装成「未安装」', async () => {
    script([
      { timedOut: true, durationMs: 5000 },
      { timedOut: true, durationMs: 5000 },
    ])
    const outcome = await check.run()
    expect(outcome.status).toBe('timeout')
    expect(outcome.summary).toContain('超时')
  })

  it('退出码 0 但输出不含版本号 → 视为不可用，继续下一候选', async () => {
    script([okResult('hello world'), okResult('Python 3.10.2')])
    const outcome = await check.run()
    expect(outcome.status).toBe('ok')
    expect(cliRun).toHaveBeenCalledTimes(2)
  })
})
