import type { IFileParserPlugin, ConfigSchema } from '../types'
import { parseCsv } from '@/core/parsers/csv-parser'
import CsvRenderer from '@/views/renderers/CsvRenderer.vue'

export const csvPlugin: IFileParserPlugin = {
  name: 'csv',
  supportedExtensions: ['.csv', '.tsv'],
  canParse(file) {
    return this.supportedExtensions.some(ext => file.name.endsWith(ext))
  },
  async parse(data: Uint8Array, options?: Record<string, any>) {
    const text = new TextDecoder('utf-8').decode(data)
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
