import type { PluginRegistry } from './registry'
import { zipPlugin } from './compression/zip-plugin'
import { gzipPlugin } from './compression/gzip-plugin'
import { textPlugin } from './parser/text-plugin'
import { csvPlugin } from './parser/csv-plugin'
import { jsonPlugin } from './parser/json-plugin'
import { logPlugin } from './parser/log-plugin'
import { hexPlugin } from './parser/hex-plugin'
import { tableTreePlugin } from './parser/table-tree-plugin'

/**
 * 注册所有内置插件到注册表
 * 包含压缩插件（zip、gzip）与解析插件（text、csv、json、log、hex、table-tree）
 * @param registry - 插件注册表实例
 */
export function registerBuiltinPlugins(registry: PluginRegistry): void {
  registry.registerCompression(zipPlugin)
  registry.registerCompression(gzipPlugin)

  registry.registerParser(textPlugin)
  registry.registerParser(csvPlugin)
  registry.registerParser(jsonPlugin)
  registry.registerParser(logPlugin)
  registry.registerParser(hexPlugin)
  registry.registerParser(tableTreePlugin)
}
