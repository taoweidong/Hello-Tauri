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

### Requirement: 问题分类与技能路由

生成段 MUST 在渲染提示词前为每个回复任务选择唯一技能，且按固定次序兜底：
①规则关键词/正则命中（按配置顺序取首个命中者）；②规则未命中且用户开关开启时，
由大模型从启用技能清单中分类（复用既有 Agent 通道，调用自动落 `welink_agent_logs`）；
③内置兜底技能终兜底。任何分支 SHALL NOT reject 或阻断生成主链路。分类结果与来源
（rule/llm/fallback）MUST 随任务落库留痕。来源：`orchestrator/skill-router.spec.ts`、
`orchestrator/pipeline.spec.ts`（三级兜底 / 模板切换 / 三列留痕）。

#### Scenario: 规则命中直接路由

- **WHEN** 触发消息内容（含最近上下文）命中某启用技能的关键词或正则
- **THEN** 直接选用该技能的专属模板生成草稿，来源记为 rule，不发起大模型分类调用

#### Scenario: LLM 分类兜底

- **WHEN** 规则未命中且分类兜底开关开启
- **THEN** 以技能清单（id/名称/说明）构造分类提示词调用大模型，返回合法技能 id 时
  选用该技能并记来源 llm；分类调用与生成调用分别留痕于大模型调用日志

#### Scenario: 分类失败或关闭走兜底技能

- **WHEN** LLM 分类超时/报错/返回无法解析，或分类兜底开关关闭且规则未命中
- **THEN** 选用内置兜底技能（通用助手）生成草稿，来源记为 fallback，生成流程继续不中断

#### Scenario: 分类留痕可回溯

- **WHEN** 任一回复任务完成技能选择
- **THEN** 任务记录技能 id、技能名称快照与来源三列；技能后续被改名或删除时历史任务展示不变脸

### Requirement: 技能配置与归一化

技能清单 SHALL 作为大模型（Agent）配置的一部分随本机配置持久化，并内置一个用户不可删除的
兜底技能（其模板即既有全局提示词模板字段）。技能 SHALL 支持绑定本地知识库文档
（绑定知识库清单中的文件名，绑定数量受上限约束）。配置入口 MUST 对技能清单做归一化收敛：
条数上限、id 唯一化、关键词清洗、非法枚举收敛、知识文档绑定清洗（仅保留清单中存在的
文件名、超出上限截断）；老配置文件升级 SHALL 零手工迁移（缺省字段回退出厂默认，行为与
升级前完全一致）。来源：`types/welink.spec.ts`（skills 归一化 / 零迁移 / 去重 / 保留字）。

#### Scenario: 老配置零迁移升级

- **WHEN** 升级前的配置文件不含技能清单字段
- **THEN** 运行时技能清单仅含兜底技能，所有消息按既有全局模板回复，行为与升级前一致

#### Scenario: 非法配置收敛

- **WHEN** 配置文件被手工改为超限条数、重复 id 或错类型字段
- **THEN** 加载时收敛到合法形态（截断/去重/回退默认），不产生运行期异常

#### Scenario: 兜底技能恒存在

- **WHEN** 用户删除或禁用全部自定义技能
- **THEN** 兜底技能仍然生效，未命中任何关键词的消息继续得到回复

#### Scenario: 知识文档绑定清洗

- **WHEN** 配置中技能绑定的知识文档包含清单中不存在的文件名或超出绑定数量上限
- **THEN** 加载时仅保留清单中存在的文件名并按上限截断，路由与生成不产生异常

### Requirement: 技能知识注入

技能专属模板 SHALL 支持知识块占位符（静态知识文本，用户自配）；渲染时将命中技能的
知识块注入提示词，会话内容的不可信消毒规则 MUST 保持不变（知识块为可信配置文本，
但永不作为回复正文外发）。来源：`infra/agent/prompt.spec.ts`（知识块注入 / 消毒不变）。

#### Scenario: 知识块进入提示词

- **WHEN** 命中技能配置了非空知识块且模板含知识块占位符
- **THEN** 生成提示词包含该知识块全文；兜底技能同样支持知识块注入

#### Scenario: 会话内容消毒不变

- **WHEN** 最近对话或触发消息中包含控制字符、伪造行格式或超长文本
- **THEN** 注入提示词前仍按既有消毒规则清洗，技能路由不改变消毒行为

### Requirement: 技能强制人工审核

审核模式为「需人工审核」的技能，其生成的草稿 MUST 在落库后直接转为人工待审
（新待审原因 skill_review），SHALL NOT 进入自动外发队列；人工放行 MUST 走既有
人工发送通道，且安全闸除人工模式拦截外的其余规则照常生效。来源：
`orchestrator/pipeline.spec.ts`（转审不入队 / 待审聚合 / 人工放行回归）。

#### Scenario: 生成后转审不入自动外发队列

- **WHEN** 命中审核模式为「需人工审核」的技能且草稿已落库
- **THEN** 任务停在待发送并标记 skill_review 待审原因，计入待审聚合，自动外发不触发

#### Scenario: 人工放行过安全闸

- **WHEN** 用户在待审列表确认发送该草稿
- **THEN** 任务经既有发送通道外发，安全闸频控/配额/黑名单等其余规则照常判定

### Requirement: 安全闸不感知技能

安全闸的全部判定 MUST 与技能维度无关：技能只影响草稿如何生成，SHALL NOT 影响任何
拦截判定、配额或外发权限；所有技能生成的草稿在安全闸面前一律同等对待，唯一外发出口
与判定次序不变。来源：`orchestrator/safety-gate.ts` 零改动（本变更 diff 为空）+
`safety-gate.spec.ts` 既有全量拦截矩阵保持绿。

