import type { IFileParserPlugin } from '../types'
import { parseText } from '@/core/parsers/text-parser'
import TextRenderer from '@/views/renderers/TextRenderer.vue'

export const textPlugin: IFileParserPlugin = {
  name: 'text',
  supportedExtensions: ['.txt', '.md', '.cfg', '.ini', '.env', '.yaml', '.yml', '.toml'],
  canParse(file) {
    return this.supportedExtensions.some(ext => file.name.endsWith(ext))
  },
  async parse(data: Uint8Array) {
    return parseText(data)
  },
  getComponent() {
    return TextRenderer
  },
}
