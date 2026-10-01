import { describe, expect, it } from 'vitest'

import { escapeLike } from './like'

/** LIKE 通配符转义：筛选框必须保持字面语义（搜「100%」不能变成全表通配） */
describe('infra/db —— escapeLike', () => {
  it('转义 % _ \\ 三类字符，普通字符原样保留', () => {
    expect(escapeLike('100%')).toBe('100\\%')
    expect(escapeLike('E_01')).toBe('E\\_01')
    expect(escapeLike('a\\b')).toBe('a\\\\b')
    expect(escapeLike('周会-E-0001')).toBe('周会-E-0001')
  })

  it('空串与连续通配符逐一转义，不劣化', () => {
    expect(escapeLike('')).toBe('')
    expect(escapeLike('%_\\%_')).toBe('\\%\\_\\\\\\%\\_')
  })
})
