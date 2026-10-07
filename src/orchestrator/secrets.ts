/**
 * WeLink 配置里的敏感值注册（S-04）。
 *
 * 背景：项目有一套「日志出口等值遮蔽」机制（`utils/logger` 的 `registerSecret`），
 * 设计意图是「**最后一道闸**」—— 即使某处日志拼接漏了脱敏，已注册的敏感值也不会
 * 落到控制台、日志文件与 UI 运行日志区。
 *
 * 但此前**只有 CodeHub token 注册了**，agent/rag 的 `apiKey` 漏在遮蔽表外。这两把
 * key 会被拼进模块级缓存键字符串（`infra/agent/index.ts` / `infra/rag/index.ts`），
 * 一旦将来有人给那个数组加一条日志（很自然的排障动作），就会同时出现在
 * info 日志、落盘日志文件，以及 **UI 运行日志区**（用户可见）。
 * 错误串同样有风险：`agent-http` 会把响应体前 200 字拼进 `AgentError`，
 * 部分网关在 4xx 时会回显请求信息。
 *
 * 为什么放在 orchestrator 而不是 `types/welink.ts` 的 `normalizeWelinkSettings`：
 * 后者是**纯函数、零依赖**，而 `registerSecret` 有副作用（写模块级注册表）。
 * 混进去会让类型模块变成「有副作用的纯函数」，且违反项目对 types 层的定位。
 *
 * 调用点：`stores/welink/control.applySettings`（设置变更的唯一收敛点）
 * 与 `orchestrator/runtime.reload`（启动装配点）。
 */
import { registerSecret } from '@/utils/logger'
import type { WelinkSettings } from '@/types/welink'

/**
 * 注册 WeLink 配置里出现的全部敏感值。
 *
 * 可重复调用（幂等）：`registerSecret` 内部是 `Set.add`。
 * 空串与 <4 字符的值会被 `registerSecret` 自身跳过——短串等值替换的误伤面大于收益，
 * 这是它的既有设计，这里不重复判断。
 */
export function registerWelinkSecrets(settings: Pick<WelinkSettings, 'agent' | 'rag'>): void {
  registerSecret(settings.agent?.apiKey)
  registerSecret(settings.rag?.apiKey)
}
