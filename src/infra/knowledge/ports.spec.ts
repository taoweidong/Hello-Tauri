import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 知识库端口单测（knowledge-sedimentation 3.1）。
 *
 * fs 适配器与 mock 适配器共享 createKnowledgeCore 的全部语义，因此**同一组断言
 * 同时跑两个适配器**（对齐 infra/db 端口夹具思路）：语义只写一遍，两个适配器
 * 必须给出一致的可观察结果。fs 侧另有两项专属断言：
 *  * 对账次序——写文件调用必须先于写清单调用（K-G「先文件后清单」）；
 *  * 通道故障——fsWrite 抛错向上透传为 KnowledgeError(fs)，不静默吞掉。
 */
import { KnowledgeError, parseKnowledgeIndex, toKnowledgeFileName } from './port'
import { createFsKnowledgePort } from './knowledge-fs'
import { createMockKnowledgePort, peekMockKnowledgeFile, resetMockKnowledge, seedMockKnowledgeFile } from './mock'
import type { KnowledgePort } from './port'

type FsFn = (relative: string, content?: string) => Promise<string | null>

const db = vi.hoisted(() => ({
  platform: 'tauri',
  fsRead: vi.fn<FsFn>(),
  fsWrite: vi.fn<(relative: string, content: string) => Promise<void>>(),
}))

vi.mock('@/api', () => ({
  bridge: db,
  get platform() {
    return db.platform
  },
}))

/** 内存盘：fs 适配器与 mock 适配器共用同一份「文件系统」语义 */
function memoryDisk() {
  const files = new Map<string, string>()
  const read = vi.fn(async (relative: string) => files.get(relative) ?? null)
  const write = vi.fn(async (relative: string, content: string) => {
    files.set(relative, content)
  })
  return { files, read, write }
}

const disk = memoryDisk()

beforeEach(() => {
  disk.files.clear()
  disk.read.mockClear()
  disk.write.mockClear()
  db.fsRead.mockReset().mockImplementation((relative) => disk.read(relative))
  db.fsWrite.mockReset().mockImplementation((relative, content) => disk.write(relative, content))
  resetMockKnowledge()
})

describe('infra/knowledge —— 端口语义（fs 与 mock 双适配器同断言）', () => {
  /** 同一操作序列分别喂给两个适配器，收集可观察结果 */
  async function runScenario(makePort: () => KnowledgePort) {
    const port = makePort()
    const out: Record<string, unknown> = {}

    // 新建：文件与清单登记 + 来源标注
    out.saved = await port.saveDoc({
      file: '门禁-faq.md',
      title: '门禁常见问题',
      content: '门禁卡找行政办理。',
      source: 'extract',
    })
    out.list = await port.listDocs()
    out.content = await port.readDoc('门禁-faq.md')

    // 同名新建拒绝；覆盖保存放行并刷新时间与来源
    out.duplicate = await port.saveDoc({ file: '门禁-faq.md', title: '重复', content: '', source: 'manual' }).then(
      () => 'ok',
      (error: unknown) => (error instanceof KnowledgeError ? error.kind : 'unknown'),
    )
    out.overwritten = await port.saveDoc({
      file: '门禁-faq.md',
      title: '门禁常见问题',
      content: '更新后的正文。',
      source: 'extract',
      overwrite: true,
    })
    out.listAfterOverwrite = (await port.listDocs()).map((item) => ({ file: item.file, source: item.source }))

    // 并入既有文档：读旧 + 拼接 + 清单刷新；清单外/丢文件报 missing
    out.appended = await port.appendDoc({ file: '门禁-faq.md', content: '访客走大厅西侧。' })
    out.appendedContent = await port.readDoc('门禁-faq.md')
    out.appendMissing = await port.appendDoc({ file: 'ghost.md', content: 'x' }).then(
      () => 'ok',
      (error: unknown) => (error instanceof KnowledgeError ? error.kind : 'unknown'),
    )

    // 下架：清单移除、文件保留（readDoc 仍可读）
    await port.saveDoc({ file: 'qa-archive.md', title: '问答归档', content: 'Q/A', source: 'qa' })
    out.offShelf = await port.offShelf('qa-archive.md')
    out.offShelfAgain = await port.offShelf('qa-archive.md')
    out.offShelfContent = await port.readDoc('qa-archive.md')
    out.listAfterOffShelf = (await port.listDocs()).map((item) => item.file)

    // 登记手动文件：存在 → manual 来源；不存在 → missing；重复 → exists
    await port.saveDoc({ file: '手动放入.md', title: '手动放入', content: '内容', source: 'manual' })
    await port.offShelf('手动放入.md')
    out.register = await port.registerDoc({ file: '手动放入.md', title: '手动放入' })
    out.registerSource = (await port.listDocs()).find((item) => item.file === '手动放入.md')?.source
    out.registerMissing = await port.registerDoc({ file: 'no-such.md', title: '不存在' }).then(
      () => 'ok',
      (error: unknown) => (error instanceof KnowledgeError ? error.kind : 'unknown'),
    )
    out.registerDuplicate = await port.registerDoc({ file: '手动放入.md', title: '重复' }).then(
      () => 'ok',
      (error: unknown) => (error instanceof KnowledgeError ? error.kind : 'unknown'),
    )

    // 绑定解析：仅保留清单内文件、保序去重
    out.resolved = (await port.resolveDocs(['门禁-faq.md', 'ghost.md', '门禁-faq.md', '手动放入.md'])).map(
      (item) => item.file,
    )
    return out
  }

  it('fs 适配器（bridge 文件通道）', async () => {
    const out = await runScenario(() => createFsKnowledgePort())
    expect(out.saved).toMatchObject({ file: '门禁-faq.md', title: '门禁常见问题', source: 'extract' })
    expect(out.content).toBe('门禁卡找行政办理。')
    expect(out.duplicate).toBe('exists')
    expect(out.listAfterOverwrite).toEqual([{ file: '门禁-faq.md', source: 'extract' }])
    expect(out.appendedContent).toContain('更新后的正文。')
    expect(out.appendedContent).toContain('访客走大厅西侧。')
    expect(out.appendMissing).toBe('missing')
    expect(out.offShelf).toBe(true)
    expect(out.offShelfAgain).toBe(false)
    expect(out.offShelfContent).toBe('Q/A')
    expect(out.listAfterOffShelf).toEqual(['门禁-faq.md'])
    expect(out.registerSource).toBe('manual')
    expect(out.registerMissing).toBe('missing')
    expect(out.registerDuplicate).toBe('exists')
    expect(out.resolved).toEqual(['门禁-faq.md', '手动放入.md'])
  })

  it('mock 适配器（内存实现）与 fs 可观察结果一致', async () => {
    const diskOut = await runScenario(() => createFsKnowledgePort())
    const mockOut = await runScenario(() => createMockKnowledgePort())
    expect(mockOut).toEqual(diskOut)
  })

  it('fs 适配器对账次序：写文件先于写清单（K-G），通道故障透传为 fs 错误', async () => {
    const port = createFsKnowledgePort()
    await port.saveDoc({ file: 'a.md', title: 'A', content: '正文', source: 'manual' })
    const writeCalls = db.fsWrite.mock.calls.map((call) => call[0])
    expect(writeCalls).toEqual(['knowledge/a.md', 'knowledge/index.json'])

    db.fsWrite.mockRejectedValueOnce(new Error('disk full'))
    await expect(port.saveDoc({ file: 'b.md', title: 'B', content: '', source: 'manual' })).rejects.toThrow('disk full')
  })

  it('老清单缺 source 视为 manual（零迁移）；损坏清单报 fs 而非静默清空（防盲写覆盖）', async () => {
    disk.files.set(
      'knowledge/index.json',
      JSON.stringify({ docs: [{ file: 'legacy.md', title: '老条目', updatedAt: '2026-10-01 10:00:00' }] }),
    )
    const port = createFsKnowledgePort()
    expect(await port.listDocs()).toEqual([
      { file: 'legacy.md', title: '老条目', updatedAt: '2026-10-01 10:00:00', source: 'manual' },
    ])

    disk.files.set('knowledge/index.json', '{oops')
    await expect(port.listDocs()).rejects.toBeInstanceOf(KnowledgeError)
    // mock 适配器同款语义
    expect(parseKnowledgeIndex(JSON.stringify({ docs: [{ file: 'x.md' }] }))).toEqual([
      { file: 'x.md', title: 'x.md', updatedAt: '', source: 'manual' },
    ])
  })
})

