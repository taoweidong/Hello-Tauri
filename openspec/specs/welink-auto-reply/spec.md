# welink-auto-reply Specification

## Purpose

WeLink 助手的自动回复全链：轮询取增量 → 生成回复草稿 → SafetyGate 安全闸 → 外发与
回执回写。内网环境中的自动外发是本应用风险最高的能力，本 spec 承载其安全合同——
所有需求均描述**已实现且被测试钉住**的行为（来源标注对应测试文件），后续变更经
delta 流程对照本 spec，铁律漂移在校验期暴露。

## Requirements

### Requirement: 轮询取增量（错峰与分批）

系统 SHALL 按配置间隔轮询监控会话的增量消息：每轮按会话错峰调度、单批受
`pullBatchLimit` 约束且续批至多 3 批、窗口隐藏时间隔 ×3（P9）、失败按退避序列重试。
来源：`orchestrator/poller.spec.ts`（setTimeout 链 / single-flight / 退避序列 /
跨批 msg_uid 去重）。

#### Scenario: 正常轮询一轮

- **WHEN** 助手运行中且到达轮询周期
- **THEN** 逐会话错峰拉取增量，新消息入库并发出 `messagesAppended` 事件

#### Scenario: 拉取失败进入退避

- **WHEN** 某会话本轮拉取失败
- **THEN** 该会话进入退避状态（状态灯「退避中」），按退避序列推迟下一轮，不阻塞其他会话

### Requirement: 草稿先落库置 ready 才允许外发（铁律）

回复草稿 MUST 先持久化到任务表并置 `ready`，外发只允许消费 `ready` 任务；禁止任何
「直接发送不落库」的路径。来源：`orchestrator/pipeline.spec.ts`（草稿落库 → 外发的
状态机顺序断言）。

#### Scenario: 生成草稿

- **WHEN** 轮询到需要回复的触发消息
- **THEN** 生成草稿并落库为 `ready` 任务（含 hold_reason 时机），随后才进入外发流程

#### Scenario: 黑名单命中转待审

- **WHEN** 草稿命中 S7 敏感句式黑名单
- **THEN** 任务保持 `ready` 且置 hold_reason（转人工待审），不计入自动外发

### Requirement: 安全闸四级开关分级

外发 MUST 依次通过 L0（一键急停）→ L1（总开关）→ L2（场景开关：群 @我 / 私聊）→
L3（会话开关 + 静默）四级闸口，任一级关闭即拦截并落 skip_reason。来源：
`orchestrator/safety-gate.spec.ts`（分级拦截矩阵）。

#### Scenario: L0 急停封死唯一出口

- **WHEN** 用户触发 L0 一键全停后管线尝试外发
- **THEN** 所有外发被拦截（skip_reason=panic），manual 人工发送也需人工解锁后重走

#### Scenario: 会话静音期间不外发

- **WHEN** 会话处于 O11 静音期内且有任务待发
- **THEN** 该会话任务被拦截，静音到期后自动恢复外发

### Requirement: 配额、最小间隔与静默时段

外发 MUST 受 S1 最小间隔（跨重启生效）、S2 会话小时配额、S3 全局小时配额、S4 静默
时段约束；S2/S3 超出后任务回「待发送」等下一窗口，不丢弃。来源：
`orchestrator/safety-gate.spec.ts`（配额窗口与冷却）。

#### Scenario: 全局配额触顶

- **WHEN** 本小时全局外发数达到 S3 上限
- **THEN** 后续任务回「待发送」，下一小时窗口自动放行，全局冷却期横幅可见

### Requirement: 熔断（S8）

同类拦截在 S8 熔断窗口内达到阈值 SHALL 触发熔断：暂停该场景的外发并发出
`fuseTripped` 事件（UI 横幅），人工解除后恢复。来源：`orchestrator/safety-gate.spec.ts`
（熔断触发与人工解除）。

#### Scenario: 熔断触发

- **WHEN** 同一场景在熔断窗口内拦截次数达到 S8 阈值
- **THEN** 该场景外发暂停、UI 弹出熔断横幅，后续任务挂起直至人工解除

### Requirement: 发送不做传输层重试（防双发底线）

真实外发 MUST NOT 在传输层自动重试——重试可能真实发出两条回复；失败交由外发
worker 的退避与回执核对处理。来源：`infra/welink/welink-cli.spec.ts`（send 传输故障
不重试断言）。

#### Scenario: 传输故障不重试

- **WHEN** 外发子进程失败（transport 错误）
- **THEN** 本次调用直接失败（不发起第二次发送），任务按编排层策略回退

### Requirement: 急停跨重启不复活

L0 急停标记 SHALL 随配置落盘：重启后读到标记时强制降为人工确认模式（sendMode=manual）
并复位标记，恢复的 ready 任务不自动外发。来源：`stores/welink/facade.spec.ts`（急停
跨重启用例，评审 P1）。

#### Scenario: 急停后重启

- **WHEN** 上次会话以一键全停结束、应用重新启动并初始化助手页
- **THEN** init 返回 panicRecovered=true，发送模式降为 manual，UI 显式提示用户

### Requirement: 演示剧本仅 mock 可用

演示剧本（O13）SHALL 仅在 mock 数据源下可用：真实 CLI 端口无剧本能力时按钮置灰、
调用返回未执行。来源：`stores/welink/data.spec.ts`（非 mock 拒绝用例）。

#### Scenario: 真实端口请求演示

- **WHEN** 数据源为真实 CLI 时调用演示剧本
- **THEN** 返回 false 并记录「仅 mock 可用」日志，不产生任何拉取与外发
