import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { TableRow } from '@/types'
import { csvFileName, toCsv } from './csv'

/** CSV 导出（R-3）：转义规则 / BOM / 文件名格式 / fs 通道写入路径 */

const { fsWrite } = vi.hoisted(() => ({
  fsWrite: vi.fn(async (_relative: string, _content: string): Promise<string> => 'D:\\TangYuan\\exports\\x.csv'),
}))

vi.mock('@/api', () => ({
  bridge: { fsWrite: (relative: string, content: string) => fsWrite(relative, content) },
}))

function row(overrides: Partial<TableRow> = {}): TableRow {
  return {
    id: 1,
    name: '记录一',
    category: '分类A',
    status: 'active',
    amount: 12.5,
    owner: '张三',
    createdAt: '2026-10-03 09:00:00',
    ...overrides,
  }
}

describe('csv 导出', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('表头固定中文列，行按列序拼接', () => {
    const csv = toCsv([row()])
    const lines = csv.replace(/^\uFEFF/, '').trim().split('\r\n')
    expect(lines[0]).toBe('编号,名称,分类,状态,金额,负责人,创建日期')
    expect(lines[1]).toBe('1,记录一,分类A,active,12.5,张三,2026-10-03 09:00:00')
  })

  it('含逗号/引号/换行的单元格：双引号包裹并转义内部引号', () => {
    const csv = toCsv([row({ name: '带,逗号', owner: '说"你好"\n换行' })])
    expect(csv).toContain('"带,逗号"')
    expect(csv).toContain('"说""你好""\n换行"')
  })

  it('BOM 头：Excel 打开 UTF-8 中文不乱码', () => {
    expect(toCsv([row()]).startsWith('\uFEFF')).toBe(true)
  })

  it('csvFileName：exports/ 下按本地时间戳命名', () => {
    const name = csvFileName(new Date(2026, 9, 3, 9, 5, 1))
    expect(name).toBe('exports/records-20261003-090501.csv')
  })

  it('exportRecordsCsv：经 fs 通道写存储根 exports/（Rust 防路径穿越）', async () => {
    const { exportRecordsCsv } = await import('./csv')
    const path = await exportRecordsCsv([row()])
    expect(fsWrite).toHaveBeenCalledTimes(1)
    const [relative, content] = fsWrite.mock.calls[0]
    expect(relative).toMatch(/^exports\/records-\d{8}-\d{6}\.csv$/)
    expect(content.startsWith('\uFEFF')).toBe(true)
    expect(path).toBe('D:\\TangYuan\\exports\\x.csv')
  })
})
