# welink-group-creation Specification

## Purpose

快速建群链（migration v3）：建群模板 → welink-cli `create-group` → 全程留痕。
建群是会产生真实副作用的写操作（真的会建出群），本 spec 承载其可靠性合同——
先落痕、原子回写、绝不重试。所有需求描述已实现且被测试钉住的行为
（来源：`orchestrator/group.spec.ts`、`infra/welink/group-cli.ts` 用例）。

## Requirements

### Requirement: 外呼前先落 pending 留痕

每次建群 MUST 在外呼 CLI **之前**把任务落库为 `pending`（含模板与参数快照）：
进程崩溃、断电后任务可追溯，不存在「群建了但库里没记录」的窗口。来源：
`orchestrator/group.spec.ts`（先落痕时序断言）。

#### Scenario: 发起建群

- **WHEN** 用户提交建群表单
- **THEN** 先写入 `pending` 任务（拿到任务号）再外呼 create-group

### Requirement: 终态以 WHERE status='pending' 原子回写

任务终态（success / failed）MUST 以 `WHERE status='pending'` 条件原子回写：并发
回写或重复回写只有第一次生效，杜绝「成功后又被旧结果覆盖」。来源：
`orchestrator/group.spec.ts`（终态回写时序）。

#### Scenario: 正常完成回写

- **WHEN** create-group 退出码 0 且解析出新群 ID
- **THEN** 任务回写为 success 并记录群 ID

#### Scenario: 迟到的失败回写被拒绝

- **WHEN** 任务已是终态（如 success）后另一路径再次回写 failed
- **THEN** 回写不生效（pending 条件不命中），终态保持不变

### Requirement: 建群不做传输层重试

create-group 外呼 MUST NOT 在传输层自动重试：响应丢失时重试会**真实建出两个群**；
失败一律落 failed（或 interrupted），由人工决定是否重发。来源：
`infra/welink/group-cli.ts` 用例（传输故障不重试）。

#### Scenario: 子进程超时

- **WHEN** create-group 子进程超时（结果未知）
- **THEN** 任务回写为 interrupted（不是 failed，也不是重试）

### Requirement: 占位群 ID 如实呈现

CLI 未回传群 ID 时（建群本身已成功），MUST 以种子派生本地占位 ID（`local-` 前缀）
落库并在 UI 标注「本地占位」——不报 parse 错误（会把「已建成」记成「失败」诱导
重复建群），也不伪造真实群 ID。来源：`infra/welink/group-cli.ts`、
`stores/group.spec.ts`（占位 ID 用例）。

#### Scenario: 建群成功但无群 ID

- **WHEN** create-group 退出码 0 但输出缺 groupId 字段
- **THEN** 任务 success + 占位群 ID（`local-` 前缀），UI 显示「本地占位（CLI 未回传群 ID）」

### Requirement: 同步导入不覆盖人工配置

从候选清单同步导入会话时，已有项 MUST 只更新 title，绝不覆盖 watching /
autoReply / remark；新导入项默认不监控、不回复。来源：`stores/welink/view.spec.ts`
（syncConversations 用例，§11.5 底线）。

#### Scenario: 同步已有会话

- **WHEN** 对已存在的会话执行同步
- **THEN** 仅标题更新，监控/自动回复/备注保持人工配置
