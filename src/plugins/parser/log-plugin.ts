import type { IFileParserPlugin } from '../types'
import { matchesAnyExtension } from '../types'
import { parseLog } from '@/plugins/parsers/log-parser'
import LogRenderer from '@/views/renderers/LogRenderer.vue'

/** 日志文件解析插件，支持标准格式日志（时间戳 + 级别 + 模块 + 消息） */
export const logPlugin: IFileParserPlugin = {
  name: 'log',
  supportedExtensions: ['.log'],
  canParse(file) {
    return matchesAnyExtension(file.name, this.supportedExtensions)
  },
  async parse(data: Uint8Array, options?: Record<string, any>) {
    return parseLog(data, options?.encoding)
  },
  getComponent() {
    return LogRenderer
  },
}
