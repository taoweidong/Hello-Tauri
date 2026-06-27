import { describe, it, expect, beforeEach } from 'vitest'
import { useArchiveManager } from '@/composables/use-archives'

describe('useArchiveManager', () => {
  beforeEach(() => {
    const { reset } = useArchiveManager()
    reset()
  })

  it('adds files and creates archive items', () => {
    const { archives, addFiles } = useArchiveManager()
    const files = [
      new File(['test'], 'test.zip', { type: 'application/zip' }),
    ]
    addFiles(files)
    expect(archives.value).toHaveLength(1)
    expect(archives.value[0].name).toBe('test.zip')
    expect(archives.value[0].status).toBe('pending')
  })

  it('removes archive by id', () => {
    const { archives, addFiles, remove } = useArchiveManager()
    addFiles([new File(['test'], 'test.zip')])
    const id = archives.value[0].id
    remove(id)
    expect(archives.value).toHaveLength(0)
  })

  it('computes aggregate stats', () => {
    const { archives, addFiles, stats } = useArchiveManager()
    addFiles([
      new File(['abc'], 'a.zip'),
      new File(['defgh'], 'b.zip'),
    ])
    expect(stats.value.totalCount).toBe(2)
    expect(stats.value.totalCompressedSize).toBe(8)
  })

  it('sets startTime when status becomes running', () => {
    const { archives, addFiles, updateStatus } = useArchiveManager()
    addFiles([new File(['test'], 'test.zip')])
    const id = archives.value[0].id
    updateStatus(id, 'running')
    expect(archives.value[0].status).toBe('running')
    expect(archives.value[0].startTime).toBeTypeOf('number')
  })

  it('sets endTime when status becomes completed', () => {
    const { archives, addFiles, updateStatus } = useArchiveManager()
    addFiles([new File(['test'], 'test.zip')])
    const id = archives.value[0].id
    updateStatus(id, 'completed')
    expect(archives.value[0].status).toBe('completed')
    expect(archives.value[0].endTime).toBeTypeOf('number')
  })

  it('updates progress when provided', () => {
    const { archives, addFiles, updateStatus } = useArchiveManager()
    addFiles([new File(['test'], 'test.zip')])
    const id = archives.value[0].id
    updateStatus(id, 'running', 50)
    expect(archives.value[0].progress).toBe(50)
  })
})
