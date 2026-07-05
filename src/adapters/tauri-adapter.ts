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

/**
 * Uint8Array 转 base64 字符串（用于大文件 IPC 传输优化）
 * 相比 Array.from() 的 JSON 序列化，base64 可减少约 3-5 倍的传输体积
 */
function uint8ArrayToBase64(data: Uint8Array): string {
  let binary = ''
  const chunkSize = 8192
  for (let i = 0; i < data.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, Array.from(data.subarray(i, i + chunkSize)))
  }
  return btoa(binary)
}

/**
 * base64 字符串转 Uint8Array
 */
function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

export class TauriAdapter implements IPlatformAdapter {
  async readFile(path: string): Promise<Uint8Array> {
    const fn = await getInvoke()
    // TODO: 大文件优化 - 后端返回 base64 字符串，前端解码
    // 当前使用 Array 传输，小文件可接受，大文件建议改用 base64
    const data = await fn('read_file', { path })
    return new Uint8Array(data)
  }

  async writeFile(path: string, data: Uint8Array): Promise<void> {
    const fn = await getInvoke()
    // TODO: 大文件优化 - 使用 base64 编码传输
    // await fn('write_file', { path, data: uint8ArrayToBase64(data), encoding: 'base64' })
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
    // TODO: 大文件优化 - 使用 base64 编码传输
    // return fn('decompress', { data: uint8ArrayToBase64(data), format, outputDir, encoding: 'base64' })
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
