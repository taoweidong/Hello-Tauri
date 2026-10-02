import { describe, expect, it, vi } from 'vitest'

import { bytesToBase64, gbkBytes, utf8Bytes } from '@/utils/b64'
import type { CliResult } from '@/types'
import { createCommandRunner, type CliRunFn } from './command-exec'

/** 桩：返回预置 CliResult，并记录收到的 program/args/timeout */
function stubCliRun(result: Partial<CliResult> = {}) {
  const calls: { program: string; args: string[]; timeoutMs?: number }[] = []
  const impl: CliRunFn = async (program, args, timeoutMs) => {
    calls.push({ program, args, timeoutMs })
    return {
      exitCode: 0,
      stdout: '',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
      durationMs: 10,
      ...result,
    }
  }
  return { impl, calls }
}

const base64 = (bytes: Uint8Array) => bytesToBase64(bytes)

describe('命令执行适配器（注册表闸）', () => {
  it('已登记命令：按登记项组装固定参数与超时预算，解码输出', async () => {
    const { impl, calls } = stubCliRun({ stdout: base64(utf8Bytes('ipconfig 输出')) })
    const run = createCommandRunner(impl)
    const outcome = await run('ipconfig-all')
    expect(calls).toEqual([{ program: 'ipconfig', args: ['/all'], timeoutMs: 5000 }])
    expect(outcome).toMatchObject({ exitCode: 0, stdout: 'ipconfig 输出', timedOut: false })
  })

  it('追加参数按字面拼在固定参数之后', async () => {
    const { impl, calls } = stubCliRun()
    const run = createCommandRunner(impl)
    await run('ping-host', ['host.example'])
    expect(calls[0]?.args).toEqual(['-n', '4', 'host.example'])
    expect(calls[0]?.timeoutMs).toBe(8000)
  })

  it('未登记 ID：直接拒绝且不触碰 Bridge', async () => {
    const impl = vi.fn()
    const run = createCommandRunner(impl)
    await expect(run('format-c:')).rejects.toThrow('命令未登记')
    expect(impl).not.toHaveBeenCalled()
  })

  it('追加参数超限：拒绝且不触碰 Bridge', async () => {
    const impl = vi.fn()
    const run = createCommandRunner(impl)
    await expect(run('whoami', ['多余参数'])).rejects.toThrow('只允许追加 0 个参数')
    expect(impl).not.toHaveBeenCalled()
  })

  it('退出码非 0：正常返回结果（不 reject），stderr 如实呈现', async () => {
    const { impl } = stubCliRun({
      exitCode: 2,
      stdout: base64(utf8Bytes('部分输出')),
      stderr: base64(utf8Bytes('错误详情')),
    })
    const run = createCommandRunner(impl)
    await expect(run('whoami')).resolves.toMatchObject({
      exitCode: 2,
      stdout: '部分输出',
      stderr: '错误详情',
    })
  })

  it('超时结果：timedOut=true 原样透传，输出可能不完整', async () => {
    const { impl } = stubCliRun({
      exitCode: null,
      stdout: base64(utf8Bytes('残缺输出')),
      timedOut: true,
      durationMs: 10_000,
    })
    const run = createCommandRunner(impl)
    await expect(run('system-info')).resolves.toMatchObject({ timedOut: true, exitCode: null })
  })

  it('白名单拒绝（Bridge reject）：通道故障向上传播', async () => {
    const impl: CliRunFn = async () => {
      throw new Error('程序名不在白名单内：calc（仅允许 …）')
    }
    const run = createCommandRunner(impl)
    await expect(run('whoami')).rejects.toThrow('白名单')
  })

  it('GBK 兜底：GBK 字节流解码为可读中文（复用 utils/b64 兜底链）', async () => {
    // 语料取自 utils/b64 的 GBK 测试表（表外字符会退化为 '?'）
    const { impl } = stubCliRun({ stdout: base64(gbkBytes('中文：成功')) })
    const run = createCommandRunner(impl)
    const outcome = await run('whoami')
    expect(outcome.stdout).toBe('中文：成功')
  })

  it('截断标志透传', async () => {
    const { impl } = stubCliRun({ stdoutTruncated: true })
    const run = createCommandRunner(impl)
    await expect(run('task-list')).resolves.toMatchObject({ stdoutTruncated: true })
  })
})
