# WeLink 知识沉淀设计（knowledge-sedimentation）

> 状态：已实施（OpenSpec 变更 `add-welink-knowledge-sedimentation`，2026-10-06 规划、2026-10-07 落地）。
> 规格主文档：`openspec/changes/add-welink-knowledge-sedimentation/`（proposal / specs / design / tasks），
> 归档后主规格落在 `openspec/specs/knowledge-sedimentation/spec.md`（新增）与
> `knowledge-base` / `welink-auto-reply` / `data-storage-lifecycle`（修改）。动
> `src/orchestrator/knowledge-harvester.ts`、`src/infra/knowledge/`、沉淀相关表结构前必读本文。

## 1. 背景与目标

WeLink 群会话每天都在产生核心业务信息（公告、接口人、值班、办理口径……），此前这些信息只有两个
命运：落库 180 天后被保留期清理，或偶尔触发一次自动回复。知识供给侧已有三条通道——技能静态知识块
`{{knowledge}}`（config.json）、外挂 RAG 检索 `{{retrieved}}`（HTTP 服务）、本地 Markdown 知识库
`knowledge/*.md`（仅手动管理）——但「群消息中的知识 → 本地知识库」没有任何自动化路径；技能也无法
直接绑定本地知识文档作答。

本设计新增**知识沉淀**一等能力（独立于自动回复）：

```
┌─ 群消息（welink_messages 增量水位扫描）
├─ 群公告（新增 welink_announcements，[CLI-ASSUME] 打桩先行）
└─ 问答对（sent 的 reply_jobs + 触发消息 + 草稿 + rating）
        │
   LLM 提取（复用 agent.complete 通道，留痕落 sediment_logs，与 R4 语料分表）
        │
   待评审队列 knowledge_drafts（评审即可信化闸门；auto 模式显式直通）
        │
   knowledge/*.md + index.json（长期记忆落点，不受 SQLite 保留期影响）
        │
   答复消费：技能绑定 knowledgeDocs[] ──规则/LLM 路由命中──▶ {{docs}} 注入
```

**非目标**：本地 FTS5/向量索引、知识自动合并与冲突消解、md 物理删除与版本管理、
`fs_list`/`fs_delete` 新命令（下架=清单移除语义不变）、公告交互式回复、跨设备同步。

## 2. 数据模型（migration v6，`src/infra/db/migrations/welink-sediment.ts`）

- `welink_announcements`：群公告存档（此前公告类正文在 normalize 阶段被占位符丢弃）；
  `ann_uid` UNIQUE 幂等键，联会话表落 `conv_pk`。
- `knowledge_drafts`：待评审知识条目；`status(pending|approved|rejected)` 单向流转、
  `source_type(message|announcement|qa)`、`source_refs`（JSON 数组，回溯原料）、
  `content_hash`（指纹去重）。
- `sediment_state`：kv 水位（消息 pk / 公告 pk / 问答 finished_at / 提取连续失败计数）——
  运行态不进 config.json（配置归一化会误伤）。
- `sediment_logs`：沉淀提取的大模型调用留痕（与 `welink_agent_logs` 同形、独立分表，见 §3 K-D）。

## 3. 设计决策（K-A ~ K-J）

- **K-A 沉淀管线独立成模块**：`src/orchestrator/knowledge-harvester.ts`，与 poller / pipeline
  平行，由 `createWelinkRuntime` 装配；调度常驻、每轮按 `sediment.enabled` 自检（改配置即生效，
  无需重启）。备选：挂在 pipeline 生成段尾部——否，回复与沉淀失败域必须双向隔离。
- **K-B 水位存 SQLite kv 表**：`sediment_state`；失败本轮水位不推进、下轮重试同批，连续失败
  ≥3 跳过提取并告警（防卡死）。
- **K-C 公告打桩先行**：`WelinkPort` 增加可选方法 `pullAnnouncements`；mock 返回确定性样例，
  CLI 适配器**不实现**（调用侧以 `'pullAnnouncements' in port` 判定后诚实降级）；协议假设见 §5。
- **K-D 提取复用既有 Agent 通道**：`agent.complete` 直接调用 + 自行计时落 `sediment_logs`
  （不复用 `welink_agent_logs`：其 `job_pk` NOT NULL 且外键指向回复任务、宿主
  `PRAGMA foreign_keys=ON`，沉淀调用无 job 可挂）；提示词输入为消毒后的原料批次，输出约定
  JSON 条目数组，解析失败条目丢弃；每轮消息 ≤80、公告 ≤40、单条材料 ≤500 字、提示词总长 ≤8000。
- **K-E 评审即可信化闸门，默认 manual**：通过 = 先写知识库（新建或并入既有文档）后置 approved
  （写失败可重试）；auto 直通为显式 opt-in 且 UI 明示风险。群消息是不可信源，整篇源自会话的
  知识必须经人工确认才可升级为可信注入。
