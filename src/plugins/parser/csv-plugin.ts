import type { IFileParserPlugin, ConfigSchema } from '../types'
import { matchesAnyExtension } from '../types'
import { parseCsv } from '@/plugins/parsers/csv-parser'
import CsvRenderer from '@/views/renderers/CsvRenderer.vue'

/** CSV/TSV 解析插件，支持自定义分隔符与固定表头 */
export const csvPlugin: IFileParserPlugin = {
  name: 'csv',
  supportedExtensions: ['.csv', '.tsv'],
  canParse(file) {
    return matchesAnyExtension(file.name, this.supportedExtensions)
  },
  async parse(data: Uint8Array, options?: Record<string, any>) {
    const encoding = options?.encoding ?? 'utf-8'
    const text = new TextDecoder(encoding).decode(data)
    const delimiter = options?.delimiter ?? ','
    return parseCsv(text, delimiter)
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