describe('infra/knowledge —— 路径安全校验与子目录', () => {
  it('saveDoc 支持子目录路径（问答归档 qa-archive/<skill>/<月份>.md），非法路径报 fs', async () => {
    const port = createFsKnowledgePort()
    const entry = await port.saveDoc({
      file: 'qa-archive/door/2026-10.md',
      title: '问答归档·门禁助手·2026-10',
      content: '# 问答归档\n\n### 10:00\n',
      source: 'qa',
    })
    expect(entry).toMatchObject({ file: 'qa-archive/door/2026-10.md', source: 'qa' })
    expect(disk.files.get('knowledge/index.json')).toContain('qa-archive/door/2026-10.md')
    for (const bad of ['../escape.md', '/abs.md', 'a\\b.md', 'no-ext', 'a//b.md', 'a/./b.md']) {
      await expect(port.saveDoc({ file: bad, title: 'x', content: '', source: 'manual' })).rejects.toBeInstanceOf(
        KnowledgeError,
      )
    }
  })
})

describe('infra/knowledge —— 文件名收敛与 mock 预置', () => {
  it('toKnowledgeFileName：空派生自标题、非法字符转连字符、保证 .md 后缀', () => {
    expect(toKnowledgeFileName('', '门禁 常见/问题')).toBe('门禁-常见-问题.md')
    expect(toKnowledgeFileName('VPN FAQ.md', 'x')).toBe('vpn-faq.md')
    expect(toKnowledgeFileName('///', 'x')).toBe('') // 归一化后为空 → 返回空串，调用方判空提示（与原 KnowledgeCard 行为一致）
    expect(toKnowledgeFileName('', '')).toBe('')
  })

  it('mock 适配器：seed 模拟手动放入的文件，peek 检查清单落盘形状', async () => {
    seedMockKnowledgeFile('knowledge/seeded.md', '手工正文')
    const port = createMockKnowledgePort()
    const entry = await port.registerDoc({ file: 'seeded.md', title: '种子' })
    expect(entry.source).toBe('manual')
    const index = JSON.parse(peekMockKnowledgeFile('knowledge/index.json') ?? '{}') as { docs: unknown[] }
    expect(index.docs).toHaveLength(1)
  })
})
