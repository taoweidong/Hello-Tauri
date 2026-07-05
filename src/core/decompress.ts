import type { IPlatformAdapter } from '@/adapters/types'
import type { DecompressResult, FileEntry } from '@/types'
import type { PluginRegistry } from '@/plugins/registry'

/** 解压服务，通过插件注册表检测并执行解压操作 */
export class DecompressService {
  constructor(
    private adapter: IPlatformAdapter,
    private registry: PluginRegistry
  ) {}

  /**
   * 解压文件数据
   * @param data - 压缩包字节数据
   * @param fileName - 文件名（用于检测压缩格式）
   * @param outputDir - 输出目录
   * @returns 解压结果
   */
  async decompress(data: Uint8Array, fileName: string, outputDir: string): Promise<DecompressResult> {
    const fileEntry: FileEntry = {
      name: fileName,
      path: fileName,
      size: data.length,
      isDirectory: false,
    }

    const plugin = this.registry.detectCompression(fileEntry)
    if (!plugin) {
      return { success: false, files: [], error: `No compression plugin for: ${fileName}` }
    }

    return this.registry.safeDecompress(plugin, data, outputDir)
  }
}
