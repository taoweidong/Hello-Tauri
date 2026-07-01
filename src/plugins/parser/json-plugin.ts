import type { IFileParserPlugin } from '../types'
import { parseJson } from '@/plugins/parsers/json-parser'
import JsonRenderer from '@/views/renderers/JsonRenderer.vue'

export const jsonPlugin: IFileParserPlugin = {
  name: 'json',
  supportedExtensions: ['.json', '.jsonl'],
  canParse(file) {
    return this.supportedExtensions.some(ext => file.name.endsWith(ext))
  },
  async parse(data: Uint8Array) {
    const text = new TextDecoder('utf-8').decode(data)
    return parseJson(text)
  },
  getComponent() {
    return JsonRenderer
  },
}
