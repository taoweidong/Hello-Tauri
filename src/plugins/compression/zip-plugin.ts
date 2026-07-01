import type { ICompressionPlugin } from '../types'
import type { FileEntry } from '@/adapters/types'

export const zipPlugin: ICompressionPlugin = {
  name: 'zip',
  supportedExtensions: ['.zip'],
  canHandle(file: FileEntry): boolean {
    return file.name.endsWith('.zip')
  },
  async decompress(data: Uint8Array, _outputDir: string) {
    if (__PLATFORM__ === 'tauri') {
      const { usePlatform } = await import('@/composables/use-platform')
      const { getAdapter } = usePlatform()
      const adapter = await getAdapter()
      return adapter.decompress(data, 'zip', _outputDir)
    }
    try {
      const { unzipSync } = await import('fflate')
      const { memoryStore } = await import('@/core/memory-store')
      const files: FileEntry[] = []
      const unzipped = unzipSync(data)
      for (const [name, content] of Object.entries(unzipped)) {
        const isDir = name.endsWith('/')
        if (!isDir) {
          memoryStore.write(name, content)
        }
        files.push({
          name,
          path: name,
          size: isDir ? 0 : content.length,
          isDirectory: isDir,
        })
      }
      return { success: true, files }
    } catch (err) {
      return { success: false, files: [], error: err instanceof Error ? err.message : 'ZIP decompression failed' }
    }
  },
}
