const store = new Map<string, Uint8Array>()

export function vfsWrite(path: string, data: Uint8Array): void {
  store.set(path, data)
}

export function vfsRead(path: string): Uint8Array | undefined {
  return store.get(path)
}

export function vfsHas(path: string): boolean {
  return store.has(path)
}

export function vfsClear(): void {
  store.clear()
}