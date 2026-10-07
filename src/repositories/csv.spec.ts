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
    const lines = csv
      .replace(/^\uFEFF/, '')
      .trim()
      .split('\r\n')
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

/**
 * CSV 公式注入防护（S-09）。
 *
 * 用户可自由输入 name/category/owner 等字段，填入公式后导出并用 Excel 打开
 * 会被求值（外联风险 + 历史上出现过的 `+cmd|'/C calc'!A0` 本地命令载荷）。
 */
describe('csv —— 公式注入防护（S-09）', () => {
  it('危险前缀被前置单引号（Excel 当纯文本）', async () => {
    const { toCsv } = await import('./csv')
    const csv = toCsv([row({ name: '=HYPERLINK("http://evil/x","点我")' })])
    expect(csv).toContain("'=HYPERLINK")
    // 原文仍在（只加前缀，不丢数据）
    expect(csv).toContain('HYPERLINK')
  })

  it('覆盖全部危险前缀：= + - @ 以及前导空白/制表符', async () => {
    const { toCsv } = await import('./csv')
    const payloads = [
      '=1+1',
      "+cmd|'/C calc'!A0",
      "-2+3+cmd|'/C calc'!A0",
      '@SUM(A1)',
      '\t=1+1', // 前导制表符：Excel 忽略后仍会求值
      ' =1+1', // 前导空格同理
    ]
    const csv = toCsv(payloads.map((payload, index) => row({ id: index, name: payload })))
    for (const payload of payloads) {
      expect(csv).toContain(`'${payload}`)
    }
  })

  it('正常值不受影响（不加多余引号）', async () => {
    const { toCsv } = await import('./csv')
    const csv = toCsv([row({ name: '记录一', owner: '张三', amount: 12.5 })])
    expect(csv).toContain('记录一')
    expect(csv).toContain('张三')
    // 正常文本没有被前置单引号污染
    expect(csv).not.toContain("'记录一")
  })

  it('负数金额不被误伤（金额列是 number，前置单引号会变成文本）', async () => {
    const { toCsv } = await import('./csv')
    const csv = toCsv([row({ amount: -12.5 })])
    expect(csv).toContain('-12.5')
    expect(csv).not.toContain("'-12.5")
  })
})
