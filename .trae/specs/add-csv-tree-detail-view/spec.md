# CSV 表格行树形详情视图 Spec

## Why
当前 `CsvRenderer` 仅以静态表格展示 CSV 内容（[CsvRenderer.vue](file:///e:/GitHub/Hello-Tauri/src/views/renderers/CsvRenderer.vue)），缺少行级交互。用户希望点击任意行后，在右侧以树形结构展示该行的"隐藏数据"（如某列内嵌的 JSON、路径型字段的层级、或字段→值的兜底树），并支持树形筛选与快速折叠，以便快速浏览结构化字段较多的 CSV 文件。

## What Changes
- 扩展 `CsvRenderer.vue`：行点击交互 + 工作区内左右分栏（表格 | 树形详情）
- 新增 `CsvTreeDetail.vue` 组件：渲染选中行的树形数据，提供搜索筛选与折叠控制
- 新增 `csv-row-tree.ts` 工具模块（纯 TS）：从一行 CSV 数据派生树形结构
  - 优先识别 JSON 列（值为 `{...}` / `[...]`）
  - 其次识别路径型列（值含 `/`、`\` 或 `.` 层级分隔符）
  - 兜底：将所有字段构建为 `{ 字段名: 值 }` 的对象树
- 复用 `SplitView` 分栏组件实现表格与详情的并排展示
- 树形节点渲染参考 `JsonNode.vue` 的递归模式，但新增筛选高亮与折叠控制
- 不修改插件接口 `IFileParserPlugin`、不修改 `ParsedContent` 类型，保持插件系统稳定性

## Impact
- Affected specs: 无（首次 spec）
- Affected code:
  - 修改：[src/views/renderers/CsvRenderer.vue](file:///e:/GitHub/Hello-Tauri/src/views/renderers/CsvRenderer.vue)
  - 修改：[src/views/renderers/index.ts](file:///e:/GitHub/Hello-Tauri/src/views/renderers/index.ts)（导出新组件）
  - 新增：`src/views/renderers/CsvTreeDetail.vue`
  - 新增：`src/core/csv-row-tree.ts`（纯 TS 工具，归属 core 层与 parser-engine 同级）
  - 新增：`src/__tests__/core/csv-row-tree.test.ts`
  - 新增：`src/__tests__/components/CsvTreeDetail.test.ts`
  - 复用：[src/components/workspace/SplitView.vue](file:///e:/GitHub/Hello-Tauri/src/components/workspace/SplitView.vue)、[src/views/renderers/JsonNode.vue](file:///e:/GitHub/Hello-Tauri/src/views/renderers/JsonNode.vue)（仅参考思路，不直接复用）

## ADDED Requirements

### Requirement: CSV 行点击展示树形详情
系统 SHALL 在 CSV 表格渲染器中支持行点击交互：用户点击任意数据行时，工作区右侧分栏展示该行派生出的树形详情数据。

#### Scenario: 点击数据行展示树形详情
- **WHEN** 用户在 CSV 表格中点击某一行
- **THEN** 工作区切换为左右分栏布局，左侧保留原表格（高亮选中行），右侧展示该行派生的树形详情

#### Scenario: 切换选中行
- **WHEN** 用户在已展开详情的状态下点击另一行
- **THEN** 右侧树形详情平滑切换为新行的树形数据，左侧高亮转移至新选中行

#### Scenario: 关闭详情分栏
- **WHEN** 用户再次点击已选中的行（或点击详情面板的关闭按钮）
- **THEN** 工作区恢复为单栏表格布局，选中状态清除

### Requirement: 行数据派生树形结构
系统 SHALL 通过纯函数 `extractRowTree(headers, row)` 从一行 CSV 数据派生出树形结构，派生顺序为：JSON 列 → 路径型列 → 字段兜底树。

#### Scenario: 行中包含 JSON 列
- **WHEN** 某列的单元格值能被 `JSON.parse` 解析为对象或数组
- **THEN** 该列作为独立分支挂入树中，分支根节点显示列名，子节点为解析后的 JSON 结构

#### Scenario: 行中包含路径型列
- **WHEN** 某列的单元格值匹配路径模式（含 `/`、`\` 或由 `.` 分隔的多段标识符）
- **THEN** 该列按分隔符拆分为层级，构建为嵌套对象树挂入总树

#### Scenario: 普通字段兜底
- **WHEN** 某列既不是 JSON 也不是路径型
- **THEN** 该字段作为叶子节点挂入根对象，键为列名，值为单元格字符串

#### Scenario: 空行
- **WHEN** 传入空行（row 为空数组）
- **THEN** 返回空对象 `{}`

### Requirement: 树形详情搜索筛选
系统 SHALL 在树形详情面板顶部提供搜索输入框，支持按节点键名或值实时筛选。

#### Scenario: 输入关键字筛选
- **WHEN** 用户在搜索框输入关键字
- **THEN** 树中仅保留含关键字的节点及其所有祖先路径，匹配文本高亮显示；其余分支折叠隐藏

#### Scenario: 清空搜索
- **WHEN** 用户清空搜索框
- **THEN** 树恢复完整展示，保持之前的折叠状态

### Requirement: 树形快速折叠控制
系统 SHALL 在树形详情面板提供快速折叠控件：全部展开、全部折叠、按层级折叠（折叠到第 N 层）。

#### Scenario: 全部展开
- **WHEN** 用户点击"全部展开"按钮
- **THEN** 树中所有节点展开

#### Scenario: 全部折叠
- **WHEN** 用户点击"全部折叠"按钮
- **THEN** 树中所有非叶子节点折叠，仅显示根层级

#### Scenario: 按层级折叠
- **WHEN** 用户在层级选择器中选择"第 2 层"
- **THEN** 树展开至第 2 层（根为第 1 层），更深层节点保持折叠

### Requirement: 选中行状态记忆
系统 SHALL 在 CSV 渲染器组件内部维护选中行索引与树形状态，不污染全局 Pinia store 或模块级 composable 单例。

#### Scenario: 切换标签页后返回
- **WHEN** 用户在 CSV 标签页选中第 3 行后切换到其他标签页，再切回
- **THEN** 选中行高亮与树形详情状态保持（由 `activeTab.content` 驱动，组件重新挂载时基于 props 重建）

## MODIFIED Requirements

### Requirement: CsvRenderer 表格交互
[原 CsvRenderer 仅静态展示表格] 修改为：支持行点击交互、行高亮、与右侧详情分栏联动；当无选中行时仍保持原表格全宽展示，向后兼容。

## REMOVED Requirements
无（不删除任何已有功能）。
