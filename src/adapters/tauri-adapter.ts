import type { IPlatformAdapter } from './types'
import type { FileEntry, DecompressResult } from '@/types'

/** 懒加载 Tauri invoke 函数（避免非 Tauri 环境报错） */
let invoke: (cmd: string, args?: Record<string, unknown>) => Promise<any>

/** 获取 Tauri invoke 函数单例 */
async function getInvoke() {
  if (!invoke) {
    const tauri = await import('@tauri-apps/api/core')
    invoke = tauri.invoke
  }
  return invoke
}

/**
 * Tauri 平台适配器实现
 * 通过 Tauri IPC 调用 Rust 后端命令实现文件操作
 */
export class TauriAdapter implements IPlatformAdapter {
  /** 通过 IPC 调用 Rust 后端读取文件 */
  async readFile(path: string): Promise<Uint8Array> {
    const fn = await getInvoke()
    const data = await fn('read_file', { path })
    return new Uint8Array(data)
  }

  /** 通过 IPC 调用 Rust 后端写入文件 */
  async writeFile(path: string, data: Uint8Array): Promise<void> {
    const fn = await getInvoke()
    await fn('write_file', { path, data: Array.from(data) })
  }

  /** 通过 IPC 调用 Rust 后端列出目录文件 */
  async listFiles(dir: string): Promise<FileEntry[]> {
    const fn = await getInvoke()
    return fn('list_files', { dir })
  }

  /** 通过 IPC 获取系统临时目录 */
  async getTempDir(): Promise<string> {
    const fn = await getInvoke()
    return fn('get_temp_dir')
  }

  /** 通过 IPC 调用 Rust 后端执行解压操作 */
  async decompress(data: Uint8Array, format: string, outputDir: string, fileName?: string): Promise<DecompressResult> {
    const fn = await getInvoke()
    return fn('decompress', { data: Array.from(data), format, outputDir, fileName: fileName ?? null })
  }

  /** 通过 IPC 调用 Rust 后端内存映射读取 */
  async mmapRead(path: string, offset: number, length: number): Promise<Uint8Array> {
    const fn = await getInvoke()
    const data = await fn('mmap_read', { path, offset, length })
    return new Uint8Array(data)
  }

  /** 流式读取（当前为全量读取后包装为 ReadableStream） */
  streamRead(path: string): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      async start(controller) {
        const fn = await getInvoke()
        const data: number[] = await fn('read_file', { path })
        controller.enqueue(new Uint8Array(data))
        controller.close()
      }
    })
  }
}

/** Tauri 平台适配器全局单例 */
export default new TauriAdapter()
