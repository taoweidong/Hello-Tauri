# Draw.io 交付说明（派生物，非真源）

## 真源与派生关系

| 文件                           | 角色                                                                            | 谁该被编辑                     |
| ------------------------------ | ------------------------------------------------------------------------------- | ------------------------------ |
| `system-model.structurizr.dsl` | **C4 真源**（容器/边界/关系/置信度/`sourceRefs`）                               | 架构事实变更时改这里           |
| `system-module-map.dot`        | **模块依赖真源**（orchestrator/infra/Bridge/宿主通道粒度）                      | 模块增删时改这里               |
| `system-model.evidence.md`     | 证据索引（`file:line` + 置信 + 未知项）                                         | 与上面两份同步                 |
| `system-module-map.svg`        | DOT 的**渲染导出**（Graphviz 16.1.0 引擎，2026-10-05）                          | 不要手工编辑；改 `.dot` 后重渲 |
| `system-model.drawio`          | **可编辑交付**（4 页：L1 上下文 / L2 容器 / L3 TS 分层 / 宿主命令面与数据归属） | 排版、配色、备注可随便改       |

`.drawio` 由上述真源手工派生：节点 ID 采用真源同名前缀（`ctx.` / `ctn.` / `lay.` / `cmd.`），标签内保留 `[high]/[medium]` 置信度与 `file:line` 证据引用。

## 格式退化（Draw.io 表达不了的语义）

| 语义              | DSL/DOT 真源                     | `.drawio` 派生                                 |
| ----------------- | -------------------------------- | ---------------------------------------------- |
| C4 元素类型       | 完整                             | 仅靠形状 + 配色近似（person/系统/容器/数据库） |
| `confidence` 属性 | DSL 属性字段                     | 写进标签文字 + 虚线样式                        |
| `sourceRefs`      | DSL/DOT 属性                     | 写进标签文字（无独立元数据字段）               |
| sync/async        | DSL `interactionStyle`           | 仅虚线区分低置信，未区分同步/异步              |
| 自动布局          | DSL `autoLayout` / DOT `rankdir` | 手工坐标，改动后需自行对齐                     |

## 打开方式

当前 Qoder 会话**没有可用的 Draw.io MCP**，所以文件直接以 XML 落盘，未经过 MCP 打开或渲染。三种查看方式：

1. Draw.io 桌面版 / `app.diagrams.net` → File → Open，选 `docs/architecture/system-model.drawio`（4 个页签）。
2. VS Code 的 Draw.io Integration 插件直接编辑。
3. 需要 Agent 代开或代改时，自行安装本地 MCP（不会自动改你的配置，需你确认）：
   ```toml
   [mcp_servers.drawio]
   command = "npx"
   args = ["-y", "@drawio/mcp"]
   ```

## 再生成 / 维护步骤

1. 先改真源：DSL 结构、DOT 模块、`system-model.evidence.md` 表格（含 `file:line` 与置信度）。
2. 再同步 `.drawio` 对应页签的节点/连线文字；**只调排版不动事实**时可以不改真源。
3. 如果手工编辑 `.drawio` 时改动了架构事实（新增外部系统、改分层依赖、改命令数量），必须回写 DSL/DOT/证据索引，否则模型与代码漂移。
4. 校验事实建议对照这三处机器可核清单：`src-tauri/src/lib.rs` 的 25 个命令、`src/infra/db/index.ts:35` 的 `MIGRATIONS`（v1–v5）、`eslint.config.mjs:112-155` 的两道闸门规则。
5. freshness 检查（图是否过期）请路由 `architecture-health`。
