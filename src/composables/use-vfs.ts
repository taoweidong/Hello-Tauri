import { usePlatform } from './use-platform'

/** 虚拟文件系统 composable，通过平台适配器提供文件读取与目录列表能力 */
export function useVirtualFileSystem() {
  const { getAdapter } = usePlatform()

  /**
   * 读取指定路径的文件内容
   * @param path - 文件路径
   * @returns 文件内容的字节数组
   */
  async function readFile(path: string): Promise<Uint8Array> {
    const adapter = await getAdapter()
    return adapter.readFile(path)
  }

  /**
   * 列出指定目录下的文件
   * @param dir - 目录路径
   * @returns 文件条目数组
   */
  async function listDir(dir: string) {
    const adapter = await getAdapter()
    return adapter.listFiles(dir)
  }

  return { readFile, listDir }
}
