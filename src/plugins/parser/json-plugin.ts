import type { IFileParserPlugin } from '../types'
import { createExtensionMatcher, decodeText } from '../helpers'
import { parseJson } from '@/plugins/parsers/json-parser'
import JsonRenderer from '@/views/renderers/JsonRenderer.vue'

const EXTENSIONS = ['.json', '.jsonl']

/** JSON/JSONL 解析插件，支持标准 JSON 与按行分隔的 JSONL 格式 */
export const jsonPlugin: IFileParserPlugin = {
  name: 'json',
  supportedExtensions: EXTENSIONS,
  canParse: createExtensionMatcher(EXTENSIONS),
  async parse(data: Uint8Array, options?: Record<string, any>) {
    const text = decodeText(data, options?.encoding ?? 'utf-8')
    return parseJson(text)
  },
  getComponent() {
    return JsonRenderer
  },
}
