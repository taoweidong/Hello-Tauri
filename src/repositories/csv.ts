import { bridge } from '@/api'
import type { TableRow } from '@/types'

/**
 * 会触发电子表格软件求值的字符前缀（CSV 公式注入）。
 *
 * `=`是公式本体；`-`/`+` 是「负数/正数」在Excel 里的等价公式入口
 * （`-2+3+cmd|'/C calc'!A0` 这类payload 就靠它）；`@` 是早期 Lotus 1-2-3
 * 与部分现代表格软件的函数前缀。此外**前导空白/制表符也要防**——
 * Excel 会忽略前导空格再求值，`" =1+1"` 同样危险。
 */
const FORMULA_PREFIX = /^[=+\-@]/

/**
 * CSV 单元格转义：含逗号/引号/换行时用双引号包裹并转义内部引号。
 *
 * **公式注入防护（S-09）**：用户可自由输入「名称/分类/负责人」等字段，
 * 填入 `=HYPERLINK("http://evil/x","点我")` 后导出，用 Excel 打开会被当公式
 * 求值（既有外联风险，历史上还出现过 `+cmd|'/C calc'!A0` 这类本地命令）。
 * 处置：命中危险前缀时前置**单引号**（OWASP 口径）—— Excel 把它当纯文本。
 *
 * 取舍说明：前置单引号在部分表格软件里会显示出来（`'=1+1`）。这是行业通行
 * 的取舍；另一种做法是用 `="..."` 包裹，但对含引号的内容转义更麻烦。
 */
function cell(value: string | number): string {
  // 数字直接放行：`-12.5` 这类负数金额是正常业务数据，不是公式载荷。
  // 用户的公式攻击只可能落在**文本字段**上（名称/分类/负责人/创建日期），
  // 而 `amount` 是 `number` 类型 —— 前置单引号会把它变成文本，破坏 Excel 里的
  // 数值求和与排序。所以只对字符串做注入判定。
  if (typeof value === 'number') return String(value)
  let text = value
  // 判定危险字符时忽略前导空白/制表符（Excel 求值前会忽略它们），
  // 但单引号加在**原始文本**最前 —— 用户输入的前导空白是他数据的一部分。
  if (FORMULA_PREFIX.test(text.replace(/^[\t\r ]+/, ''))) text = `'${text}`
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
