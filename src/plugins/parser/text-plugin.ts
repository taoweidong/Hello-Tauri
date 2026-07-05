import type { IFileParserPlugin } from '../types'
import { matchesAnyExtension } from '../types'
import { parseText } from '@/plugins/parsers/text-parser'
import TextRenderer from '@/views/renderers/TextRenderer.vue'

/** 纯文本解析插件，支持 txt、md、cfg、ini、env、yaml、toml 等格式 */
export const textPlugin: IFileParserPlugin = {
  name: 'text',
  supportedExtensions: ['.txt', '.md', '.cfg', '.ini', '.env', '.yaml', '.yml', '.toml'],
  canParse(file) {
    return matchesAnyExtension(file.name, this.supportedExtensions)
  },
  async parse(data: Uint8Array, options?: Record<string, any>) {
    return parseText(data, options?.encoding)
  },
  getComponent() {
    return TextRenderer
  },
}
