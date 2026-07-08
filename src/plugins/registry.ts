import type { ICompressionPlugin, IFileParserPlugin, ParsedResult } from './types'
import type { DecompressResult, FileEntry } from '@/types'

/** 插件执行超时时间（毫秒） */
const PLUGIN_TIMEOUT_MS = 30000

/**
 * 为 Promise 添加超时保护
 * @param promise - 原始 Promise
 * @param ms - 超时毫秒数
 * @returns 带超时的 Promise
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error('Plugin timeout')), ms) }),
  ])
}

/**
 * 插件注册表
 * 管理解析插件与压缩插件的注册、查找、启停与安全执行
 */
export class PluginRegistry {
  /** 已注册的压缩插件（按名称索引） */
  private compressionPlugins = new Map<string, ICompressionPlugin>()
  /** 已注册的解析插件（按名称索引） */
  private parserPlugins = new Map<string, IFileParserPlugin>()
  /** 扩展名到解析插件名称的映射 */
  private extToParser = new Map<string, string>()
  /** 扩展名到压缩插件名称的映射 */
  private extToCompression = new Map<string, string>()
  /** 已禁用的插件名称集合 */
  private disabled = new Set<string>()

  /**
   * 注册解析插件
   * @param plugin - 解析插件实例
   */
  registerParser(plugin: IFileParserPlugin): void {
    this.parserPlugins.set(plugin.name, plugin)
    for (const ext of plugin.supportedExtensions) {
      this.extToParser.set(ext, plugin.name)
    }
  }

  /**
   * 注册压缩插件
   * @param plugin - 压缩插件实例
   */
  registerCompression(plugin: ICompressionPlugin): void {
    this.compressionPlugins.set(plugin.name, plugin)
    for (const ext of plugin.supportedExtensions) {
      this.extToCompression.set(ext, plugin.name)
    }
  }

  /**
   * 根据扩展名获取解析插件
   * @param ext - 文件扩展名（含前导点）
   * @returns 对应的解析插件，未找到或已禁用时返回 null
   */
  getParser(ext: string): IFileParserPlugin | null {
    const name = this.extToParser.get(ext)
    if (!name || this.disabled.has(name)) return null
    return this.parserPlugins.get(name) ?? null
  }

  /**
   * 根据扩展名获取压缩插件
   * @param ext - 文件扩展名（含前导点）
   * @returns 对应的压缩插件，未找到或已禁用时返回 null
   */
  getCompression(ext: string): ICompressionPlugin | null {
    const name = this.extToCompression.get(ext)
    if (!name || this.disabled.has(name)) return null
    return this.compressionPlugins.get(name) ?? null
  }

  /**
   * 根据文件条目自动检测对应的解析插件
   * @param file - 文件条目
   * @returns 匹配的解析插件或 null
   */
  detect(file: FileEntry): IFileParserPlugin | null {
    for (const [ext, name] of this.extToParser) {
      if (file.name.endsWith(ext) && !this.disabled.has(name)) {
        return this.parserPlugins.get(name) ?? null
      }
    }
    return null
  }

  /**
   * 根据文件条目自动检测对应的压缩插件
   * @param file - 文件条目
   * @returns 匹配的压缩插件或 null
   */
  detectCompression(file: FileEntry): ICompressionPlugin | null {
    for (const [ext, name] of this.extToCompression) {
      if (file.name.endsWith(ext) && !this.disabled.has(name)) {
        return this.compressionPlugins.get(name) ?? null
      }
    }
    return null
  }

  /**
   * 启用指定插件
   * @param name - 插件名称
   */
  enable(name: string): void {
    this.disabled.delete(name)
  }

  /**
   * 禁用指定插件
   * @param name - 插件名称
   */
  disable(name: string): void {
    this.disabled.add(name)
  }

  /**
   * 判断插件是否已启用
   * @param name - 插件名称
   * @returns 是否启用
   */
  isEnabled(name: string): boolean {
    return !this.disabled.has(name)
  }

  /**
   * 判断是否已注册指定名称的解析插件
   * @param name - 插件名称
   * @returns 是否已注册
   */
  hasParser(name: string): boolean {
    return this.parserPlugins.has(name)
  }

  /**
   * 判断是否已注册指定名称的压缩插件
   * @param name - 插件名称
   * @returns 是否已注册
   */
  hasCompression(name: string): boolean {
    return this.compressionPlugins.has(name)
  }

  /** 获取所有已注册的解析插件名称列表 */
  getParserNames(): string[] {
    return Array.from(this.parserPlugins.keys())
  }

  /** 获取所有已注册的压缩插件名称列表 */
  getCompressionNames(): string[] {
    return Array.from(this.compressionPlugins.keys())
  }

  /**
   * 根据文件名检测对应的解析插件
   * @param fileName - 文件名
   * @returns 匹配的解析插件或 null
   */
  detectByFileName(fileName: string): IFileParserPlugin | null {
    const ext = '.' + (fileName.split('.').pop() ?? '')
    return this.getParser(ext)
  }

  /**
   * 安全执行解析插件（带超时保护）
   * 失败时回退为 hex 类型展示
   * @param plugin - 解析插件
   * @param data - 文件字节数据
   * @param options - 解析选项
   * @returns 解析结果
   */
  async safeParse(plugin: IFileParserPlugin, data: Uint8Array, options?: Record<string, any>): Promise<ParsedResult> {
    try {
      return await withTimeout(plugin.parse(data, options), PLUGIN_TIMEOUT_MS)
    } catch (e) {
      console.warn(`[Registry] 插件 ${plugin.name} 解析失败，回退为 hex 展示`, e)
      return { type: 'hex', data: data }
    }
  }

  /**
   * 安全执行压缩插件（带超时保护）
   * @param plugin - 压缩插件
   * @param data - 压缩包字节数据
   * @param outputDir - 输出目录
   * @param file - 原始文件信息（可选，用于推断输出文件名）
   * @returns 解压结果
   */
  async safeDecompress(plugin: ICompressionPlugin, data: Uint8Array, outputDir: string, file?: { name: string }): Promise<DecompressResult> {
    try {
      return await withTimeout(plugin.decompress(data, outputDir, file), PLUGIN_TIMEOUT_MS)
    } catch (err) {
      return {
        success: false,
        files: [],
        error: err instanceof Error ? err.message : '解压失败',
      }
    }
  }
}
