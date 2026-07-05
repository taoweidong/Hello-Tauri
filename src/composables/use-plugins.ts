import { PluginRegistry } from '@/plugins/registry'
import { registerBuiltinPlugins } from '@/plugins/manifest'
import type { FileEntry } from '@/types'

/** 插件注册表单例（已注册内置插件） */
const registry = new PluginRegistry()
registerBuiltinPlugins(registry)

/** 插件引擎 composable，提供插件检测、解析、启停等操作 */
export function usePluginEngine() {
  return {
    /** 插件注册表实例 */
    registry,
    /**
     * 检测文件对应的解析插件
     * @param file - 文件条目
     * @returns 匹配的解析插件或 null
     */
    detect: (file: FileEntry) => registry.detect(file),
    /**
     * 根据扩展名获取解析插件
     * @param ext - 文件扩展名（含前导点）
     * @returns 对应的解析插件或 null
     */
    getParser: (ext: string) => registry.getParser(ext),
    /**
     * 根据扩展名获取压缩插件
     * @param ext - 文件扩展名（含前导点）
     * @returns 对应的压缩插件或 null
     */
    getCompression: (ext: string) => registry.getCompression(ext),
    /**
     * 启用指定插件
     * @param name - 插件名称
     */
    enable: (name: string) => registry.enable(name),
    /**
     * 禁用指定插件
     * @param name - 插件名称
     */
    disable: (name: string) => registry.disable(name),
  }
}
