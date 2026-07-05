import { describe, it, expect, beforeEach } from 'vitest'
import { MemoryStore } from '@/core/memory-store'

describe('MemoryStore', () => {
  let store: MemoryStore

  beforeEach(() => {
    // 使用小容量上限方便测试淘汰逻辑
    store = new MemoryStore(100)
  })

  it('写入后可读取', () => {
    const data = new Uint8Array([1, 2, 3])
    store.write('/a.bin', data)
    expect(store.read('/a.bin')).toEqual(data)
  })

  it('has 返回正确的存在性', () => {
    expect(store.has('/a.bin')).toBe(false)
    store.write('/a.bin', new Uint8Array(1))
    expect(store.has('/a.bin')).toBe(true)
  })

  it('read 不存在的 key 返回 undefined', () => {
    expect(store.read('/missing')).toBeUndefined()
  })

  it('size 和 usedBytes 反映当前状态', () => {
    expect(store.size).toBe(0)
    expect(store.usedBytes).toBe(0)
    store.write('/a', new Uint8Array(30))
    store.write('/b', new Uint8Array(20))
    expect(store.size).toBe(2)
    expect(store.usedBytes).toBe(50)
  })

  it('覆盖写入同一路径时更新 usedBytes', () => {
    store.write('/a', new Uint8Array(30))
    expect(store.usedBytes).toBe(30)
    store.write('/a', new Uint8Array(10))
    expect(store.usedBytes).toBe(10)
    expect(store.size).toBe(1)
  })

  it('clear 清空所有数据和计数', () => {
    store.write('/a', new Uint8Array(10))
    store.write('/b', new Uint8Array(20))
    store.clear()
    expect(store.size).toBe(0)
    expect(store.usedBytes).toBe(0)
    expect(store.has('/a')).toBe(false)
  })

  it('超出容量上限时触发 LRU 淘汰', () => {
    store.write('/first', new Uint8Array(40))
    store.write('/second', new Uint8Array(40))
    expect(store.size).toBe(2)
    expect(store.usedBytes).toBe(80)

    // 再写入 30 字节将超出 100 上限，应淘汰 /first
    store.write('/third', new Uint8Array(30))
    expect(store.has('/first')).toBe(false)
    expect(store.has('/second')).toBe(true)
    expect(store.has('/third')).toBe(true)
    expect(store.usedBytes).toBe(70)
  })

  it('淘汰多条数据直到有足够空间', () => {
    store.write('/a', new Uint8Array(30))
    store.write('/b', new Uint8Array(30))
    store.write('/c', new Uint8Array(30))
    // 已用 90，再写 20 → 110 > 100，淘汰 /a 后 60+20=80 ≤ 100
    store.write('/d', new Uint8Array(20))
    expect(store.has('/a')).toBe(false)
    expect(store.has('/b')).toBe(true)
    expect(store.has('/d')).toBe(true)
  })

  it('单条数据超过总容量时淘汰全部旧数据', () => {
    store.write('/a', new Uint8Array(30))
    store.write('/b', new Uint8Array(30))
    // 写入 100 字节（等于总容量），需淘汰所有旧数据
    store.write('/big', new Uint8Array(100))
    expect(store.size).toBe(1)
    expect(store.has('/big')).toBe(true)
    expect(store.usedBytes).toBe(100)
  })
})
