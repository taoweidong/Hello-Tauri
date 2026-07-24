import type { IPlatformAdapter } from './types'
import type { FileEntry } from '@/types'
import { memoryStore } from '@/core/memory-store'

/**
 * Web 平台适配器实现
 * 使用 fetch API 和内存存储实现文件读取，不支持写入和原生解压
 */
export class WebAdapter implements IPlatformAdapter {
  /** 读取文件，优先从内存存储获取，否则通过 HTTP 请求 */
  async readFile(path: string): Promise<Uint8Array> {
    const cached = memoryStore.read(path)
    if (cached) return cached
    const response = await fetch(path)
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    const buffer = await response.arrayBuffer()
    return new Uint8Array(buffer)
  }

  /** Web 模式不支持文件写入 */
  async writeFile(_path: string, _data: Uint8Array): Promise<void> {
    throw new Error('writeFile is not supported in Web mode')
  }

  /** Web 模式不支持目录列表 */
  async listFiles(_dir: string): Promise<FileEntry[]> {
    throw new Error('listFiles is not supported in Web mode')
  }

  /** 返回固定的临时目录路径 */
  async getTempDir(): Promise<string> {
    return '/tmp/web'
  }

  /** 通过 HTTP Range 请求读取文件指定区间 */
  async mmapRead(path: string, offset: number, length: number): Promise<Uint8Array> {
    const cached = memoryStore.read(path)
    if (cached) return cached.slice(offset, offset + length)
    const response = await fetch(path, {
      headers: { Range: `bytes=${offset}-${offset + length - 1}` }
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    const buffer = await response.arrayBuffer()
    return new Uint8Array(buffer)
  }

  /** 流式读取文件，优先从内存存储获取，否则通过 fetch 流式传输 */
  streamRead(path: string): ReadableStream<Uint8Array> {
    const cached = memoryStore.read(path)
    if (cached) {
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(cached)
          controller.close()
        }
      })
    }
    return new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          const response = await fetch(path)
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const reader = response.body?.getReader()
          if (!reader) { controller.close(); return }
          while (true) {
            const { done, value } = await reader.read()
            if (done) { controller.close(); break }
            controller.enqueue(value)
          }
        } catch (e) {
          controller.error(e)
        }
      }
    })
  }
}

/** Web 平台适配器全局单例 */
export default new WebAdapter()
