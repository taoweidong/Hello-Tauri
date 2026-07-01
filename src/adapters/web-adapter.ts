import type { IPlatformAdapter, FileEntry, DecompressResult } from './types'
import { vfsRead, vfsHas } from '@/core/vfs'

export class WebAdapter implements IPlatformAdapter {
  async readFile(path: string): Promise<Uint8Array> {
    const cached = vfsRead(path)
    if (cached) return cached
    const response = await fetch(path)
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    const buffer = await response.arrayBuffer()
    return new Uint8Array(buffer)
  }

  async writeFile(_path: string, _data: Uint8Array): Promise<void> {
    throw new Error('writeFile is not supported in Web mode')
  }

  async listFiles(_dir: string): Promise<FileEntry[]> {
    throw new Error('listFiles is not supported in Web mode')
  }

  async getTempDir(): Promise<string> {
    return '/tmp/web'
  }

  async decompress(_data: Uint8Array, _format: string, _outputDir: string): Promise<DecompressResult> {
    throw new Error('decompress is not supported in Web mode without WASM')
  }

  async mmapRead(path: string, offset: number, length: number): Promise<Uint8Array> {
    const cached = vfsRead(path)
    if (cached) return cached.slice(offset, offset + length)
    const response = await fetch(path, {
      headers: { Range: `bytes=${offset}-${offset + length - 1}` }
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    const buffer = await response.arrayBuffer()
    return new Uint8Array(buffer)
  }

  streamRead(path: string): ReadableStream<Uint8Array> {
    const cached = vfsRead(path)
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

export default new WebAdapter()
