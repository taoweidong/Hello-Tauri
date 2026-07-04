import type { ICompressionPlugin } from '../types'
import type { FileEntry } from '@/types'

export const gzipPlugin: ICompressionPlugin = {
  name: 'gzip',
  supportedExtensions: ['.gz', '.gzip', '.tgz'],
  canHandle(file: FileEntry): boolean {
    return this.supportedExtensions.some(ext => file.name.endsWith(ext))
  },
  async decompress(data: Uint8Array, _outputDir: string) {
    if (__PLATFORM__ === 'tauri') {
      const { usePlatform } = await import('@/composables/use-platform')
      const { getAdapter } = usePlatform()
      const adapter = await getAdapter()
      return adapter.decompress(data, 'gzip', _outputDir)
    }
    if (typeof DecompressionStream !== 'undefined') {
      const ds = new DecompressionStream('gzip')
      const writer = ds.writable.getWriter()
      const reader = ds.readable.getReader()
      writer.write(data as BufferSource)
      writer.close()
      const chunks: Uint8Array[] = []
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
      }
      const total = chunks.reduce((acc, c) => acc + c.length, 0)
      const result = new Uint8Array(total)
      let offset = 0
      for (const chunk of chunks) {
        result.set(chunk, offset)
        offset += chunk.length
      }
      // 将解压结果写入内存存储，供后续 readFile 使用
      const { memoryStore } = await import('@/core/memory-store')
      const filePath = 'decompressed'
      memoryStore.write(filePath, result)
      return {
        success: true,
        files: [{ name: 'decompressed', path: filePath, size: result.length, isDirectory: false }],
      }
    }
    return { success: false, files: [], error: 'Gzip decompression not available' }
  },
}
