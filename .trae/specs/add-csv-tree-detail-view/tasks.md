# Tasks

## 任务总览
为 CSV 渲染器新增"点击行 → 右侧分栏展示树形详情"交互，详情面板支持搜索筛选与快速折叠。所有改动集中在渲染层与一个纯 TS 工具模块，不触动插件接口与 ParsedContent 类型。

## 任务依赖关系
```
Task 1 (csv-row-tree 工具) ──┐
                             ├──> Task 3 (CsvTreeDetail 组件) ──┐
Task 2 (JsonNode 扩展/新节点)─┘                                   ├──> Task 4 (CsvRenderer 集成) ──> Task 5 (端到端验证)
                                                                  │
Task 4 依赖 Task 1/3 完成后才能集成 ────────────────────────────── ┘
```

## 任务列表

- [x] Task 1: 新建 `src/core/csv-row-tree.ts` 纯 TS 工具模块
  - [x] SubTask 1.1: 定义 `RowTreeNode` 类型（键、值、children、isLeaf、source 列名等元信息）
  - [x] SubTask 1.2: 实现 `tryParseJsonCell(value): unknown | null` 辅助函数，安全解析 JSON 单元格
  - [x] SubTask 1.3: 实现 `tryParsePathCell(value): string[] | null` 辅助函数，识别路径型单元格（含 `/`、`\` 或 `.` 多段标识符，避免误判小数）
  - [x] SubTask 1.4: 实现主函数 `extractRowTree(headers: string[], row: string[]): RowTreeNode`，按 JSON → 路径 → 字段兜底顺序合并
  - [x] SubTask 1.5: 编写 `src/__tests__/core/csv-row-tree.test.ts`，覆盖 spec 中的 4 个 scenario + 边界（空行、单 JSON、单路径、混合）

- [x] Task 2: 新增可复用的树形节点组件 `src/views/renderers/TreeNode.vue`
  - [x] SubTask 2.1: 定义 props：`node: RowTreeNode`、`depth: number`、`searchKeyword: string`、`expandedDepths: Set<number> | null`（null 表示使用节点自身 open 状态）
  - [x] SubTask 2.2: 实现节点展开/折叠切换、缩进、键值高亮（searchKeyword 命中时高亮 span）
  - [x] SubTask 2.3: 递归渲染 children，参考 [JsonNode.vue](file:///e:/GitHub/Hello-Tauri/src/views/renderers/JsonNode.vue) 的递归模式但支持外部受控折叠
  - [x] SubTask 2.4: 处理叶子节点（字符串/数字/布尔/null）的类型着色，复用 JsonNode 的色板

- [x] Task 3: 新增 `src/views/renderers/CsvTreeDetail.vue` 详情面板组件
  - [x] SubTask 3.1: 顶部工具栏布局：NInput 搜索框 + NButton 全部展开/全部折叠 + NSelect 层级选择
  - [x] SubTask 3.2: 接收 props：`tree: RowTreeNode`；内部维护 `searchKeyword`、`expandedDepths` 状态
  - [x] SubTask 3.3: 实现搜索筛选逻辑：计算 `filteredTree`（保留命中节点 + 祖先路径），传递给 TreeNode
  - [x] SubTask 3.4: 实现"全部展开/折叠"按钮：设置 `expandedDepths` 为全集或仅根层
  - [x] SubTask 3.5: 实现"按层级折叠"：层级选择器（1~maxDepth），选择后展开至该层
  - [x] SubTask 3.6: 提供 emit `close` 事件供父组件关闭分栏
  - [x] SubTask 3.7: 编写 `src/__tests__/components/CsvTreeDetail.test.ts`，覆盖搜索、折叠、层级控制

- [x] Task 4: 改造 `src/views/renderers/CsvRenderer.vue` 集成行点击与分栏
  - [x] SubTask 4.1: 引入 `SplitView`、`CsvTreeDetail`、`extractRowTree`，新增内部状态 `selectedIndex: number | null`
  - [x] SubTask 4.2: 表格行添加 `@click` 与 `:class` 高亮；点击同一行时切换选中（再次点击取消）
  - [x] SubTask 4.3: 当 `selectedIndex !== null` 时使用 SplitView 左右分栏（左表格 | 右 CsvTreeDetail），否则单栏全宽
  - [x] SubTask 4.4: 计算属性 `selectedTree` 调用 `extractRowTree(headers, rows[selectedIndex])` 派生树
  - [x] SubTask 4.5: 监听 CsvTreeDetail 的 `close` 事件，将 selectedIndex 置 null
  - [x] SubTask 4.6: 适配浅色/深色主题（沿用现有 CSS 变量体系），确保选中行高亮在两套主题下可见
  - [x] SubTask 4.7: 更新 [src/views/renderers/index.ts](file:///e:/GitHub/Hello-Tauri/src/views/renderers/index.ts) 导出 CsvTreeDetail 与 TreeNode（如需对外暴露）
  - [x] SubTask 4.8（额外）: 扩展 `src/components/shared/DataTable.vue` 新增 `rowClassName` prop 透传给 NDataTable，以支持选中行高亮（保留用户既有的 DataTable 排序/筛选/导出/虚拟滚动功能）

- [x] Task 5: 端到端验证与回归测试
  - [x] SubTask 5.1: 运行 `npm run typecheck` 确认类型通过
  - [x] SubTask 5.2: 运行 `npm test` 确认所有测试通过（含新增的 csv-row-tree 与 CsvTreeDetail 测试）
  - [ ] SubTask 5.3: 运行 `npm run dev` 手动验证：用 `data/sample.csv` 测试点击行、切换行、关闭、搜索、折叠、层级控制（用户手动）
  - [x] SubTask 5.4: 验证 csv-parser 原有测试与 JsonRenderer/LogRenderer 渲染未受影响

# Task Dependencies
- Task 2 与 Task 1 无依赖，可并行
- Task 3 依赖 Task 1（需要 RowTreeNode 类型）与 Task 2（使用 TreeNode 组件）
- Task 4 依赖 Task 1 与 Task 3
- Task 5 依赖 Task 4 完成
