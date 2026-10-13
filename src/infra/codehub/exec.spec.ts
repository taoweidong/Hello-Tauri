import { describe, expect, it } from 'vitest'
import { redactToken, TOKEN_FLAG } from './exec'

describe('redactToken（S-12 token 脱敏）', () => {
  it('遮蔽 --token 的值且不暴露长度（侧信道）', () => {
    const args = ['mr', 'list', TOKEN_FLAG, 'sk-very-long-secret-token-1234567890']
    const out = redactToken(args)
    expect(out).not.toContain('sk-very-long-secret-token-1234567890')
    expect(out).not.toContain('1234567890')
    expect(out).toContain('[token 已省略]')
    // 不得出现精确长度数字（如「35 字」）—— 那是长度侧信道
    expect(out).not.toMatch(/已省略 \d+ 字/)
  })

  it('其他参数原样保留', () => {
    const args = [TOKEN_FLAG, 'secret', '--repo', 'demo/a']
    expect(redactToken(args)).toBe('--token [token 已省略] --repo demo/a')
  })

  it('非 token 参数不被遮蔽', () => {
    expect(redactToken(['mr', 'list'])).toBe('mr list')
  })
})
