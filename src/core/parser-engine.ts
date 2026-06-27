import type { IPlatformAdapter, ParsedContent, FileTreeNode } from '@/adapters/types'
import type { PluginRegistry } from '@/plugins/registry'

export class ParserEngine {
  constructor(
    private adapter: IPlatformAdapter,
    private registry: PluginRegistry
  ) {}

  async resolveFile(node: FileTreeNode, archivePath: string): Promise<ParsedContent | null> {
    const start = performance.now()

    try {
      const data = await this.adapter.readFile(archivePath + '/' + node.path)
      const ext = '.' + node.label.split('.').pop()
      const plugin = this.registry.getParser(ext) ?? this.registry.getParser('')
      if (!plugin) return null

      const result = await this.registry.safeParse(plugin, data)
      if (!result) return null

      return {
        type: result.type,
        data: result.data,
        lineCount: result.lineCount,
        loadTimeMs: performance.now() - start,
        pluginName: plugin.name,
      }
    } catch {
      return null
    }
  }
}
