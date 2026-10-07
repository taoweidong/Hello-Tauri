import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * WeLink 敏感值注册（S-4）。
 *
 * 断言的是「**日志出口真的被遮蔽了**」，而不是「registerSecret 被调用过」——
 * 后者只能证明函数被调到，证明不了出口真遮蔽。
 * 做法走 `onLog` 订阅拿**遮蔽后**的字符串（emit 内部先 maskSecrets 再分发给sink，
 * 与控制台/落盘用的是同一份），因此断言的对象就是真实落盘的内容。
 */
import { registerWelinkSecrets } from '@/orchestrator/secrets'
import { logger, onLog, resetSecretsForTest } from '@/utils/logger'
import { DEFAULT_WELINK_SETTINGS } from '@/types/welink'

/** 订阅日志旁路，返回收集到的行（每行 `[level] 已遮蔽文本`） */
function collect(): { lines: string[]; stop: () => void } {
  const lines: string[] = []
  const stop = onLog((level, text) => lines.push(`[${level}] ${text}`))
  return { lines, stop }
}

const agentWithKey = (key: string) => ({ ...DEFAULT_WELINK_SETTINGS.agent, apiKey: key })
const ragWithKey = (key: string) => ({ ...DEFAULT_WELINK_SETTINGS.rag, apiKey: key })

let sinks: Array<() => void> = []

beforeEach(() => {
  resetSecretsForTest()
  // logger 会调 bridge.appendLog（真实实现会走 Tauri/bridge），此处替换为 no-op
  vi.stubGlobal('console', { info: vi.fn(), warn: vi.fn(), error: vi.fn() })
})

afterEach(() => {
  for (const stop of sinks) stop()
  sinks = []
  resetSecretsForTest()
  vi.unstubAllGlobals()
})

describe('orchestrator/secrets —— registerWelinkSecrets（S-4）', () => {
  it('agent 与 rag 的 apiKey 都进遮蔽表，日志里不再出现真值', () => {
    registerWelinkSecrets({ agent: agentWithKey('agent-key-AAA111'), rag: ragWithKey('rag-key-BBB222') })
    const sink = collect()
    sinks.push(sink.stop)

    logger.info('网关报错，key=agent-key-AAA111 认证失败')
    logger.error('RAG 返回 401：rag-key-BBB222')

    expect(sink.lines.join('\n')).not.toContain('agent-key-AAA111')
    expect(sink.lines.join('\n')).not.toContain('rag-key-BBB222')
    expect(sink.lines.join('\n')).toContain('***')
  })

  it('真实场景：错误串里带 key 时不外泄（复刻 agent-http 的错误形态）', () => {
    registerWelinkSecrets({ agent: agentWithKey('sk-real-secret-999'), rag: ragWithKey('') })
    const sink = collect()
    sinks.push(sink.stop)

    logger.error(`Agent 返回 HTTP 401：invalid api key: sk-real-secret-999`)

    expect(sink.lines.join('')).not.toContain('sk-real-secret-999')
    expect(sink.lines.join('')).toContain('***')
  })

  it('未配置密钥时不报错（空串被 registerSecret 自身跳过）', () => {
    expect(() => registerWelinkSecrets({ agent: agentWithKey(''), rag: ragWithKey('   ') })).not.toThrow()
  })

  it('短密钥（<4 字符）不注册 —— 沿用registerSecret 的既有规则，避免误伤正常文本', () => {
    registerWelinkSecrets({ agent: agentWithKey('abc'), rag: ragWithKey('') })
    const sink = collect()
    sinks.push(sink.stop)

    logger.info('值是 abc')
    // 短串不遮蔽（这是有意的取舍，不是缺陷）
    expect(sink.lines.join('')).toContain('abc')
  })

  it('可重复调用（幂等，Set.add 语义）', () => {
    const conf = { agent: agentWithKey('agent-key-CCC333'), rag: ragWithKey('') }
    registerWelinkSecrets(conf)
    expect(() => registerWelinkSecrets(conf)).not.toThrow()

    const sink = collect()
    sinks.push(sink.stop)
    logger.info('key=agent-key-CCC333')
    expect(sink.lines.join('')).not.toContain('agent-key-CCC333')
  })

  it('换 key 后新 key 遮蔽、旧的仍在表内（注册表累积不注销）', () => {
    registerWelinkSecrets({ agent: agentWithKey('old-key-DDD444'), rag: ragWithKey('') })
    registerWelinkSecrets({ agent: agentWithKey('new-key-EEE555'), rag: ragWithKey('') })
    const sink = collect()
    sinks.push(sink.stop)

    logger.info('现在是 new-key-EEE555，之前是 old-key-DDD444')

    const out = sink.lines.join('')
    expect(out).not.toContain('new-key-EEE555')
    // 旧 key 仍在遮蔽表里（不清注销是刻意的：换key 前的历史日志同样需要遮蔽）
    expect(out).not.toContain('old-key-DDD444')
  })
})
