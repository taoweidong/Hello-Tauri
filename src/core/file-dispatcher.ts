/**
 * 核心文件调度器
 * 职责：文件名 → 类型识别 → 解析器选择 → 渲染器分派
 * 所有下游消费方（PreviewPane、ParserEngine、FileTree 等）均通过此调度器获取结果
 *
 * 架构关系：
 * archive-manifest.ts（配置源）→ file-dispatcher.ts（调度中心）→ registry.ts（插件库）
 */
import type { Component } from 'vue'
import { defineComponent, h } from 'vue'
import type { IFileParserPlugin } from '@/plugins/types'
import type { ParsedContent } from '@/types'
import type { PluginRegistry } from '@/plugins/registry'
import { UNSUPPORTED_TYPE } from '@/config/archive-manifest'

/** 文件类型识别结果 */
export interface FileTypeInfo {
  /** 业务类型标识（如 'csv'、'table-tree'、'log'、'unsupported'） */
  type: string
  /** 匹配的规则来源（用于调试/日志） */
  matchedBy: 'nameRule' | 'suffixRule' | 'prefixRule' | 'none'
}

/** 调度结果：类型 + 解析数据 + 渲染组件 */
export interface DispatchResult {
  /** 文件类型信息 */
  fileType: FileTypeInfo
  /** 解析后的内容（unsupported 时为 null） */
  content: ParsedContent | null
  /** 对应的 Vue 渲染组件 */
  renderer: Component
  /** 解析耗时（ms） */
  loadTimeMs: number
}

/** "不支持解压展示"占位组件 */
export const UnsupportedPlaceholder = defineComponent({
  name: 'UnsupportedPlaceholder',
  props: {
    fileName: { type: String, default: '' },
  },
  setup(props) {
    return () => h('div', {
      style: {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        gap: '12px',
        color: 'var(--color-text-3, #999)',
        fontSize: '14px',
      },
    }, [
      h('span', { style: { fontSize: '48px' } }, '🚫'),
      h('span', {}, '不支持解压展示'),
      props.fileName ? h('span', { style: { fontSize: '12px', opacity: '0.7' } }, props.fileName) : null,
    ])
  },
})

/**
 * 核心文件调度器
 * 唯一的"文件名 → 类型 → 解析器 → 渲染器"调度中心
 */
export class FileDispatcher {
  constructor(private registry: PluginRegistry) {}

  /**
   * 类型识别：按 ARCHIVE_MANIFEST 优先级匹配
   * 顺序：nameRules → suffixRules → prefixRules → unsupported
   * @param fileName - 文件名
   * @returns 文件类型信息
   */
  resolveType(fileName: string): FileTypeInfo {
    const type = this.registry.resolveFileType(fileName)
    if (type === UNSUPPORTED_TYPE) {
      return { type: UNSUPPORTED_TYPE, matchedBy: 'none' }
    }
    // 根据匹配来源标注 matchedBy（用于调试）
    // 由于 registry.resolveFileType 已封装了优先级逻辑，此处简化为按类型推断
    return { type, matchedBy: this.inferMatchSource(fileName, type) }
  }

  /**
   * 根据文件名获取对应的解析插件
   * @param fileName - 文件名
   * @returns 解析插件或 null（不支持时）
   */
  getParserFor(fileName: string): IFileParserPlugin | null {
    const type = this.registry.resolveFileType(fileName)
    if (type === UNSUPPORTED_TYPE) return null
    return this.registry.getParserByName(type)
  }

  /**
   * 根据文件名获取对应的 Vue 渲染组件
   * @param fileName - 文件名
   * @returns Vue 渲染组件（不支持时返回 UnsupportedPlaceholder）
   */
  getRendererFor(fileName: string): Component {
    const type = this.registry.resolveFileType(fileName)
    if (type === UNSUPPORTED_TYPE) return UnsupportedPlaceholder
    const plugin = this.registry.getParserByName(type)
    return plugin?.getComponent() ?? UnsupportedPlaceholder
  }

  /**
   * 一站式调度：类型识别 + 解析执行 + 结果打包
   * PreviewPane 只需调用此方法，无需关心内部调度逻辑
   * @param fileName - 文件名
   * @param data - 文件字节数据
   * @param options - 解析选项
   * @returns 调度结果
   */
  async dispatch(fileName: string, data: Uint8Array, options?: Record<string, any>): Promise<DispatchResult> {
    const start = performance.now()
    const fileType = this.resolveType(fileName)

    if (fileType.type === UNSUPPORTED_TYPE) {
      return { fileType, content: null, renderer: UnsupportedPlaceholder, loadTimeMs: 0 }
    }

    const plugin = this.registry.getParserByName(fileType.type)
    if (!plugin) {
      return { fileType, content: null, renderer: UnsupportedPlaceholder, loadTimeMs: 0 }
    }

    const result = await this.registry.safeParse(plugin, data, options)
    if (!result) {
      return { fileType, content: null, renderer: UnsupportedPlaceholder, loadTimeMs: 0 }
    }
    return {
      fileType,
      content: { ...result, loadTimeMs: performance.now() - start, pluginName: plugin.name } as ParsedContent,
      renderer: plugin.getComponent(),
      loadTimeMs: performance.now() - start,
    }
  }

  /** 推断匹配来源（仅用于调试标注） */
  private inferMatchSource(fileName: string, _type: string): FileTypeInfo['matchedBy'] {
    // 简化判断：有扩展名走 suffix/name，无扩展名走 prefix
    const dotIndex = fileName.lastIndexOf('.')
    if (dotIndex <= 0) return 'prefixRule'
    return 'suffixRule'
  }
}
