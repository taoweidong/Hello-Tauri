# Spec Delta

## MODIFIED Requirements

### Requirement: 知识库清单真源

知识库 SHALL 以 `knowledge/index.json` 为清单真源：每个条目记录文件名、标题、更新时间与
来源（manual 手动创建 | extract 沉淀提取 | qa 问答归档）；清单与 `knowledge/*.md` 文件共同
存放在数据根 `knowledge/` 目录（沿用既有安全文件通道，拒绝越界路径，写自动建父目录）。
老清单文件缺来源字段时 SHALL 视为 manual，零手工迁移。来源：
`components/welink/KnowledgeCard.spec.ts`（新建/编辑用例）。

#### Scenario: 新建知识文档

- **WHEN** 用户在知识库卡新建一篇文档（标题 + 文件名 + Markdown 正文）
- **THEN** 正文写入 `knowledge/<文件名>.md`，清单同步登记该条目，列表立即可见

#### Scenario: 编辑知识文档

- **WHEN** 用户编辑既有文档正文并保存
- **THEN** 文件被覆盖更新且清单的更新时间刷新

#### Scenario: 老清单零迁移补来源

- **WHEN** 升级前的 index.json 条目不含来源字段
- **THEN** 加载时一律视为 manual 来源，清单结构与既有条目内容不变

## ADDED Requirements

### Requirement: 沉淀产物纳入清单管理

知识沉淀产出的知识条目与问答归档 SHALL 经既有安全文件通道写入 `knowledge/` 并自动登记
清单（标注来源 extract / qa），与手动创建的文档同等接受编辑、下架管理；沉淀登记 MUST NOT
破坏既有清单结构（手动条目零影响、登记失败不产生半登记状态）。来源：
`components/welink/KnowledgeCard.spec.ts`、`orchestrator/knowledge-harvester.spec.ts`（计划）。

#### Scenario: 沉淀条目与手动条目同权管理

- **WHEN** 沉淀产物登记进清单后用户在知识库卡查看
- **THEN** 沉淀条目带来源标识，可被编辑、下架，手动创建的条目不受任何影响

#### Scenario: 沉淀登记原子性

- **WHEN** 沉淀写入文档成功但清单登记失败（或反之）
- **THEN** 按先写文件后登记清单的次序重试对账，不出现清单指向不存在文件以外的半登记状态
