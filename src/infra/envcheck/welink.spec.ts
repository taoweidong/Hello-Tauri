import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * WeLink CLI 环境探测器单测。
 *
 * 通过打桩 Bridge 的 `cliRun` 覆盖探测器的**分类与短路逻辑**（不测子进程本身）：
 *  * 两步全过 → ok；第一步失败 → 短路（不再跑 doctor）；
 *  * 超时 / 启动失败要落进正确的状态（timeout 与 fail 是 UI 两种提示）；
 *  * doctor 缺席（非 0 退出 / 输出不符）降级 warn 而不是 fail —— 自检命令是
 *    增强信息，不是可用性前提（[CLI-ASSUME] 降级路径必须守住）。
 */
const cliRun = vi.hoisted(() => vi.fn())

vi.mock('@/api', () => ({
  bridge: { cliRun },
  platform: 'tauri',
}))

import { createWelinkEnvCheck } from '@/infra/envcheck/welink'
import type { CliResult } from '@/types'

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64')

/** 造一路成功的 CliResult */
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

const check = createWelinkEnvCheck({ cliPath: 'C:\\tools\\welink-cli.exe' })

beforeEach(() => {
  cliRun.mockReset()
})

describe('infra/envcheck/welink —— 两步全过', () => {
  it('version + doctor 都正常 → ok，步骤齐全，参数与预算正确', async () => {
    script([okResult('welink-cli 1.2.3'), okResult('{"ok":true}')])
    const outcome = await check.run()
    expect(outcome.status).toBe('ok')
    expect(outcome.summary).toContain('welink-cli 可用')
    expect(outcome.summary).toContain('1.2.3')
    expect(outcome.steps.map((step) => step.status)).toEqual(['ok', 'ok'])
    // 第 1 步 --version、第 2 步 doctor --json；预算分别为 5s / 8s（小于硬超时 16s）
    expect(cliRun).toHaveBeenNthCalledWith(1, 'C:\\tools\\welink-cli.exe', ['--version'], 5000)
    expect(cliRun).toHaveBeenNthCalledWith(2, 'C:\\tools\\welink-cli.exe', ['doctor', '--json'], 8000)
  })

  it('doctor 报告 ok=false 时携带 problems → fail', async () => {
    script([okResult('welink-cli 1.2.3'), okResult('{"ok":false,"problems":["登录态失效","网络不通"]}')])
    const outcome = await check.run()
    expect(outcome.status).toBe('fail')
    // problems 落在步骤结论里（整体 summary 是人读的一行话）
    expect(outcome.steps[1]?.summary).toContain('登录态失效')
    expect(outcome.steps[1]?.summary).toContain('网络不通')
    expect(outcome.summary).toContain('未通过')
  })

  it('cliPath 为空时回落裸命令名（探测 PATH）', async () => {
    script([okResult('v1'), okResult('{"ok":true}')])
    await createWelinkEnvCheck({}).run()
    expect(cliRun).toHaveBeenNthCalledWith(1, 'welink-cli', ['--version'], expect.anything())
  })
})

describe('infra/envcheck/welink —— 第 1 步失败即短路', () => {
  it('进程起不来（bridge reject）→ fail，且不再调 doctor', async () => {
    script([{ reject: new Error('启动子进程失败：program not found') }])
    const outcome = await check.run()
    expect(outcome.status).toBe('fail')
    expect(outcome.summary).toContain('启动子进程失败')
    expect(outcome.summary).toContain('C:\\tools\\welink-cli.exe')
    expect(cliRun).toHaveBeenCalledTimes(1)
  })

  it('version 超时 → timeout（不是 fail）', async () => {
    script([{ timedOut: true, durationMs: 5000 }])
    const outcome = await check.run()
    expect(outcome.status).toBe('timeout')
    expect(outcome.steps[0]?.status).toBe('timeout')
    expect(cliRun).toHaveBeenCalledTimes(1)
  })

  it('version 非 0 退出 → fail，stderr 摘录进结论', async () => {
    script([{ exitCode: 3221225786, stderr: b64('_CTRL_C_EXIT') }])
    const outcome = await check.run()
    expect(outcome.status).toBe('fail')
    expect(outcome.steps[0]?.summary).toContain('3221225786')
    expect(outcome.steps[0]?.summary).toContain('_CTRL_C_EXIT')
    expect(cliRun).toHaveBeenCalledTimes(1)
  })
})

describe('infra/envcheck/welink —— doctor 缺席降级 warn（CLI-ASSUME 容错）', () => {
  it('doctor 非 0 退出 → warn，整体 warn（基础可用性不受影响）', async () => {
    script([okResult('welink-cli 1.2.3'), { exitCode: 1, stderr: b64('unknown command "doctor"') }])
    const outcome = await check.run()
    expect(outcome.status).toBe('warn')
    expect(outcome.steps[0]?.status).toBe('ok')
    expect(outcome.steps[1]?.status).toBe('warn')
    expect(outcome.steps[1]?.summary).toContain('返回码 1')
  })

  it('doctor 输出不是约定 JSON → warn', async () => {
    script([okResult('welink-cli 1.2.3'), okResult('I am not json')])
    const outcome = await check.run()
    expect(outcome.status).toBe('warn')
    expect(outcome.steps[1]?.summary).toContain('不符合约定结构')
  })

  it('doctor 超时 → timeout（通道级故障不该伪装成「CLI 不可用」）', async () => {
    script([okResult('welink-cli 1.2.3'), { timedOut: true, durationMs: 8000 }])
    const outcome = await check.run()
    expect(outcome.status).toBe('timeout')
    expect(outcome.steps[1]?.status).toBe('timeout')
  })
})
