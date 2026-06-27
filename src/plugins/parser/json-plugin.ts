import { defineComponent, h } from 'vue'
import type { IFileParserPlugin } from '../types'

const JsonRenderer = defineComponent({
  name: 'JsonRenderer',
  props: {
    content: { required: true },
    fontSize: { type: Number, default: 14 },
  },
  setup(props) {
    return () => {
      const formatted = typeof props.content === 'string'
        ? props.content
        : JSON.stringify(props.content, null, 2)
      return h('pre', {
        style: {
          fontFamily: '"JetBrains Mono", monospace',
          fontSize: `${props.fontSize}px`,
          padding: '8px',
          overflow: 'auto',
          height: '100%',
          margin: 0,
          whiteSpace: 'pre-wrap',
        }
      }, formatted)
    }
  }
})

export const jsonPlugin: IFileParserPlugin = {
  name: 'json',
  supportedExtensions: ['.json', '.jsonl'],
  canParse(file) {
    return this.supportedExtensions.some(ext => file.name.endsWith(ext))
  },
  async parse(data: Uint8Array) {
    const text = new TextDecoder('utf-8').decode(data)
    const isJsonl = text.trimStart().startsWith('{') && text.includes('\n')
    let parsed: unknown
    try {
      if (isJsonl) {
        parsed = text.split('\n').filter(l => l.trim()).map(line => JSON.parse(line))
      } else {
        parsed = JSON.parse(text)
      }
    } catch (err) {
      throw new Error(`Invalid JSON: ${err instanceof Error ? err.message : 'parse error'}`)
    }
    const formatted = JSON.stringify(parsed, null, 2)
    return {
      type: 'json' as const,
      data: parsed,
      lineCount: formatted.split('\n').length,
    }
  },
  getComponent() {
    return JsonRenderer
  },
}
