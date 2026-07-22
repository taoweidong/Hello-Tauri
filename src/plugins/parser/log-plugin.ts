import type { IFileParserPlugin } from '../types'
import { createExtensionMatcher } from '../helpers'
import { parseLog } from '@/plugins/parsers/log-parser'
import LogRenderer from '@/views/renderers/LogRenderer.vue'

/** 无扩展名日志文件的前缀匹配规则（APPLOG1/2/3、MSGLOG1/2/3） */
const LOG_PREFIX_RE = /^(APPLOG|MSGLOG)/i

const EXTENSIONS = ['.log']
/** 扩展名匹配器 */
const matchesLogExt = createExtensionMatcher(EXTENSIONS)

/** 日志文件解析插件，支持 .log 后缀及 APPLOG/MSGLOG 前缀的无扩展名文件 */
export const logPlugin: IFileParserPlugin = {
  name: 'log',
  supportedExtensions: EXTENSIONS,
  canParse(file) {
    // 后缀匹配：.log 文件
    if (matchesLogExt(file)) return true
    // 前缀匹配：无扩展名的 APPLOG*/MSGLOG* 文件
    return LOG_PREFIX_RE.test(file.name)
  },
  async parse(data: Uint8Array, options?: Record<string, any>) {
    return parseLog(data, options?.encoding)
  },
  getComponent() {
    return LogRenderer
  },
}
