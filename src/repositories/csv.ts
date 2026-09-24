import { bridge } from '@/api'
import type { TableRow } from '@/types'

/** CSV 单元格转义：含逗号/引号/换行时用双引号包裹并转义内部引号 */
function cell(value: string | number): string {
  const text = String(value)
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

/** 导出文件名带时间戳，落盘到存储根 exports/ 下 */
export function csvFileName(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `exports/records-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}.csv`
  )
}

export function toCsv(rows: TableRow[]): string {
  const header = ['编号', '名称', '分类', '状态', '金额', '负责人', '创建日期']
  const lines = rows.map((row) =>
    [row.id, row.name, row.category, row.status, row.amount, row.owner, row.createdAt].map(cell).join(','),
  )
  // BOM：Excel 打开 UTF-8 中文不乱码
  return '\uFEFF' + [header.join(','), ...lines].join('\r\n') + '\r\n'
}

/** 通过 fs 通道写 CSV（Rust 侧防路径穿越），返回落盘绝对路径 */
export async function exportRecordsCsv(rows: TableRow[]): Promise<string> {
  return bridge.fsWrite(csvFileName(), toCsv(rows))
}

/** 浏览器调试降级：走下载而不是写盘 */
export function downloadCsv(rows: TableRow[], filename = 'records.csv') {
  const blob = new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}