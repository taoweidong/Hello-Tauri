# Design

## Context

知识供给现状（详见探索记录与 `docs/design-welink-rag-retrieval-2026-10-05.md`）：技能静态
知识块 `{{knowledge}}`（config.json）、外挂 RAG 检索 `{{retrieved}}`（mock 先行）、本地
`knowledge/*.md` + `index.json` 清单（仅手动管理）三条通道彼此独立；群公告无抓取无存储
（`adapter.ts` 对 system 类消息丢弃正文）；`welink_reply_jobs` 已答复任务含技能三列/rating/
最终 prompt，是完整的问答归档原料；消息 180 天、agent 语料 90 天会被保留期清理。文件能力
仅有 `bridge.fsRead/fsWrite`（数据根内相对路径、安全闸、自动建父目录，无 list/delete）。
`orchestrator` 覆盖率基线 92% lines。

## Goals / Non-Goals

**Goals:**

- 沉淀为独立于回复链路的一等能力：消息/公告/问答三类原料自动采集 → LLM 提取 → 评审 →
  落 `knowledge/` 长期记忆（不受 SQLite 保留期影响）。
- 答复按规则快速路由到本地知识库：技能绑定知识文档，命中即注入 `{{docs}}`。
- 全程零新增 Rust 业务命令（唯一 Rust 触点是迁移清单常量）；老配置/老清单零手工迁移。

**Non-Goals:**

- 本地 FTS5/向量索引、知识自动合并与冲突消解、md 物理删除与版本管理（RAG 设计文档 §12
  预留扩展点，本期不入）。
- `fs_list`/`fs_delete` 新命令；下架=清单移除语义不变。
- 公告的交互式回复；沉淀产物的自动外发或跨设备同步。

## Decisions

- **K-A 沉淀管线独立成模块**：新增 `src/orchestrator/knowledge-harvester.ts`，与 poller /
  pipeline 平行，由 `createWelinkRuntime` 装配并按周期调度。备选：挂在 pipeline 生成段
  尾部——否，回复与沉淀失败域必须隔离（增强不阻断原则的双向版），且沉淀不依赖任何
  回复触发。

- **K-B 水位存 SQLite kv 表**：`sediment_state(key TEXT PRIMARY KEY, value TEXT)` 分别记录
  消息 pk 水位、公告水位、问答 finished_at 水位与连续失败计数；失败本轮水位不推进、下轮
  重试同批，连续失败 ≥3 跳过并告警。备选：水位写 config.json——否，水位是运行态而非配置，
  归一化会误伤。

- **K-C 公告打桩先行（D3 同款）**：`WelinkPort` 增加可选方法 `pullAnnouncements`，mock
  实现返回样例公告，CLI 适配器暂不实现（调用即降级跳过 + warn）；子命令名/字段/分页假设
  以 `[CLI-ASSUME]` 标签逐项标注，对接期按 `docs/cli-integration-adaptation-2026-10-04.md`
  SOP 核实。备选：从消息流识别公告——否，`normalizeMessage` 已丢弃 system 类正文且 CLI
  是否回传公告正文未知，诚实打桩优于猜测。

- **K-D 提取复用既有 Agent 通道**：`agent.complete` + promptOwners 留痕（S-H 同款）；提示词
  输入为消毒后的原料批次，输出约定 JSON 条目数组（标题/正文/主题/来源下标），解析失败
  条目丢弃并 warn。每轮批数与每批字数设上限。备选：本地规则提取——否，无法归纳「接口人
  是谁」类知识，且应用已有 LLM 通道零新增依赖。沉淀调用的留痕落**独立同形表
  `sediment_logs`**（v6）：`welink_agent_logs.job_pk` 为 NOT NULL 且外键指向回复任务（宿主
  `PRAGMA foreign_keys=ON`），沉淀调用无 job 可挂、置空哨兵会破约束；分表既保住 R4 语料
  「按 job 归属」的既有语义，又让沉淀卡可回溯提取过程。

