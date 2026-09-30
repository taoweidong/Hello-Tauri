import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 建群端口夹具（migration v3，与 `ports.spec.ts` 的消息端口同构）。
 *
 * 覆盖与实现无关的契约：
 *  1. `create-group` 参数整体传递（不经 shell，中文/逗号成员串安全）；
 *  2. 输出解析「宽进严出」：字段名容错，但非法 JSON 必须报 parse 错；
 *  3. **建群绝不重试**：CLI 实现不得对 transport 错自动重试（重试可能建出两个群）；
 *  4. mock 的确定性故障注入供编排层失败路径测试。
 */
import { createGroupArgs } from '@/infra/welink/commands'
import { parseCreateGroupOutput } from '@/infra/welink/adapter'
import { createMockGroupPort } from '@/infra/welink/group-mock'
import { createCliGroupPort } from '@/infra/welink/group-cli'

const cliBridge = vi.hoisted(() => ({
  cliRun: vi.fn(),
}))

vi.mock('@/api', () => ({
  bridge: cliBridge,
  platform: 'tauri',
}))

import { WelinkError } from '@/infra/welink/port'

/** UTF-8 → base64（模拟 Rust 侧的回传编码） */
function b64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64')
}

describe('infra/welink/group —— createGroupArgs（真实接口的唯一改动面）', () => {
  it('子命令 + --name + --members + --json，成员串用半角逗号连接', () => {
    expect(createGroupArgs('项目周会群', ['E-0001', 'E-0002'])).toEqual([
      'create-group',
      '--name',
      '项目周会群',
      '--members',
      'E-0001,E-0002',
      '--json',
    ])
  })

  it('群名称与成员串各自是独立参数元素（引号/换行不会被拆分）', () => {
    const args = createGroupArgs('他说："建个群"', ['E-1'])
    expect(args).toContain('他说："建个群"')
    expect(args[args.indexOf('--name') + 1]).toBe('他说："建个群"')
  })
})

describe('infra/welink/group —— parseCreateGroupOutput（宽进严出）', () => {
  it('字段名容错：groupId / group_id / convId / id 都能取到群 ID', () => {
    for (const key of ['groupId', 'group_id', 'convId', 'conv_id', 'chatId', 'id']) {
      expect(parseCreateGroupOutput(JSON.stringify({ [key]: 'G-9' }), 'seed')).toBe('G-9')
    }
  })

  it('CLI 未回传群 ID 时用种子派生占位（建群动作已发生，不能谎报失败）', () => {
    expect(parseCreateGroupOutput(JSON.stringify({ ok: true }), 'seed-1')).toBe('local-seed-1')
  })

  it('非法 JSON / 空输出报 parse 错（结构不符必须显性暴露）', () => {
    expect(() => parseCreateGroupOutput('{oops', 'seed')).toThrow(WelinkError)
    expect(() => parseCreateGroupOutput('', 'seed')).toThrow(/create-group：输出为空/)
    try {
      parseCreateGroupOutput('{oops', 'seed')
    } catch (error) {
      expect((error as WelinkError).kind).toBe('parse')
    }
  })
})

describe('infra/welink/group —— mock 端口契约', () => {
  it('返回唯一群 ID 并记账（外呼参数可审计）', async () => {
    const port = createMockGroupPort()
    const first = await port.createGroup({ name: '周会群', memberIds: ['E-1', 'E-2'] })
    const second = await port.createGroup({ name: '周会群', memberIds: ['E-1', 'E-2'] })
    expect(first.groupId).not.toBe(second.groupId)
    expect(port.state.created).toHaveLength(2)
    expect(port.state.created[0]).toMatchObject({ name: '周会群', memberIds: ['E-1', 'E-2'] })
  })

  it('确定性故障注入：failNextCreate 只影响接下来的 N 次，且归为 transport', async () => {
    const port = createMockGroupPort()
    port.failNextCreate(2)
    await expect(port.createGroup({ name: 'g', memberIds: ['E-1'] })).rejects.toMatchObject({ kind: 'transport' })
    await expect(port.createGroup({ name: 'g', memberIds: ['E-1'] })).rejects.toMatchObject({ kind: 'transport' })
    await expect(port.createGroup({ name: 'g', memberIds: ['E-1'] })).resolves.toBeTruthy()
  })

  it('reset 清空状态（用例间隔离）', async () => {
    const port = createMockGroupPort()
    await port.createGroup({ name: 'g', memberIds: ['E-1'] })
    expect(port.state.createCount).toBe(1)
    port.reset()
    expect(port.state.createCount).toBe(0)
    expect(port.state.created).toHaveLength(0)
  })
})

describe('infra/welink/group —— CLI 适配器', () => {
  beforeEach(() => {
    cliBridge.cliRun.mockReset()
    cliBridge.cliRun.mockResolvedValue({
      exitCode: 0,
      stdout: b64(JSON.stringify({ groupId: 'G-777' })),
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
      durationMs: 12,
    })
  })

  it('走 cliRun 白名单通道，参数原样传递，返回解析后的群 ID', async () => {
    const port = createCliGroupPort({ cliPath: 'D:/tools/welink-cli.exe' })
    const result = await port.createGroup({ name: '项目群', memberIds: ['E-1', 'E-2'] })
    expect(result).toEqual({ groupId: 'G-777' })
    expect(cliBridge.cliRun).toHaveBeenCalledWith(
      'D:/tools/welink-cli.exe',
      ['create-group', '--name', '项目群', '--members', 'E-1,E-2', '--json'],
      undefined,
    )
  })

  it('退出码非 0 → parse 错（CLI 自报错误，重试无意义）', async () => {
    cliBridge.cliRun.mockResolvedValue({
      exitCode: 1,
      stdout: b64(''),
      stderr: b64('成员不存在：E-9999'),
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
      durationMs: 30,
    })
    const port = createCliGroupPort({ cliPath: 'welink-cli' })
    await expect(port.createGroup({ name: 'g', memberIds: ['E-9999'] })).rejects.toMatchObject({ kind: 'parse' })
  })

  it('超时 → transport 错，且**只调用一次**（建群不能自动重试）', async () => {
    cliBridge.cliRun.mockResolvedValue({
      exitCode: null,
      stdout: b64(''),
      stderr: b64(''),
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: true,
      durationMs: 15_000,
    })
    const port = createCliGroupPort({ cliPath: 'welink-cli' })
    await expect(port.createGroup({ name: 'g', memberIds: ['E-1'] })).rejects.toMatchObject({ kind: 'transport' })
    expect(cliBridge.cliRun).toHaveBeenCalledTimes(1)
  })

  it('通道故障（进程起不来）→ transport 错，同样不重试', async () => {
    cliBridge.cliRun.mockRejectedValue(new Error('启动子进程失败'))
    const port = createCliGroupPort({ cliPath: 'welink-cli' })
    await expect(port.createGroup({ name: 'g', memberIds: ['E-1'] })).rejects.toMatchObject({ kind: 'transport' })
    expect(cliBridge.cliRun).toHaveBeenCalledTimes(1)
  })
})
