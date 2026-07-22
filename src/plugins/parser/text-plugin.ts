import type { IFileParserPlugin } from '../types'
import { createExtensionMatcher } from '../helpers'
import { parseText } from '@/plugins/parsers/text-parser'
import TextRenderer from '@/views/renderers/TextRenderer.vue'

const EXTENSIONS = ['.txt', '.md', '.cfg', '.ini', '.env', '.yaml', '.yml', '.toml']

/** 纯文本解析插件，支持 txt、md、cfg、ini、env、yaml、toml 等格式 */
export const textPlugin: IFileParserPlugin = {
  name: 'text',
  supportedExtensions: EXTENSIONS,
  canParse: createExtensionMatcher(EXTENSIONS),
  async parse(data: Uint8Array, options?: Record<string, any>) {
    return parseText(data, options?.encoding)
  },
  getComponent() {
    return TextRenderer
  },
}
