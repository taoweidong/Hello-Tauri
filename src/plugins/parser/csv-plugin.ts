import type { IFileParserPlugin, ConfigSchema } from '../types'
import { createExtensionMatcher, decodeAndParseCsv } from '../helpers'
import CsvRenderer from '@/views/renderers/CsvRenderer.vue'

const EXTENSIONS = ['.csv', '.tsv']

/** CSV/TSV 解析插件，支持自定义分隔符与固定表头 */
export const csvPlugin: IFileParserPlugin = {
  name: 'csv',
  supportedExtensions: EXTENSIONS,
  canParse: createExtensionMatcher(EXTENSIONS),
  async parse(data: Uint8Array, options?: Record<string, any>) {
    return decodeAndParseCsv(data, options)
  },
  getComponent() {
    return CsvRenderer
  },
  getConfigSchema(): ConfigSchema {
    return {
      fields: [
        { key: 'delimiter', label: '分隔符', type: 'input', default: ',' },
        { key: 'fixedHeader', label: '固定表头', type: 'switch', default: true },
      ]
    }
  },
}
