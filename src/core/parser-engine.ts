import type { IPlatformAdapter } from '@/adapters/types'
import type { ParsedContent, FileTreeNode } from '@/types'
import type { PluginRegistry } from '@/plugins/registry'

export class ParserEngine {
  constructor(
    private adapter: IPlatformAdapter,
    private registry: PluginRegistry
  ) {}

  async resolveFile(node: FileTreeNode, archivePath: string, encoding = 'utf-8'): Promise<ParsedContent | null> {
    const start = performance.now()

    try {
      const data = await this.adapter.readFile(node.path)
      // 安全提取扩展名：无扩展名时回退为空字符串，匹配 hex 插件
      const dotIndex = node.label.lastIndexOf('.')
      const ext = dotIndex > 0 ? node.label.slice(dotIndex) : ''
      const plugin = this.registry.getParser(ext) ?? this.registry.getParser('')
      if (!plugin) return null

      const result = await this.registry.safeParse(plugin, data, { encoding })
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
