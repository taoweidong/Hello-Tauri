import type { IPlatformAdapter } from '@/adapters/types'
import type { ParsedContent, FileTreeNode } from '@/types'
import type { PluginRegistry } from '@/plugins/registry'

/** 文件解析引擎，根据文件扩展名选择插件并解析内容 */
export class ParserEngine {
  /**
   * 创建解析引擎实例
   * @param adapter - 平台适配器，用于读取文件
   * @param registry - 插件注册表，用于查找解析插件
   */
  constructor(
    private adapter: IPlatformAdapter,
    private registry: PluginRegistry
  ) {}

  /**
   * 解析指定文件节点的内容
   * @param node - 文件树节点
   * @param archivePath - 归档路径前缀
   * @param encoding - 字符编码，默认 'utf-8'
   * @returns 解析结果，失败时返回 null
   */
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
        ...result,
        loadTimeMs: performance.now() - start,
        pluginName: plugin.name,
      } as ParsedContent
    } catch {
      return null
    }
  }
}
