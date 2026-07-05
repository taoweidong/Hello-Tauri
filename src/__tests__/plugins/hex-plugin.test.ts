import { describe, it, expect } from 'vitest'
import { hexPlugin } from '@/plugins/parser/hex-plugin'
import { mount } from '@vue/test-utils'

describe('hexPlugin', () => {
  it('canParse always returns true (fallback parser)', () => {
    expect(hexPlugin.canParse({ name: 'file.bin', path: '/', size: 0, isDirectory: false })).toBe(true)
  })

  it('parse returns hex dump with correct lineCount', async () => {
    const data = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f])
    const result = await hexPlugin.parse(data)
    expect(result.type).toBe('hex')
    expect(result.data).toBe(data)
    expect(result.lineCount).toBe(1)
  })

  it('parse handles empty data', async () => {
    const data = new Uint8Array(0)
    const result = await hexPlugin.parse(data)
    expect(result.lineCount).toBe(0)
  })

  it('parse handles data larger than 16 bytes (multiple lines)', async () => {
    const data = new Uint8Array(32)
    const result = await hexPlugin.parse(data)
    expect(result.lineCount).toBe(2)
  })

  it('getComponent 返回 HexRenderer 组件', () => {
    const component = hexPlugin.getComponent()
    expect(component).toBeDefined()
    expect(component.name).toBe('HexRenderer')
  })

  it('HexRenderer 正确渲染十六进制内容', () => {
    const component = hexPlugin.getComponent()
    const data = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f])
    const wrapper = mount(component, {
      props: { content: data },
    })
    const pre = wrapper.find('pre')
    expect(pre.exists()).toBe(true)
    const text = pre.text()
    // 包含偏移量
    expect(text).toContain('00000000')
    // 包含十六进制值
    expect(text).toContain('48')
    // 包含 ASCII 表示
    expect(text).toContain('Hello')
  })

  it('HexRenderer 支持自定义 fontSize', () => {
    const component = hexPlugin.getComponent()
    const data = new Uint8Array([0x00])
    const wrapper = mount(component, {
      props: { content: data, fontSize: 18 },
    })
    const pre = wrapper.find('pre')
    expect(pre.attributes('style')).toContain('font-size: 18px')
  })

  it('supportedExtensions 为空数组（兆底解析器）', () => {
    expect(hexPlugin.supportedExtensions).toEqual([])
  })
})
