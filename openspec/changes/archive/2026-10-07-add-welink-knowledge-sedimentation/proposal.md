# Proposal

## Why

WeLink 群会话每天都在产生核心业务信息（群公告、接口人变更、门禁办理、流程口径问答……），
目前这些信息只有两个命运：落库 180 天后被保留期清理，或偶尔触发一次自动回复。应用侧已有
本地知识库（`knowledge/*.md`）与外挂 RAG 检索两条知识供给通道，但知识入库只有「手动新建 /
登记」一条路，群消息中的知识没有任何沉淀机制；同时技能只能绑定静态知识块与外挂检索服务，
无法「命中规则 → 直接加载本地知识库文档」组织答复。需要在自动回复之外，把 welink 中的
核心业务信息自动沉淀为本地长期知识（不只服务自动回复），并让答复按规则快速路由到对应
知识库。

## What Changes

- **新增知识沉淀管线**（独立于回复轮询的一等能力）：按白名单会话扫描群消息增量、抓取
  群公告（Port 可选能力，mock 先行 + `[CLI-ASSUME]` 打桩）、采集已答复问答对，三类原料
  统一经 LLM 提取与归档，与外发链路完全解耦。
- **新增待评审队列**：LLM 提取的知识条目先落库待审，人工通过后写入 `knowledge/*.md`
  并登记清单——评审即「不可信会话内容 → 可信知识」的可信化闸门（可选 auto 模式直通，
  默认关闭）。
- **问答对自动归档**：已答复问答按「技能 × 月份」追加写入 Markdown 经验文档并登记清单，
  打通「经验沉淀 → 答复可消费」闭环。
- **技能绑定知识文档**：`WelinkSkill` 新增 `knowledgeDocs` 绑定；规则/LLM 路由命中技能后
  读取绑定文档，经新占位符 `{{docs}}` 注入生成提示词，与 `{{knowledge}}`（静态口径）、
  `{{retrieved}}`（外挂检索）三口径分离；文件丢失/读失败一律空注入降级，不阻断生成。
- **配置面**：`WelinkSettings` 新增 `sediment` 配置块（总开关/评审模式/会话白名单/提取
  周期/问答归档开关/注入长度上限），三层归一化兜底，web 调试模式诚实降级。
- **migration v6**：`welink_announcements`（公告存档）、`knowledge_drafts`（待评审条目）、
  `sediment_state`（kv 水位）三表。
- **存储根迁移覆盖 knowledge/**：迁移子目录清单追加 `knowledge`（唯一 Rust 触点），否则
  用户迁移数据根会丢失全部沉淀知识。
- **安全边界不变**：沉淀全程纯本地写入、不接 safety-gate、无任何外发；「安全闸不感知技能」
  与回复铁律等既有合同零改动。

## Capabilities

### New Capabilities

- `knowledge-sedimentation`: 知识沉淀——群消息/群公告/问答对的自动采集、LLM 提取、
  人工评审与 Markdown 归档，形成不受数据库保留期影响的本地长期知识记忆；沉淀产物自动
  登记进本地知识库供答复消费。

### Modified Capabilities

- `knowledge-base`: 清单条目增加来源语义（手动创建 | 沉淀提取 | 问答归档），沉淀产物经
  既有安全文件通道自动登记，纳入既有编辑/下架管理；不改变清单真源与下架语义。
- `welink-auto-reply`: 技能配置新增知识文档绑定字段与归一化；生成段新增本地知识文档
  注入占位符 `{{docs}}`（增强不阻断、模板无占位符零变化、老配置零迁移）。
- `data-storage-lifecycle`: 数据根复制迁移 SHALL 覆盖 `knowledge/` 子目录。

## Impact

- **新增**：`src/orchestrator/knowledge-harvester.ts`（采集/提取/评审流转/归档/水位）、
  `src/infra/knowledge/`（知识文件读写端口-适配器，对齐 `infra/rag` 四件套模式）、设置页
  「知识沉淀」卡与评审队列 UI。
- **修改**：`src/types/welink.ts`（sediment 配置块、`WelinkSkill.knowledgeDocs` 及归一化）、
  `src/infra/db/migrations/`（v6 三表）、`src/orchestrator/pipeline.ts`（`{{docs}}` 注入段）、
  `src/infra/agent/prompt.ts`（占位符正则）、`src/infra/welink/`（公告 Port 可选方法 +
  `[CLI-ASSUME]` 标签）、`KnowledgeCard.vue`（来源标注与评审入口）、`SkillsSection.vue`
  （知识文档多选）、`src-tauri/src/storage.rs`（迁移清单追加 `knowledge`）。
- **不动**：`safety-gate.ts`（沉淀无外发）、既有 RAG 检索链路与 `[RAG-ASSUME]` 假设清单、
  草稿落库/外发状态机。
- **风险与门禁**：`orchestrator/**` 覆盖率 92% 基线必须保持（新增 harvester 需完整单测）；
  群公告抓取能力依赖 welink-cli 对接期核实（`[CLI-ASSUME]` 打桩先行）。