- **K-F 技能绑定知识文档 + `{{docs}}` 三口径**：`WelinkSkill.knowledgeDocs[]`（上限 5，配置层
  只做形状清洗，消费侧 `resolveDocs` 按清单解析）；`prompt.ts` 占位符正则扩展 `docs`；pipeline
  零开销门控（模板含 `{{docs}}` 且技能已绑定才读文件）；注入总长受 `sediment.docsMaxChars`
  （200–8000，默认 3000）截断；文件丢失/读失败空注入降级、不重试不阻断。与 `{{knowledge}}`
  （静态块）、`{{retrieved}}`（外挂服务）三口径语义分离，失败语义互不连坐。
- **K-G 知识文件读写收口 `src/infra/knowledge/` 端口**：port（共享核心 createKnowledgeCore）+
  fs 适配 + mock 四件套；清单结构、slug、**先写文件后登记清单**的对账次序只有一份实现；UI 经
  `stores/welink/knowledge.ts`（Pinia）消费，编排层直连工厂。
- **K-H 存储迁移纳入 knowledge/**：`storage.rs` 的 `MIGRATE_SUBDIRS` 常量清单含 `knowledge`
  （唯一 Rust 触点）；`cargo test --lib` 钉住清单与三层嵌套复制行为（uitest 沙箱无法驱动真实
  迁移，验证以 Rust 单测替代）。
- **K-I 调度与节流**：提取周期默认 6h（1–72 可配），setTimeout 链 + 每轮重读配置（热更新）；
  不受窗口隐藏 ×3 影响（沉淀无外发、无静默需求）；「立即提取」与自动轮次共用 single-flight；
  轮内次序固定：问答归档 → 公告采集 → 消息/公告提取，各自独立水位互不阻塞。问答归档逐条推进
  水位（中断零丢失）；归档按「技能 × 月份」分片 `knowledge/qa-archive/<skill>/<月>.md`，
  单文档超 64KB 拒绝并入（K-J）。
- **K-J 大小上限**：单条知识正文 ≤2000 字（超出在评审编辑阶段由 harvester 拒绝）；单条材料
  进提示词 ≤500 字；问答 section 问 ≤500 字 / 答 ≤1000 字。

## 4. 安全边界

- 沉淀全程**纯本地写入**：不产生任何回复任务、不调用消息发送、不接 safety-gate；
  「安全闸不感知技能」等既有合同零改动。
- 会话内容进入提示词前一律过 `sanitizeUntrusted`（原料与提取输出双侧）；`{{docs}}` 注入文本
  为经评审的可信知识，不消毒但永不作为回复正文外发。
- 评审 = 「不可信会话内容 → 可信知识」的唯一闸门；auto 直通需显式开启并在 UI 明示风险。
- 沉淀配置 `WelinkSettings.sediment` 走三层归一化兜底；web 调试模式沉淀卡与知识库卡整体降级。

## 5. `[CLI-ASSUME]` 公告假设清单（对接期逐项核实）

标注位置：`src/infra/welink/port.ts`（方法注释，总清单）、`src/infra/welink/welink-cli.ts`
（头部注明暂不实现）。

1. welink-cli 是否提供公告子命令（子命令名未知）；
2. 请求参数形态（会话 ID / 分页 / 数量上限）；
3. 返回字段名（标题 / 正文 / 发布时间 / 公告唯一 ID）与编码（UTF-8→GBK 兜底同消息）；
4. 幂等键语义（公告唯一 ID 是否稳定、重复拉取是否返回历史公告）；
5. 权限边界（应用是否有读取所在群公告的权限）。

核实后：实现 `createCliWelinkPort` 的 `pullAnnouncements`，更新/删除本清单与 port.ts 标注，
并按 `docs/cli-integration-adaptation-2026-10-04.md` 的 SOP 记录对接结论。CLI 无公告能力时，
公告采集保持「诚实降级跳过」，消息与问答两条沉淀链路不受影响。

## 6. 实现落点索引

| 模块       | 文件                                                                                                                                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 类型与配置 | `src/types/welink.ts`（sediment 块、knowledgeDocs）、`src/types/knowledge.ts`（KnowledgeDoc/来源/slug）                                                                                          |
| 迁移与仓储 | `src/infra/db/migrations/welink-sediment.ts`、`src/infra/db/sediment-ports.ts`、`repos/sediment.ts` + `repos/sediment-memory.ts`（契约测试 `sediment-contract.spec.ts` 用 node:sqlite 跑真迁移） |
| 知识库端口 | `src/infra/knowledge/`（port/knowledge-fs/mock/index）                                                                                                                                           |
| 公告端口   | `src/infra/welink/port.ts`（pullAnnouncements 可选方法）、`mock.ts`（样例）                                                                                                                      |
| 沉淀管线   | `src/orchestrator/knowledge-harvester.ts`（+ spec）、`runtime.ts`（装配/起停）                                                                                                                   |
| 答复注入   | `src/infra/agent/prompt.ts`（{{docs}}）、`src/orchestrator/pipeline.ts`（formatBoundDocs 注入段）                                                                                                |
| UI         | `src/stores/welink/knowledge.ts`、`SedimentCard.vue`、`KnowledgeCard.vue`（来源标识+评审队列）、`settings/SkillsSection.vue`（知识文档多选）、`views/SettingsView.vue`                           |
| 存储迁移   | `src-tauri/src/storage.rs`（MIGRATE_SUBDIRS + tests）                                                                                                                                            |
