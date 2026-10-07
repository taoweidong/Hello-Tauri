# knowledge-base Specification

## Purpose

本地 Markdown 知识库的管理能力：知识源以数据根 `knowledge/*.md` 文件承载，应用提供清单、
新建、编辑、下架与手动文件登记；文件读写走既有数据根内安全文件通道（拒绝越界路径），web
调试模式诚实降级。知识库是检索增强（welink-auto-reply）的知识供给来源，本身不做检索。

## Requirements

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

### Requirement: 下架语义（停用不删文件）

删除操作 SHALL 为「下架」：仅从清单移除条目使其退出使用，Markdown 文件本身 MUST 保留在
数据根目录；下架前 SHALL 有确认文案明示该语义。来源：`components/welink/KnowledgeCard.spec.ts`
（下架用例：清单移除 + 文件保留断言）。

#### Scenario: 下架文档

- **WHEN** 用户下架一篇文档并确认
- **THEN** 清单移除该条目、文件仍保留在 knowledge/ 目录，检索不再使用它

### Requirement: 手动文件登记

对用户手动放入 knowledge/ 目录的文件（应用无列目录能力，无法自动发现），SHALL 提供
「登记」入口：输入文件名与标题后加入清单；登记的文件名在读取不到对应文件时 MUST 给出
「文件已被移走」的可行动提示。来源：`components/welink/KnowledgeCard.spec.ts`
（登记/丢失用例）。

#### Scenario: 登记手动放入的文件

- **WHEN** 用户以「登记」录入 knowledge/ 下已存在的手工文件
- **THEN** 该文件进入清单并可用于查看与检索供给

#### Scenario: 登记后文件丢失

- **WHEN** 打开一个清单中存在但文件已不存在的条目
- **THEN** 给出「文件已被移走，可重新登记或下架」的提示，而不是报错崩溃

### Requirement: web 调试模式降级

浏览器调试模式下文件通道不可用，知识库卡 SHALL 整体呈现降级提示（知识库管理需桌面模式），
SHALL NOT 抛出未处理异常或出现半可用状态；检索增强本身在 web 模式经 mock 数据源照常可演示。
来源：`components/welink/KnowledgeCard.spec.ts`（web 降级用例）。

#### Scenario: 浏览器模式打开知识库卡

- **WHEN** web 调试模式进入设置页的知识库卡
- **THEN** 显示「知识库管理需桌面模式」降级提示，列表操作不可用，应用其余功能不受影响

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
