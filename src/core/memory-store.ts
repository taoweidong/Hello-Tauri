export class MemoryStore {
  private store = new Map<string, Uint8Array>()

  write(path: string, data: Uint8Array): void {
    this.store.set(path, data)
  }

  read(path: string): Uint8Array | undefined {
    return this.store.get(path)
  }

  has(path: string): boolean {
    return this.store.has(path)
  }

  clear(): void {
    this.store.clear()
  }

  get size(): number {
    return this.store.size
  }
}

export const memoryStore = new MemoryStore()
