import type { IFileParserPlugin } from '../types'
import { parseLog } from '@/plugins/parsers/log-parser'
import LogRenderer from '@/views/renderers/LogRenderer.vue'

export const logPlugin: IFileParserPlugin = {
  name: 'log',
  supportedExtensions: ['.log'],
  canParse(file) {
    return this.supportedExtensions.some(ext => file.name.endsWith(ext))
  },
  async parse(data: Uint8Array, options?: Record<string, any>) {
    return parseLog(data, options?.encoding)
  },
  getComponent() {
    return LogRenderer
  },
}
