import { describe, expect, it } from 'vitest'

import { base64ToBytes, bytesToBase64, decodeBase64Text, decodeBytes, gbkBytes, utf8Bytes } from '@/utils/b64'

/**
 * 子进程输出解码单测（设计 §13）。
 *
 * 这一层是「中文 CLI 输出不乱码」的唯一防线：Rust 侧只回传原始字节的 base64，
 * 编码判定全在这里。因此测试必须覆盖三条路径：
 *  UTF-8 严格成功 → GBK 兜底 → 两者都失败时的 lossy 回退。
 *
 * 关键判据是 **strict 模式而非宽容模式**：宽容解码会把非法字节替换成 U+FFFD
 * 却不报错，我们就失去了「这份输出不是 UTF-8」这个信号，GBK 兜底永远不会触发。
 */
describe('utils/b64 —— 字节与编码', () => {
  describe('base64 往返', () => {
    it('空串 → 空字节 → 空串', () => {
      expect(base64ToBytes('')).toEqual(new Uint8Array(0))
      expect(bytesToBase64(new Uint8Array(0))).toBe('')
    })

    it('ASCII 往返保真', () => {
      const text = 'welink-cli pull --json'
      expect(bytesToBase64(utf8Bytes(text))).toBe(btoa(text))
      expect(decodeBytes(base64ToBytes(btoa(text))).text).toBe(text)
    })

    it('忽略 base64 中的空白（CLI 换行回传不影响解码）', () => {
      const bytes = utf8Bytes('hello')
      const wrapped = `${bytesToBase64(bytes).slice(0, 4)}\n  ${bytesToBase64(bytes).slice(4)}\n`
      expect(decodeBase64Text(wrapped).text).toBe('hello')
    })

    it('非法 base64 不抛错，回退空串 + lossy（不丢日志路径）', () => {
      const result = decodeBase64Text('!!!not-base64!!!')
      expect(result.text).toBe('')
      expect(result.encoding).toBe('lossy')
    })

    it('大字节块正确切分（chunked btoa 不越栈）', () => {
      const bytes = new Uint8Array(70_000).fill(0x41)
      const encoded = bytesToBase64(bytes)
      expect(base64ToBytes(encoded)).toHaveLength(70_000)
      expect(base64ToBytes(encoded)[69_999]).toBe(0x41)
    })
  })

  describe('decodeBytes —— 三级降级', () => {
    it('合法 UTF-8 走 utf-8 分支（含中文与 emoji）', () => {
      const result = decodeBytes(utf8Bytes('收到，我看一下 🚀'))
      expect(result.encoding).toBe('utf-8')
      expect(result.text).toBe('收到，我看一下 🚀')
    })

    it('空字节返回空串且标 utf-8（不是 lossy）', () => {
      expect(decodeBytes(new Uint8Array(0))).toEqual({ text: '', encoding: 'utf-8' })
    })

    it('GBK 字节被识别为 utf-8 非法 → gbk 兜底且中文正确', () => {
      // 中文的 GBK 编码：d6 d0 = "中"。0xd6 是 2 字节引导，0xd0 不是合法后继 → UTF-8 必抛
      const result = decodeBytes(new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]))
      expect(result.encoding).toBe('gbk')
      expect(result.text).toBe('中文')
    })

    it('GBK 混合 ASCII 与中文整体走 gbk（不逐段猜）', () => {
      const text = '发送成功：你好'
      const result = decodeBytes(gbkBytes(text))
      expect(result.encoding).toBe('gbk')
      expect(result.text).toBe(text)
    })

    it('strict 模式是判据来源：非法字节必须抛错而不是产出 U+FFFD', () => {
      expect(() => new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array([0xd6, 0xd0]))).toThrow()
    })
  })

  describe('gbkBytes —— 测试夹具编码器', () => {
    it('ASCII 直通（单字节）', () => {
      expect(Array.from(gbkBytes('ab1'))).toEqual([0x61, 0x62, 0x31])
    })

    it('表内汉字编码为双字节高低位', () => {
      expect(Array.from(gbkBytes('中文测试'))).toEqual([0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4])
    })

    it('表外字符用 ? 占位（与真实 CLI 行为一致，不抛错）', () => {
      // 表内没有这个字，按约定产出 '?'
      expect(Array.from(gbkBytes('龘'))).toEqual([0x3f])
    })

    it('gbkBytes → decodeBytes 对表内汉字闭合', () => {
      const text = '群聊消息发送成功'
      expect(decodeBytes(gbkBytes(text))).toEqual({ text, encoding: 'gbk' })
    })
  })
})