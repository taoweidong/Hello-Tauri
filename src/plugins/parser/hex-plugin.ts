import { defineComponent, h } from 'vue'
import type { IFileParserPlugin } from '../types'

const HexRenderer = defineComponent({
  name: 'HexRenderer',
  props: {
    content: { required: true },
    fontSize: { type: Number, default: 14 },
  },
  setup(props) {
    return () => {
      const data = props.content as Uint8Array
      const lines: string[] = []
      const bytesPerLine = 16
      for (let i = 0; i < data.length; i += bytesPerLine) {
        const slice = data.slice(i, i + bytesPerLine)
        const hex = Array.from(slice).map(b => b.toString(16).padStart(2, '0')).join(' ')
        const ascii = Array.from(slice).map(b => b >= 32 && b < 127 ? String.fromCharCode(b) : '.').join('')
        const offset = i.toString(16).padStart(8, '0')
        lines.push(`${offset}  ${hex.padEnd(47)}  ${ascii}`)
      }
      return h('pre', {
        style: {
          fontFamily: '"JetBrains Mono", monospace',
          fontSize: `${props.fontSize}px`,
          padding: '8px',
          overflow: 'auto',
          height: '100%',
          margin: 0,
        }
      }, lines.join('\n'))
    }
  }
})

export const hexPlugin: IFileParserPlugin = {
  name: 'hex',
  supportedExtensions: [],
  canParse() {
    return true
  },
  async parse(data: Uint8Array) {
    return {
      type: 'hex' as const,
      data: data,
      lineCount: Math.ceil(data.length / 16),
    }
  },
  getComponent() {
    return HexRenderer
  },
}
