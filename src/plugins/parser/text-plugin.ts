import type { IFileParserPlugin } from '../types'
import { parseText } from '@/plugins/parsers/text-parser'
import TextRenderer from '@/views/renderers/TextRenderer.vue'

export const textPlugin: IFileParserPlugin = {
  name: 'text',
  supportedExtensions: ['.txt', '.md', '.cfg', '.ini', '.env', '.yaml', '.yml', '.toml'],
  canParse(file) {
    return this.supportedExtensions.some(ext => file.name.endsWith(ext))
  },
  async parse(data: Uint8Array, options?: Record<string, any>) {
    return parseText(data, options?.encoding)
  },
  getComponent() {
    return TextRenderer
  },
}
