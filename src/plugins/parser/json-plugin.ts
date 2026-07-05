import type { IFileParserPlugin } from '../types'
import { matchesAnyExtension } from '../types'
import { parseJson } from '@/plugins/parsers/json-parser'
import JsonRenderer from '@/views/renderers/JsonRenderer.vue'

/** JSON/JSONL 解析插件，支持标准 JSON 与按行分隔的 JSONL 格式 */
export const jsonPlugin: IFileParserPlugin = {
  name: 'json',
  supportedExtensions: ['.json', '.jsonl'],
  canParse(file) {
    return matchesAnyExtension(file.name, this.supportedExtensions)
  },
  async parse(data: Uint8Array, options?: Record<string, any>) {
    const encoding = options?.encoding ?? 'utf-8'
    const text = new TextDecoder(encoding).decode(data)
    return parseJson(text)
  },
  getComponent() {
    return JsonRenderer
  },
}
