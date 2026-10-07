# Tasks

## 1. 类型与配置基座

- [x] 1.1 `src/types/welink.ts` 新增 `WelinkSedimentSettings`（enabled/评审 mode/会话白名单/intervalHours/qaArchive/docsMaxChars）与 `WelinkSkill.knowledgeDocs`，含出厂默认值与三层归一化（非法枚举收敛、越界数值收敛、knowledgeDocs 去重去空白并按上限 5 截断）；验证：`types/welink.spec.ts` 新增归一化/越界收敛用例全绿
- [x] 1.2 老配置零迁移用例：配置无 `sediment` 块与技能无 `knowledgeDocs` 时行为与升级前完全一致（沉淀关闭、绑定为空）；验证：`types/welink.spec.ts` 零迁移用例绿

## 2. migration v6 与仓储扩展

- [x] 2.1 `src/infra/db/migrations/` 新增 v6：`welink_announcements`（ann_uid 幂等）、`knowledge_drafts`（含 status/source_type/source_refs/hash）、`sediment_state`（kv 水位）、`sediment_logs`（沉淀调用留痕，同 R4 形状独立分表），注册进 MIGRATIONS 唯一注册表；验证：`orchestrator/bootstrap.spec.ts` 迁移幂等与表结构断言绿
- [x] 2.2 welink 仓储扩展（SQL 与 web 内存实现同步）：公告批写/列表、待评审条目 CRUD 与状态流转、水位读写；验证：`infra/db/repos` 仓储单测（双实现行为一致）绿

## 3. infra 端口-适配器

- [x] 3.1 新增 `src/infra/knowledge/` 四件套（port/mock/fs 适配/index 工厂）：清单与文档读写、slug、先写文件后登记清单的对账次序、来源字段（manual|extract|qa）、老清单缺来源视为 manual；`KnowledgeCard.vue` 迁移到该端口；验证：`infra/knowledge/ports.spec.ts`（对账次序/来源兼容/浏览器 mock）绿
- [x] 3.2 `src/infra/welink/` Port 增加可选公告方法 `pullAnnouncements`：mock 返回样例公告，CLI 适配器不实现（调用即能力缺失），全部假设以 `[CLI-ASSUME]` 标签逐项标注；验证：welink 适配器单测（mock 可拉/CLI 诚实降级）绿，`grep -rn "CLI-ASSUME" src/` 公告条目在档

## 4. 沉淀管线（knowledge-harvester）

- [x] 4.1 `orchestrator/knowledge-harvester.ts` 采集与提取：三源独立水位扫描（消息 pk/公告/问答 finished_at）、白名单过滤、原料消毒分批、`agent.complete` 提取（留痕落 `sediment_logs`，与回复任务 R4 语料分表）、JSON 解析容错、内容指纹去重、连续失败 ≥3 跳过并告警；验证：`orchestrator/knowledge-harvester.spec.ts`（水位推进/不重复采集/去重/失败跳过/全程不产生外发）绿
- [x] 4.2 评审流转：通过（可编辑标题正文 + 新建 slug 文档或并入既有文档，先写文件后登记清单）、拒绝退出队列、auto 模式免审直通并标注来源、pending 条目不出现在知识库清单；验证：harvester.spec 评审流转与登记对账用例绿
- [x] 4.3 问答归档：sent 任务组装问答对（rating=up 优先）、按技能 × 月分片追加写入（读旧 + 拼接 + 覆写）、自动登记清单、qaArchive 关闭零写入；验证：harvester.spec 归档用例（追加不覆写/关闭零写入/登记来源 qa）绿
- [x] 4.4 runtime 装配与调度：`createWelinkRuntime` 挂载 harvester（默认 6h 周期、不受窗口隐藏 ×3 影响）并暴露「立即提取」单轮入口；验证：`orchestrator/runtime.spec.ts` 装配与调度用例绿

## 5. 答复注入（{{docs}}）

- [x] 5.1 `src/infra/agent/prompt.ts` 占位符正则扩展 `docs` 与注入函数（三口径分离、总长受 docsMaxChars 截断）；验证：`infra/agent/prompt.spec.ts`（注入/截断/模板无占位符零变化）绿
- [x] 5.2 `orchestrator/pipeline.ts` 技能路由后、渲染前读取命中技能绑定文档（经 knowledge 端口）注入 `{{docs}}`：文件丢失/读失败空注入降级 warn、不重试不阻断、规则/LLM/兜底一视同仁、未绑定零开销；验证：`orchestrator/pipeline.spec.ts`（命中注入/降级/未绑定零开销）绿

## 6. UI（设置页与评审队列）

- [x] 6.1 新增设置卡 `SedimentCard.vue`：总开关/评审模式（auto 显式风险提示）/白名单会话多选/周期/归档开关/立即提取/最近提取记录；web 调试模式整体降级提示；验证：`components/welink/SedimentCard.spec.ts`（回显/防抖推送/降级）绿
- [x] 6.2 `KnowledgeCard.vue` 扩展：清单来源标识（manual/extract/qa）与待评审队列入口（列表/编辑/通过时新建或并入/拒绝）；验证：`KnowledgeCard.spec.ts` 扩展用例（来源显示/通过后清单与文件断言/拒绝后不变）绿
- [x] 6.3 `SkillsSection.vue` 技能编辑器新增「知识文档」多选（仅清单内文件、上限 5）与 `{{docs}}` 占位符插入 tag；验证：SkillsSection 既有测试回归 + 新字段编辑断言绿

## 7. 存储迁移（唯一 Rust 触点）

- [x] 7.1 `src-tauri/src/storage.rs` 迁移子目录清单追加 `"knowledge"`（提为 MIGRATE_SUBDIRS 常量）；验证：实现期发现 uitest 沙箱 harness 只能走 DOM 无法驱动真实存储迁移，改为 Rust 单测 `cargo test --lib`（迁移清单含 knowledge + knowledge 三层嵌套子树完整复制）通过，效果等价且更强

## 8. 文档与集成收尾

- [x] 8.1 设计文档落档 `docs/design-welink-knowledge-sedimentation-2026-10-06.md`（K-A~K-J 决策、`[CLI-ASSUME]` 公告假设清单与对接 SOP 引用）；更新 `AGENTS.md` 架构边界段落与「改动前先读的文档」索引；验证：文档存在且被 grep 索引到
- [x] 8.2 规格一致性自查：`openspec validate --change add-welink-knowledge-sedimentation --strict` 通过，delta 场景与实现行为逐条对照无漂移
- [x] 8.3 会话收尾门禁：`npm run check`（lint + typecheck + test）全绿，`npm run test:coverage` 核对 orchestrator 92% 基线未回退
