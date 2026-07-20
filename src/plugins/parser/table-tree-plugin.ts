import type { IFileParserPlugin } from '../types'
import { parseCsv } from '@/plugins/parsers/csv-parser'
import TableTreeRenderer from '@/views/renderers/TableTreeRenderer.vue'

/** 表格+树形联动解析插件，用于 *_table_tree.csv 类型文件 */
export const tableTreePlugin: IFileParserPlugin = {
  name: 'table-tree',
  supportedExtensions: [],
  canParse(file) {
    // 通过文件名中的 _table_tree.csv 后缀修饰符识别
    return /_table_tree\.csv$/i.test(file.name)
  },
  async parse(data: Uint8Array, options?: Record<string, any>) {
    const encoding = options?.encoding ?? 'utf-8'
    const text = new TextDecoder(encoding).decode(data)
    const delimiter = options?.delimiter ?? ','
    return parseCsv(text, delimiter)
  },
  getComponent() {
    return TableTreeRenderer
  },
}
