import type { Component } from 'vue'
import type { DecompressResult, FileEntry, ParsedContent } from '@/types'

/**
 * 判断文件名是否匹配任一支持的扩展名
 * @param fileName - 文件名
 * @param extensions - 支持的扩展名列表（含前导点）
 * @returns 是否匹配
 */
export function matchesAnyExtension(fileName: string, extensions: string[]): boolean {
  return extensions.some(ext => fileName.endsWith(ext))
}

/** 插件配置字段定义 */
export interface ConfigField {
  /** 字段键名 */
  key: string
  /** 显示标签 */
  label: string
  /** 表单控件类型 */
  type: 'input' | 'select' | 'switch' | 'number'
  /** 默认值 */
  default: any
  /** 下拉选项（仅 type='select' 时有效） */
  options?: { label: string; value: any }[]
}

/** 插件配置模式描述 */
export interface ConfigSchema {
  /** 配置字段列表 */
  fields: ConfigField[]
}

/**
 * 压缩插件接口
 * 实现此接口以支持新的压缩格式
 */
export interface ICompressionPlugin {
  /** 插件名称（唯一标识） */
  name: string
  /** 支持的扩展名列表（含前导点） */
  supportedExtensions: string[]
  /**
   * 判断是否能处理指定文件
   * @param file - 文件条目
   * @returns 是否支持
   */
  canHandle(file: FileEntry): boolean
  /**
   * 执行解压操作
   * @param data - 压缩包字节数据
   * @param outputDir - 输出目录
   * @returns 解压结果
   */
  decompress(data: Uint8Array, outputDir: string): Promise<DecompressResult>
}

/**
 * 文件解析插件接口
 * 实现此接口以支持新的文件类型解析与渲染
 */
export interface IFileParserPlugin {
  /** 插件名称（唯一标识） */
  name: string
  /** 支持的扩展名列表（含前导点） */
  supportedExtensions: string[]
  /**
   * 判断是否能解析指定文件
   * @param file - 文件条目
   * @returns 是否支持
   */
  canParse(file: FileEntry): boolean
  /**
   * 解析文件内容
   * @param data - 文件字节数据
   * @param options - 解析选项（如编码、分隔符等）
   * @returns 解析结果
   */
  parse(data: Uint8Array, options?: Record<string, any>): Promise<ParsedContent>
  /**
   * 获取对应的 Vue 渲染组件
   * @returns Vue 组件
   */
  getComponent(): Component
  /**
   * 获取插件配置模式（可选）
   * @returns 配置模式描述
   */
  getConfigSchema?(): ConfigSchema
}

/** ParsedResult 是 ParsedContent 的别名，保持向后兼容 */
export type ParsedResult = ParsedContent
