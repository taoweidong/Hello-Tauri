import type { IFileParserPlugin } from '../types'
import { decodeAndParseCsv } from '../helpers'
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
    return decodeAndParseCsv(data, options)
  },
  getComponent() {
    return TableTreeRenderer
  },
}