- **K-E 评审即可信化闸门，默认 manual**：`knowledge_drafts(status: pending|approved|
rejected)`；通过时可编辑标题/正文，选新建文档（slug 命名）或并入既有文档（读旧 + 追加 +
  覆写，单进程低频可接受）；auto 模式直通入库且 UI 明示风险。理由：群消息是不可信源，
  D-I 只豁免「本端生成的结构头」，整篇源自会话的知识必须经人工确认才可升级为可信注入。

- **K-F 技能绑定知识文档 + `{{docs}}` 三口径**：`WelinkSkill.knowledgeDocs?: string[]`
  （上限 5，归一化仅保留清单内文件名）；`prompt.ts` 占位符正则扩展 `docs`；pipeline 在技能
  路由后、与 RAG 检索并列读取绑定文档注入，截断上限用独立配置
  `sediment.docsMaxChars`（默认 3000，范围 200–8000）。理由：沿用 D-E「分占位符=分口径」——
  `{{knowledge}}` 用户手配静态块、`{{retrieved}}` 外挂服务、`{{docs}}` 本地评审后文档，信任
  级别与失败语义不同（RAG 失败降级不得连坐本地注入）。备选：并入 `{{knowledge}}`——老
  模板语义漂移且无法区分来源；并入 `{{retrieved}}`——失败降级互相污染。

- **K-G 知识文件读写收口 `src/infra/knowledge/` 端口**：新增 port + fs 适配 + mock 四件套
  （对齐 `infra/rag` 模式），封装 index.json 结构、slug、先写文件后登记清单的对账次序；
  harvester（orchestrator 层）与 KnowledgeCard（UI 层）共用同一端口，消除清单双真源漂移。
  备选：UI 继续 bridge、harvester 另写一套——否，index.json 结构将出现两处维护。

- **K-H 存储迁移纳入 knowledge/**：`storage.rs` 迁移子目录清单追加 `"knowledge"`（唯一
  Rust 触点，基础设施常量非业务规则），配套 uitest 断言沉淀知识随迁。

- **K-I 调度与节流**：提取周期默认 6h（可配 1–72h），不受窗口隐藏 ×3 影响（沉淀无外发、
  无静默需求）；设置卡提供「立即提取」单轮触发；轮内次序固定：消息 → 公告 → 问答，各自
  独立水位互不阻塞。

- **K-J 大小上限**：单条知识正文 ≤2000 字（超出截断并标注）；并入目标文档超 64KB 时拒绝
  并入、提示新建；归档按技能 × 月分片天然限长。fsWrite 全量覆写语义下的「追加」= 读旧 +
  拼接 + 写新，仅评审动作与归档轮触发，无并发写者。

## Risks / Trade-offs

- [welink-cli 公告能力未知] → mock 打桩 + `[CLI-ASSUME]` 逐项标注，调用侧诚实降级，对接
  期核实后更新标签；不阻塞其余沉淀链路。
- [LLM 提取质量不稳/幻觉] → 评审闸默认 manual，条目携带来源消息引用可回溯原料；auto 模式
  需显式开启并明示风险。
- [index.json 并发写漂移] → 读写收口单一端口（K-G），写入动作仅评审通过与归档轮两处触发，
  单进程内天然串行。
- [orchestrator 覆盖率 92% 基线] → harvester 全套单测先行（mock 打桩惯例），收尾跑
  `npm run check`。
- [迁移窗口内 fsWrite 被拦] → 沉淀写入失败按「增强不阻断」降级告警，水位不推进下轮重试，
  复用既有迁移窗口拒绝写入行为。

## Migration Plan

migration v6 三表经既有 MIGRATIONS 注册表追加（幂等）；老配置零迁移：`sediment` 缺省 =
沉淀关闭、`knowledgeDocs` 缺省 = 空数组；老 index.json 缺 `source` 字段视为 manual。回滚：
v6 新表独立，回滚版本不读取即可；`knowledge/` 文件与清单向后兼容。

## Open Questions

- welink-cli 公告子命令的真实形态（子命令名/字段/分页）——留对接期按 `[CLI-ASSUME]` 核实，
  不阻塞打桩与本期其余任务。