#### Scenario: 拦截规则对技能草稿一视同仁

- **WHEN** 不同技能生成的草稿分别命中静默时段、黑名单、配额等任一拦截规则
- **THEN** 拦截行为与来源标记与既有规则完全一致，不因技能不同而放宽或加严

### Requirement: 知识检索增强（RAG）

生成段 SHALL 支持在技能路由之后、渲染提示词之前，按技能调用外挂 RAG 检索服务（HTTP 接口）
获取知识片段：仅当技能启用检索时发起；检索查询为触发消息内容，技能可附带过滤条件；兜底技能
是否检索由独立开关控制。检索是增强不是依赖：失败、超时、零命中一律降级为空注入且 SHALL NOT
重试、SHALL NOT 阻断或失败生成主链路。来源：`orchestrator/pipeline.spec.ts`（检索注入/降级/
开关用例）、`infra/rag/ports.spec.ts`。

#### Scenario: 启用检索的技能命中知识

- **WHEN** 启用检索的技能处理触发消息且 RAG 返回高于阈值的片段
- **THEN** 命中片段按「来源 + 相关度」拼装后注入生成提示词的检索事实占位符

#### Scenario: 检索失败静默降级

- **WHEN** RAG 服务超时、报错或返回零命中
- **THEN** 以空检索文本继续生成（行为等同无检索），仅记录运行日志，不重试不失败

#### Scenario: 未启用检索的技能零开销

- **WHEN** 技能未启用检索（含老配置零迁移场景）
- **THEN** 不发起任何检索调用，生成行为与升级前完全一致

### Requirement: 检索事实占位符与留痕

提示词模板 SHALL 支持检索事实占位符 `{{retrieved}}`（与静态口径 `{{knowledge}}` 语义分离）：
模板未包含该占位符时不注入、行为与升级前一致；检索结果随生成提示词整体落 R4 语料
（`welink_agent_logs`），可回溯「检索到了什么」。注入文本总长 MUST 受配置上限截断；检索内容
为企业内部可信知识，会话内容消毒规则保持不变。来源：`infra/agent/prompt.spec.ts`（注入/零
变化用例）、`orchestrator/pipeline.spec.ts`（截断/降级用例）。

#### Scenario: 模板无占位符零变化

- **WHEN** 技能模板未包含 `{{retrieved}}`
- **THEN** 即使检索有命中也不注入，生成提示词与升级前形状一致

#### Scenario: 检索结果可回溯

- **WHEN** 任一启用检索的任务完成生成
- **THEN** 该任务的模型调用留痕中可见注入的检索片段全文（含来源与相关度）

### Requirement: RAG 连接配置与归一化

RAG 检索服务的连接配置 SHALL 作为 WeLink 助手配置的一部分随本机配置持久化
（来源 mock|http、服务地址、接口路径、API 密钥、超时、topK、相关度阈值、注入长度上限、
兜底技能检索开关），配置入口 MUST 做三层归一化兜底（非法枚举/非法地址/越界数值收敛）；
浏览器调试模式 SHALL 强制 mock 来源；http 来源 MUST 拒绝公网 literal IP 地址（与模型接口
同一部署底线）；对接真实服务的接口假设 MUST 以 `[RAG-ASSUME]` 标签逐项标注、核实后更新。
来源：`types/welink.spec.ts`（rag 归一化用例）、`infra/rag/ports.spec.ts`（IP 守卫/浏览器
mock 用例）。

#### Scenario: 老配置零迁移

- **WHEN** 升级前的配置文件不含 rag 配置块
- **THEN** 检索默认关闭（mock 来源 + 兜底技能不检索），所有回复行为与升级前一致

#### Scenario: 非法配置收敛与安全守卫

- **WHEN** 手改配置写入非法枚举、越界数值或公网 literal IP 的 http 地址
- **THEN** 加载时收敛到合法形态；http 来源下公网 literal IP 在调用侧被拒绝（防对话原文外带）

#### Scenario: 浏览器模式强制 mock

- **WHEN** web 调试模式下 rag 来源被配置为 http
- **THEN** 运行时仍使用确定性 mock 检索（可演示路由与注入），不发真实请求

### Requirement: 技能知识文档注入（{{docs}}）

生成段 SHALL 支持本地知识文档注入：技能路由命中后、渲染提示词前，读取命中技能绑定的
知识库文档，经占位符 `{{docs}}` 注入生成提示词（与静态口径 `{{knowledge}}`、外挂检索
`{{retrieved}}` 三口径语义分离）；注入总长 MUST 受配置上限截断。文档读取失败或文件丢失
一律空注入降级并记录运行日志，SHALL NOT 重试、SHALL NOT 阻断生成主链路；模板未包含该
占位符时不注入，行为与升级前一致；绑定文档为经评审可信知识，会话内容消毒规则保持不变。
规则命中、LLM 分类与兜底技能对绑定文档注入一视同仁。来源：
`orchestrator/pipeline.spec.ts`、`infra/agent/prompt.spec.ts`（计划）。

#### Scenario: 命中技能加载绑定文档

- **WHEN** 触发消息命中某技能（规则或 LLM 分类）且该技能绑定了非空知识文档、模板含 `{{docs}}`
- **THEN** 绑定文档内容注入生成提示词，超出注入上限时截断

#### Scenario: 文件丢失静默降级

- **WHEN** 绑定的知识文档读取失败或文件已不存在
- **THEN** 以空注入继续生成（行为等同未绑定），仅记录运行日志，不重试不失败

#### Scenario: 模板无占位符零变化

- **WHEN** 技能模板未包含 `{{docs}}`，或技能未绑定任何文档（含老配置零迁移场景）
- **THEN** 不读取任何文档文件，生成提示词与升级前形状一致，生成行为完全一致
