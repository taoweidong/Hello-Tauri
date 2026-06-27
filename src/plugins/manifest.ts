import type { PluginRegistry } from './registry'
import { zipPlugin } from './compression/zip-plugin'
import { gzipPlugin } from './compression/gzip-plugin'
import { textPlugin } from './parser/text-plugin'
import { csvPlugin } from './parser/csv-plugin'
import { jsonPlugin } from './parser/json-plugin'
import { hexPlugin } from './parser/hex-plugin'

export function registerBuiltinPlugins(registry: PluginRegistry): void {
  registry.registerCompression(zipPlugin)
  registry.registerCompression(gzipPlugin)

  registry.registerParser(textPlugin)
  registry.registerParser(csvPlugin)
  registry.registerParser(jsonPlugin)
  registry.registerParser(hexPlugin)
}
