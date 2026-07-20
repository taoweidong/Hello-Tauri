import type { IPlatformAdapter } from '@/adapters/types'
import type { ParsedContent, FileTreeNode } from '@/types'
import type { PluginRegistry } from '@/plugins/registry'
import { FileDispatcher } from '@/core/file-dispatcher'
import { UNSUPPORTED_TYPE } from '@/config/archive-manifest'

/** 文件解析引擎，通过核心调度器按文件名识别类型并解析内容 */
export class ParserEngine {
  /** 核心文件调度器 */
  private dispatcher: FileDispatcher

  /**
   * 创建解析引擎实例
   * @param adapter - 平台适配器，用于读取文件
   * @param registry - 插件注册表，用于查找解析插件
   */
  constructor(
    private adapter: IPlatformAdapter,
    private registry: PluginRegistry
  ) {
    this.dispatcher = new FileDispatcher(registry)
  }

  /**
   * 解析指定文件节点的内容
   * 通过 FileDispatcher 统一调度：文件名 → 类型识别 → 解析器选择 → 执行解析
   * @param node - 文件树节点
   * @param archivePath - 归档路径前缀
   * @param encoding - 字符编码，默认 'utf-8'
   * @returns 解析结果，失败或不支持时返回 null
   */
  async resolveFile(node: FileTreeNode, archivePath: string, encoding = 'utf-8'): Promise<ParsedContent | null> {
    try {
      // 类型识别：不支持的文件直接返回 null
      const fileType = this.dispatcher.resolveType(node.label)
      if (fileType.type === UNSUPPORTED_TYPE) return null

      const data = await this.adapter.readFile(node.path)
      const result = await this.dispatcher.dispatch(node.label, data, { encoding })
      return result.content
    } catch (e) {
      console.warn(`[ParserEngine] 解析文件失败: ${node.path}`, e)
      return null
    }
  }
}
