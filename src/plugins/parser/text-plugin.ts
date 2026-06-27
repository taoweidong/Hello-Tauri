import { defineComponent, h } from 'vue'
import type { IFileParserPlugin } from '../types'

const TextRenderer = defineComponent({
  name: 'TextRenderer',
  props: {
    content: { type: String, required: true },
    showLineNumbers: { type: Boolean, default: true },
    wrap: { type: Boolean, default: false },
    fontSize: { type: Number, default: 14 },
  },
  setup(props) {
    return () => {
      const lines = props.content.split('\n')
      return h('div', {
        style: {
          fontFamily: '"JetBrains Mono", "Fira Code", monospace',
          fontSize: `${props.fontSize}px`,
          whiteSpace: props.wrap ? 'pre-wrap' : 'pre',
          overflow: 'auto',
          height: '100%',
          padding: '8px',
        }
      }, lines.map((line, i) =>
        h('div', { key: i, style: { display: 'flex' } }, [
          props.showLineNumbers
            ? h('span', {
                style: {
                  color: '#666',
                  minWidth: '3em',
                  textAlign: 'right',
                  paddingRight: '1em',
                  userSelect: 'none',
                }
              }, String(i + 1))
            : null,
          h('span', line),
        ])
      ))
    }
  }
})

export const textPlugin: IFileParserPlugin = {
  name: 'text',
  supportedExtensions: ['.txt', '.log', '.md', '.cfg', '.ini', '.env', '.yaml', '.yml', '.toml'],
  canParse(file) {
    return this.supportedExtensions.some(ext => file.name.endsWith(ext))
  },
  async parse(data: Uint8Array) {
    const text = new TextDecoder('utf-8').decode(data)
    const lineCount = text.length === 0 ? 0 : text.split('\n').length
    return { type: 'text' as const, data: text, lineCount }
  },
  getComponent() {
    return TextRenderer
  },
}
