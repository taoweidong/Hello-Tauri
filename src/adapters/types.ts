import type { DecompressResult, FileEntry } from '@/types'

/**
 * 平台适配器接口
 * 抽象文件读取、写入、解压等操作，屏蔽 Web 与 Tauri 平台差异
 */
export interface IPlatformAdapter {
  /**
   * 读取指定路径的文件内容
   * @param path - 文件路径
   * @returns 文件内容的字节数组
   */
  readFile(path: string): Promise<Uint8Array>

  /**
   * 将数据写入指定路径的文件
   * @param path - 目标文件路径
   * @param data - 要写入的字节数组
   */
  writeFile(path: string, data: Uint8Array): Promise<void>

  /**
   * 列出指定目录下的文件列表
   * @param dir - 目录路径
   * @returns 文件条目数组
   */
  listFiles(dir: string): Promise<FileEntry[]>

  /**
   * 获取系统临时目录路径
   * @returns 临时目录路径字符串
   */
  getTempDir(): Promise<string>

  /**
   * 解压数据到指定目录
   * @param data - 压缩包字节数据
   * @param format - 压缩格式（如 'zip'、'gzip'）
   * @param outputDir - 输出目录路径
   * @param fileName - 输出文件名（可选，用于 gzip 等单文件压缩格式）
   * @returns 解压结果
   */
  decompress(data: Uint8Array, format: string, outputDir: string, fileName?: string): Promise<DecompressResult>

  /**
   * 内存映射读取（或 HTTP Range 请求），读取文件指定区间的字节
   * @param path - 文件路径
   * @param offset - 起始偏移量
   * @param length - 读取长度
   * @returns 指定区间的字节数组
   */
  mmapRead(path: string, offset: number, length: number): Promise<Uint8Array>

  /**
   * 流式读取文件内容
   * @param path - 文件路径
   * @returns 可读字节流
   */
  streamRead(path: string): ReadableStream<Uint8Array>
}
