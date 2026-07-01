import type { DecompressResult, FileEntry } from '@/types'

export interface IPlatformAdapter {
  readFile(path: string): Promise<Uint8Array>
  writeFile(path: string, data: Uint8Array): Promise<void>
  listFiles(dir: string): Promise<FileEntry[]>
  getTempDir(): Promise<string>
  decompress(data: Uint8Array, format: string, outputDir: string): Promise<DecompressResult>
  mmapRead(path: string, offset: number, length: number): Promise<Uint8Array>
  streamRead(path: string): ReadableStream<Uint8Array>
}
