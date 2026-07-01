import type { IPlatformAdapter } from './types'
import type { FileEntry, DecompressResult } from '@/types'

let invoke: (cmd: string, args?: Record<string, unknown>) => Promise<any>

async function getInvoke() {
  if (!invoke) {
    const tauri = await import('@tauri-apps/api/core')
    invoke = tauri.invoke
  }
  return invoke
}

export class TauriAdapter implements IPlatformAdapter {
  async readFile(path: string): Promise<Uint8Array> {
    const fn = await getInvoke()
    const data = await fn('read_file', { path })
    return new Uint8Array(data)
  }

  async writeFile(path: string, data: Uint8Array): Promise<void> {
    const fn = await getInvoke()
    await fn('write_file', { path, data: Array.from(data) })
  }

  async listFiles(dir: string): Promise<FileEntry[]> {
    const fn = await getInvoke()
    return fn('list_files', { dir })
  }

  async getTempDir(): Promise<string> {
    const fn = await getInvoke()
    return fn('get_temp_dir')
  }

  async decompress(data: Uint8Array, format: string, outputDir: string): Promise<DecompressResult> {
    const fn = await getInvoke()
    return fn('decompress', { data: Array.from(data), format, outputDir })
  }

  async mmapRead(path: string, offset: number, length: number): Promise<Uint8Array> {
    const fn = await getInvoke()
    const data = await fn('mmap_read', { path, offset, length })
    return new Uint8Array(data)
  }

  // Tauri IPC 不支持原生流式传输，当前为全量读取后包装为 ReadableStream
  // 后续可通过 Tauri Events 或 tauri-plugin-fs 实现分块读取
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

export default new TauriAdapter()
