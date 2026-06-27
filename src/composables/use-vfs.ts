import { usePlatform } from './use-platform'

export function useVirtualFileSystem() {
  const { getAdapter } = usePlatform()

  async function readFile(path: string): Promise<Uint8Array> {
    const adapter = await getAdapter()
    return adapter.readFile(path)
  }

  async function listDir(dir: string) {
    const adapter = await getAdapter()
    return adapter.listFiles(dir)
  }

  return { readFile, listDir }
}
